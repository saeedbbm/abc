import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getCrossCheckModel, getCrossCheckModelName, getReasoningModel, getReasoningModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger, normalizeForMatch } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

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

const VALID_PROJECT_STATUS = new Set(["active", "completed", "proposed", "planned"]);
const VALID_DOC_LEVEL = new Set(["documented", "undocumented"]);
const VALID_DECISION_STATUS = new Set(["decided", "pending", "superseded", "reversed"]);
const VALID_PROCESS_STATUS = new Set(["active", "deprecated", "proposed", "informal"]);

function validateAndBackfillAttributes(
  nodes: KB2GraphNodeType[],
): { issues: AttributeIssue[]; updates: Map<string, Record<string, any>> } {
  const issues: AttributeIssue[] = [];
  const updates = new Map<string, Record<string, any>>();

  for (const node of nodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    const sourceTypes = new Set(node.source_refs.map((r) => r.source_type));
    const excerpts = node.source_refs.map((r) => r.excerpt.toLowerCase()).join(" ");
    const patch: Record<string, any> = {};

    if (node.type === "project") {
      if (!attrs.status || !VALID_PROJECT_STATUS.has(attrs.status)) {
        let inferred: string | undefined;
        if (excerpts.includes("done") || excerpts.includes("resolved") || excerpts.includes("completed")) {
          inferred = "completed";
        } else if (excerpts.includes("in progress") || excerpts.includes("active")) {
          inferred = "active";
        } else if (sourceTypes.has("customer_feedback") && !sourceTypes.has("jira") && !sourceTypes.has("confluence")) {
          inferred = "proposed";
        }
        if (inferred) {
          patch.status = inferred;
          issues.push({ node_id: node.node_id, display_name: node.display_name, field: "status", action: "backfilled", value: inferred, reason: `Inferred from source excerpts/types` });
        } else {
          issues.push({ node_id: node.node_id, display_name: node.display_name, field: "status", action: "flagged", reason: "Missing status — could not infer from sources" });
        }
      }

      if (!attrs.documentation_level || !VALID_DOC_LEVEL.has(attrs.documentation_level)) {
        const level = sourceTypes.has("confluence") ? "documented" : "undocumented";
        patch.documentation_level = level;
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "documentation_level", action: "backfilled", value: level, reason: sourceTypes.has("confluence") ? "Has confluence source" : "No confluence source found" });
      }
    }

    if (node.type === "decision") {
      if (!attrs.decision_status || !VALID_DECISION_STATUS.has(attrs.decision_status)) {
        patch.decision_status = "decided";
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "decision_status", action: "backfilled", value: "decided", reason: "Default — most extracted decisions are past decisions" });
      }

      if (!attrs.rationale) {
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "rationale", action: "flagged", reason: "Missing rationale — requires human or LLM review" });
      }

      if (!attrs.scope) {
        const rels = Array.isArray(attrs._relationships) ? attrs._relationships : [];
        const relTargets = rels.map((r: any) => r.target).filter(Boolean);
        if (relTargets.length > 0) {
          const inferred = relTargets[0];
          patch.scope = inferred;
          issues.push({ node_id: node.node_id, display_name: node.display_name, field: "scope", action: "backfilled", value: inferred, reason: `Inferred from relationship target: ${inferred}` });
        } else {
          issues.push({ node_id: node.node_id, display_name: node.display_name, field: "scope", action: "flagged", reason: "Missing scope — no relationships to infer from" });
        }
      }
    }

    if (node.type === "process") {
      if (!attrs.process_status || !VALID_PROCESS_STATUS.has(attrs.process_status)) {
        patch.process_status = "active";
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "process_status", action: "backfilled", value: "active", reason: "Default — most extracted processes are currently active" });
      }

      if (!attrs.documentation_level || !VALID_DOC_LEVEL.has(attrs.documentation_level)) {
        const level = sourceTypes.has("confluence") ? "documented" : "undocumented";
        patch.documentation_level = level;
        issues.push({ node_id: node.node_id, display_name: node.display_name, field: "documentation_level", action: "backfilled", value: level, reason: sourceTypes.has("confluence") ? "Has confluence source" : "No confluence source found" });
      }
    }

    if (Object.keys(patch).length > 0) {
      updates.set(node.node_id, patch);
    }
  }

  return { issues, updates };
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

export const extractionValidationStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-extraction-validation");
  const stepId = "pass1-step-4";
  const tc = getTenantCollections(ctx.companySlug);

  const snapshot = await tc.input_snapshots.findOne({ run_id: ctx.runId });
  if (!snapshot) throw new Error("No input snapshot found");
  const docs = snapshot.parsed_documents as KB2ParsedDocument[];

  const existingNodes = (await tc.graph_nodes.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  const existingNames = new Set<string>();
  for (const node of existingNodes) {
    existingNames.add(node.display_name.toLowerCase().trim());
    for (const alias of node.aliases) {
      existingNames.add(alias.toLowerCase().trim());
    }
  }

  // ---- Layer 0: Attribute validation & backfill ----
  await ctx.onProgress("Layer 0: Validating and backfilling entity attributes...", 2);
  const { issues: attrIssues, updates: attrUpdates } = validateAndBackfillAttributes(existingNodes);

  if (attrUpdates.size > 0) {
    const bulkOps = Array.from(attrUpdates.entries()).map(([nodeId, patch]) => ({
      updateOne: {
        filter: { node_id: nodeId, run_id: ctx.runId },
        update: { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`attributes.${k}`, v])) },
      },
    }));
    await tc.graph_nodes.bulkWrite(bulkOps);
  }

  const attrBackfilled = attrIssues.filter((i) => i.action === "backfilled").length;
  const attrFlagged = attrIssues.filter((i) => i.action === "flagged").length;
  await ctx.onProgress(`Layer 0 done: ${attrBackfilled} backfilled, ${attrFlagged} flagged`, 4);

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
  let llmCalls = 0;

  try {
    const crossCheckModel = getCrossCheckModel(ctx.config?.pipeline_settings?.models);
    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;

    const gapCheckPrompt = ctx.config?.prompts?.extraction_validation?.system_gap ?? "You are a quality assurance reviewer for a knowledge base entity extraction system. Your job is to find entities that the primary extraction missed. Be thorough but precise — only flag real entities, not attributes or components.";
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
        evidence_excerpt: missed.reason,
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
        backfilled: attrBackfilled,
        flagged: attrFlagged,
        issues: attrIssues,
      },
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
    const snapshot = await tc.input_snapshots.findOne({ run_id: ctx.runId });
    const allDocs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];
    const docByTitle = new Map<string, KB2ParsedDocument>();
    for (const d of allDocs) docByTitle.set(d.title.toLowerCase(), d);

    const newNodes: KB2GraphNodeType[] = confirmed.map((c) => {
      const matchedDoc = docByTitle.get(c.source_doc_title.toLowerCase());
      const docId = matchedDoc?.sourceId ?? c.source_doc_title;
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
      backfilled: attrBackfilled,
      flagged: attrFlagged,
      issues: attrIssues,
    },
  };
};
