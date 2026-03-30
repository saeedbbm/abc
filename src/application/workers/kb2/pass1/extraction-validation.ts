import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getCrossCheckModel, getCrossCheckModelName, getReasoningModel, getReasoningModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger, normalizeForMatch } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import { tokenSimilarity } from "@/src/application/workers/kb2/utils/text-similarity";

const PR_PATTERN = /PR\s*#(\d+)|pull\s*request\s*#?(\d+)|#(\d+)/gi;
const TICKET_PATTERN = /\b([A-Z]{2,10}-\d+)\b/g;
const EMAIL_PATTERN = /\b([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;

interface RecoveryCandidate {
  display_name: string;
  type: string;
  aliases: string[];
  attributes: Record<string, any>;
  confidence: string;
  evidence_excerpt: string;
  recovery_source: "programmatic" | "cross_llm" | "opus_confirmed";
  source_doc_title: string;
  source_doc_id?: string;
  source_provider: string;
}

// ---------------------------------------------------------------------------
// Layer 1: Programmatic pattern scan
// ---------------------------------------------------------------------------

function runProgrammaticScan(
  docs: KB2ParsedDocument[],
  existingNames: Set<string>,
): { candidates: RecoveryCandidate[]; docEntityMap: Map<string, string[]> } {
  const candidates: RecoveryCandidate[] = [];
  const seen = new Set<string>();
  const docEntityMap = new Map<string, string[]>();

  for (const doc of docs) {
    const docEntities: string[] = [];
    const fullText = `${doc.title}\n${doc.content}`;

    if (doc.provider === "github") {
      const titleMatch = doc.title.match(/^(.+?)\s+PR\s*#(\d+)/i);
      if (titleMatch) {
        const prName = `${titleMatch[1]} PR #${titleMatch[2]}`;
        const key = prName.toLowerCase();
        docEntities.push(key);
        if (!existingNames.has(key) && !seen.has(key)) {
          seen.add(key);
          const repoName = titleMatch[1].trim();
          const prNum = titleMatch[2];
          const branchMatch = doc.content.match(/Head branch:\s*(.+)/i);
          const authorMatch = doc.content.match(/Author:\s*(.+)/i);
          candidates.push({
            display_name: prName,
            type: "pull_request",
            aliases: [`PR #${prNum}`, ...(branchMatch ? [branchMatch[1].trim()] : [])],
            attributes: {
              repo: repoName,
              pr_number: parseInt(prNum),
              ...(authorMatch ? { author: authorMatch[1].trim() } : {}),
              ...(branchMatch ? { branch: branchMatch[1].trim() } : {}),
            },
            confidence: "high",
            evidence_excerpt: doc.title,
            recovery_source: "programmatic",
            source_doc_title: doc.title,
            source_doc_id: doc.sourceId,
            source_provider: doc.provider,
          });
        }
      }
    }

    if (doc.provider === "jira") {
      const ticketMatches = fullText.matchAll(TICKET_PATTERN);
      for (const match of ticketMatches) {
        const ticketKey = match[1];
        const key = ticketKey.toLowerCase();
        docEntities.push(key);
        if (!existingNames.has(key) && !seen.has(key)) {
          seen.add(key);
          candidates.push({
            display_name: ticketKey,
            type: "ticket",
            aliases: [],
            attributes: {},
            confidence: "high",
            evidence_excerpt: `Ticket ${ticketKey} found in Jira document: ${doc.title}`,
            recovery_source: "programmatic",
            source_doc_title: doc.title,
            source_doc_id: doc.sourceId,
            source_provider: doc.provider,
          });
        }
      }
    }

    const ticketMatches = fullText.matchAll(TICKET_PATTERN);
    for (const match of ticketMatches) {
      const ticketKey = match[1];
      const key = ticketKey.toLowerCase();
      docEntities.push(key);
      if (!existingNames.has(key) && !seen.has(key)) {
        seen.add(key);
        candidates.push({
          display_name: ticketKey,
          type: "ticket",
          aliases: [],
          attributes: {},
          confidence: "medium",
          evidence_excerpt: `Ticket ${ticketKey} referenced in ${doc.provider} document: ${doc.title}`,
          recovery_source: "programmatic",
          source_doc_title: doc.title,
          source_doc_id: doc.sourceId,
          source_provider: doc.provider,
        });
      }
    }

    const emailMatches = fullText.matchAll(EMAIL_PATTERN);
    for (const match of emailMatches) {
      const email = match[0];
      const namePart = match[1].replace(/[._]/g, " ");
      const nameParts = namePart.split(" ").map((p) => p.charAt(0).toUpperCase() + p.slice(1));
      const displayName = nameParts.join(" ");
      const key = displayName.toLowerCase();
      docEntities.push(key);
      if (!existingNames.has(key) && !seen.has(key)) {
        seen.add(key);
        candidates.push({
          display_name: displayName,
          type: "team_member",
          aliases: [email],
          attributes: { email },
          confidence: "medium",
          evidence_excerpt: `Email ${email} found in ${doc.provider} document: ${doc.title}`,
          recovery_source: "programmatic",
          source_doc_title: doc.title,
          source_doc_id: doc.sourceId,
          source_provider: doc.provider,
        });
      }
    }

    docEntityMap.set(doc.title, docEntities);
  }

  return { candidates, docEntityMap };
}

// ---------------------------------------------------------------------------
// Layer 2: Cross-LLM gap check (GPT-4o)
// ---------------------------------------------------------------------------

const GapCheckSchema = z.object({
  missed_entities: z.array(z.object({
    display_name: z.string(),
    suggested_type: z.string(),
    reason: z.string(),
    evidence_excerpt: z.string().describe("Exact verbatim quote from the source document that mentions or evidences this entity"),
    source_document: z.string(),
  })),
  miscategorized: z.array(z.object({
    display_name: z.string(),
    current_type: z.string(),
    suggested_type: z.string(),
    reason: z.string(),
  })),
});

// ---------------------------------------------------------------------------
// Layer 3: Opus final judge
// ---------------------------------------------------------------------------

const JudgmentSchema = z.object({
  decisions: z.array(z.object({
    display_name: z.string(),
    action: z.enum(["add", "reject", "retype"]),
    final_type: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    reason: z.string(),
  })),
});

// ---------------------------------------------------------------------------
// Layer 0: Attribute validation & backfill
// ---------------------------------------------------------------------------

interface AttributeIssue {
  node_id: string;
  display_name: string;
  field: string;
  action: "backfilled" | "flagged";
  value?: string;
  reason: string;
}

const VALID_PROJECT_STATUS = new Set(["active", "completed", "proposed"]);
const VALID_DOC_LEVEL = new Set(["documented", "undocumented"]);
const VALID_DECISION_STATUS = new Set(["decided", "pending", "superseded", "reversed"]);
const VALID_PROCESS_STATUS = new Set(["active", "deprecated", "proposed", "informal"]);

function computeSourceCoverage(sourceTypes: Set<string>) {
  const cov = {
    has_confluence: sourceTypes.has("confluence"),
    has_jira: sourceTypes.has("jira"),
    has_github: sourceTypes.has("github"),
    has_slack: sourceTypes.has("slack"),
    has_feedback: sourceTypes.has("customer_feedback") || sourceTypes.has("webform"),
  };
  let level: "documented" | "undocumented";
  if (cov.has_confluence) level = "documented";
  else level = "undocumented";
  const parts: string[] = [];
  if (cov.has_confluence) parts.push("confluence");
  if (cov.has_jira) parts.push("jira");
  if (cov.has_github) parts.push("github");
  if (cov.has_slack) parts.push("slack");
  if (cov.has_feedback) parts.push("feedback");
  return { cov, level, reason: `Sources: ${parts.join(", ") || "none"}` };
}

// ---------------------------------------------------------------------------
// Layer 0a-LLM: Batched attribute inference via LLM
// ---------------------------------------------------------------------------

const ATTR_INFERENCE_BATCH_SIZE = 15;

const AttributeInferenceSchema = z.object({
  entities: z.array(z.object({
    display_name: z.string(),
    status: z.string().optional(),
    rationale: z.string().optional(),
    scope: z.string().optional(),
    decided_by: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: z.string(),
  })),
});

const ATTRIBUTE_INFERENCE_PROMPT = `You are an attribute inference engine for a knowledge base system. You receive entities with their source excerpts and must infer missing attributes.

## PROJECT STATUS

Allowed values: active, completed, proposed.

CRITICAL: A project's status describes the OVERALL initiative, not any single ticket or PR.
- The excerpts may mention Jira ticket statuses (Done, In Progress, Backlog) and PR states (merged, open). These describe individual work items, NOT the project as a whole.
- A project is "completed" ONLY when ALL evidence points to it being finished — every ticket Done, every PR merged, no further references to outstanding work, and no ongoing discussion.
- A project is "active" if there are ANY In Progress tickets, open PRs, or recent Slack/comment mentions of ongoing work — even if most tickets are Done and some PRs are merged.
- A project is "proposed" if it is only discussed as a future idea with no work started, or if tickets/epics exist but no development work has begun.
- When in doubt between "active" and "completed", prefer "active".

## DECISION ATTRIBUTES

- "rationale": why the decision was made. Only fill if the excerpts state or strongly imply the reason.
- "scope": which project, feature, or area it affects.
- "decided_by": the person or group who made it. Only fill if explicitly named.
- Omit any field where the excerpts lack clear evidence.

## PROCESS STATUS

For process entities, return the "status" field (not "process_status").
Allowed values: active, deprecated, proposed, informal.
- "active": the process has formal documentation (e.g., a Confluence page with defined steps) and is currently followed.
- "informal": the process is practiced but NOT formally documented — only visible in Slack conversations, PR review patterns, or casual mentions.
- "deprecated": evidence indicates the process is no longer followed or has been replaced.
- "proposed": the process is discussed as something the team should adopt but hasn't yet.

## GENERAL RULES

- DO NOT hallucinate. If the excerpts do not contain enough information, omit the field (return undefined). An empty field is always better than a guess.
- "reasoning": REQUIRED. You must quote the specific evidence from the excerpts that led to your conclusion. For example: "PAW-34 Done + PR #49 merged + no further references → completed" or "PAW-32 In Progress → project still active despite other tickets being Done".
- "confidence": "high" = clear, unambiguous evidence; "medium" = reasonable inference from partial evidence; "low" = weak signal, limited data.`;

interface LLMInferenceTarget {
  node_id: string;
  display_name: string;
  type: string;
  excerpts: string;
  existing_attrs: Record<string, any>;
}

function collectLLMInferenceTargets(
  nodes: KB2GraphNodeType[],
  heuristicIssues: AttributeIssue[],
): LLMInferenceTarget[] {
  const flaggedNodeIds = new Set<string>();
  const defaultedNodeIds = new Set<string>();

  for (const issue of heuristicIssues) {
    if (issue.action === "flagged") flaggedNodeIds.add(issue.node_id);
    if (issue.action === "backfilled" && (issue.field === "status" || issue.field === "decision_status")) {
      defaultedNodeIds.add(issue.node_id);
    }
  }

  const targets: LLMInferenceTarget[] = [];
  for (const node of nodes) {
    if (node.type !== "project" && node.type !== "decision" && node.type !== "process") continue;

    const needsLLM =
      flaggedNodeIds.has(node.node_id) ||
      defaultedNodeIds.has(node.node_id) ||
      (node.type === "project" && !VALID_PROJECT_STATUS.has((node.attributes as any)?.status)) ||
      (node.type === "process" && !(node.attributes as any)?._status_reasoning);

    if (!needsLLM) continue;

    const excerpts = node.source_refs
      .map((r) => `[${r.source_type}] ${r.title}${r.section_heading ? ` > ${r.section_heading}` : ""}: ${r.excerpt}`)
      .join("\n");

    targets.push({
      node_id: node.node_id,
      display_name: node.display_name,
      type: node.type,
      excerpts: excerpts.slice(0, 3000),
      existing_attrs: node.attributes as Record<string, any> ?? {},
    });
  }
  return targets;
}

function validateAndBackfillAttributes(
  nodes: KB2GraphNodeType[],
): { issues: AttributeIssue[]; updates: Map<string, Record<string, any>> } {
  const issues: AttributeIssue[] = [];
  const updates = new Map<string, Record<string, any>>();

  for (const node of nodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    const sourceTypes = new Set(node.source_refs.map((r) => r.source_type));
    const patch: Record<string, any> = {};

    const needsDocLevel = node.type === "project" || node.type === "process" || node.type === "decision";
    if (needsDocLevel) {
      const { cov, level, reason } = computeSourceCoverage(sourceTypes);
      patch._source_coverage = cov;
      if (!attrs.documentation_level || !VALID_DOC_LEVEL.has(attrs.documentation_level)) {
        patch.documentation_level = level;
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "documentation_level", action: "backfilled", value: level, reason });
      }
    }

    if (node.type === "project") {
      if (attrs.status === "planned") {
        patch.status = "proposed";
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "status", action: "backfilled", value: "proposed", reason: "Normalized planned → proposed" });
      } else if (!attrs.status || !VALID_PROJECT_STATUS.has(attrs.status)) {
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "status", action: "flagged", reason: "Missing status — will be inferred by LLM" });
      }
    }

    if (node.type === "decision") {
      if (!attrs.decision_status || !VALID_DECISION_STATUS.has(attrs.decision_status)) {
        patch.decision_status = "decided";
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "decision_status", action: "backfilled", value: "decided", reason: "Default — most extracted decisions are past decisions" });
      }

      if (!attrs.rationale) {
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "rationale", action: "flagged", reason: "Missing rationale — will be inferred by LLM" });
      }

      if (!attrs.scope) {
        const rels = Array.isArray(attrs._relationships) ? attrs._relationships : [];
        const relTargets = rels.map((r: any) => r.target).filter(Boolean);
        if (relTargets.length > 0) {
          const inferred = relTargets[0];
          patch.scope = inferred;
          issues.push({ node_id: node.node_id, display_name: node.display_name, field: "scope", action: "backfilled", value: inferred, reason: `Inferred from relationship target: ${inferred}` });
        }
      }
    }

    if (node.type === "process") {
      const processStatus = attrs.status ?? attrs.process_status;
      if (!processStatus || !VALID_PROCESS_STATUS.has(processStatus)) {
        patch.status = "active";
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "status", action: "backfilled", value: "active", reason: "Default — will be refined by LLM pass" });
      } else if (attrs.process_status && !attrs.status) {
        patch.status = attrs.process_status;
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "status", action: "backfilled", value: attrs.process_status, reason: "Migrated process_status → status" });
      }
    }

    if (Object.keys(patch).length > 0) {
      updates.set(node.node_id, patch);
    }
  }

  return { issues, updates };
}

// ---------------------------------------------------------------------------
// Duplicate cluster detection
// ---------------------------------------------------------------------------

const SKIP_SHARED_REF_DUPE_TYPES = new Set([
  "team_member", "library", "infrastructure", "integration",
  "database", "environment", "cloud_resource",
]);

function tagDuplicateClusters(
  nodes: KB2GraphNodeType[],
): { pairs: [string, string][]; updates: Map<string, string[]> } {
  const pairs: [string, string][] = [];
  const dupeMap = new Map<string, Set<string>>();

  const addPair = (a: KB2GraphNodeType, b: KB2GraphNodeType) => {
    const key = [a.display_name, b.display_name].sort().join("|||");
    if (pairs.some(([x, y]) => [x, y].sort().join("|||") === key)) return;
    pairs.push([a.display_name, b.display_name]);
    if (!dupeMap.has(a.node_id)) dupeMap.set(a.node_id, new Set());
    if (!dupeMap.has(b.node_id)) dupeMap.set(b.node_id, new Set());
    dupeMap.get(a.node_id)!.add(b.display_name);
    dupeMap.get(b.node_id)!.add(a.display_name);
  };

  const ticketRefs = new Map<string, KB2GraphNodeType[]>();
  const prRefs = new Map<string, KB2GraphNodeType[]>();

  for (const node of nodes) {
    const allText = [node.display_name, ...node.source_refs.map((r) => r.title)].join(" ");
    for (const m of allText.matchAll(TICKET_PATTERN)) {
      const ticket = m[1].toUpperCase();
      if (!ticketRefs.has(ticket)) ticketRefs.set(ticket, []);
      ticketRefs.get(ticket)!.push(node);
    }
    for (const m of allText.matchAll(PR_PATTERN)) {
      const prNum = m[1] ?? m[2] ?? m[3];
      if (prNum) {
        const prKey = `PR#${prNum}`;
        if (!prRefs.has(prKey)) prRefs.set(prKey, []);
        prRefs.get(prKey)!.push(node);
      }
    }
  }

  for (const [, group] of ticketRefs) {
    const unique = [...new Map(group.map((n) => [n.node_id, n])).values()];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        if (unique[i].type !== unique[j].type) continue;
        if (SKIP_SHARED_REF_DUPE_TYPES.has(unique[i].type)) continue;
        const la = unique[i].display_name.toLowerCase().trim();
        const lb = unique[j].display_name.toLowerCase().trim();
        if (la.includes(lb) || lb.includes(la) || tokenSimilarity(la, lb) >= 0.3) {
          addPair(unique[i], unique[j]);
        }
      }
    }
  }

  for (const [, group] of prRefs) {
    const unique = [...new Map(group.map((n) => [n.node_id, n])).values()];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        if (unique[i].type !== unique[j].type) continue;
        if (SKIP_SHARED_REF_DUPE_TYPES.has(unique[i].type)) continue;
        const la = unique[i].display_name.toLowerCase().trim();
        const lb = unique[j].display_name.toLowerCase().trim();
        if (la.includes(lb) || lb.includes(la) || tokenSimilarity(la, lb) >= 0.3) {
          addPair(unique[i], unique[j]);
        }
      }
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].type !== nodes[j].type) continue;
      const a = nodes[i].display_name.toLowerCase().trim();
      const b = nodes[j].display_name.toLowerCase().trim();
      if (a === b) continue;
      if (a.length > 5 && b.length > 5 && (a.includes(b) || b.includes(a))) {
        addPair(nodes[i], nodes[j]);
      }
    }
  }

  const updates = new Map<string, string[]>();
  for (const [nodeId, dupes] of dupeMap) {
    updates.set(nodeId, [...dupes]);
  }
  return { pairs, updates };
}

// ---------------------------------------------------------------------------
// Decision enrichment: link decisions to parent entities
// ---------------------------------------------------------------------------

function enrichDecisionLinks(
  nodes: KB2GraphNodeType[],
): { issues: AttributeIssue[]; updates: Map<string, Record<string, any>>; stats: { decisions_enriched: number; scope_filled: number; decided_by_filled: number } } {
  const issues: AttributeIssue[] = [];
  const updates = new Map<string, Record<string, any>>();
  let scopeFilled = 0;
  let decidedByFilled = 0;
  let enriched = 0;

  const entityNames = new Map<string, { name: string; type: string }>();
  for (const n of nodes) {
    if (n.type !== "decision") {
      entityNames.set(n.display_name.toLowerCase().trim(), { name: n.display_name, type: n.type });
    }
  }

  const decisions = nodes.filter((n) => n.type === "decision");
  for (const dec of decisions) {
    const attrs = (dec.attributes ?? {}) as Record<string, any>;
    const allText = [
      dec.display_name,
      ...dec.source_refs.map((r) => r.excerpt),
      ...dec.source_refs.map((r) => r.title),
    ].join(" ").toLowerCase();

    const related: Array<{ name: string; type: string }> = [];
    const patch: Record<string, any> = {};

    for (const [key, ent] of entityNames) {
      if (key.length < 3) continue;
      if (allText.includes(key)) {
        related.push(ent);
      }
    }

    if (related.length > 0) {
      patch._related_entities = related.map((r) => ({ name: r.name, type: r.type }));
      enriched++;

      if (!attrs.scope) {
        const scopeEntity = related.find((r) => r.type === "project" || r.type === "repository");
        if (scopeEntity) {
          patch.scope = scopeEntity.name;
          scopeFilled++;
          issues.push({ node_id: dec.node_id, display_name: dec.display_name, field: "scope", action: "backfilled", value: scopeEntity.name, reason: `Matched entity "${scopeEntity.name}" (${scopeEntity.type}) in excerpts` });
        }
      }

    }

    if (Object.keys(patch).length > 0) {
      updates.set(dec.node_id, patch);
    }
  }

  return { issues, updates, stats: { decisions_enriched: enriched, scope_filled: scopeFilled, decided_by_filled: decidedByFilled } };
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

export const extractionValidationStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-extraction-validation");
  const stepId = "pass1-step-4";
  const tc = getTenantCollections(ctx.companySlug);

  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  if (!snapshot) throw new Error("No input snapshot found");
  const docs = snapshot.parsed_documents as KB2ParsedDocument[];

  // Read step 3's nodes (latest execution) and clone them into this execution
  const step3ExecId = await ctx.getStepExecutionId("pass1", 3);
  const step3Filter = step3ExecId ? { execution_id: step3ExecId } : { run_id: ctx.runId };
  const sourceNodes = (await tc.graph_nodes.find(step3Filter).toArray()) as unknown as (KB2GraphNodeType & { _id?: any })[];

  const clonedNodes = sourceNodes.map(({ _id, ...rest }) => ({
    ...rest,
    execution_id: ctx.executionId,
    attributes: { ...rest.attributes },
  }));
  if (clonedNodes.length > 0) {
    await tc.graph_nodes.insertMany(clonedNodes as any[]);
  }

  const myFilter = { execution_id: ctx.executionId };
  const existingNodes = (await tc.graph_nodes.find(myFilter).toArray()) as unknown as KB2GraphNodeType[];
  const existingNames = new Set<string>();
  for (const node of existingNodes) {
    existingNames.add(node.display_name.toLowerCase().trim());
    for (const alias of node.aliases) {
      existingNames.add(alias.toLowerCase().trim());
    }
  }

  // ---- Layer 0a: Attribute validation & backfill ----
  await ctx.onProgress("Layer 0a: Validating and backfilling entity attributes...", 1);
  const { issues: attrIssues, updates: attrUpdates } = validateAndBackfillAttributes(existingNodes);

  if (attrUpdates.size > 0) {
    const bulkOps = Array.from(attrUpdates.entries()).map(([nodeId, patch]) => ({
      updateOne: {
        filter: { node_id: nodeId, execution_id: ctx.executionId },
        update: { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`attributes.${k}`, v])) },
      },
    }));
    await tc.graph_nodes.bulkWrite(bulkOps);
  }

  let attrBackfilled = attrIssues.filter((i) => i.action === "backfilled").length;
  const attrFlagged = attrIssues.filter((i) => i.action === "flagged").length;
  await ctx.onProgress(`Layer 0a heuristics done: ${attrBackfilled} backfilled, ${attrFlagged} flagged`, 2);

  // ---- Layer 0a-LLM: Batched attribute inference ----
  let llmCalls = 0;
  const llmTargets = collectLLMInferenceTargets(existingNodes, attrIssues);
  if (llmTargets.length > 0) {
    await ctx.onProgress(`Layer 0a-LLM: Inferring attributes for ${llmTargets.length} entities...`, 2);
    const crossCheckModel = getCrossCheckModel(ctx.config?.pipeline_settings?.models);
    const systemPrompt = ctx.config?.prompts?.extraction_validation?.system_attr_inference ?? ATTRIBUTE_INFERENCE_PROMPT;
    let llmInferred = 0;

    for (let batchStart = 0; batchStart < llmTargets.length; batchStart += ATTR_INFERENCE_BATCH_SIZE) {
      const batch = llmTargets.slice(batchStart, batchStart + ATTR_INFERENCE_BATCH_SIZE);
      const entitiesText = batch.map((t, i) => {
        const missingFields: string[] = [];
        if (t.type === "project" && !VALID_PROJECT_STATUS.has(t.existing_attrs?.status)) missingFields.push("status");
        if (t.type === "decision") {
          if (!t.existing_attrs?.rationale) missingFields.push("rationale");
          if (!t.existing_attrs?.scope) missingFields.push("scope");
          if (!t.existing_attrs?.decided_by) missingFields.push("decided_by");
        }
        if (t.type === "process") missingFields.push("status");
        return `${i + 1}. "${t.display_name}" [type: ${t.type}] — missing: ${missingFields.join(", ")}\nExcerpts:\n${t.excerpts}`;
      }).join("\n\n---\n\n");

      const prompt = `Infer the missing attributes for these entities based on their source excerpts.\n\n${entitiesText}`;

      try {
        const startMs = Date.now();
        let usageData: { promptTokens: number; completionTokens: number } | null = null;

        const result = await structuredGenerate({
          model: crossCheckModel,
          system: systemPrompt,
          prompt,
          schema: AttributeInferenceSchema,
          logger,
          onUsage: (usage) => { usageData = usage; },
          signal: ctx.signal,
        });
        llmCalls++;

        if (usageData) {
          const durationMs = Date.now() - startMs;
          const cost = calculateCostUsd(getCrossCheckModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
          ctx.logLLMCall(stepId, getCrossCheckModelName(ctx.config?.pipeline_settings?.models), prompt, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, durationMs);
        }

        const resultMap = new Map<string, (typeof result.entities)[number]>();
        for (const e of result.entities ?? []) {
          resultMap.set(e.display_name.toLowerCase().trim(), e);
        }

        const llmBulkOps: any[] = [];
        for (const target of batch) {
          const inferred = resultMap.get(target.display_name.toLowerCase().trim());
          if (!inferred) continue;

          const patch: Record<string, any> = {};
          patch._status_reasoning = inferred.reasoning;

          if (target.type === "project" && inferred.status) {
            const normalizedStatus = inferred.status === "planned" ? "proposed" : inferred.status;
            if (VALID_PROJECT_STATUS.has(normalizedStatus)) {
              patch.status = normalizedStatus;
              attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "status", action: "backfilled", value: normalizedStatus, reason: `LLM-inferred: ${inferred.reasoning}` });
            }
          }
          if (target.type === "decision") {
            if (inferred.rationale) {
              patch.rationale = inferred.rationale;
              attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "rationale", action: "backfilled", value: inferred.rationale, reason: `LLM-inferred: ${inferred.reasoning}` });
            }
            if (inferred.scope) {
              patch.scope = inferred.scope;
              attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "scope", action: "backfilled", value: inferred.scope, reason: `LLM-inferred: ${inferred.reasoning}` });
            }
            if (inferred.decided_by) {
              patch.decided_by = inferred.decided_by;
              attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "decided_by", action: "backfilled", value: inferred.decided_by, reason: `LLM-inferred: ${inferred.reasoning}` });
            }
          }
          if (target.type === "process" && inferred.status && VALID_PROCESS_STATUS.has(inferred.status)) {
            patch.status = inferred.status;
            attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "status", action: "backfilled", value: inferred.status, reason: `LLM-inferred: ${inferred.reasoning}` });
          }

          if (Object.keys(patch).length > 0) {
            llmInferred++;
            llmBulkOps.push({
              updateOne: {
                filter: { node_id: target.node_id, execution_id: ctx.executionId },
                update: { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`attributes.${k}`, v])) },
              },
            });
          }
        }

        if (llmBulkOps.length > 0) {
          await tc.graph_nodes.bulkWrite(llmBulkOps);
        }
      } catch (err) {
        logger.log(`Attribute inference batch failed (non-fatal): ${err}`);
      }
    }

    attrBackfilled = attrIssues.filter((i) => i.action === "backfilled").length;
    await ctx.onProgress(`Layer 0a-LLM done: ${llmInferred} entities refined by LLM`, 3);
  }

  // ---- Layer 0b: Duplicate cluster tagging ----
  await ctx.onProgress("Layer 0b: Detecting duplicate clusters...", 2);
  const { pairs: dupePairs, updates: dupeUpdates } = tagDuplicateClusters(existingNodes);

  if (dupeUpdates.size > 0) {
    const dupeBulkOps = Array.from(dupeUpdates.entries()).map(([nodeId, dupes]) => ({
      updateOne: {
        filter: { node_id: nodeId, execution_id: ctx.executionId },
        update: { $set: { "attributes._likely_duplicates": dupes } },
      },
    }));
    await tc.graph_nodes.bulkWrite(dupeBulkOps);
  }
  await ctx.onProgress(`Layer 0b done: ${dupePairs.length} duplicate pairs found`, 3);

  // ---- Layer 0c: Decision enrichment ----
  await ctx.onProgress("Layer 0c: Enriching decision links...", 3);
  const { issues: decIssues, updates: decUpdates, stats: decStats } = enrichDecisionLinks(existingNodes);
  attrIssues.push(...decIssues);

  if (decUpdates.size > 0) {
    const decBulkOps = Array.from(decUpdates.entries()).map(([nodeId, patch]) => ({
      updateOne: {
        filter: { node_id: nodeId, execution_id: ctx.executionId },
        update: { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`attributes.${k}`, v])) },
      },
    }));
    await tc.graph_nodes.bulkWrite(decBulkOps);
  }
  await ctx.onProgress(`Layer 0c done: ${decStats.decisions_enriched} decisions enriched, ${decStats.scope_filled} scopes filled, ${decStats.decided_by_filled} decided_by filled`, 4);

  // ---- Layer 1: Programmatic scan ----
  await ctx.onProgress("Layer 1: Programmatic pattern scan...", 5);
  const { candidates: programmaticCandidates, docEntityMap } = runProgrammaticScan(docs, existingNames);
  await ctx.onProgress(`Layer 1 done: ${programmaticCandidates.length} candidates found`, 15);

  const docsWithZeroEntities: string[] = [];
  for (const doc of docs) {
    const docNameLower = doc.title.toLowerCase();
    let hasEntity = false;
    for (const name of existingNames) {
      if (docNameLower.includes(name) || name.includes(docNameLower)) {
        hasEntity = true;
        break;
      }
    }
    if (!hasEntity) {
      const docEntries = docEntityMap.get(doc.title) ?? [];
      if (docEntries.length === 0) {
        docsWithZeroEntities.push(doc.title);
      }
    }
  }

  // ---- Layer 2: Cross-LLM gap check ----
  await ctx.onProgress("Layer 2: Cross-LLM gap check (GPT-4o)...", 20);

  const entitySummary = Object.entries(
    existingNodes.reduce((acc, n) => {
      acc[n.type] = acc[n.type] ?? [];
      acc[n.type].push(n.display_name);
      return acc;
    }, {} as Record<string, string[]>),
  ).map(([type, names]) => `${type}: ${names.join(", ")}`).join("\n");

  const sampleDocs = [
    ...docs.filter((d) => docsWithZeroEntities.includes(d.title)).slice(0, 10),
    ...docs.filter((d) => d.provider === "github" || d.provider === "jira").slice(0, 10),
  ];
  const uniqueSampleDocs = [...new Map(sampleDocs.map((d) => [d.title, d])).values()].slice(0, 15);

  const docsText = uniqueSampleDocs.map((d) =>
    `--- ${d.title} (${d.provider}) ---\n${d.content.slice(0, 2000)}`,
  ).join("\n\n");

  let crossLLMCandidates: RecoveryCandidate[] = [];

  try {
    const crossCheckModel = getCrossCheckModel(ctx.config?.pipeline_settings?.models);
    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;

    const gapCheckPrompt = ctx.config?.prompts?.extraction_validation?.system_gap ?? "You are a quality assurance reviewer for a knowledge base entity extraction system. Your job is to find entities that the primary extraction missed. Be thorough but precise — only flag real entities, not attributes or components.\n\nFor each missed entity, you MUST provide an evidence_excerpt: an exact verbatim quote from the source document that mentions or evidences the entity. Copy the text word-for-word — do NOT paraphrase or summarize. The excerpt must clearly reference the entity and include enough surrounding context to be meaningful on its own (at minimum the full sentence).";
    const gapPrompt = `Here are all entities extracted so far:\n${entitySummary}\n\nReview these source documents and identify any entities that were MISSED or MISCATEGORIZED.\nFocus on: PRs, tickets, people, repositories, databases, infrastructure, decisions (architecture choices, technology tradeoffs), and processes (team workflows, procedures) that should be entities but aren't in the list above.`;

    const result = await structuredGenerate({
      model: crossCheckModel,
      system: gapCheckPrompt,
      prompt: `${gapPrompt}\n\nDocuments to review:\n${docsText}`,
      schema: GapCheckSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    llmCalls++;

    if (usageData) {
      const durationMs = Date.now() - startMs;
      const cost = calculateCostUsd(getCrossCheckModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getCrossCheckModelName(ctx.config?.pipeline_settings?.models), gapPrompt + "\n\n" + docsText, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, durationMs);
    }

    for (const missed of result.missed_entities ?? []) {
      const key = missed.display_name.toLowerCase().trim();
      if (existingNames.has(key)) continue;
      if (programmaticCandidates.some((c) => c.display_name.toLowerCase() === key)) continue;
      crossLLMCandidates.push({
        display_name: missed.display_name,
        type: missed.suggested_type,
        aliases: [],
        attributes: {},
        confidence: "medium",
        evidence_excerpt: missed.evidence_excerpt || missed.reason,
        recovery_source: "cross_llm",
        source_doc_title: missed.source_document,
        source_provider: "unknown",
      });
    }
  } catch (err) {
    logger.log(`Cross-LLM check failed (non-fatal): ${err}`);
  }

  await ctx.onProgress(`Layer 2 done: ${crossLLMCandidates.length} additional candidates`, 50);

  // ---- Layer 3: Opus final judge ----
  const allCandidates = [...programmaticCandidates, ...crossLLMCandidates];

  if (allCandidates.length === 0) {
    await ctx.onProgress("No candidates to validate — extraction was complete", 100);
    return {
      original_count: existingNodes.length,
      programmatic_candidates: 0,
      crossllm_candidates: 0,
      opus_confirmed: 0,
      opus_rejected: 0,
      final_count: existingNodes.length,
      llm_calls: llmCalls,
      source_coverage: {
        total_documents: docs.length,
        documents_with_zero_entities: docsWithZeroEntities,
      },
      recovery_details: [],
      attribute_validation: {
        total_checked: existingNodes.filter((n) => n.type === "project" || n.type === "decision" || n.type === "process").length,
        backfilled: attrBackfilled + decIssues.filter((i) => i.action === "backfilled").length,
        flagged: attrFlagged,
        issues: attrIssues,
      },
      duplicate_clusters: { count: dupePairs.length, pairs: dupePairs },
      decision_enrichment: decStats,
    };
  }

  await ctx.onProgress(`Layer 3: Opus judging ${allCandidates.length} candidates...`, 55);

  const candidatesText = allCandidates.map((c, i) =>
    `${i + 1}. "${c.display_name}" [suggested: ${c.type}] (source: ${c.recovery_source}, from: "${c.source_doc_title}")
   Reason: ${c.evidence_excerpt}`,
  ).join("\n\n");

  let confirmed: RecoveryCandidate[] = [];
  let rejected = 0;
  let retyped = 0;

  try {
    const opusModel = getReasoningModel(ctx.config?.pipeline_settings?.models);
    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;

    const judgePrompt = `Existing entities (${existingNodes.length}):\n${entitySummary}\n\nCandidate entities to review:\n${candidatesText}`;
    const judgeSystemPrompt = ctx.config?.prompts?.extraction_validation?.system_judge ?? `You are the final judge for entity extraction validation. For each candidate:
- ADD: The entity is real and missing from the existing list. Assign the correct type from: team_member, team, client_company, client_person, repository, integration, infrastructure, cloud_resource, library, database, environment, project, decision, process, ticket, pull_request, pipeline, customer_feedback.
- REJECT: The entity is already covered (by name or alias), is not a real entity, or is an attribute/component of an existing entity.
- RETYPE: The entity exists but the suggested type is wrong. Provide the correct type.
Be precise. Only ADD genuinely missing entities.`;

    const result = await structuredGenerate({
      model: opusModel,
      system: judgeSystemPrompt,
      prompt: judgePrompt,
      schema: JudgmentSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    llmCalls++;

    if (usageData) {
      const durationMs = Date.now() - startMs;
      const cost = calculateCostUsd(getReasoningModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getReasoningModelName(ctx.config?.pipeline_settings?.models), judgePrompt, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, durationMs);
    }

    const decisionMap = new Map<string, (typeof result.decisions)[number]>();
    for (const d of result.decisions ?? []) {
      decisionMap.set(d.display_name.toLowerCase().trim(), d);
    }

    for (const candidate of allCandidates) {
      const decision = decisionMap.get(candidate.display_name.toLowerCase().trim());
      if (!decision || decision.action === "reject") {
        rejected++;
        continue;
      }

      if (decision.action === "retype") {
        retyped++;
        candidate.type = decision.final_type;
      }

      candidate.confidence = decision.confidence ?? "medium";
      candidate.recovery_source = "opus_confirmed";
      confirmed.push(candidate);
    }
  } catch (err) {
    logger.log(`Opus judge failed, adding all programmatic candidates as fallback: ${err}`);
    confirmed = programmaticCandidates;
  }

  await ctx.onProgress(`Layer 3 done: ${confirmed.length} confirmed, ${rejected} rejected`, 85);

  // ---- Insert confirmed entities into graph ----
  if (confirmed.length > 0) {
    const snapshot = await tc.input_snapshots.findOne(
      snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
    );
    const allDocs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];
    const docByTitle = new Map<string, KB2ParsedDocument>();
    const docById = new Map<string, KB2ParsedDocument>();
    for (const d of allDocs) {
      docByTitle.set(d.title.toLowerCase(), d);
      if (d.sourceId) docById.set(d.sourceId.toLowerCase(), d);
    }

    const newNodes: KB2GraphNodeType[] = confirmed.map((c) => {
      let matchedDoc = docById.get(c.source_doc_id?.toLowerCase() ?? "")
        ?? docByTitle.get(c.source_doc_title.toLowerCase());
      if (!matchedDoc) {
        const needle = normalizeForMatch(c.source_doc_title);
        for (const d of allDocs) {
          const normTitle = normalizeForMatch(d.title);
          if (normTitle.includes(needle) || needle.includes(normTitle)) { matchedDoc = d; break; }
        }
      }
      const docId = matchedDoc?.sourceId ?? c.source_doc_id ?? c.source_doc_title;
      const sourceType = matchedDoc?.provider ?? c.source_provider;
      let section_heading: string | undefined;
      if (c.evidence_excerpt && matchedDoc?.sections?.length) {
        const el = normalizeForMatch(c.evidence_excerpt);
        for (const sec of matchedDoc.sections) {
          if (normalizeForMatch(sec.content).includes(el)) { section_heading = sec.heading; break; }
        }
      }
      return {
        node_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        type: c.type as any,
        display_name: c.display_name,
        aliases: c.aliases,
        attributes: { ...c.attributes, _recovery_source: c.recovery_source },
        source_refs: [{
          source_type: sourceType as any,
          doc_id: docId,
          title: matchedDoc?.title ?? c.source_doc_title,
          excerpt: c.evidence_excerpt,
          section_heading,
        }],
        truth_status: "direct" as const,
        confidence: c.confidence as any,
      };
    });

    await tc.graph_nodes.insertMany(newNodes);

    // ---- Mini pass: run attribute layers on recovered entities ----
    await ctx.onProgress(`Processing attributes for ${newNodes.length} recovered entities...`, 90);

    const newNodeIds = new Set(newNodes.map((n) => n.node_id));
    const freshNewNodes = (await tc.graph_nodes.find({ execution_id: ctx.executionId, node_id: { $in: [...newNodeIds] } }).toArray()) as unknown as KB2GraphNodeType[];

    // Layer 0a heuristics
    const { issues: newAttrIssues, updates: newAttrUpdates } = validateAndBackfillAttributes(freshNewNodes);
    if (newAttrUpdates.size > 0) {
      const ops = Array.from(newAttrUpdates.entries()).map(([nodeId, patch]) => ({
        updateOne: {
          filter: { node_id: nodeId, execution_id: ctx.executionId },
          update: { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`attributes.${k}`, v])) },
        },
      }));
      await tc.graph_nodes.bulkWrite(ops);
    }
    attrIssues.push(...newAttrIssues);

    // Layer 0a-LLM inference
    const newLLMTargets = collectLLMInferenceTargets(freshNewNodes, newAttrIssues);
    if (newLLMTargets.length > 0) {
      const crossCheckModel = getCrossCheckModel(ctx.config?.pipeline_settings?.models);
      const systemPrompt = ctx.config?.prompts?.extraction_validation?.system_attr_inference ?? ATTRIBUTE_INFERENCE_PROMPT;

      for (let batchStart = 0; batchStart < newLLMTargets.length; batchStart += ATTR_INFERENCE_BATCH_SIZE) {
        const batch = newLLMTargets.slice(batchStart, batchStart + ATTR_INFERENCE_BATCH_SIZE);
        const entitiesText = batch.map((t, i) => {
          const missingFields: string[] = [];
          if (t.type === "project" && !VALID_PROJECT_STATUS.has(t.existing_attrs?.status)) missingFields.push("status");
          if (t.type === "decision") {
            if (!t.existing_attrs?.rationale) missingFields.push("rationale");
            if (!t.existing_attrs?.scope) missingFields.push("scope");
            if (!t.existing_attrs?.decided_by) missingFields.push("decided_by");
          }
          if (t.type === "process") missingFields.push("status");
          return `${i + 1}. "${t.display_name}" [type: ${t.type}] — missing: ${missingFields.join(", ")}\nExcerpts:\n${t.excerpts}`;
        }).join("\n\n---\n\n");

        const prompt = `Infer the missing attributes for these entities based on their source excerpts.\n\n${entitiesText}`;
        try {
          const startMs = Date.now();
          let usageData: { promptTokens: number; completionTokens: number } | null = null;
          const result = await structuredGenerate({
            model: crossCheckModel, system: systemPrompt, prompt,
            schema: AttributeInferenceSchema, logger,
            onUsage: (usage) => { usageData = usage; },
            signal: ctx.signal,
          });
          llmCalls++;

          if (usageData) {
            const durationMs = Date.now() - startMs;
            const cost = calculateCostUsd(getCrossCheckModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
            ctx.logLLMCall(stepId, getCrossCheckModelName(ctx.config?.pipeline_settings?.models), prompt, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, durationMs);
          }

          const resultMap = new Map<string, (typeof result.entities)[number]>();
          for (const e of result.entities ?? []) resultMap.set(e.display_name.toLowerCase().trim(), e);

          const llmBulkOps: any[] = [];
          for (const target of batch) {
            const inferred = resultMap.get(target.display_name.toLowerCase().trim());
            if (!inferred) continue;
            const patch: Record<string, any> = { _status_reasoning: inferred.reasoning };
            if (target.type === "project" && inferred.status) {
              const normalizedStatus = inferred.status === "planned" ? "proposed" : inferred.status;
              if (VALID_PROJECT_STATUS.has(normalizedStatus)) {
                patch.status = normalizedStatus;
                attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "status", action: "backfilled", value: normalizedStatus, reason: `LLM-inferred (recovered): ${inferred.reasoning}` });
              }
            }
            if (target.type === "decision") {
              if (inferred.rationale) { patch.rationale = inferred.rationale; attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "rationale", action: "backfilled", value: inferred.rationale, reason: `LLM-inferred (recovered): ${inferred.reasoning}` }); }
              if (inferred.scope) { patch.scope = inferred.scope; attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "scope", action: "backfilled", value: inferred.scope, reason: `LLM-inferred (recovered): ${inferred.reasoning}` }); }
              if (inferred.decided_by) { patch.decided_by = inferred.decided_by; attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "decided_by", action: "backfilled", value: inferred.decided_by, reason: `LLM-inferred (recovered): ${inferred.reasoning}` }); }
            }
            if (target.type === "process" && inferred.status && VALID_PROCESS_STATUS.has(inferred.status)) {
              patch.status = inferred.status;
              attrIssues.push({ node_id: target.node_id, display_name: target.display_name, field: "status", action: "backfilled", value: inferred.status, reason: `LLM-inferred (recovered): ${inferred.reasoning}` });
            }
            if (Object.keys(patch).length > 0) {
              llmBulkOps.push({ updateOne: { filter: { node_id: target.node_id, execution_id: ctx.executionId }, update: { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`attributes.${k}`, v])) } } });
            }
          }
          if (llmBulkOps.length > 0) await tc.graph_nodes.bulkWrite(llmBulkOps);
        } catch (err) {
          logger.log(`Attribute inference for recovered entities batch failed (non-fatal): ${err}`);
        }
      }
    }

    // Layer 0b duplicates (recovered vs all)
    const allNodesForDupes = [...existingNodes, ...freshNewNodes];
    const { pairs: newDupePairs, updates: newDupeUpdates } = tagDuplicateClusters(allNodesForDupes);
    if (newDupeUpdates.size > 0) {
      const dupeOps = Array.from(newDupeUpdates.entries())
        .filter(([nodeId]) => newNodeIds.has(nodeId))
        .map(([nodeId, dupes]) => ({
          updateOne: { filter: { node_id: nodeId, execution_id: ctx.executionId }, update: { $set: { "attributes._likely_duplicates": dupes } } },
        }));
      if (dupeOps.length > 0) await tc.graph_nodes.bulkWrite(dupeOps);
    }
    dupePairs.push(...newDupePairs.filter(([a, b]) => {
      const aIsNew = freshNewNodes.some((n) => n.display_name === a);
      const bIsNew = freshNewNodes.some((n) => n.display_name === b);
      return aIsNew || bIsNew;
    }));

    // Layer 0c decision enrichment (recovered decisions only)
    const newDecisions = freshNewNodes.filter((n) => n.type === "decision");
    if (newDecisions.length > 0) {
      const allForDecEnrich = [...existingNodes, ...freshNewNodes];
      const { issues: newDecIssues, updates: newDecUpdates } = enrichDecisionLinks(allForDecEnrich);
      const relevantDecOps = Array.from(newDecUpdates.entries())
        .filter(([nodeId]) => newNodeIds.has(nodeId))
        .map(([nodeId, patch]) => ({
          updateOne: { filter: { node_id: nodeId, execution_id: ctx.executionId }, update: { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`attributes.${k}`, v])) } },
        }));
      if (relevantDecOps.length > 0) await tc.graph_nodes.bulkWrite(relevantDecOps);
      attrIssues.push(...newDecIssues.filter((i) => newNodeIds.has(i.node_id)));
    }

    await ctx.onProgress(`Recovered entity attributes processed`, 95);
  }

  const finalCount = existingNodes.length + confirmed.length;
  await ctx.onProgress(`Validation complete: ${existingNodes.length} → ${finalCount} entities (+${confirmed.length})`, 100);

  return {
    original_count: existingNodes.length,
    programmatic_candidates: programmaticCandidates.length,
    crossllm_candidates: crossLLMCandidates.length,
    opus_confirmed: confirmed.length,
    opus_rejected: rejected,
    opus_retyped: retyped,
    final_count: finalCount,
    llm_calls: llmCalls,
    source_coverage: {
      total_documents: docs.length,
      documents_with_zero_entities: docsWithZeroEntities,
    },
    recovery_details: confirmed.map((c) => ({
      display_name: c.display_name,
      type: c.type,
      recovery_source: c.recovery_source,
      reason: c.evidence_excerpt,
    })),
    attribute_validation: {
      total_checked: existingNodes.filter((n) => n.type === "project" || n.type === "decision" || n.type === "process").length,
      backfilled: attrBackfilled + decIssues.filter((i) => i.action === "backfilled").length,
      flagged: attrFlagged,
      issues: attrIssues,
    },
    duplicate_clusters: { count: dupePairs.length, pairs: dupePairs },
    decision_enrichment: decStats,
  };
};
