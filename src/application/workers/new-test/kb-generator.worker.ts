import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { EntityExtractor } from "@/src/application/workers/sync/entity-extractor";
import { embedKnowledgeDocument } from "@/src/application/lib/knowledge/embedding-service";
import { parseBundles, type ParsedDocument } from "@/src/application/lib/test/bundle-parser";
import { streamText } from "ai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { nanoid } from "nanoid";
import {
  KB_PAGE_TEMPLATES,
  type ScoreFormatOutputType,
} from "@/src/entities/models/score-format";

const QDRANT_COLLECTION = "knowledge_embeddings";

const logger = new PrefixLogger("kb-generator");

const KB_CATEGORIES: { key: string; label: string }[] = [
  { key: "company_overview", label: "Company Overview" },
  { key: "setup_onboarding", label: "Setup & Onboarding" },
  { key: "people", label: "People" },
  { key: "clients", label: "Clients" },
  { key: "past_documented", label: "Past Documented Projects" },
  { key: "past_undocumented", label: "Past Undocumented Projects" },
  { key: "ongoing_projects", label: "Ongoing Projects" },
  { key: "new_projects", label: "New Projects" },
  { key: "processes", label: "Processes" },
];

const PIDRAX_SYSTEM = `You are Pidrax, an AI knowledge base system. You analyze company data from multiple sources and produce structured knowledge.

ROUTING RULES for each atomic item:
- "none": informational, goes in the KB
- "verify_task": needs human confirmation
- "update_kb": an existing doc needs a correction
- "create_jira_ticket": user-facing issue requiring engineering

Internal issues → verify_task or update_kb. User-facing issues → create_jira_ticket.

ITEM TYPE RULES:
- If Confluence says one thing but Slack/code says another → "conflict"
- If Confluence info is stale → "outdated"
- If something only in Slack/GitHub but NOT in Confluence → "gap"
- Use: fact, step, decision, owner, dependency, risk, question, ticket as appropriate

ALWAYS cite source documents in source_refs.`;

// ---------------------------------------------------------------------------
// Main KB Generation Pipeline (blind — no access to ground truth)
// ---------------------------------------------------------------------------

export async function runKBGenerationPipeline(
  inputs: { confluence: string; jira: string; slack: string; github: string; customerFeedback: string },
  projectId: string,
  onProgress?: (detail: string, percent: number) => void,
): Promise<ScoreFormatOutputType> {
  const docsRepo = new MongoDBKnowledgeDocumentsRepository();
  const entitiesRepo = new MongoDBKnowledgeEntitiesRepository();

  const pipelineStart = Date.now();

  // Step 1: Setup project
  onProgress?.("[Pidrax 1/6] Setting up project and clearing previous data...", 10);
  await ensureProject(projectId);
  await clearPreviousData(projectId);
  logger.log("Project setup and cleanup done");

  // Step 2: Parse and store documents
  onProgress?.("[Pidrax 2/6] Parsing input bundles into individual documents...", 15);
  const bundles = parseBundles(
    inputs.confluence, inputs.jira, inputs.slack, inputs.github, inputs.customerFeedback,
  );
  logger.log(`Parsed ${bundles.totalDocuments} documents (Confluence: ${bundles.confluence.length}, Jira: ${bundles.jira.length}, Slack: ${bundles.slack.length}, GitHub: ${bundles.github.length}, Feedback: ${bundles.customerFeedback.length})`);
  onProgress?.(`[Pidrax 2/6] Parsed ${bundles.totalDocuments} documents — storing to MongoDB...`, 18);

  const storedDocs = await storeDocuments(bundles, projectId, docsRepo);
  logger.log(`Stored ${storedDocs.length} documents`);
  onProgress?.(`[Pidrax 2/6] Stored ${storedDocs.length} documents in MongoDB`, 22);

  // Step 3: Generate embeddings
  onProgress?.(`[Pidrax 3/6] Generating embeddings for ${storedDocs.length} documents...`, 25);
  let embedded = 0;
  for (const doc of storedDocs) {
    try {
      await embedKnowledgeDocument(doc, logger);
      embedded++;
      if (embedded % 5 === 0 || embedded === storedDocs.length) {
        onProgress?.(`[Pidrax 3/6] Embedded ${embedded}/${storedDocs.length} documents...`, 25 + Math.round((embedded / storedDocs.length) * 15));
      }
    } catch (err) {
      logger.log(`Embedding failed for ${doc.title}: ${err}`);
    }
  }
  logger.log(`Embedded ${embedded}/${storedDocs.length} documents`);
  onProgress?.(`[Pidrax 3/6] Embedding complete — ${embedded}/${storedDocs.length} succeeded`, 40);

  // Step 4: Extract entities
  onProgress?.("[Pidrax 4/6] Extracting entities (people, teams, projects, systems, customers)...", 42);
  const extractor = new EntityExtractor(docsRepo, entitiesRepo, {}, logger);
  const entityResult = await extractor.processProject(projectId);
  logger.log(`Extracted ${entityResult.processed} entities`);
  onProgress?.(`[Pidrax 4/6] Extracted ${entityResult.processed} entities`, 50);

  // Step 5: Build comprehensive context for KB generation
  onProgress?.("[Pidrax 5/6] Building full knowledge context from documents + entities...", 52);
  const contextSummary = await buildFullContext(projectId, docsRepo, entitiesRepo);
  logger.log(`Context built — ${contextSummary.length} chars`);
  onProgress?.(`[Pidrax 5/6] Context ready — ${contextSummary.length} chars of structured input`, 55);

  // Step 6: Discover what pages to create (blind — Pidrax decides from the data)
  onProgress?.("[Pidrax 6/10] Discovering KB pages from data...", 56);
  const planResult = streamText({
    model: getFastModel(),
    maxTokens: 2048,
    system: `You analyze company data and decide what KB pages should exist. Output ONLY a JSON array.
Each element: {"category":"<key>","title":"<page title>"}
Categories: ${KB_CATEGORIES.map(c => c.key).join(", ")}
Rules: 1 page for overview/onboarding, 1 per person, 1 per project, 1 per process. Only create pages for things you find evidence of in the data.`,
    prompt: `DATA:\n${contextSummary}\n\nReturn JSON array of pages to create. JSON only.`,
  });
  let planText = "";
  for await (const chunk of planResult.textStream) {
    planText += chunk;
  }
  let pagesToCreate: { category: string; title: string }[] = [];
  try {
    const match = planText.match(/\[[\s\S]*\]/);
    if (match) pagesToCreate = JSON.parse(match[0]);
  } catch { /* fallthrough */ }
  if (pagesToCreate.length === 0) {
    pagesToCreate = KB_CATEGORIES.map(c => ({ category: c.key, title: c.label }));
  }
  logger.log(`Pidrax discovered ${pagesToCreate.length} pages to create`);
  onProgress?.(`[Pidrax 6/10] Discovered ${pagesToCreate.length} pages`, 58);

  // Step 7: Generate KB pages one by one
  const output: ScoreFormatOutputType = {
    kb_pages: [], conversation_tickets: [], feedback_tickets: [], howto_pages: [],
  };
  const totalPages = pagesToCreate.length;

  for (let pi = 0; pi < totalPages; pi++) {
    const spec = pagesToCreate[pi];
    const cat = KB_CATEGORIES.find(c => c.key === spec.category);
    const sections = KB_PAGE_TEMPLATES[spec.category as keyof typeof KB_PAGE_TEMPLATES] || [];
    const pct = 58 + Math.round(((pi + 1) / totalPages) * 12);
    onProgress?.(`[Pidrax Page ${pi + 1}/${totalPages}] ${spec.title}...`, pct);
    const pageStart = Date.now();

    try {
      const pageStream = streamText({
        model: getFastModel(),
        maxTokens: 4096,
        system: `${PIDRAX_SYSTEM}

Generate a KB page as a JSON object. No markdown, ONLY JSON.
10-20 atomic items across sections. item_id prefix: "gen-${pi + 1}-".
JSON: {"page_id":"gen-page-${pi + 1}","category":"${spec.category}","title":"${spec.title}","sections":[{"section_name":"<name>","bullets":[{"item_id":"gen-${pi + 1}-1","item_text":"<1-3 sentences>","item_type":"fact|step|decision|owner|dependency|risk|question|ticket|conflict|gap|outdated","source_refs":[{"source_type":"confluence|slack|jira|github|customer_feedback","doc_id":"<id>","title":"<title>","excerpt":"<quote>"}],"verification":{"status":"needs_verification","verifier":null},"action_routing":{"action":"none|verify_task|update_kb|create_jira_ticket","reason":"<why>","severity":"S1|S2|S3|S4"},"confidence_bucket":"high|medium|low"}]}]}
Sections: ${sections.join(", ")}`,
        prompt: `Generate KB page "${spec.title}" (${cat?.label || spec.category}) from this data:\n${contextSummary}\n\nJSON only, 10-20 items:`,
      });

      let accumulated = "";
      for await (const chunk of pageStream.textStream) {
        accumulated += chunk;
        if (accumulated.length % 500 < 15) {
          onProgress?.(`[Pidrax Page ${pi + 1}/${totalPages}] ${spec.title} (${accumulated.length} chars)...`, pct);
        }
      }

      const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in response");
      const page = JSON.parse(jsonMatch[0]) as ScoreFormatOutputType["kb_pages"][number];
      if (!page.page_id) page.page_id = `gen-page-${pi + 1}`;
      if (!page.category) (page as any).category = spec.category;
      if (!page.title) page.title = spec.title;
      output.kb_pages.push(page);
      const items = (page.sections || []).reduce((s: number, sec: any) => s + (sec.bullets?.length || 0), 0);
      const elapsed = ((Date.now() - pageStart) / 1000).toFixed(1);
      logger.log(`Pidrax page "${spec.title}": ${items} items in ${elapsed}s`);
      onProgress?.(`[Pidrax Page ${pi + 1}/${totalPages}] ${spec.title} ✓ ${items} items (${elapsed}s)`, pct);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log(`Pidrax page "${spec.title}" FAILED: ${msg}`);
      onProgress?.(`[Pidrax Page ${pi + 1}/${totalPages}] ${spec.title} FAILED: ${msg}`, pct);
    }
  }

  // Step 8: Generate conversation tickets
  onProgress?.("[Pidrax 8/10] Detecting conversation tickets from Slack/Jira...", 71);
  try {
    const convStream = streamText({
      model: getFastModel(),
      maxTokens: 3000,
      system: `${PIDRAX_SYSTEM}\nDetect tickets from Slack/Jira conversations. Output ONLY JSON: {"conversation_tickets":[...]}
Each: {"ticket_id":"gen-conv-N","type":"bug|feature|task|improvement","title":"...","priority":"P0|P1|P2|P3","priority_rationale":"short","description":"1-2 sentences","acceptance_criteria":["..."],"assigned_to":"...","assignment_rationale":"short","affected_systems":["..."],"customer_evidence":[],"technical_constraints":[],"complexity":"small|medium|large","related_tickets":[],"source_refs":[...]}`,
      prompt: `DATA:\n${contextSummary}\n\nDetect conversation tickets. JSON only.`,
    });
    let text = "";
    for await (const chunk of convStream.textStream) {
      text += chunk;
      if (text.length % 500 < 15) onProgress?.(`[Pidrax 8/10] Conv tickets (${text.length} chars)...`, 72);
    }
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      output.conversation_tickets = data.conversation_tickets || [];
    }
    logger.log(`Pidrax conv tickets: ${output.conversation_tickets.length}`);
    onProgress?.(`[Pidrax 8/10] Conv tickets: ${output.conversation_tickets.length}`, 73);
  } catch (err) {
    logger.log(`Pidrax conv tickets FAILED: ${err}`);
    onProgress?.(`[Pidrax 8/10] Conv tickets FAILED`, 73);
  }

  // Step 9: Generate feedback tickets
  onProgress?.("[Pidrax 9/10] Generating tickets from customer feedback...", 73);
  try {
    const fbStream = streamText({
      model: getFastModel(),
      maxTokens: 3000,
      system: `${PIDRAX_SYSTEM}\nGenerate tickets from customer feedback. Output ONLY JSON: {"feedback_tickets":[...]}
Same ticket format as conversation tickets. Include customer_evidence with feedback excerpts.`,
      prompt: `DATA:\n${contextSummary}\n\nGenerate feedback tickets. JSON only.`,
    });
    let text = "";
    for await (const chunk of fbStream.textStream) {
      text += chunk;
      if (text.length % 500 < 15) onProgress?.(`[Pidrax 9/10] Feedback tickets (${text.length} chars)...`, 74);
    }
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      output.feedback_tickets = data.feedback_tickets || [];
    }
    logger.log(`Pidrax feedback tickets: ${output.feedback_tickets.length}`);
    onProgress?.(`[Pidrax 9/10] Feedback tickets: ${output.feedback_tickets.length}`, 75);
  } catch (err) {
    logger.log(`Pidrax feedback tickets FAILED: ${err}`);
    onProgress?.(`[Pidrax 9/10] Feedback tickets FAILED`, 75);
  }

  // Step 10: Generate how-to pages for feedback tickets
  if (output.feedback_tickets.length > 0) {
    for (let hi = 0; hi < output.feedback_tickets.length; hi++) {
      const ticket = output.feedback_tickets[hi];
      onProgress?.(`[Pidrax 10/10] How-to ${hi + 1}/${output.feedback_tickets.length}: ${ticket.title}...`, 76);
      try {
        const howtoStream = streamText({
          model: getFastModel(),
          maxTokens: 2000,
          system: `${PIDRAX_SYSTEM}\nGenerate a how-to-implement page as JSON. 3-6 items.
{"page_id":"gen-howto-${hi + 1}","category":"new_projects","title":"...","sections":[{"section_name":"...","bullets":[...]}]}`,
          prompt: `TICKET: ${ticket.title} (${ticket.type}): ${ticket.description}\nDATA:\n${contextSummary}\n\nJSON only:`,
        });
        let text = "";
        for await (const chunk of howtoStream.textStream) { text += chunk; }
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const page = JSON.parse(match[0]) as ScoreFormatOutputType["howto_pages"][number];
          output.howto_pages.push(page);
        }
        onProgress?.(`[Pidrax 10/10] How-to ${hi + 1} ✓`, 77);
      } catch (err) {
        logger.log(`Pidrax how-to "${ticket.title}" FAILED: ${err}`);
      }
    }
  }

  const totalItems = output.kb_pages.reduce((s, p) => s + (p.sections || []).reduce((ss: number, sec: any) => ss + (sec.bullets?.length || 0), 0), 0);
  const pipelineElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  logger.log(`Pidrax complete in ${pipelineElapsed}s: ${output.kb_pages.length} pages (${totalItems} items), ${output.conversation_tickets.length} conv, ${output.feedback_tickets.length} fb, ${output.howto_pages.length} howto`);
  onProgress?.(`[Pidrax] Done — ${output.kb_pages.length} pages, ${totalItems} items (${pipelineElapsed}s)`, 78);

  onProgress?.("[Pidrax] Saving results...", 79);
  await db.collection("new_test_results").insertOne({
    projectId,
    data: output,
    createdAt: new Date().toISOString(),
  });
  onProgress?.("[Pidrax] Saved.", 79);

  return output;
}

// ---------------------------------------------------------------------------
// Helpers
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
    db.collection("knowledge_documents").deleteMany({ projectId: pid }),
    db.collection("knowledge_entities").deleteMany({ projectId: pid }),
    db.collection("new_test_results").deleteMany({ projectId: pid }),
    db.collection("new_test_analysis").deleteMany({ projectId: pid }),
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

async function storeDocuments(bundles: ReturnType<typeof parseBundles>, pid: string, docsRepo: MongoDBKnowledgeDocumentsRepository) {
  const allParsed: ParsedDocument[] = [
    ...bundles.confluence, ...bundles.jira, ...bundles.slack, ...bundles.github, ...bundles.customerFeedback,
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

async function buildFullContext(
  projectId: string,
  docsRepo: MongoDBKnowledgeDocumentsRepository,
  entitiesRepo: MongoDBKnowledgeEntitiesRepository,
): Promise<string> {
  const sections: string[] = [];

  const providers = ["confluence", "slack", "jira", "github", "customer_feedback"] as const;
  for (const provider of providers) {
    const { items } = await docsRepo.findByProjectId(projectId, { provider, limit: 200 });
    if (items.length === 0) continue;

    const lines = items.map(d => {
      const excerpt = d.content.substring(0, 2000).replace(/\n/g, " ");
      return `[${d.sourceType}] "${d.title}" (id:${d.id}): ${excerpt}`;
    });
    sections.push(`=== ${provider.toUpperCase()} (${items.length} docs) ===\n${truncate(lines.join("\n\n"), 20000)}`);
  }

  const entityTypes = ["person", "team", "project", "system", "customer", "process"];
  const entityLines: string[] = [];
  for (const type of entityTypes) {
    const result = await entitiesRepo.findByProjectId(projectId, { type, limit: 100 });
    for (const e of result.items) {
      const meta = e.metadata as Record<string, any>;
      const parts = [`${type.toUpperCase()}: ${e.name}`];
      if (e.aliases.length > 0) parts.push(`aka: ${e.aliases.join(", ")}`);
      if (meta.description) parts.push(meta.description.substring(0, 150));
      if (meta.role) parts.push(`role: ${meta.role}`);
      if (meta.team) parts.push(`team: ${meta.team}`);
      if (meta.status) parts.push(`status: ${meta.status}`);
      entityLines.push(`- ${parts.join(" | ")}`);
    }
  }
  if (entityLines.length > 0) {
    sections.push(`=== EXTRACTED ENTITIES (${entityLines.length}) ===\n${truncate(entityLines.join("\n"), 8000)}`);
  }

  return sections.join("\n\n");
}
