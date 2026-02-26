import { getFastModel, getReasoningModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { EntityExtractor } from "@/src/application/workers/sync/entity-extractor";
import { embedKnowledgeDocument, searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { parseBundles, type ParsedDocument } from "@/src/application/lib/test/bundle-parser";
import { structuredGenerate, type LLMUsage } from "@/src/application/workers/test/structured-generate";
import { QdrantClient } from "@qdrant/js-client-rest";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  TEMPLATE_REGISTRY,
  getSectionInstructions,
  getIncludeExcludeRules,
  validateAndNormalizePage,
  ScoreFormatPage,
  PMTicket,
  TicketAuditItem,
  LAYER_A_CATEGORIES,
  LAYER_B_CATEGORIES,
  SINGLETON_CATEGORIES,
  KB_CATEGORY_LABELS,
  type KBCategory,
  type ScoreFormatOutputType,
  type ScoreFormatPageType,
  type TicketAuditItemType,
} from "@/src/entities/models/score-format";

const QDRANT_COLLECTION = "knowledge_embeddings";
const logger = new PrefixLogger("pidrax-pipeline");

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const PIDRAX_SYSTEM = `You are Pidrax, an AI knowledge base system that produces structured,
trustworthy knowledge from raw company data.

CORE PRINCIPLES:
1. NEVER invent information. If evidence is weak, set confidence_bucket
   to "low" and action_routing.action to "verify_task".
2. Every factual claim MUST have a source_ref with a real excerpt.
3. Use EXACTLY the section names provided. Do not add extra sections.
4. Information belongs in ONE page only. Cross-reference, don't duplicate.
5. If you have NO evidence for a section, leave it with empty bullets.
   An empty section is ALWAYS better than a hallucinated one.

ITEM TYPE RULES:
- fact: Verifiable statement from the data
- step: Step in a process or procedure
- decision: Choice that was made with rationale
- owner: Person or team responsible for something
- dependency: Something depends on something else
- risk: Potential problem or concern
- question: Open question that needs answering
- conflict: Two sources say different things about same topic
- outdated: Document content contradicted by newer evidence
- gap: Knowledge exists informally but no formal documentation
- ticket: Actionable work item

ROUTING RULES:
- none: Informational, no action needed
- verify_task: Needs human confirmation (assign severity + verifier)
- update_kb: Existing document needs correction
- create_jira_ticket: User-facing issue requiring engineering work

VERIFICATION STATUS RULES:
- verified_authoritative: Official current Confluence doc, no contradictions
- supported_multi_source: 2+ independent sources agree
- weak_support: Single informal source (Slack msg, commit comment)
- needs_verification: Inferred, conflicting, or uncertain
  MUST set action_routing.action to verify_task
- Never use verified_human (set only by humans in UI)

SEVERITY RULES (for verify_task and create_jira_ticket):
- S1: Blocks work or causes customer impact if wrong
- S2: Significant but not blocking, verify within a week
- S3: Nice to verify, low impact if wrong
- S4: Cosmetic or trivial

VERIFIER ASSIGNMENT:
- About a person's role/ownership -> that person
- About a system -> the system owner
- About a process -> the process owner
- About a client -> the account owner
- Unclear -> null

CITATION FORMAT:
Every source_ref: source_type, doc_id, title, excerpt (verbatim 10-50
words), location (section/channel/comment author).`;

// ---------------------------------------------------------------------------
// Zod schemas for intermediate pipeline outputs
// ---------------------------------------------------------------------------

const DocSummary = z.object({
  summary: z.string(),
  entities_mentioned: z.object({
    people: z.array(z.string()),
    systems: z.array(z.string()),
    clients: z.array(z.string()),
    projects: z.array(z.string()),
  }),
});

const DataMap = z.object({
  people: z.array(z.object({
    name: z.string(),
    role_hint: z.string(),
    found_in: z.array(z.string()),
  })),
  systems: z.array(z.object({
    name: z.string(),
    type: z.enum(["api", "frontend", "worker", "database", "queue", "cache", "external", "other"]),
    found_in: z.array(z.string()),
  })),
  clients: z.array(z.object({
    name: z.string(),
    found_in: z.array(z.string()),
  })),
  projects: z.array(z.object({
    name: z.string(),
    status: z.enum(["past", "ongoing", "proposed"]),
    has_confluence_doc: z.boolean(),
    has_jira_tickets: z.boolean(),
    jira_status_hint: z.string().optional(),
    found_in: z.array(z.string()),
  })),
  processes: z.array(z.object({
    name: z.string(),
    found_in: z.array(z.string()),
  })),
  key_decisions: z.array(z.object({
    summary: z.string(),
    found_in: z.array(z.string()),
  })),
  integrations: z.array(z.object({
    name: z.string(),
    found_in: z.array(z.string()),
  })),
  conflicts: z.array(z.object({
    description: z.string(),
    source_a: z.string(),
    source_b: z.string(),
  })),
  outdated_docs: z.array(z.object({
    doc_title: z.string(),
    reason: z.string(),
    contradicting_source: z.string(),
  })),
  gaps: z.array(z.object({
    topic: z.string(),
    evidence_exists_in: z.string(),
    missing_from: z.string(),
  })),
  active_jira_tickets: z.array(z.object({
    key: z.string(),
    title: z.string(),
    status: z.string(),
    project_name: z.string().optional(),
  })),
});
type DataMapType = z.infer<typeof DataMap>;

const PagePlanItem = z.object({
  page_id: z.string(),
  template: z.string(),
  title: z.string(),
  primary_source_ids: z.array(z.string()),
  search_queries: z.array(z.string()),
});
type PagePlanItemType = z.infer<typeof PagePlanItem>;

const PagePlan = z.object({
  pages: z.array(PagePlanItem),
});

const ValidationResult = z.object({
  duplicate_content: z.array(z.object({
    page_a: z.string(),
    page_b: z.string(),
    overlapping_topic: z.string(),
  })),
  category_errors: z.array(z.object({
    page_id: z.string(),
    current_category: z.string(),
    suggested_category: z.string(),
    reason: z.string(),
  })),
  missing_cross_refs: z.array(z.object({
    from_page: z.string(),
    should_reference: z.string(),
    reason: z.string(),
  })),
});
type ValidationResultType = z.infer<typeof ValidationResult>;

const MergedProjectHowto = z.object({
  project_page: ScoreFormatPage,
  howto_page: ScoreFormatPage,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 3) + "...";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function summarizeKB(pages: ScoreFormatPageType[]): string {
  return pages.map(p => {
    const items = (p.sections || []).flatMap(s => (s.bullets || []).map(b => b.item_text).filter(Boolean));
    return `[${p.category}] ${p.title}: ${items.slice(0, 5).join("; ")}`;
  }).join("\n");
}

// ---------------------------------------------------------------------------
// Metrics, Checkpoint & Cost Helpers
// ---------------------------------------------------------------------------

export type StepMetric = {
  step: number;
  name: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  models: string[];
  itemsProcessed?: number;
};

export type PidraxRunMetrics = {
  runId: string;
  projectId: string;
  steps: StepMetric[];
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  totalPages: number;
  totalItems: number;
};

type UsageAccumulator = {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  track: (usage: LLMUsage) => void;
};

function createUsageAccumulator(): UsageAccumulator {
  const acc: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    track: (usage: LLMUsage) => {
      acc.inputTokens += usage.promptTokens;
      acc.outputTokens += usage.completionTokens;
      acc.calls++;
    },
  };
  return acc;
}

// Anthropic pricing (USD per 1M tokens)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
};

function computeStepCost(inputTokens: number, outputTokens: number, modelKey: string): number {
  const pricing = MODEL_PRICING[modelKey] || MODEL_PRICING.sonnet;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

function buildStepMetric(
  step: number, name: string, startMs: number, acc: UsageAccumulator,
  modelKey: string, itemsProcessed?: number,
): StepMetric {
  const now = Date.now();
  return {
    step,
    name,
    startedAt: new Date(startMs).toISOString(),
    completedAt: new Date(now).toISOString(),
    durationMs: now - startMs,
    llmCalls: acc.calls,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    estimatedCostUsd: computeStepCost(acc.inputTokens, acc.outputTokens, modelKey),
    models: [modelKey],
    itemsProcessed,
  };
}

const CHECKPOINT_COLLECTION = "new_test_pidrax_checkpoints";

async function saveCheckpoint(projectId: string, runId: string, data: Record<string, unknown>): Promise<void> {
  await db.collection(CHECKPOINT_COLLECTION).updateOne(
    { projectId, runId },
    {
      $set: { ...data, updatedAt: new Date().toISOString() },
      $setOnInsert: { projectId, runId, createdAt: new Date().toISOString() },
    },
    { upsert: true },
  );
}

async function loadCheckpoint(projectId: string, runId: string) {
  return db.collection(CHECKPOINT_COLLECTION).findOne({ projectId, runId });
}

export async function getLatestIncompleteCheckpoint(projectId: string) {
  return db.collection(CHECKPOINT_COLLECTION).findOne(
    { projectId, completedStep: { $gte: 0, $lt: 8 } },
    { sort: { updatedAt: -1 } },
  );
}

async function reloadParsedDocs(projectId: string): Promise<ParsedDocument[]> {
  const docs = await db.collection("knowledge_documents")
    .find({ projectId })
    .toArray();
  return docs.map(d => ({
    provider: d.provider,
    sourceType: d.sourceType,
    sourceId: d.sourceId,
    title: d.title,
    content: d.content,
    metadata: d.metadata || {},
    entityRefs: d.entityRefs || [],
    contentHash: d.metadata?.contentHash || "",
  } as ParsedDocument));
}

// ---------------------------------------------------------------------------
// RAG Context Retrieval
// ---------------------------------------------------------------------------

async function retrieveContext(
  projectId: string,
  query: string,
  options: { maxChars?: number; minScore?: number; topK?: number } = {},
): Promise<string> {
  const { maxChars = 40000, minScore = 0.4, topK = 30 } = options;

  const results = await searchKnowledgeEmbeddings(projectId, query, { limit: topK }, logger);
  let filtered = results.filter(r => r.score >= minScore);

  const providerBuckets = new Map<string, typeof results>();
  for (const r of results) {
    if (!providerBuckets.has(r.provider)) providerBuckets.set(r.provider, []);
    providerBuckets.get(r.provider)!.push(r);
  }
  for (const [, provResults] of providerBuckets) {
    const inFiltered = filtered.filter(r => r.provider === provResults[0].provider).length;
    if (inFiltered < 2) {
      const toAdd = provResults.filter(r => !filtered.includes(r)).slice(0, 2 - inFiltered);
      filtered.push(...toAdd);
    }
  }

  filtered.sort((a, b) => b.score - a.score);

  const lines: string[] = [];
  let totalChars = 0;
  for (const r of filtered) {
    const line = `[${r.provider}] "${r.title}" (score:${r.score.toFixed(2)}):\n${r.content}`;
    if (totalChars + line.length > maxChars) break;
    lines.push(line);
    totalChars += line.length;
  }
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

async function ensureProject(pid: string) {
  const existing = await db.collection("projects").findOne({ _id: pid } as any);
  if (!existing) {
    await db.collection("projects").insertOne({
      _id: pid, projectId: pid, name: pid, companySlug: pid,
      secret: nanoid(), createdAt: new Date().toISOString(),
    } as any);
  }
}

async function clearSourceData(pid: string) {
  await Promise.all([
    db.collection("knowledge_documents").deleteMany({ projectId: pid }),
    db.collection("knowledge_entities").deleteMany({ projectId: pid }),
  ]);
  try {
    const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || "http://localhost:6333", checkCompatibility: false });
    await qdrant.delete(QDRANT_COLLECTION, {
      filter: { must: [{ key: "projectId", match: { value: pid } }] },
    });
  } catch (err) {
    logger.log(`Qdrant cleanup warning: ${err}`);
  }
}

async function storeDocuments(
  bundles: ReturnType<typeof parseBundles>,
  pid: string,
  docsRepo: MongoDBKnowledgeDocumentsRepository,
) {
  const allParsed: ParsedDocument[] = [
    ...bundles.confluence, ...bundles.jira, ...bundles.slack,
    ...bundles.github, ...bundles.customerFeedback,
  ];
  const stored = [];
  for (const parsed of allParsed) {
    const doc = await docsRepo.create({
      projectId: pid,
      provider: parsed.provider as any,
      sourceType: parsed.sourceType as any,
      sourceId: parsed.sourceId,
      title: parsed.title,
      content: parsed.content,
      metadata: { ...parsed.metadata, contentHash: parsed.contentHash },
      entityRefs: parsed.entityRefs,
      syncedAt: new Date().toISOString(),
    });
    stored.push(doc);
  }
  return { stored, allParsed };
}

// ---------------------------------------------------------------------------
// Step 0: Parse + Embed
// ---------------------------------------------------------------------------

async function step0_ParseAndEmbed(
  inputs: { confluence: string; jira: string; slack: string; github: string; customerFeedback: string },
  projectId: string,
  onProgress?: (detail: string, percent: number) => void,
): Promise<ParsedDocument[]> {
  const docsRepo = new MongoDBKnowledgeDocumentsRepository();
  const entitiesRepo = new MongoDBKnowledgeEntitiesRepository();

  onProgress?.("[Step 0] Setting up project...", 2);
  await ensureProject(projectId);

  onProgress?.("[Step 0] Clearing previous data...", 4);
  await clearSourceData(projectId);
  await db.collection("new_test_pidrax_results").deleteMany({ projectId });
  await db.collection(CHECKPOINT_COLLECTION).deleteMany({ projectId });

  onProgress?.("[Step 0] Parsing input bundles...", 6);
  const bundles = parseBundles(inputs.confluence, inputs.jira, inputs.slack, inputs.github, inputs.customerFeedback);
  logger.log(`Parsed ${bundles.totalDocuments} documents`);

  onProgress?.(`[Step 0] Storing ${bundles.totalDocuments} documents...`, 8);
  const { stored, allParsed } = await storeDocuments(bundles, projectId, docsRepo);

  onProgress?.(`[Step 0] Embedding ${stored.length} documents...`, 10);
  let embedded = 0;
  for (const doc of stored) {
    try {
      await embedKnowledgeDocument(doc, logger);
      embedded++;
      if (embedded % 5 === 0) {
        onProgress?.(`[Step 0] Embedded ${embedded}/${stored.length}...`, 10 + Math.round((embedded / stored.length) * 8));
      }
    } catch (err) {
      logger.log(`Embedding failed for ${doc.title}: ${err}`);
    }
  }
  onProgress?.(`[Step 0] Embedded ${embedded}/${stored.length}`, 18);

  onProgress?.("[Step 0] Extracting entities...", 19);
  const extractor = new EntityExtractor(docsRepo, entitiesRepo, {}, logger);
  const entityResult = await extractor.processProject(projectId);
  logger.log(`Extracted ${entityResult.processed} entities`);
  onProgress?.(`[Step 0] Complete — ${bundles.totalDocuments} docs, ${embedded} embedded, ${entityResult.processed} entities`, 20);

  return allParsed;
}

// ---------------------------------------------------------------------------
// Step 1: Summarize Documents (Sonnet, N parallel)
// ---------------------------------------------------------------------------

const DOC_CHUNK_THRESHOLD = 12000;
const DOC_CHUNK_SIZE = 10000;
const DOC_CHUNK_OVERLAP = 500;

function smartChunkDoc(content: string): string[] {
  if (content.length <= DOC_CHUNK_THRESHOLD) return [content];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    chunks.push(content.slice(offset, offset + DOC_CHUNK_SIZE));
    offset += DOC_CHUNK_SIZE - DOC_CHUNK_OVERLAP;
  }
  return chunks;
}

async function summarizeOneDoc(
  doc: ParsedDocument,
  onUsage?: (usage: LLMUsage) => void,
): Promise<z.infer<typeof DocSummary>> {
  const chunks = smartChunkDoc(doc.content);

  if (chunks.length === 1) {
    return structuredGenerate({
      model: getFastModel(),
      schema: DocSummary,
      system: "You are a document summarizer. Return concise structured summaries.",
      prompt: `Summarize this document in 3-5 sentences. Focus on: main topic,
key facts, any decisions or action items.

Then list entities mentioned: people names, system/service names,
client/customer names, and project/initiative names.

DOCUMENT:
Provider: ${doc.provider}
Title: ${doc.title}
Content:
${doc.content}`,
      logger,
      onUsage,
    });
  }

  const chunkSummaries: string[] = [];
  for (let c = 0; c < chunks.length; c++) {
    const partial = await structuredGenerate({
      model: getFastModel(),
      schema: DocSummary,
      system: "You are a document summarizer. Return concise structured summaries.",
      prompt: `Summarize this CHUNK (${c + 1}/${chunks.length}) of a larger document.
Focus on: main topic, key facts, any decisions or action items.
List entities mentioned: people, systems, clients, projects.

DOCUMENT: "${doc.title}" (${doc.provider}) — chunk ${c + 1}/${chunks.length}
Content:
${chunks[c]}`,
      logger,
      onUsage,
    });
    chunkSummaries.push(partial.summary);
  }

  return structuredGenerate({
    model: getFastModel(),
    schema: DocSummary,
    system: "You are a document summarizer. Merge these chunk summaries into one.",
    prompt: `Merge these ${chunkSummaries.length} chunk summaries of document "${doc.title}" (${doc.provider}) into a single 3-5 sentence summary. Combine all entity lists (deduplicate).

CHUNK SUMMARIES:
${chunkSummaries.map((s, i) => `[Chunk ${i + 1}]: ${s}`).join("\n")}`,
    logger,
    onUsage,
  });
}

async function step1_Summarize(
  allParsed: ParsedDocument[],
  onProgress?: (detail: string, percent: number) => void,
  onUsage?: (usage: LLMUsage) => void,
): Promise<Map<string, z.infer<typeof DocSummary>>> {
  onProgress?.("[Step 1] Summarizing documents...", 21);
  const summaries = new Map<string, z.infer<typeof DocSummary>>();
  const BATCH_SIZE = 5;

  for (let i = 0; i < allParsed.length; i += BATCH_SIZE) {
    const batch = allParsed.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(doc =>
        summarizeOneDoc(doc, onUsage).then(result => ({ sourceId: doc.sourceId, result })),
      ),
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        summaries.set(r.value.sourceId, r.value.result);
      }
    }

    const done = Math.min(i + BATCH_SIZE, allParsed.length);
    onProgress?.(`[Step 1] Summarized ${done}/${allParsed.length} docs...`, 21 + Math.round((done / allParsed.length) * 9));
  }

  logger.log(`Step 1: ${summaries.size}/${allParsed.length} summaries`);
  onProgress?.(`[Step 1] Complete — ${summaries.size} summaries`, 30);
  return summaries;
}

// ---------------------------------------------------------------------------
// Step 2: Global Triage (Opus, 1 call)
// ---------------------------------------------------------------------------

const TRIAGE_PROMPT_INSTRUCTIONS = `Identify ALL entities and relationships:

1. PEOPLE: Every person mentioned. Include likely role if evident.
2. SYSTEMS: Every service, app, database, queue. Classify type.
3. CLIENTS: Every client or customer by name.
4. PROJECTS: Every project or initiative. Classify:
   - "past" if completed (closed Jira, past tense)
   - "ongoing" if active (open Jira, recent Slack)
   - "proposed" if only discussed
   - has_confluence_doc: true ONLY if a Confluence page documents it
   - has_jira_tickets: true if Jira tickets reference it
5. PROCESSES: Recurring workflows (NOT one-time projects).
6. KEY DECISIONS: Significant arch/process decisions with rationale.
7. INTEGRATIONS: External third-party services.
8. CONFLICTS: Two sources say different things about same topic.
9. OUTDATED DOCS: Confluence content contradicted by newer evidence.
10. GAPS: Knowledge exists informally but no Confluence doc.
11. ACTIVE JIRA TICKETS: All tickets that are open/in-progress.

RULES:
- A PROJECT has start, deliverables, end. A PROCESS is recurring.
- Each entity appears EXACTLY ONCE in its list.
- Base on EVIDENCE, not guesses.`;

const TRIAGE_MAX_INPUT_CHARS = 200000;

function mergeDataMaps(maps: DataMapType[]): DataMapType {
  const dedup = <T extends { name?: string; summary?: string; topic?: string; doc_title?: string; key?: string; description?: string }>(arr: T[], keyFn: (x: T) => string): T[] => {
    const seen = new Set<string>();
    return arr.filter(x => { const k = keyFn(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  return {
    people: dedup(maps.flatMap(m => m.people), x => x.name),
    systems: dedup(maps.flatMap(m => m.systems), x => x.name),
    clients: dedup(maps.flatMap(m => m.clients), x => x.name),
    projects: dedup(maps.flatMap(m => m.projects), x => x.name),
    processes: dedup(maps.flatMap(m => m.processes), x => x.name),
    key_decisions: dedup(maps.flatMap(m => m.key_decisions), x => x.summary),
    integrations: dedup(maps.flatMap(m => m.integrations), x => x.name),
    conflicts: maps.flatMap(m => m.conflicts),
    outdated_docs: dedup(maps.flatMap(m => m.outdated_docs), x => x.doc_title),
    gaps: dedup(maps.flatMap(m => m.gaps), x => x.topic),
    active_jira_tickets: dedup(maps.flatMap(m => m.active_jira_tickets), x => x.key),
  };
}

function buildSummaryLines(
  allParsed: ParsedDocument[],
  summaries: Map<string, z.infer<typeof DocSummary>>,
): string[] {
  const providers = ["confluence", "jira", "slack", "github", "customer_feedback"] as const;
  const grouped: Record<string, string[]> = {};
  for (const p of providers) grouped[p] = [];
  for (const doc of allParsed) {
    const summary = summaries.get(doc.sourceId);
    const line = summary
      ? `- "${doc.title}" [${doc.sourceId}]: ${summary.summary}`
      : `- "${doc.title}" [${doc.sourceId}]: ${truncate(doc.content, 200)}`;
    grouped[doc.provider]?.push(line);
  }
  return providers
    .filter(p => grouped[p].length > 0)
    .map(p => `=== ${p.toUpperCase()} (${grouped[p].length} docs) ===\n${grouped[p].join("\n")}`);
}

async function step2_GlobalTriage(
  allParsed: ParsedDocument[],
  summaries: Map<string, z.infer<typeof DocSummary>>,
  onProgress?: (detail: string, percent: number) => void,
  onUsage?: (usage: LLMUsage) => void,
): Promise<DataMapType> {
  onProgress?.("[Step 2] Running global triage...", 31);

  const summaryLines = buildSummaryLines(allParsed, summaries);
  const fullText = summaryLines.join("\n\n");

  if (fullText.length <= TRIAGE_MAX_INPUT_CHARS) {
    const dataMap = await structuredGenerate({
      model: getReasoningModel(),
      schema: DataMap,
      system: `${PIDRAX_SYSTEM}\n\nYou are analyzing a company's full data corpus to create a structured inventory.`,
      prompt: `You have document summaries from 5 sources.\n\n${TRIAGE_PROMPT_INSTRUCTIONS}\n\nDOCUMENT SUMMARIES:\n${fullText}`,
      maxOutputTokens: 16384,
      logger,
      onUsage,
    });
    logger.log(`Step 2: ${dataMap.people.length} people, ${dataMap.systems.length} systems, ${dataMap.projects.length} projects, ${dataMap.conflicts.length} conflicts, ${dataMap.gaps.length} gaps`);
    onProgress?.(`[Step 2] Triage complete — ${dataMap.people.length} people, ${dataMap.systems.length} systems, ${dataMap.projects.length} projects`, 38);
    return dataMap;
  }

  logger.log(`Step 2: Input too large (${fullText.length} chars), splitting into chunks`);
  const chunks: string[] = [];
  let currentChunk = "";
  for (const line of summaryLines) {
    for (const docLine of line.split("\n")) {
      if (currentChunk.length + docLine.length + 1 > TRIAGE_MAX_INPUT_CHARS) {
        chunks.push(currentChunk);
        currentChunk = "";
      }
      currentChunk += docLine + "\n";
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk);

  onProgress?.(`[Step 2] Large corpus — triaging in ${chunks.length} batches...`, 32);
  const partialMaps: DataMapType[] = [];

  for (let c = 0; c < chunks.length; c++) {
    onProgress?.(`[Step 2] Triage batch ${c + 1}/${chunks.length}...`, 31 + Math.round(((c + 1) / chunks.length) * 6));
    const partial = await structuredGenerate({
      model: getReasoningModel(),
      schema: DataMap,
      system: `${PIDRAX_SYSTEM}\n\nYou are analyzing BATCH ${c + 1}/${chunks.length} of a company's data corpus. Extract all entities you find in this batch.`,
      prompt: `${TRIAGE_PROMPT_INSTRUCTIONS}\n\nDOCUMENT SUMMARIES (batch ${c + 1}/${chunks.length}):\n${chunks[c]}`,
      maxOutputTokens: 16384,
      logger,
      onUsage,
    });
    partialMaps.push(partial);
  }

  const dataMap = mergeDataMaps(partialMaps);
  logger.log(`Step 2: merged ${chunks.length} batches → ${dataMap.people.length} people, ${dataMap.systems.length} systems, ${dataMap.projects.length} projects`);
  onProgress?.(`[Step 2] Triage complete — ${dataMap.people.length} people, ${dataMap.systems.length} systems, ${dataMap.projects.length} projects`, 38);
  return dataMap;
}

// ---------------------------------------------------------------------------
// Step 3: Page Plan (Opus, 1 call)
// ---------------------------------------------------------------------------

async function step3_PagePlan(
  dataMap: DataMapType,
  onProgress?: (detail: string, percent: number) => void,
  onUsage?: (usage: LLMUsage) => void,
): Promise<PagePlanItemType[]> {
  onProgress?.("[Step 3] Creating page plan...", 39);

  // Serialize DataMap section-by-section with per-section budgets
  // so we never truncate mid-JSON object
  const DATA_MAP_BUDGET = 100000;
  const sections = [
    { key: "people", data: dataMap.people },
    { key: "systems", data: dataMap.systems },
    { key: "clients", data: dataMap.clients },
    { key: "projects", data: dataMap.projects },
    { key: "processes", data: dataMap.processes },
    { key: "key_decisions", data: dataMap.key_decisions },
    { key: "integrations", data: dataMap.integrations },
    { key: "conflicts", data: dataMap.conflicts },
    { key: "outdated_docs", data: dataMap.outdated_docs },
    { key: "gaps", data: dataMap.gaps },
    { key: "active_jira_tickets", data: dataMap.active_jira_tickets },
  ] as const;
  const sectionBudget = Math.floor(DATA_MAP_BUDGET / sections.length);
  const dataMapParts: string[] = [];
  for (const sec of sections) {
    const json = JSON.stringify(sec.data, null, 1);
    if (json.length <= sectionBudget) {
      dataMapParts.push(`"${sec.key}": ${json}`);
    } else {
      const items = sec.data as any[];
      const kept: any[] = [];
      let size = 0;
      for (const item of items) {
        const itemJson = JSON.stringify(item);
        if (size + itemJson.length > sectionBudget - 100) break;
        kept.push(item);
        size += itemJson.length;
      }
      dataMapParts.push(`"${sec.key}": ${JSON.stringify(kept, null, 1)} /* ${items.length - kept.length} more omitted */`);
    }
  }
  const dataMapJson = `{\n${dataMapParts.join(",\n")}\n}`;

  const plan = await structuredGenerate({
    model: getReasoningModel(),
    schema: PagePlan,
    system: `${PIDRAX_SYSTEM}\n\nPlan ALL pages for a company knowledge base.`,
    prompt: `Plan ALL pages for a company knowledge base.

TEMPLATES (singleton = exactly 1, N = one per entity):
- company_overview (singleton): company facts, products, revenue
- glossary (singleton): internal terms, acronyms
- org_map (singleton): team structure, reporting
- person (N): one per person found
- client (N): one per significant client
- system_architecture (singleton): high-level system map
- service (N): one per service/repo with enough detail
- integration (N): one per external service
- setup_onboarding (singleton): dev environment setup
- environments_cicd (singleton): envs, CI/CD, deployment
- observability (singleton): dashboards, alerts, SLOs
- process (N): one per recurring workflow
- decision_record (N): one per key architectural decision
- past_documented (N): completed projects WITH Confluence docs
- past_undocumented (N): completed projects WITHOUT Confluence docs
- ongoing_documented (N): active projects WITH Confluence docs
- ongoing_undocumented (N): active projects WITHOUT Confluence docs
- ticket (N): one per active/recent Jira ticket

SKIP proposed_project and howto_implementation (created later from tickets).
SKIP glossary if fewer than 5 terms found.
SKIP observability if no monitoring info exists.
SKIP decision_record if fewer than 2 decisions found.

Create page even if data is sparse. Do NOT create duplicates.
Use deterministic page_id format: {template}-{slug} e.g. "person-sarah-chen"

For each page, provide 2-4 search_queries that would help retrieve relevant data
from the vector store. Each query should target different aspects.

DATA MAP:
${dataMapJson}`,
    maxOutputTokens: 16384,
    logger,
    onUsage,
  });

  logger.log(`Step 3: ${plan.pages.length} pages planned`);
  onProgress?.(`[Step 3] Plan complete — ${plan.pages.length} pages`, 42);
  return plan.pages;
}

// ---------------------------------------------------------------------------
// Step 4: Generate Pages (Sonnet, N calls)
// ---------------------------------------------------------------------------

async function step4_GeneratePages(
  projectId: string,
  pagePlan: PagePlanItemType[],
  dataMap: DataMapType,
  onProgress?: (detail: string, percent: number) => void,
  onPage?: (page: ScoreFormatPageType) => void,
  options?: {
    skipPageIds?: Set<string>;
    existingPages?: ScoreFormatPageType[];
    onPageCheckpoint?: (pages: ScoreFormatPageType[]) => Promise<void>;
    onUsage?: (usage: LLMUsage) => void;
  },
): Promise<ScoreFormatPageType[]> {
  onProgress?.(`[Step 4] Generating ${pagePlan.length} pages...`, 43);

  const allPageTitles = truncate(pagePlan.map(p => `${p.template}: "${p.title}"`).join(", "), 8000);
  const dataMapSummary = truncate(JSON.stringify({
    people: dataMap.people.map(p => p.name),
    systems: dataMap.systems.map(s => s.name),
    clients: dataMap.clients.map(c => c.name),
    projects: dataMap.projects.map(p => `${p.name} (${p.status})`),
    processes: dataMap.processes.map(p => p.name),
    integrations: dataMap.integrations.map(i => i.name),
  }), 4000);

  const skipPageIds = options?.skipPageIds || new Set<string>();
  const pages: ScoreFormatPageType[] = [...(options?.existingPages || [])];

  for (let i = 0; i < pagePlan.length; i++) {
    const item = pagePlan[i];
    const pct = 43 + Math.round(((i + 1) / pagePlan.length) * 27);

    if (skipPageIds.has(item.page_id)) {
      onProgress?.(`[Step 4 ${i + 1}/${pagePlan.length}] ${item.title} (cached)`, pct);
      continue;
    }

    onProgress?.(`[Step 4 ${i + 1}/${pagePlan.length}] ${item.title}...`, pct);

    const templateKey = item.template;
    if (!TEMPLATE_REGISTRY[templateKey]) {
      logger.log(`Step 4: Unknown template "${templateKey}", skipping`);
      continue;
    }

    const sectionInstr = getSectionInstructions(templateKey);
    const { include, exclude } = getIncludeExcludeRules(templateKey);

    const queries = [item.title, ...(item.search_queries || [])];
    let ragContext = "";
    for (const q of queries.slice(0, 4)) {
      const ctx = await retrieveContext(projectId, q, { maxChars: 12000 });
      if (ctx) ragContext += ctx + "\n\n";
      if (ragContext.length > 40000) break;
    }
    ragContext = truncate(ragContext, 40000);

    try {
      const rawPage = await structuredGenerate({
        model: getFastModel(),
        schema: ScoreFormatPage,
        system: `${PIDRAX_SYSTEM}

Generate a KB page using EXACTLY these sections:
${sectionInstr}

RULES FOR THIS TEMPLATE (${templateKey}):
INCLUDE: ${include}
EXCLUDE: ${exclude}

If you have NO evidence for a section, return it with empty bullets.`,
        prompt: `This is page "${item.title}" (page_id: "${item.page_id}", template: ${templateKey}).

Other pages in this KB cover: ${allPageTitles}
Do NOT duplicate information that belongs in other pages.

DATA (retrieved via RAG):
${ragContext}

DATA MAP SUMMARY (for cross-reference):
${dataMapSummary}`,
        logger,
        onUsage: options?.onUsage,
      });

      rawPage.page_id = item.page_id;
      rawPage.category = templateKey as any;
      rawPage.title = item.title;
      rawPage.source_doc_ids = item.primary_source_ids || [];

      const { page, violations } = validateAndNormalizePage(rawPage, templateKey);
      if (violations.length > 0) {
        logger.log(`Step 4 "${item.title}" violations: ${violations.join(", ")}`);
      }
      pages.push(page);
      onPage?.(page);
      await options?.onPageCheckpoint?.(pages);

      const items = page.sections.reduce((s, sec) => s + (sec.bullets?.length || 0), 0);
      logger.log(`Step 4 page "${item.title}": ${items} items`);
      onProgress?.(`[Step 4 ${i + 1}/${pagePlan.length}] ${item.title} done — ${items} items`, pct);
    } catch (err) {
      logger.log(`Step 4 page "${item.title}" FAILED: ${err}`);
    }
  }

  onProgress?.(`[Step 4] Complete — ${pages.length} pages generated`, 70);
  return pages;
}

// ---------------------------------------------------------------------------
// Step 5: Ticket Audit (Opus, 1 call)
// ---------------------------------------------------------------------------

const AUDIT_BATCH_SIZE = 30;

async function step5_TicketAudit(
  projectId: string,
  dataMap: DataMapType,
  kbPages: ScoreFormatPageType[],
  onProgress?: (detail: string, percent: number) => void,
  onUsage?: (usage: LLMUsage) => void,
): Promise<TicketAuditItemType[]> {
  if (dataMap.active_jira_tickets.length === 0) {
    onProgress?.("[Step 5] No active Jira tickets — skipping audit.", 73);
    return [];
  }

  const allTickets = dataMap.active_jira_tickets;
  const kbSummary = truncate(summarizeKB(kbPages), 5000);
  const totalBatches = Math.ceil(allTickets.length / AUDIT_BATCH_SIZE);
  const allAuditItems: TicketAuditItemType[] = [];

  onProgress?.(`[Step 5] Auditing ${allTickets.length} Jira tickets (${totalBatches} batch${totalBatches > 1 ? "es" : ""})...`, 71);

  for (let b = 0; b < totalBatches; b++) {
    const batch = allTickets.slice(b * AUDIT_BATCH_SIZE, (b + 1) * AUDIT_BATCH_SIZE);
    const ticketKeys = batch.map(t => t.key).join(", ");
    const ragContext = await retrieveContext(projectId, `Jira tickets status ${ticketKeys}`, { maxChars: 30000 });

    if (totalBatches > 1) {
      onProgress?.(`[Step 5] Audit batch ${b + 1}/${totalBatches} (${batch.length} tickets)...`, 71 + Math.round(((b + 1) / totalBatches) * 2));
    }

    const auditItems = await structuredGenerate({
      model: getReasoningModel(),
      schema: z.array(TicketAuditItem),
      system: `${PIDRAX_SYSTEM}

You are auditing existing Jira tickets against all other company data.`,
      prompt: `For each active Jira ticket, check:
1. STATUS ACCURACY: Does evidence from Slack/GitHub/Confluence confirm
   the current Jira status? If Slack says "shipped" but Jira says
   "In Progress", flag it.
2. MISSING INFO: Is the ticket description incomplete? Are acceptance
   criteria missing? Is assignee correct?
3. STALENESS: Has this ticket had no activity in 30+ days while still
   marked as active?
4. DUPLICATES: Are there tickets that cover the same work?

For each issue found, provide:
- field: which field is wrong
- current_value: what Jira currently says
- suggested_value: what it should be (concrete suggestion)
- evidence: why you think this (cite the source)
- severity: S1-S4

If a ticket looks fine, return it with overall_assessment "ok" and empty issues.

ACTIVE JIRA TICKETS (batch ${b + 1}/${totalBatches}):
${JSON.stringify(batch, null, 1)}

RELEVANT DATA:
${ragContext}

KB PAGES ALREADY GENERATED (for project context):
${kbSummary}`,
      maxOutputTokens: Math.min(16384, Math.max(4096, batch.length * 500)),
      logger,
      onUsage,
    });
    allAuditItems.push(...auditItems);
  }

  logger.log(`Step 5: ${allAuditItems.length} tickets audited, ${allAuditItems.filter(t => t.overall_assessment !== "ok").length} with issues`);
  onProgress?.(`[Step 5] Audit complete — ${allAuditItems.length} tickets checked`, 73);
  return allAuditItems;
}

// ---------------------------------------------------------------------------
// Step 6: Extract New Tickets (Opus, 2 calls)
// ---------------------------------------------------------------------------

async function step6_ExtractNewTickets(
  projectId: string,
  kbSummary: string,
  onProgress?: (detail: string, percent: number) => void,
  onUsage?: (usage: LLMUsage) => void,
): Promise<{ convTickets: z.infer<typeof PMTicket>[]; custTickets: z.infer<typeof PMTicket>[] }> {
  onProgress?.("[Step 6a] Extracting conversation tickets...", 74);

  const convContext = await retrieveContext(
    projectId,
    "actionable items bugs features from slack conversations jira comments",
  );

  let convTickets: z.infer<typeof PMTicket>[] = [];
  try {
    const convData = await structuredGenerate({
      model: getReasoningModel(),
      schema: z.object({ conversation_tickets: z.array(PMTicket) }),
      system: `${PIDRAX_SYSTEM}

Extract tickets from Slack conversations and Jira comments.
1. Include conversation context
2. Check if similar ticket exists in Jira → set jira_match
3. Cite exact Slack timestamps/channels or Jira comments
4. Set source_group: "conversation"`,
      prompt: `KB CONTEXT:\n${kbSummary}\n\nDATA:\n${convContext}`,
      maxOutputTokens: 8192,
      logger,
      onUsage,
    });
    convTickets = convData.conversation_tickets.map(t => ({
      ...t, source_group: "conversation" as const,
    }));
    logger.log(`Step 6a: ${convTickets.length} conversation tickets`);
    onProgress?.(`[Step 6a] ${convTickets.length} conversation tickets`, 77);
  } catch (err) {
    logger.log(`Step 6a FAILED: ${err}`);
  }

  onProgress?.("[Step 6b] Extracting customer feedback tickets...", 78);
  const custContext = await retrieveContext(
    projectId,
    "customer feedback bugs features requests complaints",
  );
  const convTitles = convTickets.map(t => t.title);

  let custTickets: z.infer<typeof PMTicket>[] = [];
  try {
    const custData = await structuredGenerate({
      model: getReasoningModel(),
      schema: z.object({ customer_tickets: z.array(PMTicket) }),
      system: `${PIDRAX_SYSTEM}

Extract tickets from customer feedback.
1. Check Jira match
2. Skip if duplicate of: ${convTitles.join("; ")}
3. Include customer_evidence
4. Set source_group: "customer_feedback"`,
      prompt: `KB CONTEXT:\n${kbSummary}\n\nDATA:\n${custContext}`,
      maxOutputTokens: 8192,
      logger,
      onUsage,
    });
    custTickets = custData.customer_tickets.map(t => ({
      ...t, source_group: "customer_feedback" as const,
    }));
    logger.log(`Step 6b: ${custTickets.length} customer tickets`);
    onProgress?.(`[Step 6b] ${custTickets.length} customer tickets`, 80);
  } catch (err) {
    logger.log(`Step 6b FAILED: ${err}`);
  }

  return { convTickets, custTickets };
}

// ---------------------------------------------------------------------------
// Step 7: Proposed Projects + How-to (Sonnet, N calls)
// ---------------------------------------------------------------------------

async function step7_ProposedProjects(
  projectId: string,
  allTickets: z.infer<typeof PMTicket>[],
  kbSummary: string,
  onProgress?: (detail: string, percent: number) => void,
  onPage?: (page: ScoreFormatPageType) => void,
  options?: {
    skipTicketTitles?: Set<string>;
    existingProjectPages?: ScoreFormatPageType[];
    existingHowtoPages?: ScoreFormatPageType[];
    onPageCheckpoint?: (projPages: ScoreFormatPageType[], htPages: ScoreFormatPageType[]) => Promise<void>;
    onUsage?: (usage: LLMUsage) => void;
  },
): Promise<{ projectPages: ScoreFormatPageType[]; howtoPages: ScoreFormatPageType[] }> {
  if (allTickets.length === 0) {
    onProgress?.("[Step 7] No tickets — skipping project generation.", 88);
    return {
      projectPages: options?.existingProjectPages || [],
      howtoPages: options?.existingHowtoPages || [],
    };
  }

  onProgress?.(`[Step 7] Generating ${allTickets.length} proposed projects + how-to docs...`, 81);
  const projInstr = getSectionInstructions("proposed_project");
  const howtoInstr = getSectionInstructions("howto_implementation");
  const skipTitles = options?.skipTicketTitles || new Set<string>();
  const projectPages: ScoreFormatPageType[] = [...(options?.existingProjectPages || [])];
  const howtoPages: ScoreFormatPageType[] = [...(options?.existingHowtoPages || [])];

  for (let i = 0; i < allTickets.length; i++) {
    const ticket = allTickets[i];
    const pct = 81 + Math.round(((i + 1) / allTickets.length) * 7);

    if (skipTitles.has(ticket.title)) {
      onProgress?.(`[Step 7 ${i + 1}/${allTickets.length}] ${ticket.title} (cached)`, pct);
      continue;
    }

    const projId = `proposed-project-${slugify(ticket.title)}`;
    const howtoId = `howto-implementation-${slugify(ticket.title)}`;
    const source = ticket.source_group || "conversation";
    const jiraInfo = ticket.jira_match
      ? `Jira match: ${ticket.jira_match.exists ? `YES (${ticket.jira_match.matching_jira_key})` : "NO (new)"}`
      : "";

    onProgress?.(`[Step 7 ${i + 1}/${allTickets.length}] ${ticket.title}...`, pct);
    const ticketContext = await retrieveContext(
      projectId,
      `${ticket.title} ${ticket.description} implementation`,
    );

    try {
      const result = await structuredGenerate({
        model: getFastModel(),
        schema: MergedProjectHowto,
        system: `${PIDRAX_SYSTEM}

Generate BOTH a Proposed Project page AND a How-to-Implement page for this ticket.

Proposed Project sections:
${projInstr}

How-to-Implement sections:
${howtoInstr}

Source: ${source}. ${jiraInfo}`,
        prompt: `TICKET:
${ticket.ticket_id} — ${ticket.title} (${ticket.type}, ${ticket.priority})
${ticket.description}
Acceptance: ${(ticket.acceptance_criteria || []).join("; ")}

KB CONTEXT:
${truncate(kbSummary, 5000)}

DATA:
${ticketContext}`,
        logger,
        onUsage: options?.onUsage,
      });

      const projPage = result.project_page;
      projPage.page_id = projId;
      projPage.category = "proposed_project" as any;
      projPage.title = ticket.title;
      projPage.linked_ticket_id = ticket.ticket_id;
      const { page: normProj, violations: projV } = validateAndNormalizePage(projPage, "proposed_project");
      if (projV.length > 0) logger.log(`Step 7 proj "${ticket.title}" violations: ${projV.join(", ")}`);
      projectPages.push(normProj);
      onPage?.(normProj);

      const howtoPage = result.howto_page;
      howtoPage.page_id = howtoId;
      howtoPage.category = "howto_implementation" as any;
      howtoPage.title = `How to Implement: ${ticket.title}`;
      howtoPage.linked_ticket_id = ticket.ticket_id;
      const { page: normHowto, violations: howtoV } = validateAndNormalizePage(howtoPage, "howto_implementation");
      if (howtoV.length > 0) logger.log(`Step 7 howto "${ticket.title}" violations: ${howtoV.join(", ")}`);
      howtoPages.push(normHowto);
      onPage?.(normHowto);

      await options?.onPageCheckpoint?.(projectPages, howtoPages);
      logger.log(`Step 7 "${ticket.title}" done`);
      onProgress?.(`[Step 7 ${i + 1}/${allTickets.length}] ${ticket.title} done`, pct);
    } catch (err) {
      logger.log(`Step 7 "${ticket.title}" FAILED: ${err}`);
    }
  }

  onProgress?.(`[Step 7] Done — ${projectPages.length} projects + ${howtoPages.length} how-to`, 88);
  return { projectPages, howtoPages };
}

// ---------------------------------------------------------------------------
// Step 8: Cross-validation (Sonnet, 1 call)
// ---------------------------------------------------------------------------

async function step8_CrossValidation(
  allPages: ScoreFormatPageType[],
  onProgress?: (detail: string, percent: number) => void,
  onUsage?: (usage: LLMUsage) => void,
): Promise<ValidationResultType> {
  onProgress?.("[Step 8] Running cross-validation...", 89);

  const PAGE_SUMMARY_BUDGET = 120000;
  const pageSummaryLines = allPages.map(p => {
    const sectionNames = p.sections.map(s => s.section_name).join(", ");
    const itemCount = p.sections.reduce((s, sec) => s + (sec.bullets?.length || 0), 0);
    const topItems = p.sections
      .flatMap(s => s.bullets.map(b => b.item_text))
      .slice(0, 3)
      .join("; ");
    return `- [${p.category}] "${p.title}" (id: ${p.page_id}, ${itemCount} items, sections: ${sectionNames}): ${topItems}`;
  });
  let pageSummaries = "";
  for (const line of pageSummaryLines) {
    if (pageSummaries.length + line.length > PAGE_SUMMARY_BUDGET) {
      pageSummaries += `\n... and ${pageSummaryLines.length - pageSummaries.split("\n").length} more pages omitted for size`;
      break;
    }
    pageSummaries += line + "\n";
  }

  const result = await structuredGenerate({
    model: getFastModel(),
    schema: ValidationResult,
    system: `${PIDRAX_SYSTEM}\n\nReview KB pages for quality issues.`,
    prompt: `Review these KB pages for quality issues:

1. DUPLICATED CONTENT: Same facts appearing in multiple pages
2. CATEGORY ERRORS: Pages that seem to be in the wrong category
3. MISSING CROSS-REFERENCES: Pages that should link to each other but don't

PAGE SUMMARIES (${allPages.length} pages):
${pageSummaries}`,
    logger,
    onUsage,
  });

  logger.log(`Step 8: ${result.duplicate_content.length} duplicates, ${result.category_errors.length} category errors, ${result.missing_cross_refs.length} missing refs`);
  onProgress?.(`[Step 8] Validation complete — ${result.duplicate_content.length} duplicates, ${result.category_errors.length} errors`, 93);
  return result;
}

// ---------------------------------------------------------------------------
// Main: Pidrax KB Generation Pipeline
// ---------------------------------------------------------------------------

export type PidraxProgressEvent = {
  phase: string;
  detail: string;
  percent: number;
  plan?: PagePlanItemType[];
  page?: ScoreFormatPageType;
  done?: boolean;
  success?: boolean;
  stepMetric?: StepMetric;
  metrics?: PidraxRunMetrics;
};

export async function runPidraxPipeline(
  inputs: { confluence: string; jira: string; slack: string; github: string; customerFeedback: string },
  projectId: string,
  onProgress?: (event: PidraxProgressEvent) => void,
  options?: { resumeRunId?: string },
): Promise<{
  output: ScoreFormatOutputType;
  dataMap: DataMapType;
  pagePlan: PagePlanItemType[];
  crossValidation: ValidationResultType;
  metrics: PidraxRunMetrics;
}> {
  const pipelineStart = Date.now();
  const isResume = !!options?.resumeRunId;
  const runId = options?.resumeRunId || nanoid();

  const emit = (phase: string, detail: string, percent: number, extra?: Partial<PidraxProgressEvent>) => {
    try { onProgress?.({ phase, detail, percent, ...extra }); } catch { /* stream may be closed */ }
  };
  const emitStep = (detail: string, percent: number) => emit("pipeline", detail, percent);

  // Load checkpoint if resuming
  let checkpoint: Record<string, any> | null = null;
  if (isResume) {
    checkpoint = await loadCheckpoint(projectId, runId);
    if (checkpoint) {
      emit("pipeline", `Resuming from step ${(checkpoint.completedStep ?? -1) + 1} (run ${runId})`, 1);
    } else {
      emit("pipeline", `No checkpoint found for run ${runId} — starting fresh`, 1);
    }
  }

  const completedStep: number = checkpoint?.completedStep ?? -1;
  const stepMetrics: StepMetric[] = [...(checkpoint?.stepMetrics ?? [])];

  // ── Step 0: Parse + Embed ────────────────────────────────────────────
  let allParsed: ParsedDocument[];
  if (completedStep >= 0) {
    allParsed = await reloadParsedDocs(projectId);
    emitStep(`[Step 0] Loaded ${allParsed.length} docs from checkpoint`, 20);
  } else {
    const start = Date.now();
    const acc = createUsageAccumulator();
    allParsed = await step0_ParseAndEmbed(inputs, projectId, emitStep);
    const metric = buildStepMetric(0, "Parse & Embed", start, acc, "sonnet", allParsed.length);
    stepMetrics.push(metric);
    await saveCheckpoint(projectId, runId, { completedStep: 0, documentCount: allParsed.length, stepMetrics });
    emit("step_metric", `Step 0 done in ${(metric.durationMs / 1000).toFixed(1)}s`, 20, { stepMetric: metric });
  }

  // ── Step 1: Summarize ────────────────────────────────────────────────
  let summaries: Map<string, z.infer<typeof DocSummary>>;
  if (completedStep >= 1) {
    const raw = checkpoint!.summaries || {};
    summaries = new Map(Object.entries(raw));
    emitStep(`[Step 1] Loaded ${summaries.size} summaries from checkpoint`, 30);
  } else {
    const start = Date.now();
    const acc = createUsageAccumulator();
    summaries = await step1_Summarize(allParsed, emitStep, acc.track);
    const metric = buildStepMetric(1, "Summarize", start, acc, "sonnet", allParsed.length);
    stepMetrics.push(metric);
    const summObj: Record<string, unknown> = {};
    summaries.forEach((v, k) => { summObj[k] = v; });
    await saveCheckpoint(projectId, runId, { completedStep: 1, summaries: summObj, stepMetrics });
    emit("step_metric", `Step 1 done in ${(metric.durationMs / 1000).toFixed(1)}s — $${metric.estimatedCostUsd.toFixed(3)}`, 30, { stepMetric: metric });
  }

  // ── Step 2: Global Triage ────────────────────────────────────────────
  let dataMap: DataMapType;
  if (completedStep >= 2) {
    dataMap = checkpoint!.dataMap;
    emitStep(`[Step 2] Loaded triage from checkpoint`, 38);
  } else {
    const start = Date.now();
    const acc = createUsageAccumulator();
    dataMap = await step2_GlobalTriage(allParsed, summaries, emitStep, acc.track);
    const metric = buildStepMetric(2, "Global Triage", start, acc, "opus");
    stepMetrics.push(metric);
    await saveCheckpoint(projectId, runId, { completedStep: 2, dataMap, stepMetrics });
    emit("step_metric", `Step 2 done in ${(metric.durationMs / 1000).toFixed(1)}s — $${metric.estimatedCostUsd.toFixed(3)}`, 38, { stepMetric: metric });
    emit("triage", "Global triage complete", 38);
  }

  // ── Step 3: Page Plan ────────────────────────────────────────────────
  let pagePlan: PagePlanItemType[];
  if (completedStep >= 3) {
    pagePlan = checkpoint!.pagePlan;
    emitStep(`[Step 3] Loaded plan (${pagePlan.length} pages) from checkpoint`, 42);
  } else {
    const start = Date.now();
    const acc = createUsageAccumulator();
    pagePlan = await step3_PagePlan(dataMap, emitStep, acc.track);
    const metric = buildStepMetric(3, "Page Plan", start, acc, "opus", pagePlan.length);
    stepMetrics.push(metric);
    await saveCheckpoint(projectId, runId, { completedStep: 3, pagePlan, stepMetrics });
    emit("step_metric", `Step 3 done in ${(metric.durationMs / 1000).toFixed(1)}s — $${metric.estimatedCostUsd.toFixed(3)}`, 42, { stepMetric: metric });
  }
  emit("plan", "Page plan ready", 42, { plan: pagePlan });

  // ── Step 4: Generate Pages ───────────────────────────────────────────
  let kbPages: ScoreFormatPageType[];
  if (completedStep >= 4) {
    kbPages = checkpoint!.kbPages;
    emitStep(`[Step 4] Loaded ${kbPages.length} pages from checkpoint`, 70);
    for (const page of kbPages) {
      emit("pidrax_page", `Page: ${page.title}`, -1, { page });
    }
  } else {
    const start = Date.now();
    const acc = createUsageAccumulator();
    const existingKbPages: ScoreFormatPageType[] = checkpoint?.kbPages || [];
    const skipIds = new Set(existingKbPages.map(p => p.page_id));
    for (const page of existingKbPages) {
      emit("pidrax_page", `Page: ${page.title} (cached)`, -1, { page });
    }
    kbPages = await step4_GeneratePages(
      projectId, pagePlan, dataMap, emitStep,
      (page) => emit("pidrax_page", `Page: ${page.title}`, -1, { page }),
      {
        skipPageIds: skipIds,
        existingPages: existingKbPages,
        onPageCheckpoint: async (pages) => {
          await saveCheckpoint(projectId, runId, { kbPages: pages });
        },
        onUsage: acc.track,
      },
    );
    const metric = buildStepMetric(4, "Generate Pages", start, acc, "sonnet", kbPages.length);
    stepMetrics.push(metric);
    await saveCheckpoint(projectId, runId, { completedStep: 4, kbPages, stepMetrics });
    emit("step_metric", `Step 4 done in ${(metric.durationMs / 1000).toFixed(1)}s — $${metric.estimatedCostUsd.toFixed(3)}`, 70, { stepMetric: metric });
  }

  // ── Step 5: Ticket Audit ─────────────────────────────────────────────
  let ticketAudit: TicketAuditItemType[];
  if (completedStep >= 5) {
    ticketAudit = checkpoint!.ticketAudit;
    emitStep(`[Step 5] Loaded audit from checkpoint`, 73);
  } else {
    const start = Date.now();
    const acc = createUsageAccumulator();
    ticketAudit = await step5_TicketAudit(projectId, dataMap, kbPages, emitStep, acc.track);
    const metric = buildStepMetric(5, "Ticket Audit", start, acc, "opus", ticketAudit.length);
    stepMetrics.push(metric);
    await saveCheckpoint(projectId, runId, { completedStep: 5, ticketAudit, stepMetrics });
    emit("step_metric", `Step 5 done in ${(metric.durationMs / 1000).toFixed(1)}s — $${metric.estimatedCostUsd.toFixed(3)}`, 73, { stepMetric: metric });
  }

  // ── Step 6: Extract New Tickets ──────────────────────────────────────
  let convTickets: z.infer<typeof PMTicket>[];
  let custTickets: z.infer<typeof PMTicket>[];
  if (completedStep >= 6) {
    convTickets = checkpoint!.convTickets;
    custTickets = checkpoint!.custTickets;
    emitStep(`[Step 6] Loaded tickets from checkpoint`, 80);
  } else {
    const start = Date.now();
    const acc = createUsageAccumulator();
    const kbSummary = truncate(summarizeKB(kbPages), 20000);
    const tickets = await step6_ExtractNewTickets(projectId, kbSummary, emitStep, acc.track);
    convTickets = tickets.convTickets;
    custTickets = tickets.custTickets;
    const metric = buildStepMetric(6, "Extract New Tickets", start, acc, "opus", convTickets.length + custTickets.length);
    stepMetrics.push(metric);
    await saveCheckpoint(projectId, runId, { completedStep: 6, convTickets, custTickets, stepMetrics });
    emit("step_metric", `Step 6 done in ${(metric.durationMs / 1000).toFixed(1)}s — $${metric.estimatedCostUsd.toFixed(3)}`, 80, { stepMetric: metric });
  }

  // ── Step 7: Proposed Projects + How-to ───────────────────────────────
  let projectPages: ScoreFormatPageType[];
  let howtoPages: ScoreFormatPageType[];
  if (completedStep >= 7) {
    projectPages = checkpoint!.projectPages;
    howtoPages = checkpoint!.howtoPages;
    emitStep(`[Step 7] Loaded projects from checkpoint`, 88);
    for (const page of [...projectPages, ...howtoPages]) {
      emit("pidrax_page", `Page: ${page.title} (cached)`, -1, { page });
    }
  } else {
    const start = Date.now();
    const acc = createUsageAccumulator();
    const allTickets = [...convTickets, ...custTickets];
    const kbSummary = truncate(summarizeKB(kbPages), 20000);
    const existingProjectPages: ScoreFormatPageType[] = checkpoint?.projectPages || [];
    const existingHowtoPages: ScoreFormatPageType[] = checkpoint?.howtoPages || [];
    const skipTitles = new Set(existingProjectPages.map(p => p.title));
    for (const page of [...existingProjectPages, ...existingHowtoPages]) {
      emit("pidrax_page", `Page: ${page.title} (cached)`, -1, { page });
    }
    const result = await step7_ProposedProjects(
      projectId, allTickets, kbSummary, emitStep,
      (page) => emit("pidrax_page", `Page: ${page.title}`, -1, { page }),
      {
        skipTicketTitles: skipTitles,
        existingProjectPages,
        existingHowtoPages,
        onPageCheckpoint: async (projPages, htPages) => {
          await saveCheckpoint(projectId, runId, { projectPages: projPages, howtoPages: htPages });
        },
        onUsage: acc.track,
      },
    );
    projectPages = result.projectPages;
    howtoPages = result.howtoPages;
    const metric = buildStepMetric(7, "Proposed Projects", start, acc, "sonnet", projectPages.length);
    stepMetrics.push(metric);
    await saveCheckpoint(projectId, runId, { completedStep: 7, projectPages, howtoPages, stepMetrics });
    emit("step_metric", `Step 7 done in ${(metric.durationMs / 1000).toFixed(1)}s — $${metric.estimatedCostUsd.toFixed(3)}`, 88, { stepMetric: metric });
  }

  // ── Step 8: Cross-validation ─────────────────────────────────────────
  let crossValidation: ValidationResultType;
  if (completedStep >= 8) {
    crossValidation = checkpoint!.crossValidation;
    emitStep(`[Step 8] Loaded validation from checkpoint`, 93);
  } else {
    const start = Date.now();
    const acc = createUsageAccumulator();
    const allPages = [...kbPages, ...projectPages];
    crossValidation = await step8_CrossValidation(allPages, emitStep, acc.track);
    const metric = buildStepMetric(8, "Cross-validation", start, acc, "sonnet");
    stepMetrics.push(metric);
    await saveCheckpoint(projectId, runId, { completedStep: 8, crossValidation, stepMetrics });
    emit("step_metric", `Step 8 done in ${(metric.durationMs / 1000).toFixed(1)}s — $${metric.estimatedCostUsd.toFixed(3)}`, 93, { stepMetric: metric });
  }

  // ── Assemble final output ────────────────────────────────────────────
  const output: ScoreFormatOutputType = {
    kb_pages: [...kbPages, ...projectPages],
    conversation_tickets: convTickets,
    customer_tickets: custTickets,
    howto_pages: howtoPages,
    ticket_audit: ticketAudit,
  };

  const elapsed = Date.now() - pipelineStart;
  const totalItems = output.kb_pages.reduce(
    (s, p) => s + (p.sections || []).reduce((ss, sec) => ss + (sec.bullets?.length || 0), 0), 0,
  );

  const metrics: PidraxRunMetrics = {
    runId,
    projectId,
    steps: stepMetrics,
    totalDurationMs: elapsed,
    totalInputTokens: stepMetrics.reduce((s, m) => s + m.inputTokens, 0),
    totalOutputTokens: stepMetrics.reduce((s, m) => s + m.outputTokens, 0),
    totalEstimatedCostUsd: stepMetrics.reduce((s, m) => s + m.estimatedCostUsd, 0),
    totalPages: output.kb_pages.length,
    totalItems,
  };

  await db.collection("new_test_pidrax_results").insertOne({
    projectId, runId, data: output, dataMap, pagePlan, crossValidation, metrics,
    createdAt: new Date().toISOString(),
  });

  await db.collection("new_test_pidrax_runs").insertOne({
    projectId, runId,
    completedAt: new Date().toISOString(),
    documentCount: allParsed.length,
    pageCount: output.kb_pages.length,
    dataMap, pagePlan, crossValidation, metrics,
  });

  const elapsedSec = (elapsed / 1000).toFixed(1);
  logger.log(`Pidrax pipeline complete in ${elapsedSec}s: ${output.kb_pages.length} pages (${totalItems} items), ${convTickets.length} conv tickets, ${custTickets.length} cust tickets, ${howtoPages.length} howto pages`);
  logger.log(`Total cost: $${metrics.totalEstimatedCostUsd.toFixed(3)} (${metrics.totalInputTokens} in, ${metrics.totalOutputTokens} out)`);

  emit("done", `Pipeline complete — ${output.kb_pages.length} pages, ${totalItems} items (${elapsedSec}s, $${metrics.totalEstimatedCostUsd.toFixed(2)})`, 100, {
    done: true, success: true, metrics,
  });

  return { output, dataMap, pagePlan, crossValidation, metrics };
}
