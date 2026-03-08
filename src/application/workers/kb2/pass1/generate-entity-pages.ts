import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import {
  getEntityTemplate as getStaticEntityTemplate,
  getSectionInstructionsKB2,
} from "@/src/entities/models/kb2-templates";
import {
  getEntityTemplate as getConfigEntityTemplate,
} from "@/src/application/lib/kb2/company-config";
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
      source_excerpts: z.array(z.object({
        title: z.string().describe("Document title from 'Available Source Documents'"),
        excerpt: z.string().describe("Exact verbatim 1-2 sentence quote from this document that supports this fact"),
      })).describe("ALL source documents for this fact — include every document that mentions it, with an exact quote from each"),
    })),
  })),
});

export const generateEntityPagesStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-gen-entity-pages");
  const stepId = "pass1-step-11";

  const retrievalArtifact = await ctx.getStepArtifact("pass1", 10);
  if (!retrievalArtifact?.retrieval_packs) throw new Error("No retrieval packs found — run step 10 first");

  const entityPacks = (retrievalArtifact.retrieval_packs as RetrievalPack[]).filter(
    (p) => p.page_type === "entity",
  );

  const nodes = (await tc.graph_nodes.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  const nodeById = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) nodeById.set(node.node_id, node);

  const planArtifact = await ctx.getStepArtifact("pass1", 9);
  const entityPlans = planArtifact?.entity_pages ?? [];

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  const pages: KB2EntityPageType[] = [];
  let totalLLMCalls = 0;

  await ctx.onProgress(`Generating ${entityPacks.length} entity pages...`, 5);

  for (let i = 0; i < entityPacks.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const pack = entityPacks[i];
    const plan = entityPlans.find((p: any) => p.page_id === pack.page_id);
    if (!plan) continue;

    const node = nodeById.get(plan.node_id);
    if (!node) continue;

    const pgSettings = ctx.config?.pipeline_settings?.page_generation;
    const DOC_SNIPPETS = pgSettings?.doc_snippets_per_entity_page ?? 8;
    const VECTOR_SNIPPETS = pgSettings?.vector_snippets_per_entity_page ?? 6;

    const template = ctx.config?.entity_templates?.[node.type]
      ? (() => { const t = ctx.config!.entity_templates![node.type]!; return t.enabled !== false ? { description: t.description, includeRules: t.includeRules, excludeRules: t.excludeRules, sections: t.sections } : undefined; })()
      : getStaticEntityTemplate(node.type);
    const sectionInstructions = template
      ? getSectionInstructionsKB2(template)
      : "Generate relevant sections based on the entity type.";

    const sourceRefsList = node.source_refs.map((r) => `- "${r.title}" (${r.source_type})`).join("\n");
    const context = [
      "## Graph Context",
      ...pack.graph_context,
      "",
      "## Available Source Documents (use these titles in source_excerpts)",
      sourceRefsList || "(no sources listed)",
      "",
      "## Document Snippets",
      ...pack.doc_snippets.slice(0, DOC_SNIPPETS),
      "",
      "## Vector Search Results",
      ...pack.vector_snippets.slice(0, VECTOR_SNIPPETS),
    ].join("\n");

    let entityPageSystemPrompt = `You generate structured entity reference pages for a knowledge base.
Each page has sections with bullet-point items. Each item is a single factual statement.

${template ? `Include rules: ${template.includeRules}\nExclude rules: ${template.excludeRules}\n` : ""}
Section layout:
${sectionInstructions}

Rules:
- Each item must be a standalone factual statement.
- For source_excerpts: you MUST list EVERY source document that supports this fact. For each, provide the document title (from "Available Source Documents") and an EXACT VERBATIM quote of 1-2 sentences copied directly from the Document Snippets or Vector Search Results that proves this fact. Do NOT paraphrase — copy the text exactly as it appears.
- You MUST check ALL Document Snippets and Vector Search Results for mentions of each fact. If a fact appears in 3 documents, all 3 must be listed.
- Rate confidence: high = multiple sources confirm, medium = single source, low = inferred/uncertain.
- Only include information supported by the provided context.
- If a section has no relevant data, return it with an empty items array.`;
    if (ctx.config?.prompts?.generate_entity_pages?.system) {
      entityPageSystemPrompt = ctx.config.prompts.generate_entity_pages.system
        .replace(/\$\{template_rules\}/g, template ? `Include rules: ${template.includeRules}\nExclude rules: ${template.excludeRules}` : "")
        .replace(/\$\{section_instructions\}/g, sectionInstructions);
    }

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: entityPageSystemPrompt,
      prompt: `Generate the entity page for "${node.display_name}" (type: ${node.type}).

${context}`,
      schema: GeneratedSectionSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;
    if (usageData) {
      const cost = calculateCostUsd(getFastModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getFastModelName(ctx.config?.pipeline_settings?.models), `Entity page: ${node.display_name}`, JSON.stringify(result, null, 2).slice(0, 5000), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
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
            const srcExcerpts = item.source_excerpts ?? [];
            const normalize = (s: string) => s.toLowerCase().replace(/[—–\-_]/g, " ").replace(/['"]/g, "").replace(/\s+/g, " ").trim();

            const wordOverlap = (a: string, b: string): number => {
              const wordsA = new Set(normalize(a).split(/\s+/).filter((w) => w.length > 2));
              const wordsB = normalize(b).split(/\s+/).filter((w) => w.length > 2);
              if (wordsA.size === 0) return 0;
              const hits = wordsB.filter((w) => wordsA.has(w)).length;
              return hits / wordsA.size;
            };

            const matched = srcExcerpts
              .map((se) => {
                const norm = normalize(se.title);
                const ref = node.source_refs.find((r) => {
                  const refNorm = normalize(r.title);
                  return refNorm === norm || refNorm.includes(norm) || norm.includes(refNorm);
                }) ?? node.source_refs
                  .map((r) => ({ ref: r, score: wordOverlap(se.title, r.title) }))
                  .filter((x) => x.score > 0.5)
                  .sort((a, b) => b.score - a.score)[0]?.ref ?? null;
                if (!ref) return null;
                return {
                  source_type: ref.source_type,
                  doc_id: ref.doc_id,
                  title: ref.title,
                  section_heading: ref.section_heading,
                  excerpt: se.excerpt || ref.excerpt,
                };
              })
              .filter(Boolean) as { source_type: string; doc_id: string; title: string; section_heading?: string; excerpt: string }[];

            const seenDocIds = new Set(matched.map((m) => m.doc_id));
            if (matched.length === 0 && node.source_refs.length > 0) {
              const fallback = node.source_refs[0];
              matched.push({
                source_type: fallback.source_type,
                doc_id: fallback.doc_id,
                title: fallback.title,
                section_heading: fallback.section_heading,
                excerpt: fallback.excerpt,
              });
              seenDocIds.add(fallback.doc_id);
            }

            return {
              text: item.text,
              confidence: item.confidence,
              source_refs: matched,
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
      await ctx.onProgress(`Generated ${i + 1}/${entityPacks.length} entity pages`, pct);
    }
  }

  if (pages.length > 0) {
    await tc.entity_pages.deleteMany({ run_id: ctx.runId });
    await tc.entity_pages.insertMany(pages);
  }

  await ctx.onProgress(`Generated ${pages.length} entity pages`, 100);
  return {
    total_pages: pages.length,
    llm_calls: totalLLMCalls,
    by_type: pages.reduce((acc, p) => {
      acc[p.node_type] = (acc[p.node_type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };
};
