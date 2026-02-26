import { getFastModel, getReasoningModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { EntityExtractor } from "@/src/application/workers/sync/entity-extractor";
import { embedKnowledgeDocument, searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { parseBundles, type ParsedDocument } from "@/src/application/lib/test/bundle-parser";
import { structuredGenerate } from "@/src/application/workers/test/structured-generate";
import { QdrantClient } from "@qdrant/js-client-rest";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  TEMPLATE_REGISTRY,
  getSectionInstructions,
  validateAndNormalizePage,
  ScoreFormatPage,
  PMTicket,
  KB_BASIC_CATEGORIES,
  KB_PROJECT_CATEGORIES,
  KB_CATEGORY_LABELS,
  type KBCategory,
  type ScoreFormatOutputType,
} from "@/src/entities/models/score-format";

const QDRANT_COLLECTION = "knowledge_embeddings";
const logger = new PrefixLogger("kb-generator");

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const PIDRAX_SYSTEM = `You are Pidrax, an AI knowledge base system. You analyze company data from multiple sources and produce structured knowledge.

ROUTING RULES:
- "none": informational, goes in the KB
- "verify_task": needs human confirmation
- "update_kb": an existing doc needs a correction
- "create_jira_ticket": user-facing issue requiring engineering

ITEM TYPE RULES:
- Confluence says one thing but Slack/code says another → "conflict"
- Confluence info is stale → "outdated"
- Something only in Slack/GitHub but NOT in Confluence → "gap"
- Use: fact, step, decision, owner, dependency, risk, question, ticket as appropriate

ALWAYS cite source documents in source_refs with excerpt and location.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 3) + "...";
}

function summarizeKB(pages: ScoreFormatOutputType["kb_pages"]): string {
  return pages.map(p => {
    const items = (p.sections || []).flatMap(s => (s.bullets || []).map(b => b.item_text).filter(Boolean));
    return `[${p.category}] ${p.title}: ${items.slice(0, 5).join("; ")}`;
  }).join("\n");
}

function getProjectTitles(pages: ScoreFormatOutputType["kb_pages"]): string[] {
  return pages
    .filter(p => KB_PROJECT_CATEGORIES.includes(p.category as any))
    .map(p => p.title);
}

// ---------------------------------------------------------------------------
// RAG Context Retrieval (replaces buildFullContext)
// ---------------------------------------------------------------------------

async function retrieveContext(
  projectId: string,
  query: string,
  options: { maxChars?: number; minScore?: number; topK?: number } = {},
): Promise<string> {
  const { maxChars = 40000, minScore = 0.4, topK = 30 } = options;

  const results = await searchKnowledgeEmbeddings(projectId, query, { limit: topK }, logger);
  let filtered = results.filter(r => r.score >= minScore);

  // Per-provider floor: ensure at least 2 results from each provider that has data
  const providerBuckets = new Map<string, typeof results>();
  for (const r of results) {
    if (!providerBuckets.has(r.provider)) providerBuckets.set(r.provider, []);
    providerBuckets.get(r.provider)!.push(r);
  }
  for (const [provider, provResults] of providerBuckets) {
    const inFiltered = filtered.filter(r => r.provider === provider).length;
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

async function buildGlobalDigest(projectId: string): Promise<string> {
  const docsRepo = new MongoDBKnowledgeDocumentsRepository();
  const providers = ["confluence", "slack", "jira", "github", "customer_feedback"] as const;
  const lines: string[] = [];
  for (const provider of providers) {
    const { items } = await docsRepo.findByProjectId(projectId, { provider, limit: 200 });
    if (items.length === 0) continue;
    const titles = items.map(d => `"${truncate(d.title, 60)}"`).join(" | ");
    lines.push(`[${provider}] ${items.length} docs: ${titles}`);
  }
  return lines.length > 0 ? `AVAILABLE DATA:\n${lines.join("\n")}` : "AVAILABLE DATA: none";
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

async function clearPreviousData(pid: string) {
  await Promise.all([
    db.collection("new_test_results").deleteMany({ projectId: pid }),
    db.collection("new_test_analysis").deleteMany({ projectId: pid }),
  ]);
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
      metadata: parsed.metadata,
      entityRefs: parsed.entityRefs,
      syncedAt: new Date().toISOString(),
    });
    stored.push(doc);
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

const PHASE_ORDER = ["embedding", "phase1", "phase2", "phase3", "phase5", "phase6"];
function phaseIndex(phase: string): number { return PHASE_ORDER.indexOf(phase); }

async function saveCheckpoint(projectId: string, runId: string, phase: string, data: ScoreFormatOutputType) {
  await db.collection("new_test_checkpoints").updateOne(
    { projectId, runId },
    { $set: { phase, data, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
}

async function loadCheckpoint(projectId: string, resumeRunId: string) {
  return db.collection("new_test_checkpoints").findOne({ projectId, runId: resumeRunId });
}

// ---------------------------------------------------------------------------
// Shared Zod schemas for plan/classify calls
// ---------------------------------------------------------------------------

const PlanItem = z.object({
  category: z.string(),
  title: z.string(),
  evidence_source: z.string(),
});

const ProjectListItem = z.object({ title: z.string(), evidence: z.string() });

const MergedProjectHowto = z.object({
  project_page: ScoreFormatPage,
  howto_page: ScoreFormatPage,
});

// ---------------------------------------------------------------------------
// Phase 1: KB Basic (blind)
// ---------------------------------------------------------------------------

async function phase1_KBBasic(
  projectId: string,
  globalDigest: string,
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
): Promise<void> {
  onProgress?.("[Phase 1] Planning KB Basic pages...", 56);
  const categoriesList = KB_BASIC_CATEGORIES.map(c => `- ${c}: ${KB_CATEGORY_LABELS[c]}`).join("\n");
  const planContext = await retrieveContext(projectId, "company overview setup onboarding people team clients customers");

  const plan = await structuredGenerate({
    model: getReasoningModel(),
    schema: z.array(PlanItem),
    system: `${PIDRAX_SYSTEM}\nPlan what KB Basic pages to create.`,
    prompt: `${globalDigest}\n\nRELEVANT DATA:\n${planContext}\n\nFor each KB Basic category, decide what pages to create:\n${categoriesList}\n\nRules:\n- company_overview: exactly 1 page\n- setup_onboarding: exactly 1 page\n- people: 1 page per person/engineer found\n- clients: 1 page per client/customer found\n\nCite which source you found each in.`,
    logger,
  });

  const filtered = plan.filter(p => KB_BASIC_CATEGORIES.includes(p.category as any));
  logger.log(`Phase 1 plan: ${filtered.length} pages`);

  for (let i = 0; i < filtered.length; i++) {
    const spec = filtered[i];
    const templateKey = spec.category as KBCategory;
    const sectionInstr = getSectionInstructions(templateKey);
    const pageId = `gen-basic-${i + 1}`;
    const pct = 57 + Math.round(((i + 1) / filtered.length) * 6);
    onProgress?.(`[Phase 1 Page ${i + 1}/${filtered.length}] ${spec.title}...`, pct);

    const pageContext = await retrieveContext(
      projectId,
      `${spec.title} ${KB_CATEGORY_LABELS[templateKey]} ${spec.evidence_source}`,
    );

    try {
      const rawPage = await structuredGenerate({
        model: getFastModel(),
        schema: ScoreFormatPage,
        system: `${PIDRAX_SYSTEM}\n\nGenerate a KB page. Sections (use these exact names):\n${sectionInstr}\n\n10-20 atomic items total. Cite sources with excerpts.`,
        prompt: `Page ID: "${pageId}"\nCategory: "${spec.category}"\nTitle: "${spec.title}"\nEvidence: ${spec.evidence_source}\n\nDATA:\n${pageContext}`,
        logger,
      });
      rawPage.page_id = pageId;
      rawPage.category = spec.category as any;
      rawPage.title = spec.title;
      const { page, violations } = validateAndNormalizePage(rawPage, templateKey);
      if (violations.length > 0) logger.log(`Phase 1 "${spec.title}" violations: ${violations.join(", ")}`);
      output.kb_pages.push(page);
      const items = page.sections.reduce((s, sec) => s + (sec.bullets?.length || 0), 0);
      logger.log(`Phase 1 page "${spec.title}": ${items} items`);
      onProgress?.(`[Phase 1 Page ${i + 1}/${filtered.length}] ${spec.title} done — ${items} items`, pct);
    } catch (err) {
      logger.log(`Phase 1 page "${spec.title}" FAILED: ${err}`);
    }
  }
  onProgress?.(`[Phase 1] KB Basic done — ${output.kb_pages.length} pages`, 63);
}

// ---------------------------------------------------------------------------
// Phase 2: KB Projects (blind)
// ---------------------------------------------------------------------------

const PROJECT_SUB_GROUPS: { category: KBCategory; instruction: string }[] = [
  {
    category: "past_documented",
    instruction: `Find projects that have BOTH Confluence documentation AND Jira tickets with status done/closed/resolved. Cite Confluence page + Jira ticket key + status.`,
  },
  {
    category: "past_undocumented",
    instruction: `Find projects inferred from GitHub commits, closed Jira tickets, or Slack references — but with NO Confluence documentation. Cite the evidence.`,
  },
  {
    category: "ongoing_documented",
    instruction: `Find projects that have Confluence docs BUT Jira shows active/in-progress/open tickets. Cite both Confluence doc AND active Jira tickets.`,
  },
  {
    category: "ongoing_undocumented",
    instruction: `Find projects with active Jira tickets, ongoing Slack discussions, or open PRs but NO Confluence documentation. Cite evidence.`,
  },
];

async function phase2_KBProjects(
  projectId: string,
  globalDigest: string,
  kbBasicSummary: string,
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
): Promise<void> {
  onProgress?.("[Phase 2] Identifying projects...", 64);
  const allProjectTitles: string[] = [];
  const allSpecs: { category: string; title: string; evidence: string }[] = [];

  for (const group of PROJECT_SUB_GROUPS) {
    const classifyContext = await retrieveContext(
      projectId,
      `${group.instruction} projects confluence jira status`,
    );
    const excludeList = allProjectTitles.length > 0
      ? `\nEXCLUDE already-classified: ${allProjectTitles.join(", ")}`
      : "";

    const projects = await structuredGenerate({
      model: getReasoningModel(),
      schema: z.array(ProjectListItem),
      system: `${PIDRAX_SYSTEM}\nIdentify projects for classification.`,
      prompt: `KB BASIC:\n${kbBasicSummary}\n\n${globalDigest}\n\nRELEVANT DATA:\n${classifyContext}\n\n${group.instruction}${excludeList}\n\nIf none, return [].`,
      logger,
    });

    for (const p of projects) {
      allProjectTitles.push(p.title);
      allSpecs.push({ category: group.category, title: p.title, evidence: p.evidence });
    }
    logger.log(`Phase 2 ${group.category}: ${projects.length} projects`);
  }

  onProgress?.(`[Phase 2] ${allSpecs.length} projects — generating pages...`, 66);

  for (let i = 0; i < allSpecs.length; i++) {
    const spec = allSpecs[i];
    const templateKey = spec.category as KBCategory;
    const sectionInstr = getSectionInstructions(templateKey);
    const pageId = `gen-proj-${i + 1}`;
    const pct = 66 + Math.round(((i + 1) / allSpecs.length) * 6);
    onProgress?.(`[Phase 2 Page ${i + 1}/${allSpecs.length}] ${spec.title}...`, pct);

    const pageContext = await retrieveContext(
      projectId,
      `${spec.title} ${KB_CATEGORY_LABELS[templateKey]} ${spec.evidence}`,
    );

    try {
      const rawPage = await structuredGenerate({
        model: getFastModel(),
        schema: ScoreFormatPage,
        system: `${PIDRAX_SYSTEM}\n\nGenerate a project KB page. Category: ${spec.category}.\nSections:\n${sectionInstr}\n\n10-20 items. Cite exact sources.`,
        prompt: `Page ID: "${pageId}"\nCategory: "${spec.category}"\nTitle: "${spec.title}"\nEvidence: ${spec.evidence}\n\nDATA:\n${pageContext}`,
        logger,
      });
      rawPage.page_id = pageId;
      rawPage.category = spec.category as any;
      rawPage.title = spec.title;
      const { page, violations } = validateAndNormalizePage(rawPage, templateKey);
      if (violations.length > 0) logger.log(`Phase 2 "${spec.title}" violations: ${violations.join(", ")}`);
      output.kb_pages.push(page);
      const items = page.sections.reduce((s, sec) => s + (sec.bullets?.length || 0), 0);
      logger.log(`Phase 2 page "${spec.title}": ${items} items`);
      onProgress?.(`[Phase 2 Page ${i + 1}/${allSpecs.length}] ${spec.title} done`, pct);
    } catch (err) {
      logger.log(`Phase 2 page "${spec.title}" FAILED: ${err}`);
    }
  }
  onProgress?.(`[Phase 2] KB Projects done — ${allSpecs.length} pages`, 72);
}

// ---------------------------------------------------------------------------
// Phase 3: Processes (blind)
// ---------------------------------------------------------------------------

async function phase3_Processes(
  projectId: string,
  globalDigest: string,
  existingPagesSummary: string,
  allProjectTitles: string[],
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
): Promise<void> {
  onProgress?.("[Phase 3] Identifying processes...", 73);
  const identifyContext = await retrieveContext(
    projectId,
    "recurring workflow deployment on-call code review release process incident response sprint",
  );

  const processes = await structuredGenerate({
    model: getReasoningModel(),
    schema: z.array(ProjectListItem),
    system: `${PIDRAX_SYSTEM}\nIdentify recurring processes/workflows (NOT projects).`,
    prompt: `EXISTING KB:\n${existingPagesSummary}\n\n${globalDigest}\n\nRELEVANT DATA:\n${identifyContext}\n\nIdentify recurring activities that are NOT projects.\nA PROJECT has a start, end, deliverable. A PROCESS is ongoing/recurring.\n\nExclude these projects: ${allProjectTitles.join(", ")}\n\nIf none, return [].`,
    logger,
  });

  logger.log(`Phase 3: ${processes.length} processes`);
  const sectionInstr = getSectionInstructions("processes");

  for (let i = 0; i < processes.length; i++) {
    const spec = processes[i];
    const pageId = `gen-proc-${i + 1}`;
    onProgress?.(`[Phase 3 Page ${i + 1}/${processes.length}] ${spec.title}...`, 74);

    const pageContext = await retrieveContext(
      projectId,
      `${spec.title} recurring workflow ${spec.evidence}`,
    );

    try {
      const rawPage = await structuredGenerate({
        model: getFastModel(),
        schema: ScoreFormatPage,
        system: `${PIDRAX_SYSTEM}\n\nGenerate a Process page.\nSections:\n${sectionInstr}\n\n5-15 items.`,
        prompt: `Page ID: "${pageId}"\nCategory: "processes"\nTitle: "${spec.title}"\nEvidence: ${spec.evidence}\n\nDATA:\n${pageContext}`,
        logger,
      });
      rawPage.page_id = pageId;
      rawPage.category = "processes" as any;
      rawPage.title = spec.title;
      const { page, violations } = validateAndNormalizePage(rawPage, "processes");
      if (violations.length > 0) logger.log(`Phase 3 "${spec.title}" violations: ${violations.join(", ")}`);
      output.kb_pages.push(page);
      logger.log(`Phase 3 process "${spec.title}" done`);
      onProgress?.(`[Phase 3 Page ${i + 1}/${processes.length}] ${spec.title} done`, 74);
    } catch (err) {
      logger.log(`Phase 3 process "${spec.title}" FAILED: ${err}`);
    }
  }
  onProgress?.(`[Phase 3] Processes done — ${processes.length}`, 75);
}

// ---------------------------------------------------------------------------
// Phase 5: Tickets (blind)
// ---------------------------------------------------------------------------

async function phase5_Tickets(
  projectId: string,
  kbSummary: string,
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
): Promise<void> {
  onProgress?.("[Phase 5a] Extracting conversation tickets...", 76);
  const convContext = await retrieveContext(
    projectId,
    "actionable items bugs features from slack conversations jira comments",
  );

  try {
    const convData = await structuredGenerate({
      model: getReasoningModel(),
      schema: z.object({ conversation_tickets: z.array(PMTicket) }),
      system: `${PIDRAX_SYSTEM}\n\nExtract tickets from Slack conversations and Jira comments.\n1. Include conversation context\n2. Check if similar ticket exists in Jira → set jira_match\n3. Cite exact Slack timestamps/channels or Jira comments\n4. Set source_group: "conversation"`,
      prompt: `KB CONTEXT:\n${kbSummary}\n\nDATA:\n${convContext}`,
      maxOutputTokens: 8192,
      logger,
    });
    output.conversation_tickets = convData.conversation_tickets.map(t => ({
      ...t, source_group: "conversation" as const,
    }));
    logger.log(`Phase 5a: ${output.conversation_tickets.length} conv tickets`);
    onProgress?.(`[Phase 5a] ${output.conversation_tickets.length} conversation tickets`, 78);
  } catch (err) {
    logger.log(`Phase 5a FAILED: ${err}`);
    onProgress?.(`[Phase 5a] FAILED: ${err}`, 78);
  }

  onProgress?.("[Phase 5b] Extracting customer tickets...", 79);
  const custContext = await retrieveContext(
    projectId,
    "customer feedback bugs features requests complaints",
  );
  const convTitles = output.conversation_tickets.map(t => t.title);

  try {
    const custData = await structuredGenerate({
      model: getReasoningModel(),
      schema: z.object({ customer_tickets: z.array(PMTicket) }),
      system: `${PIDRAX_SYSTEM}\n\nExtract tickets from customer feedback.\n1. Check Jira match\n2. Skip if duplicate of: ${convTitles.join("; ")}\n3. Include customer_evidence\n4. Set source_group: "customer_feedback"`,
      prompt: `KB CONTEXT:\n${kbSummary}\n\nDATA:\n${custContext}`,
      maxOutputTokens: 8192,
      logger,
    });
    output.customer_tickets = custData.customer_tickets.map(t => ({
      ...t, source_group: "customer_feedback" as const,
    }));
    logger.log(`Phase 5b: ${output.customer_tickets.length} customer tickets`);
    onProgress?.(`[Phase 5b] ${output.customer_tickets.length} customer tickets`, 80);
  } catch (err) {
    logger.log(`Phase 5b FAILED: ${err}`);
    onProgress?.(`[Phase 5b] FAILED: ${err}`, 80);
  }
}

// ---------------------------------------------------------------------------
// Phase 6: New Projects + How-to (merged call, blind)
// ---------------------------------------------------------------------------

async function phase6_NewProjectsAndHowTo(
  projectId: string,
  kbSummary: string,
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
): Promise<void> {
  const allTickets = [...output.conversation_tickets, ...output.customer_tickets];
  if (allTickets.length === 0) {
    onProgress?.("[Phase 6] No tickets — skipping.", 90);
    return;
  }

  onProgress?.(`[Phase 6] Generating ${allTickets.length} new projects + how-to docs...`, 81);
  const projInstr = getSectionInstructions("new_projects");
  const howtoInstr = getSectionInstructions("howto_implementation");

  for (let i = 0; i < allTickets.length; i++) {
    const ticket = allTickets[i];
    const pct = 81 + Math.round(((i + 1) / allTickets.length) * 9);
    const projId = `gen-newproj-${i + 1}`;
    const howtoId = `gen-howto-${i + 1}`;
    const source = ticket.source_group || "conversation";
    const jiraInfo = (ticket as any).jira_match
      ? `Jira match: ${(ticket as any).jira_match.exists ? `YES (${(ticket as any).jira_match.matching_jira_key})` : "NO (new)"}`
      : "";

    onProgress?.(`[Phase 6 ${i + 1}/${allTickets.length}] ${ticket.title}...`, pct);
    const ticketContext = await retrieveContext(
      projectId,
      `${ticket.title} ${ticket.description} implementation`,
    );

    try {
      const result = await structuredGenerate({
        model: getFastModel(),
        schema: MergedProjectHowto,
        system: `${PIDRAX_SYSTEM}\n\nGenerate BOTH a New Project page AND a How-to-Implement page for this ticket.\n\nNew Project sections:\n${projInstr}\n\nHow-to-Implement sections:\n${howtoInstr}\n\nSource: ${source}. ${jiraInfo}`,
        prompt: `TICKET:\n${ticket.ticket_id} — ${ticket.title} (${ticket.type}, ${ticket.priority})\n${ticket.description}\nAcceptance: ${(ticket.acceptance_criteria || []).join("; ")}\n\nKB CONTEXT:\n${truncate(kbSummary, 5000)}\n\nDATA:\n${ticketContext}`,
        logger,
      });

      const projPage = result.project_page;
      projPage.page_id = projId;
      projPage.category = "new_projects" as any;
      projPage.title = ticket.title;
      projPage.linked_ticket_id = ticket.ticket_id;
      const { page: normProj, violations: projV } = validateAndNormalizePage(projPage, "new_projects");
      if (projV.length > 0) logger.log(`Phase 6 proj "${ticket.title}" violations: ${projV.join(", ")}`);
      output.kb_pages.push(normProj);

      const howtoPage = result.howto_page;
      howtoPage.page_id = howtoId;
      howtoPage.category = "new_projects" as any;
      howtoPage.title = `How to Implement: ${ticket.title}`;
      howtoPage.linked_ticket_id = ticket.ticket_id;
      const { page: normHowto, violations: howtoV } = validateAndNormalizePage(howtoPage, "howto_implementation");
      if (howtoV.length > 0) logger.log(`Phase 6 howto "${ticket.title}" violations: ${howtoV.join(", ")}`);
      output.howto_pages.push(normHowto);

      logger.log(`Phase 6 "${ticket.title}" done (merged)`);
      onProgress?.(`[Phase 6 ${i + 1}/${allTickets.length}] ${ticket.title} done`, pct);
    } catch (err) {
      logger.log(`Phase 6 "${ticket.title}" FAILED: ${err}`);
    }
  }
  onProgress?.(`[Phase 6] Done — ${output.howto_pages.length} new projects + how-to`, 90);
}

// ---------------------------------------------------------------------------
// Main: Pidrax KB Generation Pipeline (blind)
// ---------------------------------------------------------------------------

export async function runKBGenerationPipeline(
  inputs: { confluence: string; jira: string; slack: string; github: string; customerFeedback: string },
  projectId: string,
  options: { embeddingsReady?: boolean; runId?: string; resumeRunId?: string } = {},
  onProgress?: (detail: string, percent: number) => void,
): Promise<ScoreFormatOutputType> {
  const docsRepo = new MongoDBKnowledgeDocumentsRepository();
  const entitiesRepo = new MongoDBKnowledgeEntitiesRepository();
  const pipelineStart = Date.now();
  const runId = options.runId || nanoid();

  let output: ScoreFormatOutputType = {
    kb_pages: [], conversation_tickets: [], customer_tickets: [], howto_pages: [],
  };
  let startAfter = -1;

  if (options.resumeRunId) {
    const cp = await loadCheckpoint(projectId, options.resumeRunId);
    if (cp) {
      output = (cp as any).data || output;
      startAfter = phaseIndex((cp as any).phase);
      logger.log(`Resuming run ${options.resumeRunId} from after phase ${(cp as any).phase}`);
    }
  }

  if (startAfter < 0) {
    onProgress?.("[Pidrax 1/8] Setting up project...", 10);
    await ensureProject(projectId);
    await clearPreviousData(projectId);
  }

  if (startAfter < phaseIndex("embedding") && !options.embeddingsReady) {
    onProgress?.("[Pidrax 2/8] Clearing source data for fresh run...", 12);
    await clearSourceData(projectId);

    onProgress?.("[Pidrax 3/8] Parsing input bundles...", 15);
    const bundles = parseBundles(inputs.confluence, inputs.jira, inputs.slack, inputs.github, inputs.customerFeedback);
    logger.log(`Parsed ${bundles.totalDocuments} documents`);

    onProgress?.(`[Pidrax 4/8] Storing ${bundles.totalDocuments} documents...`, 20);
    let storedDocs: Awaited<ReturnType<typeof storeDocuments>> | null =
      await storeDocuments(bundles, projectId, docsRepo);

    onProgress?.("[Pidrax 5/8] Generating embeddings...", 25);
    let embedded = 0;
    const totalDocs = storedDocs.length;
    for (const doc of storedDocs) {
      try {
        await embedKnowledgeDocument(doc, logger);
        embedded++;
        if (embedded % 5 === 0) {
          onProgress?.(`[Pidrax 5/8] Embedded ${embedded}/${totalDocs}...`, 25 + Math.round((embedded / totalDocs) * 15));
        }
      } catch (err) { logger.log(`Embedding failed for ${doc.title}: ${err}`); }
    }
    onProgress?.(`[Pidrax 5/8] Embedded ${embedded}/${totalDocs}`, 40);
    storedDocs = null;

    onProgress?.("[Pidrax 6/8] Extracting entities...", 42);
    const extractor = new EntityExtractor(docsRepo, entitiesRepo, {}, logger);
    const entityResult = await extractor.processProject(projectId);
    logger.log(`Extracted ${entityResult.processed} entities`);
    onProgress?.(`[Pidrax 6/8] ${entityResult.processed} entities`, 50);

    await saveCheckpoint(projectId, runId, "embedding", output);
  }

  onProgress?.("[Pidrax 7/8] Building context digest...", 52);
  const globalDigest = await buildGlobalDigest(projectId);
  logger.log(`Global digest: ${globalDigest.length} chars`);
  onProgress?.("[Pidrax 7/8] Context ready", 55);

  if (startAfter < phaseIndex("phase1")) {
    await phase1_KBBasic(projectId, globalDigest, output, onProgress);
    await saveCheckpoint(projectId, runId, "phase1", output);
  }

  if (startAfter < phaseIndex("phase2")) {
    const kbBasicSummary = summarizeKB(output.kb_pages);
    await phase2_KBProjects(projectId, globalDigest, kbBasicSummary, output, onProgress);
    await saveCheckpoint(projectId, runId, "phase2", output);
  }

  if (startAfter < phaseIndex("phase3")) {
    const allPagesSummary = summarizeKB(output.kb_pages);
    const projectTitles = getProjectTitles(output.kb_pages);
    await phase3_Processes(projectId, globalDigest, allPagesSummary, projectTitles, output, onProgress);
    await saveCheckpoint(projectId, runId, "phase3", output);
  }

  if (startAfter < phaseIndex("phase5")) {
    const kbSummary = summarizeKB(output.kb_pages);
    await phase5_Tickets(projectId, kbSummary, output, onProgress);
    await saveCheckpoint(projectId, runId, "phase5", output);
  }

  if (startAfter < phaseIndex("phase6")) {
    const kbSummary = summarizeKB(output.kb_pages);
    await phase6_NewProjectsAndHowTo(projectId, kbSummary, output, onProgress);
    await saveCheckpoint(projectId, runId, "phase6", output);
  }

  const elapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  const totalItems = output.kb_pages.reduce(
    (s, p) => s + (p.sections || []).reduce((ss, sec) => ss + (sec.bullets?.length || 0), 0), 0,
  );
  logger.log(`Pidrax complete in ${elapsed}s: ${output.kb_pages.length} pages (${totalItems} items)`);
  onProgress?.(`[Pidrax] Done — ${output.kb_pages.length} pages, ${totalItems} items (${elapsed}s)`, 91);

  await db.collection("new_test_results").insertOne({
    projectId, runId, data: output, createdAt: new Date().toISOString(),
  });
  onProgress?.("[Pidrax] Saved.", 91);

  return output;
}
