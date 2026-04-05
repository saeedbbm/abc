import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, getReasoningModel, getReasoningModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { STANDARD_HUMAN_PAGES } from "@/src/entities/models/kb2-templates";
import { getHumanPages } from "@/src/application/lib/kb2/company-config";
import { PROJECT_CATEGORIES, classifyProjectCategory } from "./page-plan";
import type { KB2EntityPageType, KB2GraphNodeType, KB2HumanPageType, KB2HumanPageLayer } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const PROPOSED_TICKET_CATEGORIES = new Set([
  "proposed_ticket",
  "proposed_from_feedback",
]);

const CATEGORIES_NEEDING_REASONING = new Set([
  "architecture_overview",
  "decision_index",
  "hidden_conventions",
  "decisions_tradeoffs",
]);

const COMPANY_OVERVIEW_FALLBACK_TYPES = ["repository", "project", "team", "team_member"] as const;

const GeneratedHumanPageSchema = z.object({
  paragraphs: z.array(z.object({
    heading: z.string(),
    body: z.string().describe("1-2 context sentences then bullet points (- item). NEVER a single block of prose. Use \\n between lines."),
    entity_refs: z.array(z.string()),
    used_items: z.array(z.object({
      entity_name: z.string(),
      section_name: z.string(),
      item_index: z.number(),
    })).describe("Which AI page items were used to write this paragraph"),
  })),
});

function summarizeHumanPageSample(page: KB2HumanPageType) {
  return {
    title: page.title,
    category: page.category,
    linked_entity_page_ids: page.linked_entity_page_ids.slice(0, 8),
    paragraphs: page.paragraphs.slice(0, 2).map((paragraph) => ({
      heading: paragraph.heading,
      body: paragraph.body.slice(0, 500),
      entity_refs: paragraph.entity_refs,
      source_items_count: paragraph.source_items.length,
    })),
  };
}

function isPlaceholderHumanPage(page: KB2HumanPageType | null | undefined): boolean {
  if (!page) return true;
  if ((page.linked_entity_page_ids ?? []).length > 0) return false;
  const paragraphs = page.paragraphs ?? [];
  if (paragraphs.length === 0) return true;
  return paragraphs.every((paragraph) => /^No .* data has been discovered yet\./i.test(paragraph.body?.trim() ?? ""));
}

export const generateHumanPagesStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-gen-human-pages");
  const stepId = "pass1-step-15";
  const tc = getTenantCollections(ctx.companySlug);

  const epExecId = await ctx.getStepExecutionId("pass1", 14);
  const epFilter = epExecId ? { execution_id: epExecId } : { run_id: ctx.runId };
  const entityPages = (await tc.entity_pages.find(epFilter).toArray()) as unknown as KB2EntityPageType[];
  if (entityPages.length === 0) throw new Error("No entity pages found — run step 14 first");

  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  const nodeExecIds = [step9ExecId, step10ExecId].filter(Boolean);
  const nodesFilter = nodeExecIds.length > 0
    ? { execution_id: { $in: nodeExecIds } }
    : { run_id: ctx.runId };
  const graphNodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  const nodeById = new Map<string, KB2GraphNodeType>();
  for (const n of graphNodes) nodeById.set(n.node_id, n);

  const proposedTicketNodeIds = new Set(
    graphNodes
      .filter((n) => n.type === "ticket" && PROPOSED_TICKET_CATEGORIES.has(n.attributes?.discovery_category))
      .map((n) => n.node_id),
  );
  const filteredEntityPages = entityPages.filter(
    (ep) => !proposedTicketNodeIds.has(ep.node_id),
  );

  const planArtifact = await ctx.getStepArtifact("pass1", 12);
  const humanPlans = planArtifact?.human_pages ?? [];

  const entityPageByNodeType = new Map<string, KB2EntityPageType[]>();
  for (const ep of filteredEntityPages) {
    const arr = entityPageByNodeType.get(ep.node_type) ?? [];
    arr.push(ep);
    entityPageByNodeType.set(ep.node_type, arr);
  }

  const entityPageByName = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) {
    entityPageByName.set(ep.title.toLowerCase(), ep);
  }
  const entityPageById = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) {
    entityPageById.set(ep.page_id, ep);
    entityPageById.set(ep.node_id, ep);
  }

  const pages: KB2HumanPageType[] = [];
  const pageSamples: ReturnType<typeof summarizeHumanPageSample>[] = [];
  const criticalPageSamples: ReturnType<typeof summarizeHumanPageSample>[] = [];
  let totalLinkedEntityPageIds = 0;
  let validLinkedEntityPageIds = 0;
  const validEntityPageIds = new Set(entityPages.map((page) => page.page_id));
  let totalLLMCalls = 0;

  await ctx.onProgress(`Generating ${humanPlans.length} human pages from AI pages...`, 5);

  for (let i = 0; i < humanPlans.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const plan = humanPlans[i];
    const humanPageDefs = ctx.config ? await getHumanPages(ctx.companySlug) : STANDARD_HUMAN_PAGES;
    const hpDef = humanPageDefs.find((hp) => hp.category === plan.category)
      ?? STANDARD_HUMAN_PAGES.find((hp) => hp.category === plan.category);
    if (!hpDef) continue;

    const useReasoning = CATEGORIES_NEEDING_REASONING.has(plan.category);
    const model = useReasoning ? getReasoningModel(ctx.config?.pipeline_settings?.models) : getFastModel(ctx.config?.pipeline_settings?.models);
    const modelName = useReasoning ? getReasoningModelName(ctx.config?.pipeline_settings?.models) : getFastModelName(ctx.config?.pipeline_settings?.models);

    const pgSettings = ctx.config?.pipeline_settings?.page_generation;
    const MAX_ENTITY_PAGES = pgSettings?.max_entity_pages_per_human_page ?? 25;

    const relatedPages: KB2EntityPageType[] = [];
    const isProjectCategory = PROJECT_CATEGORIES.has(plan.category);
    for (const entityType of hpDef.relatedEntityTypes) {
      const pagesOfType = entityPageByNodeType.get(entityType) ?? [];
      if (isProjectCategory && entityType === "project") {
        const filtered = pagesOfType.filter((ep) => {
          const node = nodeById.get(ep.node_id);
          return node && classifyProjectCategory(node) === plan.category;
        });
        relatedPages.push(...filtered);
      } else {
        relatedPages.push(...pagesOfType);
      }
    }
    let filteredRelatedPages = relatedPages;
    if (hpDef.category === "hidden_conventions") {
      const conventionPages = relatedPages.filter((ep) => {
        const node = nodeById.get(ep.node_id);
        return node?.type === "team_member" || node?.attributes?.is_convention === true;
      });
      if (conventionPages.length > 0) {
        filteredRelatedPages = conventionPages;
      } else {
        filteredRelatedPages = relatedPages.filter((ep) => {
          const node = nodeById.get(ep.node_id);
          if (!node) return false;
          if (node.type === "team_member") return true;
          if (node.type === "decision") {
            const attrs = node.attributes as Record<string, any> | undefined;
            return attrs?.is_convention === true
              || typeof attrs?.pattern_rule === "string"
              || typeof attrs?.established_by === "string";
          }
          return false;
        });
      }
    }
    let cappedPages = filteredRelatedPages.slice(0, MAX_ENTITY_PAGES);

    if (cappedPages.length === 0 && hpDef.category === "company_overview") {
      const fallbackPages = filteredEntityPages
        .filter((page) => COMPANY_OVERVIEW_FALLBACK_TYPES.includes(page.node_type as typeof COMPANY_OVERVIEW_FALLBACK_TYPES[number]))
        .sort((a, b) => {
          const typeDelta =
            COMPANY_OVERVIEW_FALLBACK_TYPES.indexOf(a.node_type as typeof COMPANY_OVERVIEW_FALLBACK_TYPES[number]) -
            COMPANY_OVERVIEW_FALLBACK_TYPES.indexOf(b.node_type as typeof COMPANY_OVERVIEW_FALLBACK_TYPES[number]);
          if (typeDelta !== 0) return typeDelta;
          return a.title.localeCompare(b.title);
        })
        .slice(0, MAX_ENTITY_PAGES);
      cappedPages = fallbackPages;
    }

    if (cappedPages.length === 0) {
      const page: KB2HumanPageType = {
        page_id: plan.page_id,
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        title: hpDef.title,
        layer: hpDef.layer as KB2HumanPageLayer,
        category: hpDef.category,
        paragraphs: [{
          heading: hpDef.title,
          body: `No ${hpDef.title.toLowerCase()} data has been discovered yet. This page will be populated when relevant information is ingested.`,
          entity_refs: [],
          entity_node_ids: [],
          source_items: [],
        }],
        linked_entity_page_ids: [],
      };
      pages.push(page);
      if ((i + 1) % 3 === 0 || i === humanPlans.length - 1) {
        const pct = Math.round(5 + ((i + 1) / humanPlans.length) * 90);
        await ctx.onProgress(`Generated ${i + 1}/${humanPlans.length} human pages`, pct);
      }
      continue;
    }

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
    const conventionCategoryPrompt = plan.category === "hidden_conventions"
      ? `\nSPECIAL INSTRUCTIONS for Hidden Conventions page:
- Focus on patterns, rules, and standards that are implicitly followed but not formally documented.
- For each convention, explain: (1) What the rule/pattern is, (2) Who established it and how, (3) Where it is currently applied, (4) What evidence (decisions, PRs, discussions) supports its existence.
- Highlight conventions that span multiple teams or services.
- If a convention has constituent decisions, trace the evidence trail.
- Flag conventions at risk of being lost (e.g. established by a single person, no documentation).
`
      : "";

    let humanPageSystemPrompt = `You generate human-readable concept hub pages for a company knowledge base.
These pages synthesize information from AI entity pages into coherent, well-structured prose.

Page: "${hpDef.title}"
Layer: ${hpDef.layer}
Purpose: ${hpDef.description}
${conventionCategoryPrompt}
Rules:
- Write like a knowledgeable colleague explaining things to a new team member. Short sentences, active voice, plain English.
- FORMATTING IS CRITICAL: Every paragraph MUST follow this structure:
  1. Start with 1-2 short sentences that set context.
  2. Then list the key details as bullet points, one fact per bullet. Use "- " as the bullet marker.
  3. NEVER write a paragraph as one continuous block of text. Always break facts into bullets.
  Example:
    The platform connects users with partner locations.
    - 12 active partners across 3 regions
    - Supports browsing, applications, and transactions
    - Staff manage data through a dedicated dashboard
- Each paragraph should have a descriptive heading.
- No filler intros ("Based on the analysis...", "This section covers..."). Get to the content directly.
- No hedge words ("may", "potentially", "appears to") unless the source material itself is uncertain.
- Name people, teams, and systems specifically using the names from the AI entity pages. Do not use vague phrases like "a team member established a pattern" — use the actual person and convention names from the data.
- For entity_refs: list the DISPLAY NAMES (e.g. "Priya Nair", "brewgo-api", "PostgreSQL") of entities mentioned in the paragraph. NEVER use IDs or UUIDs — only human-readable names from the "##" headers of the AI entity pages.
- ONLY include information from the provided AI entity pages — do not invent facts.
- Write 3-8 paragraphs depending on available information.
- For used_items: list which entity page items you used to write each paragraph.
  Use the entity display name (from the "##" header), section name, and item index from the AI pages.
  This creates traceability from human content back to structured AI data.`;
    if (ctx.config?.prompts?.generate_human_pages?.system) {
      humanPageSystemPrompt = ctx.config.prompts.generate_human_pages.system
        .replace(/\$\{page_title\}/g, hpDef.title)
        .replace(/\$\{page_layer\}/g, hpDef.layer)
        .replace(/\$\{page_description\}/g, hpDef.description);
    }

    const result = await structuredGenerate({
      model,
      system: humanPageSystemPrompt,
      prompt: `Generate the "${hpDef.title}" page from these AI entity pages:

${entityPagesContext}`,
      schema: GeneratedHumanPageSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;
    if (usageData) {
      const cost = calculateCostUsd(modelName, usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, modelName, `Human page: ${hpDef.title}`, JSON.stringify(result, null, 2).slice(0, 5000), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    const linkedEntityPageIds = cappedPages.map((ep) => ep.page_id).filter(Boolean);

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

      const entityNodeIds = (p.entity_refs ?? [])
        .map((name) => {
          const lower = name.toLowerCase();
          const node = graphNodes.find((n) =>
            n.display_name.toLowerCase() === lower ||
            n.aliases.some((a) => a.toLowerCase() === lower),
          );
          return node?.node_id;
        })
        .filter(Boolean) as string[];

      return {
        heading: p.heading,
        body: p.body,
        entity_refs: p.entity_refs,
        entity_node_ids: entityNodeIds,
        source_items: sourceItems,
      };
    });

    const page: KB2HumanPageType = {
      page_id: plan.page_id,
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      title: hpDef.title,
      layer: hpDef.layer as KB2HumanPageLayer,
      category: hpDef.category,
      paragraphs,
      linked_entity_page_ids: linkedEntityPageIds,
    };

    pages.push(page);
    totalLinkedEntityPageIds += page.linked_entity_page_ids.length;
    validLinkedEntityPageIds += page.linked_entity_page_ids.filter((id) => validEntityPageIds.has(id)).length;
    const sample = summarizeHumanPageSample(page);
    if (pageSamples.length < 5) {
      pageSamples.push(sample);
    }
    if (
      ["hidden_conventions", "proposed_projects", "past_undocumented", "ongoing_undocumented"].includes(
        page.category,
      ) &&
      criticalPageSamples.length < 6
    ) {
      criticalPageSamples.push(sample);
    }

    if ((i + 1) % 3 === 0 || i === humanPlans.length - 1) {
      const pct = Math.round(5 + ((i + 1) / humanPlans.length) * 90);
      await ctx.onProgress(`Generated ${i + 1}/${humanPlans.length} human pages`, pct);
    }
  }

  if (pages.length > 0) {
    await tc.human_pages.insertMany(pages);
  }

  const companyOverviewPage = pages.find((page) => page.category === "company_overview") ?? null;
  const pageTitlesByCategory = pages.reduce<Record<string, string[]>>((acc, page) => {
    (acc[page.category] ??= []).push(page.title);
    return acc;
  }, {});
  for (const titles of Object.values(pageTitlesByCategory)) {
    titles.sort((a, b) => a.localeCompare(b));
  }
  const projectHubLinkStats = pages
    .filter((page) => PROJECT_CATEGORIES.has(page.category))
    .map((page) => {
      const linkedPages = (page.linked_entity_page_ids ?? [])
        .map((id) => entityPageById.get(id))
        .filter(Boolean) as KB2EntityPageType[];
      const byType = linkedPages.reduce<Record<string, number>>((acc, linkedPage) => {
        acc[linkedPage.node_type] = (acc[linkedPage.node_type] ?? 0) + 1;
        return acc;
      }, {});
      return {
        category: page.category,
        linked_total: linkedPages.length,
        linked_project_count: byType.project ?? 0,
        linked_team_member_count: byType.team_member ?? 0,
        linked_other_count: linkedPages.length - (byType.project ?? 0) - (byType.team_member ?? 0),
        linked_project_titles: linkedPages
          .filter((linkedPage) => linkedPage.node_type === "project")
          .map((linkedPage) => linkedPage.title)
          .sort((a, b) => a.localeCompare(b)),
      };
    });

  await ctx.onProgress(`Generated ${pages.length} human pages`, 100);
  return {
    total_pages: pages.length,
    llm_calls: totalLLMCalls,
    by_layer: pages.reduce((acc, p) => {
      acc[p.layer] = (acc[p.layer] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    page_samples: pageSamples,
    critical_page_samples: criticalPageSamples,
    critical_page_titles: criticalPageSamples.map((sample) => sample.title),
    page_titles: pages.map((page) => page.title).sort((a, b) => a.localeCompare(b)),
    page_titles_by_category: pageTitlesByCategory,
    company_overview: {
      exists: Boolean(companyOverviewPage),
      placeholder: isPlaceholderHumanPage(companyOverviewPage),
      linked_entity_page_count: companyOverviewPage?.linked_entity_page_ids.length ?? 0,
    },
    project_hub_link_stats: projectHubLinkStats,
    linked_entity_page_id_stats: {
      total: totalLinkedEntityPageIds,
      valid: validLinkedEntityPageIds,
      invalid: Math.max(0, totalLinkedEntityPageIds - validLinkedEntityPageIds),
    },
  };
};
