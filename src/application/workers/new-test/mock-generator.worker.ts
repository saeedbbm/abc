import { getFastModel, getReasoningModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { structuredGenerate } from "@/src/application/workers/test/structured-generate";
import { streamText } from "ai";
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

const logger = new PrefixLogger("mock-generator");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildScenarioSpec(messages: { role: string; content: string }[]): string {
  return messages
    .filter(m => m.content.trim().length > 0)
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");
}

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
// RAG Context Retrieval — GT uses high-recall settings (oracle mode)
// ---------------------------------------------------------------------------

async function retrieveContext(
  projectId: string,
  query: string,
  options: { maxChars?: number; minScore?: number; topK?: number } = {},
): Promise<string> {
  const { maxChars = 60000, minScore = 0.3, topK = 50 } = options;

  const results = await searchKnowledgeEmbeddings(projectId, query, { limit: topK }, logger);
  let filtered = results.filter(r => r.score >= minScore);

  // Per-provider floor: at least 3 results from each provider (GT gets wider net)
  const providerBuckets = new Map<string, typeof results>();
  for (const r of results) {
    if (!providerBuckets.has(r.provider)) providerBuckets.set(r.provider, []);
    providerBuckets.get(r.provider)!.push(r);
  }
  for (const [provider, provResults] of providerBuckets) {
    const inFiltered = filtered.filter(r => r.provider === provider).length;
    if (inFiltered < 3) {
      const toAdd = provResults.filter(r => !filtered.includes(r)).slice(0, 3 - inFiltered);
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
// Source bundle configs (for mock input generation — unchanged)
// ---------------------------------------------------------------------------

const SOURCE_BUNDLES = [
  {
    key: "confluence" as const, label: "Confluence",
    format: `Use "--- PAGE ---" separators between pages. Each page has "Title:", "Author:", "Date:", "Space:", then content with markdown headers for sections.`,
    hint: "Confluence wiki pages documenting the company's projects, architecture, and processes.",
  },
  {
    key: "jira" as const, label: "Jira",
    format: `Use "--- TICKET ---" separators. Each ticket has "Key:", "Title:", "Type:", "Status:", "Priority:", "Assignee:", "Reporter:", "Created:", "Updated:", "Description:", "Acceptance Criteria:", "Comments:".`,
    hint: "Jira tickets showing ongoing work, bugs, and tasks.",
  },
  {
    key: "slack" as const, label: "Slack",
    format: `Use "--- CHANNEL: #channel-name ---" then messages as "[YYYY-MM-DD HH:MM] @username: message text". Threads indented with "  > [time] @user: reply".`,
    hint: "Slack conversations with corrections, tribal knowledge, and informal decisions.",
  },
  {
    key: "github" as const, label: "GitHub",
    format: `Use "--- REPO: repo-name ---" then "## Directory Tree", "## File: path/to/file", "## PR #N: title", "## Commit: hash".`,
    hint: "GitHub repos with PRs, commits, and config files.",
  },
  {
    key: "customerFeedback" as const, label: "Customer Feedback",
    format: `Use "--- FEEDBACK ---" separators. Each has "Source:", "Date:", "Customer:", "Severity:", "Product Area:", then the feedback text.`,
    hint: "Customer feedback from reviews, support chats, and emails.",
  },
] as const;

const NO_HINTS_RULE = `EXTREMELY IMPORTANT — NO HINTS OR ANNOTATIONS:
Write exactly as a real human would. Do NOT include meta-annotations like "(this is a conflict)", "(subtle confusion)", "(outdated info)", "[NOTE: ...]", "// intentionally ...". Let issues exist naturally.`;

// ---------------------------------------------------------------------------
// Generate mock inputs (unchanged)
// ---------------------------------------------------------------------------

export interface InputStreamCallback { (source: string, textSoFar: string): void; }

export async function generateMockInputs(
  messages: { role: string; content: string }[],
  projectId: string,
  onProgress?: (detail: string, percent: number) => void,
  onInputChunk?: InputStreamCallback,
): Promise<{ confluence: string; jira: string; slack: string; github: string; customerFeedback: string }> {
  const scenarioSpec = buildScenarioSpec(messages);
  const t0 = Date.now();
  logger.log("Generating mock input data...");
  const output: Record<string, string> = { confluence: "", jira: "", slack: "", github: "", customerFeedback: "" };
  let previousContext = "";

  for (let i = 0; i < SOURCE_BUNDLES.length; i++) {
    const bundle = SOURCE_BUNDLES[i];
    const pctBase = 3 + Math.round((i / SOURCE_BUNDLES.length) * 15);
    onProgress?.(`[Mock ${i + 1}/5] Streaming ${bundle.label}...`, pctBase);
    const stepStart = Date.now();
    try {
      const result = streamText({
        model: getFastModel(),
        system: `You are generating realistic mock ${bundle.label} data for a company. The output must look EXACTLY like real data exported from ${bundle.label}.\n\nFORMAT:\n${bundle.format}\n\n${NO_HINTS_RULE}\n\nHARD WORD LIMIT: Your ENTIRE output for this source MUST be under 200 words total. Be extremely concise.\n\nThe data must be internally consistent with any previously generated sources (same people names, project names, ticket IDs, dates, etc.).`,
        prompt: `SCENARIO:\n${scenarioSpec}\n\n${previousContext ? `PREVIOUSLY GENERATED SOURCES (use same names, IDs, dates):\n${previousContext}\n` : ""}Generate the ${bundle.label} source bundle. ${bundle.hint}\nREMEMBER: MAXIMUM 200 WORDS TOTAL. Be very brief.\nOutput ONLY the raw ${bundle.label} text, nothing else.`,
      });
      let accumulated = "";
      for await (const chunk of result.textStream) {
        accumulated += chunk;
        onInputChunk?.(bundle.key, accumulated);
      }
      output[bundle.key] = accumulated;
      const stepElapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
      logger.log(`${bundle.label} streamed in ${stepElapsed}s — ${accumulated.length} chars`);
      onProgress?.(`[Mock ${i + 1}/5] ${bundle.label} done (${stepElapsed}s)`, pctBase + 3);
      const trunc = accumulated.length > 600 ? accumulated.substring(0, 600) + "\n..." : accumulated;
      previousContext += `\n=== ${bundle.label.toUpperCase()} ===\n${trunc}\n`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log(`${bundle.label} generation FAILED: ${msg}`);
      throw new Error(`Failed to generate ${bundle.label}: ${msg}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logger.log(`All 5 mock inputs in ${elapsed}s`);
  onProgress?.(`[Mock] All done (${elapsed}s)`, 19);
  await db.collection("new_test_inputs").insertOne({ projectId, inputs: output, createdAt: new Date().toISOString() });
  onProgress?.("[Mock] Saved.", 20);
  return output as any;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GTPartCallback {
  (part: keyof ScoreFormatOutputType, data: any): void;
}

export interface PagePlanItem {
  category: string;
  title: string;
  description: string;
}

// ---------------------------------------------------------------------------
// GT System prompt base
// ---------------------------------------------------------------------------

const GT_SYSTEM_BASE = `You are generating part of the GROUND TRUTH (answer key) for evaluating a knowledge base AI system.
You have access to the scenario spec AND the full generated source data. You know exactly what exists in the data.
Your output must represent PERFECT results — what a flawless KB system should produce.`;

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const PlanItem = z.object({
  category: z.string(),
  title: z.string(),
  evidence_source: z.string(),
  location: z.string(),
});

const ProjectListItem = z.object({ title: z.string(), evidence: z.string() });

const MergedProjectHowto = z.object({
  project_page: ScoreFormatPage,
  howto_page: ScoreFormatPage,
});

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

const PHASE_ORDER = ["phase1", "phase2", "phase3", "phase5", "phase6"];
function phaseIndex(phase: string): number { return PHASE_ORDER.indexOf(phase); }

async function saveCheckpoint(projectId: string, runId: string, phase: string, data: ScoreFormatOutputType) {
  await db.collection("new_test_checkpoints").updateOne(
    { projectId, runId, pipeline: "gt" },
    { $set: { phase, data, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
}

async function loadCheckpoint(projectId: string, resumeRunId: string) {
  return db.collection("new_test_checkpoints").findOne({ projectId, runId: resumeRunId, pipeline: "gt" });
}

// ---------------------------------------------------------------------------
// PHASE 1: KB Basic
// ---------------------------------------------------------------------------

async function phase1_KBBasic(
  scenarioSpec: string,
  projectId: string,
  globalDigest: string,
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
  onGTPart?: GTPartCallback,
): Promise<void> {
  onProgress?.("[Phase 1] Planning KB Basic pages...", 22);
  const categoriesList = KB_BASIC_CATEGORIES.map(c => `- ${c}: ${KB_CATEGORY_LABELS[c]}`).join("\n");
  const planContext = await retrieveContext(projectId, "company overview setup onboarding people team clients customers");

  const plan = await structuredGenerate({
    model: getReasoningModel(),
    schema: z.array(PlanItem),
    system: `${GT_SYSTEM_BASE}\nPlan what KB Basic pages to create.`,
    prompt: `SCENARIO:\n${scenarioSpec}\n\n${globalDigest}\n\nRELEVANT DATA:\n${planContext}\n\nFor each KB Basic category, decide what pages to create:\n${categoriesList}\n\nRules:\n- company_overview: exactly 1 page\n- setup_onboarding: exactly 1 page\n- people: 1 page per person/engineer found\n- clients: 1 page per client/customer found\n\nCite exact source docs and locations.`,
    logger,
  });

  const filtered = plan.filter(p => KB_BASIC_CATEGORIES.includes(p.category as any));
  logger.log(`Phase 1 plan: ${filtered.length} KB Basic pages`);
  onProgress?.(`[Phase 1] Planned ${filtered.length} KB Basic pages`, 24);

  for (let i = 0; i < filtered.length; i++) {
    const spec = filtered[i];
    const templateKey = spec.category as KBCategory;
    const sectionInstr = getSectionInstructions(templateKey);
    const pageId = `gt-basic-${i + 1}`;
    const pct = 24 + Math.round(((i + 1) / filtered.length) * 8);
    onProgress?.(`[Phase 1 Page ${i + 1}/${filtered.length}] ${spec.title}...`, pct);

    const pageContext = await retrieveContext(
      projectId,
      `${spec.title} ${KB_CATEGORY_LABELS[templateKey]} ${spec.evidence_source}`,
    );

    try {
      const rawPage = await structuredGenerate({
        model: getFastModel(),
        schema: ScoreFormatPage,
        system: `${GT_SYSTEM_BASE}\n\nGenerate a KB page. Sections (use these exact names):\n${sectionInstr}\n\n10-20 atomic items. Every source_ref must include excerpt and location.`,
        prompt: `SCENARIO:\n${scenarioSpec}\n\nPage ID: "${pageId}"\nCategory: "${spec.category}"\nTitle: "${spec.title}"\nEvidence: ${spec.evidence_source} at ${spec.location}\n\nDATA:\n${pageContext}`,
        logger,
      });
      rawPage.page_id = pageId;
      rawPage.category = spec.category as any;
      rawPage.title = spec.title;
      const { page, violations } = validateAndNormalizePage(rawPage, templateKey);
      if (violations.length > 0) logger.log(`Phase 1 "${spec.title}" violations: ${violations.join(", ")}`);
      output.kb_pages.push(page);
      onGTPart?.("kb_pages", output.kb_pages);
      const items = page.sections.reduce((s, sec) => s + (sec.bullets?.length || 0), 0);
      logger.log(`Phase 1 page "${spec.title}": ${items} items`);
      onProgress?.(`[Phase 1 Page ${i + 1}/${filtered.length}] ${spec.title} done — ${items} items`, pct);
    } catch (err) {
      logger.log(`Phase 1 page "${spec.title}" FAILED: ${err}`);
      onProgress?.(`[Phase 1 Page ${i + 1}] ${spec.title} FAILED`, pct);
    }
  }
  onProgress?.(`[Phase 1] KB Basic done — ${output.kb_pages.length} pages`, 32);
}

// ---------------------------------------------------------------------------
// PHASE 2: KB Projects
// ---------------------------------------------------------------------------

const PROJECT_SUB_GROUPS: { category: KBCategory; instruction: string }[] = [
  {
    category: "past_documented",
    instruction: `Find projects that have BOTH Confluence documentation AND Jira tickets with status done/closed/resolved. Cite Confluence page + Jira ticket key.`,
  },
  {
    category: "past_undocumented",
    instruction: `Find projects inferred from GitHub commits, closed Jira tickets, or Slack references — but with NO Confluence documentation. Cite the evidence.`,
  },
  {
    category: "ongoing_documented",
    instruction: `Find projects that have Confluence docs BUT Jira shows active/in-progress/open tickets. Cite both.`,
  },
  {
    category: "ongoing_undocumented",
    instruction: `Find projects with active Jira tickets, ongoing Slack discussions, or open PRs but NO Confluence documentation. Cite evidence.`,
  },
];

async function phase2_KBProjects(
  scenarioSpec: string,
  projectId: string,
  globalDigest: string,
  kbBasicSummary: string,
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
  onGTPart?: GTPartCallback,
): Promise<void> {
  onProgress?.("[Phase 2] Identifying projects across 4 sub-groups...", 33);
  const allProjectTitles: string[] = [];
  const allProjectSpecs: { category: string; title: string; evidence: string }[] = [];

  for (const group of PROJECT_SUB_GROUPS) {
    const classifyContext = await retrieveContext(
      projectId,
      `${group.instruction} projects confluence jira status`,
    );
    const excludeList = allProjectTitles.length > 0
      ? `\n\nEXCLUDE already-classified: ${allProjectTitles.join(", ")}`
      : "";

    const projects = await structuredGenerate({
      model: getReasoningModel(),
      schema: z.array(ProjectListItem),
      system: `${GT_SYSTEM_BASE}\nIdentify projects for classification.`,
      prompt: `SCENARIO:\n${scenarioSpec}\n\nKB BASIC:\n${kbBasicSummary}\n\n${globalDigest}\n\nRELEVANT DATA:\n${classifyContext}\n\n${group.instruction}${excludeList}\n\nIf none, return [].`,
      logger,
    });

    for (const p of projects) {
      allProjectTitles.push(p.title);
      allProjectSpecs.push({ category: group.category, title: p.title, evidence: p.evidence });
    }
    logger.log(`Phase 2 ${group.category}: ${projects.length} projects`);
    onProgress?.(`[Phase 2] ${KB_CATEGORY_LABELS[group.category]}: ${projects.length}`, 35);
  }

  logger.log(`Phase 2 total: ${allProjectSpecs.length} projects`);
  onProgress?.(`[Phase 2] ${allProjectSpecs.length} projects — generating pages...`, 36);

  for (let i = 0; i < allProjectSpecs.length; i++) {
    const spec = allProjectSpecs[i];
    const templateKey = spec.category as KBCategory;
    const sectionInstr = getSectionInstructions(templateKey);
    const pageId = `gt-proj-${i + 1}`;
    const pct = 36 + Math.round(((i + 1) / allProjectSpecs.length) * 10);
    onProgress?.(`[Phase 2 Page ${i + 1}/${allProjectSpecs.length}] ${spec.title}...`, pct);

    const pageContext = await retrieveContext(
      projectId,
      `${spec.title} ${KB_CATEGORY_LABELS[templateKey]} ${spec.evidence}`,
    );

    try {
      const rawPage = await structuredGenerate({
        model: getFastModel(),
        schema: ScoreFormatPage,
        system: `${GT_SYSTEM_BASE}\n\nGenerate a project KB page. Category: ${spec.category}.\nSections:\n${sectionInstr}\n\n10-20 items. Cite exact source locations.`,
        prompt: `SCENARIO:\n${scenarioSpec}\n\nPage ID: "${pageId}"\nCategory: "${spec.category}"\nTitle: "${spec.title}"\nEvidence: ${spec.evidence}\n\nDATA:\n${pageContext}`,
        logger,
      });
      rawPage.page_id = pageId;
      rawPage.category = spec.category as any;
      rawPage.title = spec.title;
      const { page, violations } = validateAndNormalizePage(rawPage, templateKey);
      if (violations.length > 0) logger.log(`Phase 2 "${spec.title}" violations: ${violations.join(", ")}`);
      output.kb_pages.push(page);
      onGTPart?.("kb_pages", output.kb_pages);
      const items = page.sections.reduce((s, sec) => s + (sec.bullets?.length || 0), 0);
      logger.log(`Phase 2 page "${spec.title}": ${items} items`);
      onProgress?.(`[Phase 2 Page ${i + 1}/${allProjectSpecs.length}] ${spec.title} done`, pct);
    } catch (err) {
      logger.log(`Phase 2 page "${spec.title}" FAILED: ${err}`);
    }
  }
  onProgress?.(`[Phase 2] KB Projects done — ${allProjectSpecs.length} pages`, 46);
}

// ---------------------------------------------------------------------------
// PHASE 3: Processes
// ---------------------------------------------------------------------------

async function phase3_Processes(
  scenarioSpec: string,
  projectId: string,
  globalDigest: string,
  existingPagesSummary: string,
  allProjectTitles: string[],
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
  onGTPart?: GTPartCallback,
): Promise<void> {
  onProgress?.("[Phase 3] Identifying processes...", 47);
  const identifyContext = await retrieveContext(
    projectId,
    "recurring workflow deployment on-call code review release process incident response sprint",
  );

  const processes = await structuredGenerate({
    model: getReasoningModel(),
    schema: z.array(ProjectListItem),
    system: `${GT_SYSTEM_BASE}\nIdentify recurring processes/workflows (NOT projects).`,
    prompt: `SCENARIO:\n${scenarioSpec}\n\nEXISTING KB:\n${existingPagesSummary}\n\n${globalDigest}\n\nRELEVANT DATA:\n${identifyContext}\n\nIdentify recurring activities that are NOT projects.\nExclude: ${allProjectTitles.join(", ")}\n\nIf none, return [].`,
    logger,
  });

  logger.log(`Phase 3: ${processes.length} processes`);
  onProgress?.(`[Phase 3] ${processes.length} processes — generating pages...`, 48);
  const sectionInstr = getSectionInstructions("processes");

  for (let i = 0; i < processes.length; i++) {
    const spec = processes[i];
    const pageId = `gt-proc-${i + 1}`;
    const pct = 48 + Math.round(((i + 1) / processes.length) * 4);
    onProgress?.(`[Phase 3 Page ${i + 1}/${processes.length}] ${spec.title}...`, pct);

    const pageContext = await retrieveContext(
      projectId,
      `${spec.title} recurring workflow ${spec.evidence}`,
    );

    try {
      const rawPage = await structuredGenerate({
        model: getFastModel(),
        schema: ScoreFormatPage,
        system: `${GT_SYSTEM_BASE}\n\nGenerate a Process KB page.\nSections:\n${sectionInstr}\n\n5-15 items. Cite exact sources.`,
        prompt: `SCENARIO:\n${scenarioSpec}\n\nPage ID: "${pageId}"\nCategory: "processes"\nTitle: "${spec.title}"\nEvidence: ${spec.evidence}\n\nDATA:\n${pageContext}`,
        logger,
      });
      rawPage.page_id = pageId;
      rawPage.category = "processes" as any;
      rawPage.title = spec.title;
      const { page, violations } = validateAndNormalizePage(rawPage, "processes");
      if (violations.length > 0) logger.log(`Phase 3 "${spec.title}" violations: ${violations.join(", ")}`);
      output.kb_pages.push(page);
      onGTPart?.("kb_pages", output.kb_pages);
      logger.log(`Phase 3 process "${spec.title}" done`);
      onProgress?.(`[Phase 3 Page ${i + 1}/${processes.length}] ${spec.title} done`, pct);
    } catch (err) {
      logger.log(`Phase 3 process "${spec.title}" FAILED: ${err}`);
    }
  }
  onProgress?.(`[Phase 3] Processes done — ${processes.length} pages`, 52);
}

// ---------------------------------------------------------------------------
// PHASE 5: Tickets
// ---------------------------------------------------------------------------

async function phase5_Tickets(
  scenarioSpec: string,
  projectId: string,
  kbSummary: string,
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
  onGTPart?: GTPartCallback,
): Promise<void> {
  onProgress?.("[Phase 5a] Extracting conversation tickets...", 53);
  const convContext = await retrieveContext(
    projectId,
    "actionable items bugs features from slack conversations jira comments",
  );

  try {
    const convData = await structuredGenerate({
      model: getReasoningModel(),
      schema: z.object({ conversation_tickets: z.array(PMTicket) }),
      system: `${GT_SYSTEM_BASE}\n\nExtract tickets from Slack conversations and Jira comments.\n1. Include conversation context\n2. Check if similar Jira ticket exists → set jira_match\n3. Cite exact Slack timestamps/channels\n4. Set source_group: "conversation"`,
      prompt: `SCENARIO:\n${scenarioSpec}\n\nKB CONTEXT:\n${kbSummary}\n\nDATA:\n${convContext}`,
      maxOutputTokens: 8192,
      logger,
    });
    output.conversation_tickets = convData.conversation_tickets.map(t => ({
      ...t, source_group: "conversation" as const,
    }));
    onGTPart?.("conversation_tickets", output.conversation_tickets);
    logger.log(`Phase 5a: ${output.conversation_tickets.length} conv tickets`);
    onProgress?.(`[Phase 5a] ${output.conversation_tickets.length} conversation tickets`, 56);
  } catch (err) {
    logger.log(`Phase 5a FAILED: ${err}`);
    onProgress?.(`[Phase 5a] FAILED: ${err}`, 56);
  }

  onProgress?.("[Phase 5b] Extracting customer tickets...", 57);
  const custContext = await retrieveContext(
    projectId,
    "customer feedback bugs features requests complaints",
  );
  const convTitles = output.conversation_tickets.map(t => t.title);

  try {
    const custData = await structuredGenerate({
      model: getReasoningModel(),
      schema: z.object({ customer_tickets: z.array(PMTicket) }),
      system: `${GT_SYSTEM_BASE}\n\nExtract tickets from customer feedback.\n1. Check Jira match\n2. Skip duplicates of: ${convTitles.join("; ")}\n3. Include customer_evidence\n4. Set source_group: "customer_feedback"`,
      prompt: `SCENARIO:\n${scenarioSpec}\n\nKB CONTEXT:\n${kbSummary}\n\nDATA:\n${custContext}`,
      maxOutputTokens: 8192,
      logger,
    });
    output.customer_tickets = custData.customer_tickets.map(t => ({
      ...t, source_group: "customer_feedback" as const,
    }));
    onGTPart?.("customer_tickets", output.customer_tickets);
    logger.log(`Phase 5b: ${output.customer_tickets.length} customer tickets`);
    onProgress?.(`[Phase 5b] ${output.customer_tickets.length} customer tickets`, 60);
  } catch (err) {
    logger.log(`Phase 5b FAILED: ${err}`);
    onProgress?.(`[Phase 5b] FAILED: ${err}`, 60);
  }
}

// ---------------------------------------------------------------------------
// PHASE 6: New Projects + How-to (merged call)
// ---------------------------------------------------------------------------

async function phase6_NewProjectsAndHowTo(
  scenarioSpec: string,
  projectId: string,
  kbSummary: string,
  output: ScoreFormatOutputType,
  onProgress?: (detail: string, percent: number) => void,
  onGTPart?: GTPartCallback,
): Promise<void> {
  const allTickets = [...output.conversation_tickets, ...output.customer_tickets];
  if (allTickets.length === 0) {
    onProgress?.("[Phase 6] No tickets — skipping.", 75);
    return;
  }

  onProgress?.(`[Phase 6] Generating ${allTickets.length} new projects + how-to docs...`, 61);
  const projInstr = getSectionInstructions("new_projects");
  const howtoInstr = getSectionInstructions("howto_implementation");

  for (let i = 0; i < allTickets.length; i++) {
    const ticket = allTickets[i];
    const pct = 61 + Math.round(((i + 1) / allTickets.length) * 14);
    const projId = `gt-newproj-${i + 1}`;
    const howtoId = `gt-howto-${i + 1}`;
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
        system: `${GT_SYSTEM_BASE}\n\nGenerate BOTH a New Project page AND a How-to-Implement page for this ticket.\n\nNew Project sections:\n${projInstr}\n\nHow-to-Implement sections:\n${howtoInstr}\n\nSource: ${source}. ${jiraInfo}`,
        prompt: `SCENARIO:\n${scenarioSpec}\n\nTICKET:\n${ticket.ticket_id} — ${ticket.title} (${ticket.type}, ${ticket.priority})\n${ticket.description}\nAcceptance: ${(ticket.acceptance_criteria || []).join("; ")}\nAffected systems: ${(ticket.affected_systems || []).join(", ")}\n\nKB CONTEXT:\n${truncate(kbSummary, 5000)}\n\nDATA:\n${ticketContext}`,
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
      onGTPart?.("kb_pages", output.kb_pages);

      const howtoPage = result.howto_page;
      howtoPage.page_id = howtoId;
      howtoPage.category = "new_projects" as any;
      howtoPage.title = `How to Implement: ${ticket.title}`;
      howtoPage.linked_ticket_id = ticket.ticket_id;
      const { page: normHowto, violations: howtoV } = validateAndNormalizePage(howtoPage, "howto_implementation");
      if (howtoV.length > 0) logger.log(`Phase 6 howto "${ticket.title}" violations: ${howtoV.join(", ")}`);
      output.howto_pages.push(normHowto);
      onGTPart?.("howto_pages", output.howto_pages);

      logger.log(`Phase 6 "${ticket.title}" done (merged)`);
      onProgress?.(`[Phase 6 ${i + 1}/${allTickets.length}] ${ticket.title} done`, pct);
    } catch (err) {
      logger.log(`Phase 6 "${ticket.title}" FAILED: ${err}`);
    }
  }
  onProgress?.(`[Phase 6] Done — ${output.howto_pages.length} new projects + how-to`, 75);
}

// ---------------------------------------------------------------------------
// Main: Generate Ground Truth (with RAG, oracle mode)
// ---------------------------------------------------------------------------

export async function generateGroundTruth(
  messages: { role: string; content: string }[],
  inputs: { confluence: string; jira: string; slack: string; github: string; customerFeedback: string },
  projectId: string,
  options: { embeddingsReady?: boolean; runId?: string; resumeRunId?: string } = {},
  onProgress?: (detail: string, percent: number) => void,
  onGTPart?: GTPartCallback,
): Promise<ScoreFormatOutputType> {
  const scenarioSpec = buildScenarioSpec(messages);
  const t0 = Date.now();
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
      logger.log(`Resuming GT run ${options.resumeRunId} from after phase ${(cp as any).phase}`);
    }
  }

  const globalDigest = await buildGlobalDigest(projectId);
  logger.log(`GT global digest: ${globalDigest.length} chars`);

  if (startAfter < phaseIndex("phase1")) {
    await phase1_KBBasic(scenarioSpec, projectId, globalDigest, output, onProgress, onGTPart);
    await saveCheckpoint(projectId, runId, "phase1", output);
  }

  if (startAfter < phaseIndex("phase2")) {
    const kbBasicSummary = summarizeKB(output.kb_pages);
    await phase2_KBProjects(scenarioSpec, projectId, globalDigest, kbBasicSummary, output, onProgress, onGTPart);
    await saveCheckpoint(projectId, runId, "phase2", output);
  }

  if (startAfter < phaseIndex("phase3")) {
    const allPagesSummary = summarizeKB(output.kb_pages);
    const projectTitles = getProjectTitles(output.kb_pages);
    await phase3_Processes(scenarioSpec, projectId, globalDigest, allPagesSummary, projectTitles, output, onProgress, onGTPart);
    await saveCheckpoint(projectId, runId, "phase3", output);
  }

  if (startAfter < phaseIndex("phase5")) {
    const kbSummary = summarizeKB(output.kb_pages);
    await phase5_Tickets(scenarioSpec, projectId, kbSummary, output, onProgress, onGTPart);
    await saveCheckpoint(projectId, runId, "phase5", output);
  }

  if (startAfter < phaseIndex("phase6")) {
    const kbSummary = summarizeKB(output.kb_pages);
    await phase6_NewProjectsAndHowTo(scenarioSpec, projectId, kbSummary, output, onProgress, onGTPart);
    await saveCheckpoint(projectId, runId, "phase6", output);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logger.log(`Ground truth complete in ${elapsed}s`);
  onProgress?.(`[Ground Truth] All done in ${elapsed}s`, 76);

  await db.collection("new_test_ground_truth").updateOne(
    { projectId },
    { $set: { projectId, runId, data: output, updatedAt: new Date().toISOString() }, $setOnInsert: { createdAt: new Date().toISOString() } },
    { upsert: true },
  );
  onProgress?.("[Ground Truth] Saved.", 76);

  return output;
}

// ---------------------------------------------------------------------------
// Legacy exports
// ---------------------------------------------------------------------------

export async function generatePagePlan(
  _messages: { role: string; content: string }[],
  _inputs: { confluence: string; jira: string; slack: string; github: string; customerFeedback: string },
  _projectId: string,
  onProgress?: (detail: string, percent: number) => void,
): Promise<PagePlanItem[]> {
  onProgress?.("[Plan] Page planning is now integrated into GT generation phases.", 100);
  return [];
}
