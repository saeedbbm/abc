import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getCrossCheckModel, getCrossCheckModelName, getReasoningModel, getReasoningModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const VALID_PROJECT_STATUS = new Set(["active", "completed", "proposed"]);
const VALID_PROCESS_STATUS = new Set(["active", "deprecated", "proposed", "informal"]);
const VALID_DOC_LEVEL = new Set(["documented", "undocumented"]);
const RAW_JIRA_TITLE_RE = /^[A-Z]+-\d+:\s*/i;
const RAW_PR_TITLE_RE = /^[\w./-]+\s+PR\s+#\d+:\s*/i;
const LEADING_WORK_VERB_RE = /^(build|implement|add|create|design|set up|standardi[sz]e|improv(?:e|ing)|refresh)\s+/i;
const CONFLUENCE_SKIP_RE = /\b(roadmap|capacity notes|quarterly priorities|postmortem|incident)\b/i;
const HIGH_SIGNAL_DOC_TOKENS = new Set([
  "api",
  "browse",
  "ci",
  "comparison",
  "deployment",
  "donation",
  "integration",
  "locations",
  "mobile",
  "pipeline",
  "portal",
  "profile",
  "profiles",
  "response",
  "responsiveness",
  "standardization",
  "volunteer",
]);

function computeSourceCoverage(sourceTypes: Set<string>) {
  const hasConfluence = sourceTypes.has("confluence");
  let level: "documented" | "undocumented" = hasConfluence ? "documented" : "undocumented";
  const parts: string[] = [];
  if (hasConfluence) parts.push("confluence");
  if (sourceTypes.has("jira")) parts.push("jira");
  if (sourceTypes.has("github")) parts.push("github");
  if (sourceTypes.has("slack")) parts.push("slack");
  if (sourceTypes.has("customer_feedback") || sourceTypes.has("webform")) parts.push("feedback");
  return { level, reason: `Sources: ${parts.join(", ") || "none"}` };
}

const DESC_BATCH_SIZE = 12;
const DECISION_BATCH_SIZE = 8;
const STATUS_BATCH_SIZE = 12;

const DescriptionSchema = z.object({
  entities: z.array(z.object({
    display_name: z.string(),
    description: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

const DecidedBySchema = z.object({
  entities: z.array(z.object({
    display_name: z.string(),
    decided_by: z.string().optional(),
    rationale: z.string().optional(),
    scope: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: z.string(),
  })),
});

const StatusInferenceSchema = z.object({
  entities: z.array(z.object({
    display_name: z.string(),
    status: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: z.string(),
  })),
});

interface JiraTicketInfo {
  key: string;
  status: string;
  summary: string;
}

const MATCH_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "page",
  "feature",
  "project",
  "system",
  "flow",
  "work",
  "update",
]);

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stripStructuredWorkPrefix(value: string): string {
  return value
    .replace(RAW_JIRA_TITLE_RE, "")
    .replace(RAW_PR_TITLE_RE, "")
    .replace(LEADING_WORK_VERB_RE, "")
    .trim();
}

function tokenizeComparableText(value: string): string[] {
  return normalizeComparableText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !MATCH_STOPWORDS.has(token));
}

function tokenizeDocMatchText(value: string): string[] {
  return normalizeComparableText(stripStructuredWorkPrefix(value))
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !MATCH_STOPWORDS.has(token));
}

function countSharedTokens(a: string[], b: string[]): number {
  const bSet = new Set(b);
  return a.filter((token) => bSet.has(token)).length;
}

function dedupeTickets(tickets: JiraTicketInfo[]): JiraTicketInfo[] {
  const seen = new Set<string>();
  return tickets.filter((ticket) => {
    const key = `${ticket.key}:${ticket.summary}:${ticket.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildJiraStatusMap(docs: KB2ParsedDocument[]): Map<string, JiraTicketInfo[]> {
  const jiraDocs = docs.filter(d => d.provider === "jira");
  const projectTickets = new Map<string, JiraTicketInfo[]>();

  for (const doc of jiraDocs) {
    const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
    const key = String(
      metadata.key ??
      (doc as any).external_id ??
      doc.sourceId ??
      doc.title,
    ).trim();
    if (!/^[A-Z]+-\d+$/i.test(key)) continue;

    const statusMatch = doc.content?.match(/Status:\s*(\w[\w\s]*\w)/i);
    const ticketStatus = String(
      metadata.status ??
      statusMatch?.[1] ??
      "unknown",
    ).trim().toLowerCase();

    const info: JiraTicketInfo = {
      key,
      status: ticketStatus,
      summary: String(metadata.summary ?? doc.title).trim(),
    };
    const existing = projectTickets.get(key) ?? [];
    existing.push(info);
    projectTickets.set(key, existing);
  }

  return projectTickets;
}

function getComparablePhrases(node: KB2GraphNodeType): string[] {
  const phrases = new Set<string>();
  for (const rawName of [node.display_name, ...(node.aliases ?? [])]) {
    if (typeof rawName !== "string" || !rawName.trim()) continue;
    const stripped = stripStructuredWorkPrefix(rawName);
    if (!stripped) continue;
    const normalized = normalizeComparableText(stripped);
    if (normalized.length >= 4) {
      phrases.add(normalized);
    }
  }
  return [...phrases];
}

function matchesNodeToTextStrict(node: KB2GraphNodeType, text: string): boolean {
  const normalizedText = normalizeComparableText(text);
  return getComparablePhrases(node).some((phrase) =>
    phrase.length >= 6 &&
    (normalizedText.includes(phrase) || phrase.includes(normalizedText))
  );
}

function matchesNodeToDocStrict(node: KB2GraphNodeType, doc: KB2ParsedDocument): boolean {
  return matchesNodeToTextStrict(node, `${doc.title}\n${doc.content.slice(0, 4000)}`);
}

function matchesNodeToConfluenceBySignalTokens(node: KB2GraphNodeType, doc: KB2ParsedDocument): boolean {
  const bodyTokens = tokenizeDocMatchText(`${doc.title}\n${doc.content.slice(0, 4000)}`);
  if (bodyTokens.length === 0) return false;
  return [node.display_name, ...(node.aliases ?? [])].some((name) => {
    if (typeof name !== "string" || !name.trim()) return false;
    const tokens = tokenizeDocMatchText(name);
    if (tokens.length < 2) return false;
    const sharedTokens = tokens.filter((token) => bodyTokens.includes(token));
    return sharedTokens.length >= 2 && sharedTokens.some((token) => HIGH_SIGNAL_DOC_TOKENS.has(token));
  });
}

function getExplicitProviderRefKeys(node: KB2GraphNodeType, provider: string): Set<string> {
  const keys = new Set<string>();
  for (const ref of node.source_refs ?? []) {
    if (ref.source_type !== provider) continue;
    if (typeof ref.doc_id === "string" && ref.doc_id.trim()) keys.add(ref.doc_id.trim());
    if (typeof ref.title === "string" && ref.title.trim()) keys.add(ref.title.trim());
  }
  return keys;
}

function hasExplicitConfluenceSource(node: KB2GraphNodeType): boolean {
  return (node.source_refs ?? []).some((ref) => ref.source_type === "confluence");
}

function findMatchingDocsForProvider(
  node: KB2GraphNodeType,
  docs: KB2ParsedDocument[],
  provider: KB2ParsedDocument["provider"],
): KB2ParsedDocument[] {
  const providerDocs = docs.filter((doc) => doc.provider === provider);
  if (providerDocs.length === 0) return [];

  const explicitKeys = getExplicitProviderRefKeys(node, provider);
  const explicitMatches = providerDocs.filter((doc) =>
    explicitKeys.has(String(doc.sourceId ?? "").trim()) ||
    explicitKeys.has(doc.title.trim()),
  );
  if (explicitMatches.length > 0) return explicitMatches;

  if (provider === "confluence") {
    return providerDocs.filter((doc) => {
      const titleText = normalizeComparableText(doc.title);
      if (CONFLUENCE_SKIP_RE.test(titleText)) return false;
      if (/\bno formal project doc\b/i.test(doc.content)) return false;
      return matchesNodeToDocStrict(node, doc) || matchesNodeToConfluenceBySignalTokens(node, doc);
    });
  }

  return providerDocs.filter((doc) => matchesNodeToDocStrict(node, doc));
}

function hasMatchingConfluenceDocumentation(node: KB2GraphNodeType, docs: KB2ParsedDocument[]): boolean {
  if (hasExplicitConfluenceSource(node)) {
    return true;
  }
  return findMatchingDocsForProvider(node, docs, "confluence").length > 0;
}

function deriveStatusFromGitHub(node: KB2GraphNodeType, docs: KB2ParsedDocument[]): { status: string; reasoning: string } | null {
  const githubDocs = findMatchingDocsForProvider(node, docs, "github");
  if (githubDocs.length === 0) return null;

  const states = githubDocs
    .map((doc) => {
      const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
      const merged = typeof metadata.merged === "string" ? metadata.merged.trim() : "";
      const state = String(metadata.state ?? "").trim().toLowerCase();
      if (merged) return "merged";
      return state;
    })
    .filter(Boolean);

  if (states.length === 0) return null;
  if (states.every((state) => state === "merged" || state === "closed")) {
    return { status: "completed", reasoning: `All ${states.length} matching GitHub PRs are merged/closed.` };
  }
  if (states.some((state) => state === "open")) {
    return { status: "active", reasoning: `At least one matching GitHub PR is still open.` };
  }
  return null;
}

function deriveStatusFromJira(node: KB2GraphNodeType, jiraMap: Map<string, JiraTicketInfo[]>): { status: string; reasoning: string } | null {
  const refs = node.source_refs ?? [];
  const linkedTickets: JiraTicketInfo[] = [];
  const directLinkedTicket = typeof node.attributes?.linked_ticket === "string"
    ? node.attributes.linked_ticket.trim()
    : "";
  const hasDirectJiraRef =
    refs.some((ref) => ref.source_type === "jira")
    || /^[A-Z]+-\d+$/.test(directLinkedTicket);

  for (const ref of refs) {
    if (ref.source_type !== "jira") continue;
    const key = ref.doc_id || ref.title;
    const tickets = jiraMap.get(key);
    if (tickets) linkedTickets.push(...tickets);
  }

  if (linkedTickets.length === 0 && directLinkedTicket) {
    const directTickets = jiraMap.get(directLinkedTicket);
    if (directTickets) linkedTickets.push(...directTickets);
  }

  if (linkedTickets.length === 0 && hasDirectJiraRef) {
    for (const tickets of jiraMap.values()) {
      for (const ticket of tickets) {
        if (matchesNodeToTextStrict(node, ticket.summary)) {
          linkedTickets.push(ticket);
        }
      }
    }
  }

  const uniqueTickets = dedupeTickets(linkedTickets);
  if (uniqueTickets.length === 0) return null;

  const statuses = uniqueTickets.map((t) => t.status);
  const allDone = statuses.every(s => s === "done" || s === "closed" || s === "resolved");
  const anyInProgress = statuses.some(s => s === "in progress" || s === "in review" || s === "active");
  const allBacklog = statuses.every(s => s === "backlog" || s === "to do" || s === "open");

  if (allDone) return { status: "completed", reasoning: `All ${uniqueTickets.length} linked Jira tickets are done/closed` };
  if (anyInProgress) return { status: "active", reasoning: `${statuses.filter(s => s === "in progress" || s === "in review" || s === "active").length}/${uniqueTickets.length} linked tickets in progress` };
  if (allBacklog) return { status: "proposed", reasoning: `All ${uniqueTickets.length} linked Jira tickets are backlog/to-do` };
  return null;
}

function deriveStatusFromConfluence(node: KB2GraphNodeType, docs: KB2ParsedDocument[]): { status: string; reasoning: string } | null {
  const confluenceRefs = (node.source_refs ?? []).filter((ref) => ref.source_type === "confluence");
  const sourceText = confluenceRefs
    .map((ref) => `${ref.title}\n${ref.section_heading ?? ""}\n${ref.excerpt ?? ""}`)
    .join("\n");
  const directText = normalizeComparableText(sourceText);
  const nodeScopeText = normalizeComparableText([
    node.display_name,
    ...confluenceRefs.map((ref) => `${ref.title}\n${ref.section_heading ?? ""}`),
  ].join("\n"));
  const isFutureScopedNode = /\bfuture considerations\b|\blow priority for now\b/.test(nodeScopeText);
  const hasDirectProposedCue = /\bfuture considerations\b|\blow priority for now\b/.test(directText);
  const hasDirectActiveCue = /\bstatus in progress\b|\bin progress\b|\bcurrent phase\b|\bliving document\b|\bongoing\b/.test(directText);
  const hasDirectCompletedCue = /\bstatus complete\b|\bstatus completed\b|\bcompleted\b|\blaunched\b|\bis live\b|\boperational\b|\bscheduler triggers sync job every\b/.test(directText);

  if (hasDirectProposedCue) {
    return { status: "proposed", reasoning: "Direct Confluence evidence frames this work as future or proposed." };
  }
  if (hasDirectActiveCue) {
    return { status: "active", reasoning: "Direct Confluence evidence marks this as ongoing or in progress." };
  }
  if (hasDirectCompletedCue) {
    return { status: "completed", reasoning: "Direct Confluence evidence describes this as complete or operational." };
  }

  let text = directText;

  if (confluenceRefs.length > 0) {
    const docKeys = new Set<string>();
    for (const ref of confluenceRefs) {
      if (typeof ref.doc_id === "string" && ref.doc_id.trim()) docKeys.add(ref.doc_id.trim());
      if (typeof ref.title === "string" && ref.title.trim()) docKeys.add(ref.title.trim());
    }
    const matchedDocs = docs.filter((doc) =>
      doc.provider === "confluence" &&
      (docKeys.has(String(doc.sourceId ?? "").trim()) || docKeys.has(doc.title.trim())),
    );
    text = normalizeComparableText(
      `${sourceText}\n${matchedDocs.map((doc) => doc.content.slice(0, 4000)).join("\n")}`,
    );
  }

  if (!text) return null;
  const hasDocumentProposedCue = /\bfuture considerations\b|\blow priority for now\b/.test(text);
  const hasDocumentActiveCue = /\bstatus in progress\b|\bin progress\b|\bcurrent phase\b|\bliving document\b|\bongoing\b/.test(text);
  const hasDocumentCompletedCue =
    /\bstatus complete\b|\bstatus completed\b|\bcompleted\b|\blaunched\b|\bis live\b|\boperational\b|\bscheduler triggers sync job every\b/.test(text);

  if (isFutureScopedNode && hasDocumentProposedCue) {
    return { status: "proposed", reasoning: "Matching Confluence section is explicitly scoped as future work." };
  }
  if (hasDocumentActiveCue) {
    return { status: "active", reasoning: "Matching Confluence documentation marks this as ongoing or in progress." };
  }
  if (hasDocumentCompletedCue && !hasDocumentActiveCue) {
    return { status: "completed", reasoning: "Matching Confluence documentation describes this as complete or operational." };
  }
  if (hasDocumentProposedCue && !hasDocumentActiveCue && !hasDocumentCompletedCue) {
    return { status: "proposed", reasoning: "Matching Confluence documentation frames this work as future or proposed." };
  }
  return null;
}

function queueAttributePatch(
  node: KB2GraphNodeType,
  changes: Record<string, unknown>,
  bulkOps: any[],
  executionId: string,
): void {
  const nextAttributes = {
    ...((node.attributes ?? {}) as Record<string, unknown>),
    ...changes,
  };
  node.attributes = nextAttributes as KB2GraphNodeType["attributes"];
  bulkOps.push({
    updateOne: {
      filter: { node_id: node.node_id, execution_id: executionId },
      update: { $set: { attributes: nextAttributes } },
    },
  });
}

function parseProvenanceFromSourceRefs(node: KB2GraphNodeType): string {
  const roles: string[] = [];
  for (const ref of node.source_refs ?? []) {
    const attrs = ref as Record<string, unknown>;
    if (typeof attrs.author === "string") roles.push(`Author: ${attrs.author}`);
    if (typeof attrs.assignee === "string") roles.push(`Assignee: ${attrs.assignee}`);
    if (typeof attrs.reporter === "string") roles.push(`Reporter: ${attrs.reporter}`);
    if (typeof attrs.comment_author === "string") roles.push(`Comment Author: ${attrs.comment_author}`);
    if (attrs.pr_author) roles.push(`PR Author: ${attrs.pr_author}`);
    if (attrs.pr_reviewers) roles.push(`PR Reviewers: ${attrs.pr_reviewers}`);
    if (attrs.slack_speaker) roles.push(`Slack Speaker: ${attrs.slack_speaker}`);
    if (ref.source_type === "confluence" && typeof attrs.author === "string") {
      roles.push(`Confluence Author: ${attrs.author}`);
    } else if (ref.source_type === "confluence") {
      roles.push(`Confluence Author: (from ${ref.title})`);
    }
    if (ref.source_type === "jira") roles.push(`Jira (${ref.title})`);
  }
  return roles.length > 0 ? roles.join("\n") : "(no structured provenance available)";
}

function deriveLikelyImplementer(node: KB2GraphNodeType): string | null {
  const counts = new Map<string, number>();
  for (const ref of (node.source_refs ?? []) as Array<Record<string, unknown>>) {
    for (const key of ["pr_author", "source_author", "assignee", "author"]) {
      const value = ref[key];
      if (typeof value !== "string" || !value.trim()) continue;
      const normalized = value.replace(/\s*\[[^\]]+\]\s*$/g, "").trim();
      counts.set(normalized, (counts.get(normalized) ?? 0) + (key === "pr_author" ? 2 : 1));
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return ranked?.[0] ?? null;
}

export const attributeCompletionStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-attribute-completion");
  const stepId = "pass1-step-9";
  const tc = getTenantCollections(ctx.companySlug);

  const step5ExecId = await ctx.getStepExecutionId("pass1", 5);
  const step5Filter = step5ExecId ? { execution_id: step5ExecId } : { run_id: ctx.runId };
  const step5Nodes = (await tc.graph_nodes.find(step5Filter).toArray()) as unknown as KB2GraphNodeType[];

  const step8ExecId = await ctx.getStepExecutionId("pass1", 8);
  const step8Filter = step8ExecId ? { execution_id: step8ExecId } : { run_id: ctx.runId, "attributes.discovery_category": { $exists: true } };
  const step8Nodes = (await tc.graph_nodes.find(step8Filter).toArray()) as unknown as KB2GraphNodeType[];

  const allNodes = [
    ...step5Nodes,
    ...step8Nodes.filter((n) => !step5Nodes.some((s5) => s5.node_id === n.node_id)),
  ];

  const clonedNodes = allNodes.map(({ _id, ...rest }: any) => ({
    ...rest,
    execution_id: ctx.executionId,
  }));
  if (clonedNodes.length > 0) {
    await tc.graph_nodes.insertMany(clonedNodes as any[]);
  }

  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  const docs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];
  const jiraMap = buildJiraStatusMap(docs);

  await ctx.onProgress(`Processing ${allNodes.length} entities for attribute completion...`, 5);

  let descriptionsPromoted = 0;
  let descriptionsGenerated = 0;
  let statusesFilled = 0;
  let statusesCorrected = 0;
  let statusesJiraDeterministic = 0;
  let statusesConfirmed = 0;
  let docLevelsFilled = 0;
  let decidedByFixed = 0;
  let decidedByCorrected = 0;
  let decidedByConfirmed = 0;
  let rationalesFilled = 0;
  let llmCalls = 0;

  const corrections: Array<{ entity_name: string; field: string; old_value: string | null; new_value: string; reasoning: string; model_used: string }> = [];
  const crossCheckResults: Array<{ entity_name: string; primary_value: string; cross_check_value: string; agreed: boolean; adjudication?: string; adjudicated_value?: string }> = [];
  const decisionSummary: Array<{ entity_name: string; decided_by_before: string | null; decided_by_after: string | null }> = [];

  const bulkOps: any[] = [];

  // 1. Promote _description to description
  for (const node of allNodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    if (attrs._description && !attrs.description) {
      queueAttributePatch(node, { description: attrs._description }, bulkOps, ctx.executionId);
      descriptionsPromoted++;
    }
  }

  if (bulkOps.length > 0) {
    await tc.graph_nodes.bulkWrite(bulkOps);
    bulkOps.length = 0;
  }
  await ctx.onProgress(`Promoted ${descriptionsPromoted} descriptions`, 10);

  // 1b. Generate descriptions for entities missing both
  const needsDescription = allNodes.filter((n) => {
    const attrs = (n.attributes ?? {}) as Record<string, any>;
    return !attrs.description && !attrs._description;
  });

  if (needsDescription.length > 0) {
    await ctx.onProgress(`Generating descriptions for ${needsDescription.length} entities via LLM...`, 12);
    const model = getCrossCheckModel(ctx.config?.pipeline_settings?.models);

    for (let i = 0; i < needsDescription.length; i += DESC_BATCH_SIZE) {
      if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
      const batch = needsDescription.slice(i, i + DESC_BATCH_SIZE);
      const entitiesText = batch.map((n, idx) => {
        const excerpts = n.source_refs
          .map((r) => `[${r.source_type}] ${r.title}: ${r.excerpt}`)
          .join("\n")
          .slice(0, 1500);
        return `${idx + 1}. "${n.display_name}" [${n.type}]\n${excerpts || "(no source excerpts)"}`;
      }).join("\n\n---\n\n");

      const prompt = `Write a concise, factual 1-2 sentence description for each entity based on available source evidence. If there is no evidence, write a brief description based on the entity name and type.\n\n${entitiesText}`;

      try {
        const startMs = Date.now();
        let usageData: { promptTokens: number; completionTokens: number } | null = null;
        const result = await structuredGenerate({
          model,
          system: "You generate concise entity descriptions from source excerpts. Be factual and specific. Each description should be 1-2 sentences.",
          prompt,
          schema: DescriptionSchema,
          logger,
          onUsage: (u) => { usageData = u; },
          signal: ctx.signal,
        });
        llmCalls++;

        if (usageData) {
          const cost = calculateCostUsd(getCrossCheckModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
          ctx.logLLMCall(stepId, getCrossCheckModelName(ctx.config?.pipeline_settings?.models), prompt, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
        }

        const resultMap = new Map<string, (typeof result.entities)[number]>();
        for (const e of result.entities ?? []) resultMap.set(e.display_name.toLowerCase().trim(), e);

        for (const node of batch) {
          const inferred = resultMap.get(node.display_name.toLowerCase().trim());
          if (!inferred?.description) continue;
          queueAttributePatch(
            node,
            { description: inferred.description, _description_source: "llm-inferred" },
            bulkOps,
            ctx.executionId,
          );
          descriptionsGenerated++;
        }
      } catch (err) {
        logger.log(`Description generation batch failed (non-fatal): ${err}`);
      }
    }

    if (bulkOps.length > 0) {
      await tc.graph_nodes.bulkWrite(bulkOps);
      bulkOps.length = 0;
    }
    await ctx.onProgress(`Generated ${descriptionsGenerated} descriptions`, 20);
  }

  // 2. Fill missing documentation_level
  for (const node of allNodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    if (!attrs.documentation_level || !VALID_DOC_LEVEL.has(attrs.documentation_level)) {
      const sourceTypes = new Set(node.source_refs.map((r) => r.source_type));
      const { level } = computeSourceCoverage(sourceTypes);
      const enrichedLevel =
        node.type === "project" && hasMatchingConfluenceDocumentation(node, docs)
          ? "documented"
          : level;
      queueAttributePatch(node, { documentation_level: enrichedLevel }, bulkOps, ctx.executionId);
      docLevelsFilled++;
    }
  }

  if (bulkOps.length > 0) {
    await tc.graph_nodes.bulkWrite(bulkOps);
    bulkOps.length = 0;
  }
  await ctx.onProgress(`Filled ${docLevelsFilled} documentation levels`, 30);

  // 3. Status inference — deterministic-first, then LLM for ambiguous
  const projectProcessNodes = allNodes.filter((n) => n.type === "project" || n.type === "process");
  const totalProjectProcess = projectProcessNodes.length;
  const needsStatusLLM: KB2GraphNodeType[] = [];

  for (const node of projectProcessNodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    const currentStatus = attrs.status;
    const validSet = node.type === "process" ? VALID_PROCESS_STATUS : VALID_PROJECT_STATUS;
    const hasValidStatus = currentStatus && validSet.has(currentStatus);

    const confluenceResult =
      node.type === "project" && hasExplicitConfluenceSource(node)
        ? deriveStatusFromConfluence(node, docs)
        : null;
    const jiraResult = !confluenceResult ? deriveStatusFromJira(node, jiraMap) : null;
    const githubResult = !confluenceResult && !jiraResult && node.type === "project"
      ? deriveStatusFromGitHub(node, docs)
      : null;
    const deterministicStatus = confluenceResult ?? jiraResult ?? githubResult;
    const deterministicSource =
      confluenceResult
        ? "confluence-deterministic"
        : jiraResult
        ? "jira-deterministic"
        : githubResult
          ? "github-deterministic"
          : null;

    if (deterministicStatus && deterministicSource) {
      if (hasValidStatus && currentStatus === deterministicStatus.status) {
        statusesConfirmed++;
      } else {
        queueAttributePatch(
          node,
          {
            status: deterministicStatus.status,
            _status_reasoning: deterministicStatus.reasoning,
            _status_source: deterministicSource,
          },
          bulkOps,
          ctx.executionId,
        );
        if (hasValidStatus && currentStatus !== deterministicStatus.status) {
          statusesCorrected++;
          corrections.push({ entity_name: node.display_name, field: "status", old_value: currentStatus, new_value: deterministicStatus.status, reasoning: deterministicStatus.reasoning, model_used: deterministicSource });
        } else {
          statusesFilled++;
        }
        statusesJiraDeterministic++;
      }
    } else if (!hasValidStatus) {
      needsStatusLLM.push(node);
    } else {
      statusesConfirmed++;
    }
  }

  if (bulkOps.length > 0) {
    await tc.graph_nodes.bulkWrite(bulkOps);
    bulkOps.length = 0;
  }

  if (needsStatusLLM.length > 0) {
    await ctx.onProgress(`Inferring status for ${needsStatusLLM.length} ambiguous entities via LLM...`, 35);
    const statusModel = getCrossCheckModel(ctx.config?.pipeline_settings?.models);

    for (let i = 0; i < needsStatusLLM.length; i += STATUS_BATCH_SIZE) {
      if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
      const batch = needsStatusLLM.slice(i, i + STATUS_BATCH_SIZE);
      const entitiesText = batch.map((n, idx) => {
        const excerpts = n.source_refs
          .map((r) => `[${r.source_type}] ${r.title}: ${r.excerpt}`)
          .join("\n")
          .slice(0, 2000);
        return `${idx + 1}. "${n.display_name}" [${n.type}]\n${excerpts}`;
      }).join("\n\n---\n\n");

      const prompt = `Infer the status for these entities. Prioritize structured evidence (Jira tickets, PR merge status) over conversational mentions.\nFor projects: active, completed, or proposed.\nFor processes: active, deprecated, proposed, or informal.\n\n${entitiesText}`;

      try {
        const startMs = Date.now();
        let usageData: { promptTokens: number; completionTokens: number } | null = null;
        const result = await structuredGenerate({
          model: statusModel,
          system: "You infer entity statuses from source excerpts. Prioritize structured evidence over conversational mentions. Be precise and evidence-based.",
          prompt,
          schema: StatusInferenceSchema,
          logger,
          onUsage: (u) => { usageData = u; },
          signal: ctx.signal,
        });
        llmCalls++;

        if (usageData) {
          const cost = calculateCostUsd(getCrossCheckModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
          ctx.logLLMCall(stepId, getCrossCheckModelName(ctx.config?.pipeline_settings?.models), prompt, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
        }

        const resultMap = new Map<string, (typeof result.entities)[number]>();
        for (const e of result.entities ?? []) resultMap.set(e.display_name.toLowerCase().trim(), e);

        for (const node of batch) {
          const inferred = resultMap.get(node.display_name.toLowerCase().trim());
          if (!inferred?.status) continue;
          const validSet = node.type === "process" ? VALID_PROCESS_STATUS : VALID_PROJECT_STATUS;
          if (!validSet.has(inferred.status)) continue;

          queueAttributePatch(
            node,
            {
              status: inferred.status,
              _status_reasoning: inferred.reasoning,
              _status_source: "llm-inferred",
            },
            bulkOps,
            ctx.executionId,
          );
          statusesFilled++;
        }
      } catch (err) {
        logger.log(`Status inference batch failed (non-fatal): ${err}`);
      }
    }

    if (bulkOps.length > 0) {
      await tc.graph_nodes.bulkWrite(bulkOps);
      bulkOps.length = 0;
    }
  }
  await ctx.onProgress(`Status: ${statusesJiraDeterministic} Jira-deterministic, ${statusesFilled} LLM-filled, ${statusesCorrected} corrected`, 55);

  // 4. Fix decided_by, rationale, scope on ALL decisions (corrective, not fill-only)
  const decisions = allNodes.filter((n) => n.type === "decision");
  const reasoningModel = getReasoningModel(ctx.config?.pipeline_settings?.models);
  const reasoningModelName = getReasoningModelName(ctx.config?.pipeline_settings?.models);

  if (decisions.length > 0) {
    await ctx.onProgress(`Evaluating ${decisions.length} decision attributes via LLM (corrective mode)...`, 60);

    for (let i = 0; i < decisions.length; i += DECISION_BATCH_SIZE) {
      if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
      const batch = decisions.slice(i, i + DECISION_BATCH_SIZE);
      const entitiesText = batch.map((n, idx) => {
        const attrs = (n.attributes ?? {}) as Record<string, any>;
        const provenance = parseProvenanceFromSourceRefs(n);
        const excerpts = n.source_refs
          .map((r) => `[${r.source_type}] ${r.title}: ${r.excerpt}`)
          .join("\n")
          .slice(0, 2000);
        return `${idx + 1}. "${n.display_name}"
Current values: decided_by=${attrs.decided_by ?? "(null)"}, rationale=${attrs.rationale ?? "(null)"}, scope=${attrs.scope ?? "(null)"}
Provenance metadata:
${provenance}
Source excerpts:
${excerpts}`;
      }).join("\n\n---\n\n");

      const prompt = `For each decision, evaluate and correct its attributes. You may KEEP, FILL, or CORRECT existing values.

CRITICAL RULES:
- "decided_by" = the person who MADE the architectural/design decision, NOT the person who implemented it.
- The PR author is usually the IMPLEMENTER. Look for the reviewer or commenter who proposed/approved the approach.
- A Slack speaker who proposes a pattern is more likely the decision-maker than someone who just mentions it.
- If a reviewer says "let's do X" or "I think we should Y", they are the decision-maker even if someone else writes the code.
- Only fill decided_by when evidence clearly identifies the decision-maker. Say "(unknown)" if ambiguous.

IMPORTANT: If the current decided_by looks like the implementer (PR author) but a reviewer/commenter actually made the call, CORRECT it.

${entitiesText}`;

      try {
        const startMs = Date.now();
        let usageData: { promptTokens: number; completionTokens: number } | null = null;
        const result = await structuredGenerate({
          model: reasoningModel,
          system: "You evaluate and correct decision entity attributes using structured provenance evidence. You distinguish implementers from decision-makers. Correct wrong values, not just fill blanks.",
          prompt,
          schema: DecidedBySchema,
          logger,
          onUsage: (u) => { usageData = u; },
          signal: ctx.signal,
        });
        llmCalls++;

        if (usageData) {
          const cost = calculateCostUsd(reasoningModelName, usageData.promptTokens, usageData.completionTokens);
          ctx.logLLMCall(stepId, reasoningModelName, prompt, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
        }

        const resultMap = new Map<string, (typeof result.entities)[number]>();
        for (const e of result.entities ?? []) resultMap.set(e.display_name.toLowerCase().trim(), e);

        for (const node of batch) {
          const inferred = resultMap.get(node.display_name.toLowerCase().trim());
          if (!inferred) continue;
          const attrs = (node.attributes ?? {}) as Record<string, any>;
          const patch: Record<string, any> = {};
          const oldDecidedBy = attrs.decided_by ?? null;
          const likelyImplementer = deriveLikelyImplementer(node);

          if (inferred.decided_by && inferred.decided_by !== "(unknown)") {
            if (!attrs.decided_by) {
              patch["attributes.decided_by"] = inferred.decided_by;
              if (
                likelyImplementer &&
                likelyImplementer !== inferred.decided_by
              ) {
                patch["attributes._decided_by_implicit_baseline"] = likelyImplementer;
                decidedByCorrected++;
                corrections.push({
                  entity_name: node.display_name,
                  field: "decided_by",
                  old_value: likelyImplementer,
                  new_value: inferred.decided_by,
                  reasoning: `Corrected from likely implementer baseline (${likelyImplementer}) using provenance-aware attribution. ${inferred.reasoning}`,
                  model_used: reasoningModelName,
                });
              } else {
                decidedByFixed++;
              }
            } else if (attrs.decided_by !== inferred.decided_by) {
              patch["attributes.decided_by"] = inferred.decided_by;
              patch["attributes._decided_by_previous"] = attrs.decided_by;
              decidedByCorrected++;
              corrections.push({ entity_name: node.display_name, field: "decided_by", old_value: attrs.decided_by, new_value: inferred.decided_by, reasoning: inferred.reasoning, model_used: reasoningModelName });
            } else {
              decidedByConfirmed++;
            }
          }

          if (inferred.rationale && (!attrs.rationale || attrs.rationale !== inferred.rationale)) {
            patch["attributes.rationale"] = inferred.rationale;
            if (!attrs.rationale) rationalesFilled++;
          }
          if (inferred.scope && (!attrs.scope || attrs.scope !== inferred.scope)) {
            patch["attributes.scope"] = inferred.scope;
          }

          if (Object.keys(patch).length > 0) {
            patch["attributes._decided_by_reasoning"] = inferred.reasoning;
            patch["attributes._decided_by_model"] = reasoningModelName;
            bulkOps.push({
              updateOne: {
                filter: { node_id: node.node_id, execution_id: ctx.executionId },
                update: { $set: patch },
              },
            });
          }

          decisionSummary.push({ entity_name: node.display_name, decided_by_before: oldDecidedBy, decided_by_after: inferred.decided_by ?? oldDecidedBy });
        }
      } catch (err) {
        logger.log(`Decision attribute inference batch failed (non-fatal): ${err}`);
      }
    }

    if (bulkOps.length > 0) {
      await tc.graph_nodes.bulkWrite(bulkOps);
      bulkOps.length = 0;
    }
    await ctx.onProgress(`Decisions: ${decidedByFixed} filled, ${decidedByCorrected} corrected, ${decidedByConfirmed} confirmed`, 80);
  }

  // 4b. Cross-check decided_by assignments owner-by-owner so corrections are not limited to repeated names
  const decidedByCounts = new Map<string, string[]>();
  for (const ds of decisionSummary) {
    if (!ds.decided_by_after) continue;
    const list = decidedByCounts.get(ds.decided_by_after) ?? [];
    list.push(ds.entity_name);
    decidedByCounts.set(ds.decided_by_after, list);
  }

  const highImpactDecisions = [...decidedByCounts.entries()]
    .filter(([, names]) => names.length >= 1)
    .sort((a, b) => b[1].length - a[1].length);

  if (highImpactDecisions.length > 0) {
    await ctx.onProgress(`Cross-checking ${highImpactDecisions.length} high-impact decided_by owners...`, 82);
    const ccModel = getCrossCheckModel(ctx.config?.pipeline_settings?.models);
    const ccModelName = getCrossCheckModelName(ctx.config?.pipeline_settings?.models);

    for (const [owner, decisionNames] of highImpactDecisions) {
      const relevantNodes = decisions.filter(d => decisionNames.includes(d.display_name));
      const crossCheckText = relevantNodes.map((n, idx) => {
        const provenance = parseProvenanceFromSourceRefs(n);
        const excerpts = n.source_refs.map(r => `[${r.source_type}] ${r.title}: ${r.excerpt}`).join("\n").slice(0, 1500);
        return `${idx + 1}. "${n.display_name}"\nClaimed decided_by: ${owner}\nProvenance: ${provenance}\nExcerpts: ${excerpts}`;
      }).join("\n\n---\n\n");

      try {
        const startMs = Date.now();
        let usageData: { promptTokens: number; completionTokens: number } | null = null;
        const result = await structuredGenerate({
          model: ccModel,
          system: `You are cross-checking ownership attribution. For each decision attributed to "${owner}", verify if this person actually made the decision or if someone else did. Focus on evidence of who proposed/approved the approach vs who implemented it.`,
          prompt: `Verify decided_by for these decisions:\n\n${crossCheckText}`,
          schema: DecidedBySchema,
          logger,
          onUsage: (u) => { usageData = u; },
          signal: ctx.signal,
        });
        llmCalls++;

        if (usageData) {
          const cost = calculateCostUsd(ccModelName, usageData.promptTokens, usageData.completionTokens);
          ctx.logLLMCall(stepId, ccModelName, `cross-check: ${owner}`, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
        }

        const AdjudicationSchema = z.object({
          decided_by: z.string(),
          reasoning: z.string(),
          chose: z.enum(["model_a", "model_b", "new_answer"]),
        });

        for (const e of result.entities ?? []) {
          const agreed = !e.decided_by || e.decided_by === owner || e.decided_by === "(unknown)";
          const crossCheckEntry: { entity_name: string; primary_value: string; cross_check_value: string; agreed: boolean; adjudication?: string; adjudicated_value?: string } = {
            entity_name: e.display_name, primary_value: owner, cross_check_value: e.decided_by ?? "(none)", agreed,
          };

          if (!agreed && e.decided_by && e.confidence !== "low") {
            // Three-way adjudication: call reasoning model with both opinions
            const matchingNode = relevantNodes.find(n => n.display_name.toLowerCase().trim() === e.display_name.toLowerCase().trim());
            const provenance = matchingNode ? parseProvenanceFromSourceRefs(matchingNode) : "(unavailable)";

            try {
              const adjResult = await structuredGenerate({
                model: reasoningModel,
                system: "You are adjudicating a disagreement between two AI models about who made an architectural decision. Use provenance evidence to determine the correct attribution.",
                prompt: `Two models disagree on decided_by for "${e.display_name}":
Model A (primary) says: "${owner}" 
Model B (cross-check) says: "${e.decided_by}" because: ${e.reasoning}

Provenance evidence:
${provenance}

Based on the evidence, which attribution is correct? Or provide a new answer if both are wrong.`,
                schema: AdjudicationSchema,
                logger,
                signal: ctx.signal,
              });
              llmCalls++;

              const adjudicatedValue = adjResult.decided_by;
              crossCheckEntry.adjudication = adjResult.reasoning;
              crossCheckEntry.adjudicated_value = adjudicatedValue;

              if (matchingNode) {
                bulkOps.push({
                  updateOne: {
                    filter: { node_id: matchingNode.node_id, execution_id: ctx.executionId },
                    update: {
                      $set: {
                        "attributes.decided_by": adjudicatedValue,
                        "attributes._decided_by_primary": owner,
                        "attributes._decided_by_cross_check": e.decided_by,
                        "attributes._decided_by_adjudicated": adjudicatedValue,
                        "attributes._decided_by_adjudication_reasoning": adjResult.reasoning,
                      },
                    },
                  },
                });
                corrections.push({
                  entity_name: e.display_name, field: "decided_by", old_value: owner, new_value: adjudicatedValue,
                  reasoning: `Adjudicated (chose ${adjResult.chose}): ${adjResult.reasoning}`, model_used: `${reasoningModelName} (adjudication)`,
                });
              }
            } catch (err) {
              logger.log(`Adjudication failed for ${e.display_name}, keeping primary value: ${err}`);
              crossCheckEntry.adjudication = "adjudication_failed";
            }
          }

          crossCheckResults.push(crossCheckEntry);
        }
      } catch (err) {
        logger.log(`Cross-check for ${owner} failed (non-fatal): ${err}`);
      }
    }

    if (bulkOps.length > 0) {
      await tc.graph_nodes.bulkWrite(bulkOps);
      bulkOps.length = 0;
    }
    await ctx.onProgress(`Cross-check done: ${crossCheckResults.length} decisions verified`, 88);
  }

  // 5. Ensure uniform public attributes per type
  const typeAttrs = new Map<string, Set<string>>();
  for (const node of allNodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    const pubKeys = Object.keys(attrs).filter((k) => !k.startsWith("_"));
    if (!typeAttrs.has(node.type)) typeAttrs.set(node.type, new Set());
    const set = typeAttrs.get(node.type)!;
    for (const k of pubKeys) set.add(k);
  }

  let uniformFills = 0;
  for (const node of allNodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    const expectedKeys = typeAttrs.get(node.type);
    if (!expectedKeys) continue;
    const patch: Record<string, any> = {};
    for (const key of expectedKeys) {
      if (attrs[key] === undefined) {
        patch[`attributes.${key}`] = null;
        uniformFills++;
      }
    }
    if (Object.keys(patch).length > 0) {
      bulkOps.push({
        updateOne: {
          filter: { node_id: node.node_id, execution_id: ctx.executionId },
          update: { $set: patch },
        },
      });
    }
  }

  if (bulkOps.length > 0) {
    await tc.graph_nodes.bulkWrite(bulkOps);
  }
  await ctx.onProgress(`Attribute completion done`, 100);

  const descriptionsMissingAfter = allNodes.filter((n) => {
    const attrs = (n.attributes ?? {}) as Record<string, any>;
    return !attrs.description && !attrs._description;
  }).length - descriptionsGenerated;

  const adjudicatedEntries = crossCheckResults.filter((r) => r.adjudicated_value);
  const decisionsWithDecidedByAfter = decisionSummary.filter(
    (entry) => entry.decided_by_after && entry.decided_by_after !== "(unknown)",
  ).length;
  const crossCheckTargets = highImpactDecisions.reduce((sum, [, names]) => sum + names.length, 0);

  return {
    total_entities_processed: allNodes.length,
    descriptions_promoted: descriptionsPromoted,
    descriptions_generated: descriptionsGenerated,
    descriptions_missing_before: needsDescription.length,
    descriptions_missing_after: Math.max(0, descriptionsMissingAfter),
    total_project_process_nodes: totalProjectProcess,
    statuses_needed: needsStatusLLM.length + statusesCorrected,
    statuses_already_valid: statusesConfirmed,
    statuses_filled: statusesFilled,
    statuses_corrected: statusesCorrected,
    statuses_jira_deterministic: statusesJiraDeterministic,
    doc_levels_filled: docLevelsFilled,
    total_decisions: decisions.length,
    decisions_needing_fix: decisions.length,
    decided_by_fixed: decidedByFixed,
    decided_by_corrected: decidedByCorrected,
    decided_by_confirmed: decidedByConfirmed,
    decisions_with_decided_by_after: decisionsWithDecidedByAfter,
    rationales_filled: rationalesFilled,
    corrections,
    cross_check_results: crossCheckResults,
    cross_check_targets: crossCheckTargets,
    adjudication_count: adjudicatedEntries.length,
    adjudication_details: adjudicatedEntries,
    decision_summary: decisionSummary,
    uniform_fills: uniformFills,
    llm_calls: llmCalls,
  };
};
