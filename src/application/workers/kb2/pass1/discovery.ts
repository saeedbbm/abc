import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const DiscoverySchema = z.object({
  discoveries: z.array(z.object({
    display_name: z.string(),
    type: z.string().describe("One of: project, ticket, customer_feedback"),
    category: z.string().describe("One of: past_undocumented, ongoing_undocumented, proposed_project, proposed_ticket, proposed_from_feedback"),
    description: z.string(),
    evidence: z.string(),
    source_document: z.string(),
    related_entities: z.array(z.string()),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

const DISCOVERY_PROMPT = `You analyze company knowledge base documents and an existing entity list to discover MISSING projects and tickets that should exist but were never formally documented.

Look for:
1. PAST UNDOCUMENTED PROJECTS: Work mentioned in conversations/PRs that happened in the past but has no project entity (e.g., "remember when we migrated to Redis last quarter?")
2. ONGOING UNDOCUMENTED WORK: Patterns of activity (PRs, Slack discussions) around a topic with no project entity tracking it
3. PROPOSED PROJECTS: Customer feedback themes or conversation suggestions that indicate a new project/feature should be created (e.g., 5 customers asking for offline ordering)
4. PROPOSED TICKETS: Bugs, tasks, or improvements mentioned in conversations or feedback that have no Jira ticket (e.g., "we should fix that memory leak")
5. PROPOSED FROM FEEDBACK: Recurring customer complaints or requests that deserve their own tracking item

RULES:
- Only propose discoveries that do NOT already exist as entities in the existing entity list
- Each discovery must have clear evidence from the source documents
- Set confidence to "medium" for inferred items, "high" only for clearly mentioned but untracked items
- For proposed items, set confidence to "low" since they need human verification
- Reference existing entity names in related_entities when applicable
- Source document types: Confluence = documented technical content, Jira = project tracking/ticketing, Slack = team conversations, GitHub = code/PRs, Customer Feedback = external user reports
- If evidence comes from Confluence AND Jira, the project is DOCUMENTED
- If evidence comes only from Jira, the project exists but may be UNDOCUMENTED (no Confluence docs)
- If evidence comes only from Slack/GitHub, it is fully DISCOVERED/UNDOCUMENTED`;

export const discoveryStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-discovery");
  const stepId = "pass1-step-8";
  const tc = getTenantCollections(ctx.companySlug);

  const snapshot = await tc.input_snapshots.findOne({ run_id: ctx.runId });
  if (!snapshot) throw new Error("No input snapshot found — run step 1 first");

  const docs = snapshot.parsed_documents as KB2ParsedDocument[];
  const existingNodes = (await tc.graph_nodes.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];

  const existingEntityList = existingNodes
    .map((n) => `- ${n.display_name} [${n.type}]`)
    .join("\n");

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  let totalLLMCalls = 0;
  const allDiscoveries: z.infer<typeof DiscoverySchema>["discoveries"] = [];

  const discoverySettings = ctx.config?.pipeline_settings?.discovery;
  const BATCH_SIZE = discoverySettings?.batch_size ?? 3;
  const CONTENT_CAP = discoverySettings?.content_cap_per_doc ?? 3000;

  let discoveryPrompt = DISCOVERY_PROMPT;
  if (ctx.config?.prompts?.discovery?.system) {
    discoveryPrompt = ctx.config.prompts.discovery.system;
    const context = ctx.config?.profile?.company_context ?? "";
    if (context) {
      discoveryPrompt = discoveryPrompt.replace(/\$\{company_context\}/g, context);
    } else {
      discoveryPrompt = discoveryPrompt.replace(/\$\{company_context\}\n?/g, "");
    }
  }

  const conversationDocs = docs.filter((d) =>
    d.provider === "slack" || d.provider === "customerFeedback" || d.provider === "github",
  );

  if (conversationDocs.length === 0) {
    await ctx.onProgress("No conversation/feedback documents to analyze", 100);
    return { total_discoveries: 0, by_category: {} };
  }

  const totalBatches = Math.ceil(conversationDocs.length / BATCH_SIZE);

  await ctx.onProgress(`Analyzing ${conversationDocs.length} documents for undocumented work...`, 5);

  for (let i = 0; i < conversationDocs.length; i += BATCH_SIZE) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const batch = conversationDocs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const batchText = batch.map((d, idx) =>
      `--- Document ${idx + 1}: ${d.title} (${d.provider}) ---\n${d.content.slice(0, CONTENT_CAP)}`,
    ).join("\n\n");

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: discoveryPrompt,
      prompt: `EXISTING ENTITIES (do not re-discover these):\n${existingEntityList}\n\nDOCUMENTS TO ANALYZE:\n${batchText}`,
      schema: DiscoverySchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;

    if (usageData) {
      const cost = calculateCostUsd(getFastModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getFastModelName(ctx.config?.pipeline_settings?.models),
        `Discovery batch ${batchNum}/${totalBatches}`,
        JSON.stringify(result, null, 2).slice(0, 5000),
        usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    const discoveries = Array.isArray(result?.discoveries) ? result.discoveries : [];
    allDiscoveries.push(...discoveries);

    await ctx.onProgress(
      `Batch ${batchNum}/${totalBatches}: found ${discoveries.length} discoveries (${allDiscoveries.length} total)`,
      Math.round(5 + (batchNum / totalBatches) * 80),
    );
  }

  const existingNames = new Set(existingNodes.map((n) => n.display_name.toLowerCase()));
  const uniqueDiscoveries = allDiscoveries.filter((d) => !existingNames.has(d.display_name.toLowerCase()));

  const newNodes: KB2GraphNodeType[] = [];
  for (const disc of uniqueDiscoveries) {
    const validType = ["project", "ticket", "customer_feedback"].includes(disc.type) ? disc.type : "project";
    newNodes.push({
      node_id: randomUUID(),
      run_id: ctx.runId,
      type: validType as any,
      display_name: disc.display_name,
      aliases: [],
      attributes: {
        discovery_category: disc.category,
        description: disc.description,
        related_entities: disc.related_entities,
      },
      source_refs: [{
        source_type: (() => {
          const sourceDoc = docs.find((d: any) => d.title === disc.source_document || d.sourceId === disc.source_document);
          return (sourceDoc?.provider ?? "slack") as any;
        })(),
        doc_id: disc.source_document,
        title: disc.source_document,
        excerpt: disc.evidence.slice(0, 300),
      }],
      truth_status: "inferred",
      confidence: disc.confidence as any,
    });
  }

  if (newNodes.length > 0) {
    await tc.graph_nodes.insertMany(newNodes);
  }

  const byCategory: Record<string, number> = {};
  for (const d of uniqueDiscoveries) {
    byCategory[d.category] = (byCategory[d.category] || 0) + 1;
  }

  await ctx.onProgress(`Discovered ${uniqueDiscoveries.length} new items`, 100);
  return {
    total_discoveries: uniqueDiscoveries.length,
    llm_calls: totalLLMCalls,
    by_category: byCategory,
    discoveries: uniqueDiscoveries.map((d) => ({
      display_name: d.display_name,
      type: d.type,
      category: d.category,
      confidence: d.confidence,
      evidence_preview: d.evidence.slice(0, 100),
    })),
  };
};
