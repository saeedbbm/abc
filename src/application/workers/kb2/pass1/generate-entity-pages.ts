import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, getReasoningModel, getReasoningModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { cleanEntityTitle } from "@/src/application/lib/kb2/title-cleanup";
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

function summarizeEntityPageSample(
  page: KB2EntityPageType,
  extras?: { priority?: string; project_category?: string | null },
) {
  return {
    title: page.title,
    node_type: page.node_type,
    priority: extras?.priority ?? null,
    project_category: extras?.project_category ?? null,
    sections: page.sections.slice(0, 3).map((section) => ({
      section_name: section.section_name,
      items: section.items.slice(0, 3).map((item) => ({
        text: item.text,
        confidence: item.confidence,
        source_count: item.source_refs.length,
      })),
    })),
  };
}

function resolveEntityPageTitle(node: KB2GraphNodeType): string {
  const cleaned = cleanEntityTitle(node.display_name, node.type);
  if (node.type !== "decision") return cleaned;
  const patternRule = typeof node.attributes?.pattern_rule === "string"
    ? cleanEntityTitle(node.attributes.pattern_rule, "decision")
    : "";
  if (
    node.attributes?.is_convention === true &&
    patternRule &&
    (/^(going with\b|green\b)$/i.test(cleaned) || /\b(the|a|an|of|for|to|with|on|in)$/i.test(cleaned))
  ) {
    return patternRule;
  }

  if (/^Instead Of\b/i.test(cleaned)) {
    const sourceText = (node.source_refs ?? [])
      .map((ref) => `${ref.section_heading ?? ""}\n${ref.excerpt ?? ""}`)
      .join("\n");
    if (/\bsequentially\b/i.test(sourceText)) {
      return "Concurrent Processing Decision";
    }
  }

  return cleaned;
}

export const generateEntityPagesStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-gen-entity-pages");
  const stepId = "pass1-step-14";

  const retrievalArtifact = await ctx.getStepArtifact("pass1", 13);
  if (!retrievalArtifact?.retrieval_packs) throw new Error("No retrieval packs found — run step 13 first");

  const entityPacks = (retrievalArtifact.retrieval_packs as RetrievalPack[]).filter(
    (p) => p.page_type === "entity",
  );

  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  const nodeExecIds = [step9ExecId, step10ExecId].filter(Boolean);
  const nodesFilter = nodeExecIds.length > 0
    ? { execution_id: { $in: nodeExecIds } }
    : { run_id: ctx.runId };
  const nodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  const nodeById = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) nodeById.set(node.node_id, node);

  const planArtifact = await ctx.getStepArtifact("pass1", 12);
  const entityPlans = planArtifact?.entity_pages ?? [];

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  const pages: KB2EntityPageType[] = [];
  const pageSamples: ReturnType<typeof summarizeEntityPageSample>[] = [];
  const criticalPageSamples: ReturnType<typeof summarizeEntityPageSample>[] = [];
  let totalLLMCalls = 0;

  await ctx.onProgress(`Generating ${entityPacks.length} entity pages...`, 5);

  for (let i = 0; i < entityPacks.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const pack = entityPacks[i];
    const plan = entityPlans.find((p: any) => p.page_id === pack.page_id);
    if (!plan) continue;

    const node = nodeById.get(plan.node_id);
    if (!node) continue;
    const entityTitle = resolveEntityPageTitle(node);

    const isConventionNode = node.attributes?.is_convention === true;
    const useReasoning = node.type === "team_member" || isConventionNode;
    const pageModel = useReasoning ? getReasoningModel(ctx.config?.pipeline_settings?.models) : model;
    const pageModelName = useReasoning ? getReasoningModelName(ctx.config?.pipeline_settings?.models) : getFastModelName(ctx.config?.pipeline_settings?.models);

    const pgSettings = ctx.config?.pipeline_settings?.page_generation;
    const DOC_SNIPPETS = pgSettings?.doc_snippets_per_entity_page ?? 8;
    const VECTOR_SNIPPETS = pgSettings?.vector_snippets_per_entity_page ?? 6;

    const template = ctx.config?.entity_templates?.[node.type]
      ? (() => { const t = ctx.config!.entity_templates![node.type]!; return t.enabled !== false ? { description: t.description, includeRules: t.includeRules, excludeRules: t.excludeRules, sections: t.sections } : undefined; })()
      : getStaticEntityTemplate(node.type);
    const effectiveTemplate = template && isConventionNode && node.type === "decision"
      ? {
          ...template,
          excludeRules: "Low-level code snippets and file-by-file diffs. DO include concrete implementation prescriptions of this convention such as exact colors, layout direction, breakpoint behavior, data-loading thresholds, component behavior, and reusable UI rules.",
        }
      : template;
    const sectionInstructions = effectiveTemplate
      ? getSectionInstructionsKB2(effectiveTemplate)
      : "Generate relevant sections based on the entity type.";

    const sourceRefsList = node.source_refs.map((r) => `- "${r.title}" (${r.source_type})`).join("\n");
    const isConvention = node.attributes?.is_convention === true;
    const conventionContextLines: string[] = [];
    if (isConvention) {
      conventionContextLines.push("## Convention Attributes");
      conventionContextLines.push(`is_convention: true`);
      if (node.attributes?.pattern_rule) {
        conventionContextLines.push(`Pattern/Rule: ${node.attributes.pattern_rule}`);
      }
      if (node.attributes?.established_by) {
        conventionContextLines.push(`Established By: ${node.attributes.established_by}`);
      }
      if (Array.isArray(node.attributes?.constituent_decisions)) {
        conventionContextLines.push(`Constituent Decisions: ${node.attributes.constituent_decisions.join(", ")}`);
      }
      conventionContextLines.push("");
    }

    const context = [
      "## Graph Context",
      ...pack.graph_context,
      "",
      ...conventionContextLines,
      "## Available Source Documents (use these titles in source_excerpts)",
      sourceRefsList || "(no sources listed)",
      "",
      "## Document Snippets",
      ...pack.doc_snippets.slice(0, DOC_SNIPPETS),
      "",
      "## Vector Search Results",
      ...pack.vector_snippets.slice(0, VECTOR_SNIPPETS),
    ].join("\n");

    const conventionSectionOverride = isConvention
      ? `\nThis entity is a CONVENTION. Use the following section layout:
- Convention Rule: The core pattern, rule, or standard this convention encodes.
- Established By: Who introduced it, when, and why (team member, decision, PR, etc.).
- Evidence Trail: The constituent decisions, discussions, and artifacts that led to this convention.
- Applied On: Which features, services, or modules currently follow this convention.
- Future Applications: Where this convention should be applied next and any proposed changes.
- For conventions, INCLUDE concrete implementation prescriptions from the sources: exact colors, layout direction, breakpoint behavior, data-loading thresholds, component structure, and other reusable rules. Do not strip implementation detail just because this entity is a decision page.
`
      : "";

    let entityPageSystemPrompt = `You generate structured entity reference pages for a knowledge base.
Each page has sections with bullet-point items. Each item is a single factual statement.

${effectiveTemplate ? `Include rules: ${effectiveTemplate.includeRules}\nExclude rules: ${effectiveTemplate.excludeRules}\n` : ""}${conventionSectionOverride}
Section layout:
${isConvention ? "Convention Rule, Established By, Evidence Trail, Applied On, Future Applications" : sectionInstructions}

Rules:
- Each item must be a standalone factual statement in one short sentence. Active voice, plain English.
- No filler intros ("This entity represents...", "Based on the analysis..."). State the fact directly.
- No hedge words in items unless the source material itself is uncertain. No "may", "potentially", "appears to".
- One fact per bullet. If a bullet has more than 2 sentences, split it.
- For source_excerpts: you MUST list EVERY source document that supports this fact. For each, provide the document title (from "Available Source Documents") and an EXACT VERBATIM quote of 1-2 sentences copied directly from the Document Snippets or Vector Search Results that proves this fact. Do NOT paraphrase — copy the text exactly as it appears.
- You MUST check ALL Document Snippets and Vector Search Results for mentions of each fact. If a fact appears in 3 documents, all 3 must be listed.
- Rate confidence: high = multiple sources confirm, medium = single source, low = inferred/uncertain.
- Only include information supported by the provided context.
- If a section has no relevant data, return it with an empty items array.`;
    if (ctx.config?.prompts?.generate_entity_pages?.system) {
      entityPageSystemPrompt = ctx.config.prompts.generate_entity_pages.system
        .replace(/\$\{template_rules\}/g, effectiveTemplate ? `Include rules: ${effectiveTemplate.includeRules}\nExclude rules: ${effectiveTemplate.excludeRules}` : "")
        .replace(/\$\{section_instructions\}/g, sectionInstructions);
    }

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model: pageModel,
      system: entityPageSystemPrompt,
      prompt: `Generate the entity page for "${entityTitle}" (type: ${node.type}).

${context}`,
      schema: GeneratedSectionSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;
    if (usageData) {
      const cost = calculateCostUsd(pageModelName, usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, pageModelName, `Entity page: ${entityTitle}`, JSON.stringify(result, null, 2).slice(0, 5000), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    const requirement = template?.sections ?? [];
    const page: KB2EntityPageType = {
      page_id: pack.page_id,
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      node_id: node.node_id,
      node_type: node.type,
      title: entityTitle,
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
    const pagePlanMeta = plan as { priority?: string; project_category?: string | null };
    const sample = summarizeEntityPageSample(page, pagePlanMeta);
    if (pageSamples.length < 5) {
      pageSamples.push(sample);
    }
    const isCriticalPage =
      node.attributes?.is_convention === true ||
      ["proposed_projects", "past_undocumented", "ongoing_undocumented"].includes(
        pagePlanMeta.project_category ?? "",
      );
    if (isCriticalPage && criticalPageSamples.length < 8) {
      criticalPageSamples.push(sample);
    }

    if ((i + 1) % 5 === 0 || i === entityPacks.length - 1) {
      const pct = Math.round(5 + ((i + 1) / entityPacks.length) * 90);
      await ctx.onProgress(`Generated ${i + 1}/${entityPacks.length} entity pages`, pct);
    }
  }

  if (pages.length > 0) {
    await tc.entity_pages.insertMany(pages);
  }

  const plannedRepositoryPages = Array.isArray(entityPlans)
    ? entityPlans.filter((plan: any) => plan.node_type === "repository")
    : [];
  const generatedProjectPagesByCategory = pages.reduce<Record<string, string[]>>((acc, page) => {
    if (page.node_type !== "project") return acc;
    const plan = entityPlans.find((candidate: any) => candidate.page_id === page.page_id);
    const category = typeof plan?.project_category === "string" ? plan.project_category : null;
    if (!category) return acc;
    (acc[category] ??= []).push(page.title);
    return acc;
  }, {});
  for (const titles of Object.values(generatedProjectPagesByCategory)) {
    titles.sort((a, b) => a.localeCompare(b));
  }

  await ctx.onProgress(`Generated ${pages.length} entity pages`, 100);
  return {
    total_pages: pages.length,
    llm_calls: totalLLMCalls,
    by_type: pages.reduce((acc, p) => {
      acc[p.node_type] = (acc[p.node_type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    planned_repository_page_count: plannedRepositoryPages.length,
    repository_page_titles: pages
      .filter((page) => page.node_type === "repository")
      .map((page) => page.title)
      .sort((a, b) => a.localeCompare(b)),
    generated_project_pages_by_category: generatedProjectPagesByCategory,
    page_samples: pageSamples,
    critical_page_samples: criticalPageSamples,
    critical_page_titles: criticalPageSamples.map((sample) => sample.title),
  };
};
