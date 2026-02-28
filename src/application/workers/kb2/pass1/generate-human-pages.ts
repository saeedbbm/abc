import { z } from "zod";
import {
  kb2EntityPagesCollection,
  kb2HumanPagesCollection,
} from "@/lib/mongodb";
import { getFastModel, getReasoningModel, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/workers/test/structured-generate";
import { STANDARD_HUMAN_PAGES } from "@/src/entities/models/kb2-templates";
import type { KB2EntityPageType, KB2HumanPageType, KB2HumanPageLayer } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const CATEGORIES_NEEDING_REASONING = new Set([
  "architecture_overview",
  "decision_index",
]);

const GeneratedHumanPageSchema = z.object({
  paragraphs: z.array(z.object({
    heading: z.string(),
    body: z.string(),
    entity_refs: z.array(z.string()),
    used_items: z.array(z.object({
      entity_name: z.string(),
      section_name: z.string(),
      item_index: z.number(),
    })).describe("Which AI page items were used to write this paragraph"),
  })),
});

export const generateHumanPagesStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-gen-human-pages");
  const stepId = "pass1-step-12";

  const entityPages = (await kb2EntityPagesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2EntityPageType[];
  if (entityPages.length === 0) throw new Error("No entity pages found — run step 11 first");

  const planArtifact = await ctx.getStepArtifact("pass1", 9);
  const humanPlans = planArtifact?.human_pages ?? [];

  const entityPageByNodeType = new Map<string, KB2EntityPageType[]>();
  for (const ep of entityPages) {
    const arr = entityPageByNodeType.get(ep.node_type) ?? [];
    arr.push(ep);
    entityPageByNodeType.set(ep.node_type, arr);
  }

  const entityPageByName = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) {
    entityPageByName.set(ep.title.toLowerCase(), ep);
  }

  const pages: KB2HumanPageType[] = [];
  let totalLLMCalls = 0;

  ctx.onProgress(`Generating ${humanPlans.length} human pages from AI pages...`, 5);

  for (let i = 0; i < humanPlans.length; i++) {
    const plan = humanPlans[i];
    const hpDef = STANDARD_HUMAN_PAGES.find((hp) => hp.category === plan.category);
    if (!hpDef) continue;

    const useReasoning = CATEGORIES_NEEDING_REASONING.has(plan.category);
    const model = useReasoning ? getReasoningModel() : getFastModel();
    const modelName = useReasoning ? "claude-opus-4-6" : "claude-sonnet-4-6";

    const relatedPages: KB2EntityPageType[] = [];
    for (const entityType of hpDef.relatedEntityTypes) {
      const pagesOfType = entityPageByNodeType.get(entityType) ?? [];
      relatedPages.push(...pagesOfType);
    }
    const cappedPages = relatedPages.slice(0, 25);

    const entityPagesContext = cappedPages.map((ep) => {
      const sections = ep.sections.map((s) => {
        const items = s.items.map((item, idx) =>
          `  [item ${idx}] ${item.text} (confidence: ${item.confidence})`,
        ).join("\n");
        return `### ${s.section_name} [${s.requirement}]\n${items || "  (empty)"}`;
      }).join("\n");
      return `## ${ep.title} [${ep.node_type}]\n${sections}`;
    }).join("\n\n");

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: `You generate human-readable concept hub pages for a company knowledge base.
These pages synthesize information from AI entity pages into coherent, well-structured prose.

Page: "${hpDef.title}"
Layer: ${hpDef.layer}
Purpose: ${hpDef.description}

Rules:
- Write clear, professional prose paragraphs (not bullet lists).
- Each paragraph should have a descriptive heading.
- For entity_refs: list the DISPLAY NAMES (e.g. "Priya Nair", "brewgo-api", "PostgreSQL") of entities mentioned in the paragraph. NEVER use IDs or UUIDs — only human-readable names from the "##" headers of the AI entity pages.
- ONLY include information from the provided AI entity pages — do not invent facts.
- Write 3-8 paragraphs depending on available information.
- For used_items: list which entity page items you used to write each paragraph.
  Use the entity display name (from the "##" header), section name, and item index from the AI pages.
  This creates traceability from human content back to structured AI data.`,
      prompt: `Generate the "${hpDef.title}" page from these AI entity pages:

${entityPagesContext}`,
      schema: GeneratedHumanPageSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
    });
    totalLLMCalls++;
    if (usageData) {
      const cost = calculateCostUsd(modelName, usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, modelName, `Human page: ${hpDef.title}`, JSON.stringify(result, null, 2).slice(0, 5000), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    const linkedEntityPageIds = cappedPages.map((ep) => ep.node_id).filter(Boolean);

    const paragraphs = result.paragraphs.map((p) => {
      const sourceItems = (p.used_items ?? []).map((ui) => {
        const matchedPage = entityPageByName.get(ui.entity_name.toLowerCase());
        if (!matchedPage) return null;
        return {
          entity_page_id: matchedPage.page_id,
          section_name: ui.section_name,
          item_index: ui.item_index,
        };
      }).filter(Boolean) as { entity_page_id: string; section_name: string; item_index: number }[];

      return {
        heading: p.heading,
        body: p.body,
        entity_refs: p.entity_refs,
        source_items: sourceItems,
      };
    });

    const page: KB2HumanPageType = {
      page_id: plan.page_id,
      run_id: ctx.runId,
      title: hpDef.title,
      layer: hpDef.layer as KB2HumanPageLayer,
      category: hpDef.category,
      paragraphs,
      linked_entity_page_ids: linkedEntityPageIds,
    };

    pages.push(page);

    if ((i + 1) % 3 === 0 || i === humanPlans.length - 1) {
      const pct = Math.round(5 + ((i + 1) / humanPlans.length) * 90);
      ctx.onProgress(`Generated ${i + 1}/${humanPlans.length} human pages`, pct);
    }
  }

  if (pages.length > 0) {
    await kb2HumanPagesCollection.deleteMany({ run_id: ctx.runId });
    await kb2HumanPagesCollection.insertMany(pages);
  }

  ctx.onProgress(`Generated ${pages.length} human pages`, 100);
  return {
    total_pages: pages.length,
    llm_calls: totalLLMCalls,
    by_layer: pages.reduce((acc, p) => {
      acc[p.layer] = (acc[p.layer] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };
};
