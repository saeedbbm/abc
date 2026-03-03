import { randomUUID } from "crypto";
import { z } from "zod";
import {
  kb2GraphNodesCollection,
  kb2EntityPagesCollection,
} from "@/lib/mongodb";
import { getFastModel, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import {
  getEntityTemplate,
  getSectionInstructionsKB2,
} from "@/src/entities/models/kb2-templates";
import type { KB2GraphNodeType, KB2EntityPageType } from "@/src/entities/models/kb2-types";
import { KB2ConfidenceEnum } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import type { RetrievalPack } from "./graphrag-retrieval";

const GeneratedSectionSchema = z.object({
  sections: z.array(z.object({
    section_name: z.string(),
    items: z.array(z.object({
      text: z.string(),
      confidence: KB2ConfidenceEnum,
      source_titles: z.array(z.string()).describe("Titles of ALL source documents this fact comes from"),
    })),
  })),
});

export const generateEntityPagesStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-gen-entity-pages");
  const stepId = "pass1-step-11";

  const retrievalArtifact = await ctx.getStepArtifact("pass1", 10);
  if (!retrievalArtifact?.retrieval_packs) throw new Error("No retrieval packs found — run step 10 first");

  const entityPacks = (retrievalArtifact.retrieval_packs as RetrievalPack[]).filter(
    (p) => p.page_type === "entity",
  );

  const nodes = (await kb2GraphNodesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  const nodeById = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) nodeById.set(node.node_id, node);

  const planArtifact = await ctx.getStepArtifact("pass1", 9);
  const entityPlans = planArtifact?.entity_pages ?? [];

  const model = getFastModel();
  const pages: KB2EntityPageType[] = [];
  let totalLLMCalls = 0;

  ctx.onProgress(`Generating ${entityPacks.length} entity pages...`, 5);

  for (let i = 0; i < entityPacks.length; i++) {
    const pack = entityPacks[i];
    const plan = entityPlans.find((p: any) => p.page_id === pack.page_id);
    if (!plan) continue;

    const node = nodeById.get(plan.node_id);
    if (!node) continue;

    const template = getEntityTemplate(node.type);
    const sectionInstructions = template
      ? getSectionInstructionsKB2(template)
      : "Generate relevant sections based on the entity type.";

    const sourceRefsList = node.source_refs.map((r) => `- "${r.title}" (${r.source_type})`).join("\n");
    const context = [
      "## Graph Context",
      ...pack.graph_context,
      "",
      "## Available Source Documents (use these titles for source_titles)",
      sourceRefsList || "(no sources listed)",
      "",
      "## Document Snippets",
      ...pack.doc_snippets.slice(0, 8),
      "",
      "## Vector Search Results",
      ...pack.vector_snippets.slice(0, 6),
    ].join("\n");

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: `You generate structured entity reference pages for a knowledge base.
Each page has sections with bullet-point items. Each item is a single factual statement.

${template ? `Include rules: ${template.includeRules}\nExclude rules: ${template.excludeRules}\n` : ""}
Section layout:
${sectionInstructions}

Rules:
- Each item must be a standalone factual statement.
- For source_titles: list ALL source document titles that support this fact (from the "Available Source Documents" list). Include every source that mentions this fact.
- Rate confidence: high = multiple sources confirm, medium = single source, low = inferred/uncertain.
- Only include information supported by the provided context.
- If a section has no relevant data, return it with an empty items array.`,
      prompt: `Generate the entity page for "${node.display_name}" (type: ${node.type}).

${context}`,
      schema: GeneratedSectionSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
    });
    totalLLMCalls++;
    if (usageData) {
      const cost = calculateCostUsd("claude-sonnet-4-6", usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, "claude-sonnet-4-6", `Entity page: ${node.display_name}`, JSON.stringify(result, null, 2).slice(0, 5000), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    const requirement = template?.sections ?? [];
    const page: KB2EntityPageType = {
      page_id: pack.page_id,
      run_id: ctx.runId,
      node_id: node.node_id,
      node_type: node.type,
      title: node.display_name,
      sections: result.sections.map((s) => {
        const spec = requirement.find((r) => r.name === s.section_name);
        return {
          section_name: s.section_name,
          requirement: spec?.requirement ?? "OPTIONAL",
          items: s.items.map((item) => {
            const titles = item.source_titles ?? [];
            const normalize = (s: string) => s.toLowerCase().replace(/[—–\-_]/g, " ").replace(/['"]/g, "").replace(/\s+/g, " ").trim();
            const matched = titles
              .map((t) => {
                const norm = normalize(t);
                return node.source_refs.find((r) => {
                  const refNorm = normalize(r.title);
                  return refNorm === norm || refNorm.includes(norm) || norm.includes(refNorm);
                });
              })
              .filter(Boolean) as typeof node.source_refs;
            if (matched.length === 0 && titles.length > 0) {
              console.warn(`[gen-entity-pages] No source match for "${node.display_name}" item titles: ${titles.join(", ")} | Available: ${node.source_refs.map(r => r.title).join(", ")}`);
            }
            const refs = matched;
            return {
              text: item.text,
              confidence: item.confidence,
              source_refs: refs.map((r) => ({
                source_type: r.source_type,
                doc_id: r.doc_id,
                title: r.title,
                section_heading: r.section_heading,
                excerpt: r.excerpt,
              })),
            };
          }),
        };
      }),
      linked_human_page_ids: [],
      manual_overrides: {},
    };

    pages.push(page);

    if ((i + 1) % 5 === 0 || i === entityPacks.length - 1) {
      const pct = Math.round(5 + ((i + 1) / entityPacks.length) * 90);
      ctx.onProgress(`Generated ${i + 1}/${entityPacks.length} entity pages`, pct);
    }
  }

  if (pages.length > 0) {
    await kb2EntityPagesCollection.deleteMany({ run_id: ctx.runId });
    await kb2EntityPagesCollection.insertMany(pages);
  }

  ctx.onProgress(`Generated ${pages.length} entity pages`, 100);
  return {
    total_pages: pages.length,
    llm_calls: totalLLMCalls,
    by_type: pages.reduce((acc, p) => {
      acc[p.node_type] = (acc[p.node_type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };
};
