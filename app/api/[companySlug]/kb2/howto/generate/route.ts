import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { getReasoningModel } from "@/lib/ai-model";
import { getTenantCollections } from "@/lib/mongodb";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { getCompanyConfig } from "@/src/application/lib/kb2/company-config";
import {
  KB2GeneratedHowtoResultSchema,
  normalizeGeneratedHowtoSections,
} from "@/src/application/lib/kb2/howto-structure";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import {
  buildParsedDocLookup,
  dedupeHowtoEvidenceRefs,
} from "@/src/application/lib/kb2/howto-context";
import { buildNodeOwnerMap, getPrimaryOwnerName } from "@/src/application/lib/kb2/owner-resolution";
import { buildPlanSectionEvidence } from "@/src/application/lib/kb2/plan-evidence";
import { getLatestCompletedRunId, getLatestRunIdFromCollection } from "@/src/application/lib/kb2/run-scope";
import { buildPlanTitle } from "@/src/application/lib/kb2/title-cleanup";
import {
  buildBaselineRunFilter,
  buildStateFilter,
  ensureWritableDemoState,
} from "@/src/application/lib/kb2/demo-state";
import { buildHowtoEvidencePack, renderEvidencePackPrompt } from "@/src/application/lib/kb2/howto-evidence-pack";
import { PrefixLogger } from "@/lib/utils";
import type {
  KB2EntityPageType,
  KB2EvidenceRefType,
  KB2GraphEdgeType,
  KB2GraphNodeType,
} from "@/src/entities/models/kb2-types";

const HOWTO_TEMPLATE_SECTIONS = [
  "Overview",
  "Context",
  "Requirements",
  "Implementation Steps",
  "Testing Plan",
  "Risks and Considerations",
  "Prompt Section",
];

const EVIDENCE_FIRST_SYSTEM_PROMPT = `You generate implementation plan documents for engineering work items.
Each plan has sections that must be filled with specific, actionable content.

Sections: \${howto_sections}

Rules:
- Overview: 2-3 sentences explaining what this work is and why it matters.
- Context: What existing patterns, systems, and decisions are relevant. Reference the convention names and owners provided in the evidence.
- Requirements: Concrete acceptance criteria derived from the evidence. Cite source artifacts.
- Implementation Steps: Return 4-7 explicit step objects in the steps array. Each step needs a short title plus 2-4 sentences of prose.
- Testing Plan: What tests to write and edge cases to cover.
- Risks and Considerations: What could go wrong.
- Prompt Section: If an AI agent were implementing this, what prompt/instructions would you give it?

EVIDENCE-FIRST GENERATION:
- You are given a structured evidence pack containing convention constraints, implementation precedents, customer feedback, and identified gaps.
- EVERY implementation step must be one of:
  (a) An EVIDENCE-BACKED step: derived from convention constraints, implementation precedents, or customer feedback in the evidence pack. Cite the specific source artifact in evidence_hints.
  (b) A NEW-WORK-TO-DEFINE step: when no evidence exists. Mark it explicitly by starting the step prose with "New work to define:".

CONVENTION RULES:
- When Convention Constraints are provided, you MUST name each convention and its owner explicitly.
- For each convention, state: what it means for THIS specific feature, the exact implementation choice it implies, and the source artifact that proves it.
- Do NOT reduce conventions to vague mentions like "follow established patterns."

IMPLEMENTATION PRECEDENT RULES:
- READ THE RAW SOURCE EVIDENCE CAREFULLY. It contains PR review comments, Slack discussions, and design decisions with specific implementation details.
- Extract EVERY specific implementation pattern you find in the source evidence, including but not limited to:
  * Image loading: lazy loading, skeleton loading states, species-specific image fallbacks
  * Grid layout: responsive breakpoints, minimum touch target sizes, mobile nav accommodations
  * Component architecture: React.memo + useCallback for card grids, Promise.all for parallel API calls, shared Toast components, CSS transitions
  * Navigation: vertical vs horizontal layout choices, sidebar scroll behavior, panel width splits, form column layouts
  * API design: response envelope shapes, pagination strategies, date formats, idempotent DELETE, validation patterns
  * File conventions: CSS Modules, page folder structure, controller/routes/model patterns
  * Testing: exact test frameworks, known issues
  * Process: PR review assignments, merge strategy
- If a pattern appears in the source evidence, it MUST appear in the implementation plan.
- Cite the precedent name and source when using a pattern.
- You may reference exact API paths and identifiers that appear in the evidence.
- Name the person who established each pattern when the evidence shows authorship.

PROPOSED FEATURE RULES:
- For proposed features, do NOT invent exact API endpoint paths, database schemas, or contract details that are not in the evidence.
- Mark new contracts as "new work to define."

FORMATTING:
- Each implementation step must list supporting artifact titles in evidence_hints.
- Write like a knowledgeable teammate: short sentences, active voice, plain English.
- No filler intros, hedge words, or generic advice.`;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const config = await getCompanyConfig(companySlug);
  const body = await request.json();
  const { ticket_id, project_node_id } = body;
  const writableState = await ensureWritableDemoState(tc, companySlug);
  let scopedRunId =
    body.run_id
    ?? writableState.base_run_id
    ?? await getLatestRunIdFromCollection(tc, companySlug, {
      distinct: (field: string) => tc.entity_pages.distinct(field, { demo_state_id: { $exists: false } }),
    })
    ?? await getLatestRunIdFromCollection(tc, companySlug, {
      distinct: (field: string) => tc.tickets.distinct(field, { demo_state_id: { $exists: false } }),
    })
    ?? await getLatestCompletedRunId(tc, companySlug);

  const templateSections = config?.pipeline_settings?.howto?.sections ?? HOWTO_TEMPLATE_SECTIONS;
  let title = "Implementation Plan";
  let ownerName = "";
  const linkedEntityIds = new Set<string>();
  const contextPages: KB2EntityPageType[] = [];

  async function loadEntityPagesByNodeIds(nodeIds: string[]): Promise<KB2EntityPageType[]> {
    const ids = [...new Set(nodeIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const statePages = await tc.entity_pages.find({
      node_id: { $in: ids },
      ...buildStateFilter(writableState.state_id),
    }).toArray() as unknown as KB2EntityPageType[];
    const seenNodeIds = new Set(statePages.map((page) => page.node_id));
    if (!scopedRunId || seenNodeIds.size === ids.length) return statePages;
    const remainingIds = ids.filter((id) => !seenNodeIds.has(id));
    if (remainingIds.length === 0) return statePages;
    const baselinePages = await tc.entity_pages.find({
      node_id: { $in: remainingIds },
      ...buildBaselineRunFilter(scopedRunId),
    }).toArray() as unknown as KB2EntityPageType[];
    const seenAfterBaseline = new Set([...statePages, ...baselinePages].map((page) => page.node_id));
    const rawFallbackIds = ids.filter((id) => !seenAfterBaseline.has(id));
    if (rawFallbackIds.length === 0) return [...statePages, ...baselinePages];
    const rawFallbackPages = await tc.entity_pages.find({
      node_id: { $in: rawFallbackIds },
    }).toArray() as unknown as KB2EntityPageType[];
    const deduped = new Map<string, KB2EntityPageType>();
    for (const page of [...statePages, ...baselinePages, ...rawFallbackPages]) {
      if (!deduped.has(page.node_id)) deduped.set(page.node_id, page);
    }
    return Array.from(deduped.values());
  }

  async function loadGraphNodes(filter: Record<string, unknown>): Promise<KB2GraphNodeType[]> {
    const stateNodes = await tc.graph_nodes.find({
      ...filter,
      ...buildStateFilter(writableState.state_id),
    }).toArray() as unknown as KB2GraphNodeType[];
    if (!scopedRunId) return stateNodes;
    const baselineNodes = await tc.graph_nodes.find({
      ...filter,
      ...buildBaselineRunFilter(scopedRunId),
    }).toArray() as unknown as KB2GraphNodeType[];
    const deduped = new Map<string, KB2GraphNodeType>();
    for (const node of [...stateNodes, ...baselineNodes]) {
      if (!deduped.has(node.node_id)) deduped.set(node.node_id, node);
    }
    return Array.from(deduped.values());
  }

  async function loadGraphEdges(filter: Record<string, unknown>): Promise<KB2GraphEdgeType[]> {
    const stateEdges = await tc.graph_edges.find({
      ...filter,
      ...buildStateFilter(writableState.state_id),
    }).toArray() as unknown as KB2GraphEdgeType[];
    if (!scopedRunId) return stateEdges;
    const baselineEdges = await tc.graph_edges.find({
      ...filter,
      ...buildBaselineRunFilter(scopedRunId),
    }).toArray() as unknown as KB2GraphEdgeType[];
    const deduped = new Map<string, KB2GraphEdgeType>();
    for (const edge of [...stateEdges, ...baselineEdges]) {
      if (!deduped.has(edge.edge_id)) deduped.set(edge.edge_id, edge);
    }
    return Array.from(deduped.values());
  }

  let selectedProjectNode: KB2GraphNodeType | null = null;
  let graphNodes: KB2GraphNodeType[] = [];
  let graphEdges: KB2GraphEdgeType[] = [];
  let entityPages: KB2EntityPageType[] = [];

  if (ticket_id) {
    const ticket = await tc.tickets.findOne({ ticket_id, ...buildStateFilter(writableState.state_id) });
    if (ticket) {
      if (typeof ticket.run_id === "string" && ticket.run_id.trim().length > 0) {
        scopedRunId = ticket.run_id;
      }
      title = buildPlanTitle(String((ticket as any).title ?? ticket_id));
      ownerName =
        (Array.isArray((ticket as any).assignees) ? (ticket as any).assignees[0] : null)
        ?? ((ticket as any).owner_name || "")
        ?? "";
      for (const entityId of ((ticket as any).linked_entity_ids ?? []) as string[]) {
        if (entityId) linkedEntityIds.add(entityId);
      }
      const linkedPages = await loadEntityPagesByNodeIds([...linkedEntityIds]);
      contextPages.push(...linkedPages);
      entityPages.push(...linkedPages);
    }
  }

  if (project_node_id) {
    const projectNodes = await loadGraphNodes({ node_id: project_node_id });
    selectedProjectNode = projectNodes[0] ?? null;

    const projectPages = await loadEntityPagesByNodeIds([project_node_id]);
    const page = projectPages[0] ?? null;
    if (page) {
      title = buildPlanTitle((page as any).title ?? project_node_id);
      if (!scopedRunId && typeof (page as any).run_id === "string" && (page as any).run_id.trim().length > 0) {
        scopedRunId = (page as any).run_id;
      }
      linkedEntityIds.add(project_node_id);
      contextPages.push(page);
    } else if (selectedProjectNode) {
      title = buildPlanTitle(selectedProjectNode.display_name ?? project_node_id);
      linkedEntityIds.add(project_node_id);
    }

    const edgeFilter = {
      $or: [{ source_node_id: project_node_id }, { target_node_id: project_node_id }],
    };
    graphEdges = await loadGraphEdges(edgeFilter);

    const relatedIds = new Set<string>();
    for (const e of graphEdges) {
      relatedIds.add(e.source_node_id as string);
      relatedIds.add(e.target_node_id as string);
    }
    relatedIds.delete(project_node_id);

    graphNodes = await loadGraphNodes({ node_id: { $in: [project_node_id, ...relatedIds] } });

    // Load all convention nodes and project nodes for the evidence pack builder
    const allConventionNodes = await loadGraphNodes({
      "attributes.is_convention": true,
    });
    const allProjectNodes = await loadGraphNodes({
      type: { $in: ["project", "pull_request"] },
    });
    const seenNodeIds = new Set(graphNodes.map((n) => n.node_id));
    for (const n of [...allConventionNodes, ...allProjectNodes]) {
      if (!seenNodeIds.has(n.node_id)) {
        graphNodes.push(n);
        seenNodeIds.add(n.node_id);
      }
    }

    // Load all edges involving convention nodes for APPLIES_TO traversal
    const conventionNodeIds = allConventionNodes.map((n) => n.node_id);
    if (conventionNodeIds.length > 0) {
      const conventionEdges = await loadGraphEdges({
        $or: [
          { source_node_id: { $in: conventionNodeIds } },
          { target_node_id: { $in: conventionNodeIds } },
        ],
      });
      const existingEdgeIds = new Set(graphEdges.map((e) => e.edge_id));
      for (const e of conventionEdges) {
        if (!existingEdgeIds.has(e.edge_id)) {
          graphEdges.push(e);
          existingEdgeIds.add(e.edge_id);
        }
      }
    }

    const ownershipMap = buildNodeOwnerMap(graphNodes, graphEdges);
    ownerName = ownerName || getPrimaryOwnerName(selectedProjectNode, ownershipMap) || "";

    entityPages = await loadEntityPagesByNodeIds([project_node_id, ...relatedIds]);
    contextPages.push(...entityPages.filter((p) => !contextPages.some((cp) => cp.page_id === p.page_id)));

    // Also load all decision/project entity pages for broader precedent coverage
    const allDecisionPages = await tc.entity_pages.find({
      node_type: { $in: ["decision", "project", "pull_request"] },
      ...(scopedRunId ? buildBaselineRunFilter(scopedRunId) : {}),
    }).limit(200).toArray() as unknown as KB2EntityPageType[];

    const existingPageIds = new Set(entityPages.map((p) => p.page_id));
    for (const p of allDecisionPages) {
      if (!existingPageIds.has(p.page_id)) {
        entityPages.push(p);
        existingPageIds.add(p.page_id);
      }
    }
  }

  const latestSnapshot = scopedRunId
    ? await tc.input_snapshots.findOne(
        { run_id: scopedRunId },
        { sort: { created_at: -1 } },
      ) as { parsed_documents?: KB2ParsedDocument[] } | null
    : null;
  const parsedDocs = (latestSnapshot?.parsed_documents ?? []) as KB2ParsedDocument[];
  const parsedDocLookup = buildParsedDocLookup(parsedDocs);
  const ownershipMap = buildNodeOwnerMap(graphNodes, graphEdges);

  let evidencePrompt = "";
  let evidencePackDebug: Record<string, unknown> | null = null;
  if (selectedProjectNode) {
    const evidencePack = buildHowtoEvidencePack({
      targetNode: selectedProjectNode,
      graphNodes,
      graphEdges,
      entityPages,
      parsedDocLookup,
      ownershipMap,
    });
    evidencePrompt = renderEvidencePackPrompt(evidencePack);
    evidencePackDebug = {
      convention_count: evidencePack.convention_constraints.length,
      convention_titles: evidencePack.convention_constraints.map((c) => c.title),
      precedent_count: evidencePack.implementation_precedents.length,
      precedent_titles: evidencePack.implementation_precedents.map((p) => p.title),
      precedent_item_counts: evidencePack.implementation_precedents.map((p) => ({
        title: p.title,
        items: p.relevant_items.length,
        raw_units: p.raw_source_units.length,
      })),
      feedback_count: evidencePack.customer_feedback.length,
      diagnostics: evidencePack.diagnostics,
      gaps: evidencePack.gaps,
      evidence_prompt_length: evidencePrompt.length,
    };
  }

  const systemPrompt = (config?.prompts?.howto_on_demand?.system ?? EVIDENCE_FIRST_SYSTEM_PROMPT)
    .replace(/\$\{howto_sections\}/g, templateSections.join(", "));

  const logger = new PrefixLogger("kb2-howto-on-demand");

  const result = await structuredGenerate({
    model: getReasoningModel(config?.pipeline_settings?.models),
    system: systemPrompt,
    prompt: `Generate an implementation plan for this proposed project.

${evidencePrompt}

## Output Reminders
- Fill every requested section.
- For Implementation Steps, populate the steps array with titled prose steps.
- Each step must be either EVIDENCE-BACKED (cite artifacts in evidence_hints) or NEW-WORK-TO-DEFINE (start prose with "New work to define:").
- Name convention owners explicitly when applying their conventions.
- Use exact values from the evidence: colors, breakpoints, pixel sizes, component names, API paths.
- When no evidence supports a detail, mark it as new work to define rather than inventing it.`,
    schema: KB2GeneratedHowtoResultSchema,
    logger,
    maxOutputTokens: config?.pipeline_settings?.howto_on_demand?.max_output_tokens ?? 4096,
  });

  const normalizedSections = normalizeGeneratedHowtoSections(result.sections ?? [], templateSections)
    .filter((section) => section.section_name !== "Prompt Section");

  for (const entityId of result.linked_entity_ids ?? []) {
    if (entityId) linkedEntityIds.add(entityId);
  }

  const fallbackEvidenceRefs = dedupeHowtoEvidenceRefs(
    entityPages.flatMap((page) =>
      page.sections.flatMap((s) =>
        s.items.flatMap((item) => (item.source_refs ?? []) as KB2EvidenceRefType[]),
      ),
    ),
  );

  const sectionsWithEvidence = buildPlanSectionEvidence(normalizedSections, {
    entityPages: Array.from(
      new Map(contextPages.map((page) => [page.page_id, page])).values(),
    ),
    fallbackSourceRefs: fallbackEvidenceRefs,
  });

  for (const section of sectionsWithEvidence) {
    for (const ref of section.entity_refs ?? []) linkedEntityIds.add(ref.node_id);
    for (const step of section.steps ?? []) {
      for (const ref of step.entity_refs ?? []) linkedEntityIds.add(ref.node_id);
    }
  }

  const howtoId = randomUUID();
  const doc = {
    howto_id: howtoId,
    run_id: scopedRunId,
    demo_state_id: writableState.state_id,
    company_slug: companySlug,
    ticket_id: ticket_id ?? null,
    project_node_id: project_node_id ?? null,
    title,
    sections: sectionsWithEvidence,
    linked_entity_ids: [...linkedEntityIds],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    plan_status: "draft",
    owner_name: ownerName,
    reviewers: [],
    discussion: [],
  };

  await tc.howto.insertOne(doc);

  return Response.json({ howto: doc, _evidence_debug: evidencePackDebug });
}
