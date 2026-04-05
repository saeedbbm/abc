import { randomUUID } from "crypto";
import { getTenantCollections } from "@/lib/mongodb";
import { getReasoningModel, getReasoningModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import {
  KB2GeneratedHowtoResultSchema,
  normalizeGeneratedHowtoSections,
} from "@/src/application/lib/kb2/howto-structure";
import {
  buildParsedDocLookup,
  collectPageText,
  dedupeHowtoEvidenceRefs,
  normalizeNodeLookupKey,
} from "@/src/application/lib/kb2/howto-context";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import { buildNodeOwnerMap, getNodeOwnerNames, getPrimaryOwnerName } from "@/src/application/lib/kb2/owner-resolution";
import { buildPlanSectionEvidence } from "@/src/application/lib/kb2/plan-evidence";
import { buildPlanTitle } from "@/src/application/lib/kb2/title-cleanup";
import { buildHowtoEvidencePack, renderEvidencePackPrompt, type HowtoEvidencePack } from "@/src/application/lib/kb2/howto-evidence-pack";
import type { KB2GraphNodeType, KB2GraphEdgeType, KB2EntityPageType, KB2EvidenceRefType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";

const HOWTO_DISCOVERY_CATEGORIES = new Set([
  "proposed_from_feedback",
  "proposed_project",
  "past_undocumented",
  "ongoing_undocumented",
]);

const DEFAULT_HOWTO_SECTIONS = [
  "Overview",
  "Context",
  "Requirements",
  "Implementation Steps",
  "Testing Plan",
  "Risks and Considerations",
  "Prompt Section",
];

const DEFAULT_GENERATE_HOWTO_SYSTEM = `You generate implementation plan documents for engineering work items.
Each plan has sections that must be filled with specific, actionable content.

\${company_context}

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
  (a) An EVIDENCE-BACKED step: derived from convention constraints, implementation precedents, or customer feedback in the evidence pack. Cite the specific source artifact (PR title, Slack thread, ticket key) in evidence_hints.
  (b) A NEW-WORK-TO-DEFINE step: when the evidence pack's "Identified Gaps" section or absence of evidence means the detail must be invented. Mark it explicitly by starting the step prose with "New work to define:".

CONVENTION RULES:
- When Convention Constraints are provided, you MUST name each convention and its owner explicitly (e.g. "Kim's Green Color for Financial Actions convention requires green for all purchase CTAs").
- For each convention, state: what it means for THIS specific feature, the exact implementation choice it implies (colors, breakpoints, pixel sizes, component patterns), and the source artifact that proves it.
- Do NOT reduce conventions to vague mentions like "follow established patterns."

IMPLEMENTATION PRECEDENT RULES:
- READ THE RAW SOURCE EVIDENCE CAREFULLY. It contains PR review comments, Slack discussions, and design decisions with specific implementation details.
- Extract EVERY specific implementation pattern you find in the source evidence, including but not limited to:
  * Image loading: lazy loading, skeleton loading states, species-specific image fallbacks
  * Grid layout: responsive breakpoints (how many columns at desktop/tablet/mobile), minimum touch target sizes, mobile nav accommodations
  * Component architecture: React.memo + useCallback for card grids, Promise.all for parallel API calls, shared Toast components, CSS transitions (exact durations)
  * Navigation: vertical vs horizontal layout choices, sidebar scroll behavior (max-height + overflow-y), panel width splits (1/3 vs 2/3), single column vs multi-column form layouts
  * API design: response envelope shapes ({ data, meta }), pagination strategies (cursor-based vs load-all, with thresholds), date format standards, idempotent DELETE, validation patterns (409 for duplicates, 422 for capacity)
  * File conventions: CSS Modules with camelCase, page folder structure, controller/routes/model patterns, migration conventions
  * Testing: exact test frameworks (Vitest+RTL, Jest, Playwright), known flakiness patterns
  * Process: PR review assignments, description requirements, merge strategy
- If a pattern appears in the source evidence, it MUST appear in the implementation plan. Do not summarize or omit details.
- Cite the precedent name and source when using a pattern.
- If a precedent mentions an API path like /api/v1/pets, you may reference it exactly since it exists in the evidence.
- Name the person who established each pattern when the evidence shows authorship.

PROPOSED FEATURE RULES:
- For proposed features, do NOT invent exact API endpoint paths, database schemas, or contract details that are not in the evidence.
- Instead, reference the existing patterns (e.g. "follow the /api/v1 namespace pattern") and mark new contracts as "new work to define."
- CRITICAL: When a step is "New work to define", you MUST NOT write specific endpoint paths like /api/v1/toys or /api/v1/donations/toys. Instead write "new endpoint under the /api/v1 namespace" or "new API contract to be defined following existing patterns."
- Only reference specific API paths (like /api/v1/pets) when they ALREADY EXIST in the evidence as completed implementations.

FORMATTING:
- In Implementation Steps, each step must list supporting artifact titles in evidence_hints.
- Write like a knowledgeable teammate: short sentences, active voice, plain English.
- You may reference exact API paths, component names, and identifiers that appear in the evidence.
- No filler intros, hedge words, or generic advice.`;

function summarizeHowtoSample(doc: {
  title: string;
  ticket_id?: string | null;
  project_node_id?: string | null;
  linked_entity_ids: string[];
  sections: { section_name: string; content: string }[];
}) {
  return {
    title: doc.title,
    ticket_id: doc.ticket_id ?? null,
    project_node_id: doc.project_node_id ?? null,
    linked_entity_ids: doc.linked_entity_ids,
    sections: doc.sections.map((section) => ({
      section_name: section.section_name,
      content: section.content.slice(
        0,
        section.section_name === "Implementation Steps"
          ? 6000
          : section.section_name === "Requirements" || section.section_name === "Context"
            ? 3000
            : 1800,
      ),
    })),
  };
}

function getRelatedEntityOwnerName(
  node: KB2GraphNodeType,
  nodeByName: Map<string, KB2GraphNodeType>,
  ownershipMap: Map<string, string[]>,
): string | null {
  const relatedNames = Array.isArray(node.attributes?.related_entities)
    ? node.attributes.related_entities
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  for (const name of relatedNames) {
    const relatedNode = nodeByName.get(normalizeNodeLookupKey(name));
    if (relatedNode?.type === "team_member") {
      return relatedNode.display_name;
    }
    const owner = getPrimaryOwnerName(relatedNode, ownershipMap);
    if (owner) return owner;
  }
  return null;
}

export function generateHowtoFromPack(args: {
  evidencePack: HowtoEvidencePack;
  systemPrompt: string;
}): string {
  const { evidencePack, systemPrompt: _system } = args;
  return renderEvidencePackPrompt(evidencePack);
}

export const generateHowtoStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-generate-howto");
  const stepId = "pass1-step-16";

  const epExecId = await ctx.getStepExecutionId("pass1", 14);
  const epFilter = epExecId ? { execution_id: epExecId } : { run_id: ctx.runId };
  const entityPages = (await tc.entity_pages.find(epFilter).toArray()) as unknown as KB2EntityPageType[];
  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  const nodeExecIds = [step9ExecId, step10ExecId].filter(Boolean);
  const nodesFilter = nodeExecIds.length > 0
    ? { execution_id: { $in: nodeExecIds } }
    : { run_id: ctx.runId };
  const rawGraphNodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  const seenNodeIds = new Set<string>();
  const graphNodes = rawGraphNodes.filter((n) => {
    const key = n.node_id ?? `${n.type}:${n.display_name}`;
    if (seenNodeIds.has(key)) return false;
    seenNodeIds.add(key);
    return true;
  });
  const edgesExecId = await ctx.getStepExecutionId("pass1", 6);
  const edgesFilter = edgesExecId ? { execution_id: edgesExecId } : { run_id: ctx.runId };
  const graphEdges = (await tc.graph_edges.find(edgesFilter).toArray()) as unknown as KB2GraphEdgeType[];
  for (const stepNum of [7, 11]) {
    const execId = await ctx.getStepExecutionId("pass1", stepNum);
    if (execId) {
      const extra = (await tc.graph_edges.find({ execution_id: execId }).toArray()) as unknown as KB2GraphEdgeType[];
      const edgeSet = new Set(graphEdges.map((e) => e.edge_id));
      for (const e of extra) { if (!edgeSet.has(e.edge_id)) graphEdges.push(e); }
    }
  }
  const nodeByName = new Map(
    graphNodes.map((node) => [normalizeNodeLookupKey(node.display_name), node]),
  );
  const graphNodeById = new Map(
    graphNodes.map((node) => [node.node_id, node]),
  );
  const ticketNodeByKey = new Map(
    graphNodes
      .filter((node) => node.type === "ticket")
      .map((node) => [node.display_name.toUpperCase(), node]),
  );
  const ownershipMap = buildNodeOwnerMap(graphNodes, graphEdges);

  const seenTargetIds = new Set<string>();
  const howtoTargetNodes = graphNodes.filter((n) => {
    if (n.type !== "project") return false;
    if (!HOWTO_DISCOVERY_CATEGORIES.has(n.attributes?.discovery_category ?? "") && n.attributes?.status !== "proposed") return false;
    const key = n.node_id ?? n.display_name;
    if (seenTargetIds.has(key)) return false;
    seenTargetIds.add(key);
    return true;
  });

  if (howtoTargetNodes.length === 0) {
    await ctx.onProgress("No project targets available for plan generation", 100);
    return { total_howtos: 0, llm_calls: 0 };
  }

  const entityPageByNodeId = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) {
    entityPageByNodeId.set(ep.node_id, ep);
  }
  const latestSnapshot = await tc.input_snapshots.findOne(
    { run_id: ctx.runId },
    { sort: { created_at: -1 } },
  ) as { parsed_documents?: KB2ParsedDocument[] } | null;
  const parsedDocs = (latestSnapshot?.parsed_documents ?? []) as KB2ParsedDocument[];
  const parsedDocLookup = buildParsedDocLookup(parsedDocs);

  const howtoSections =
    ctx.config?.pipeline_settings?.howto?.sections ?? DEFAULT_HOWTO_SECTIONS;
  const howtoSectionsStr = howtoSections.join(", ");

  let systemPrompt =
    ctx.config?.prompts?.generate_howto?.system ?? DEFAULT_GENERATE_HOWTO_SYSTEM;
  const companyContext = ctx.config?.profile?.company_context ?? "";
  systemPrompt = systemPrompt.replace(/\$\{company_context\}/g, companyContext);
  systemPrompt = systemPrompt.replace(/\$\{howto_sections\}/g, howtoSectionsStr);

  const model = getReasoningModel(ctx.config?.pipeline_settings?.models);
  const modelName = getReasoningModelName(ctx.config?.pipeline_settings?.models);
  let totalLLMCalls = 0;
  const howtoDocs: any[] = [];
  const complianceResults: { node: string; convention: string; referenced: boolean }[] = [];
  const howtoSamples: ReturnType<typeof summarizeHowtoSample>[] = [];
  const sourceArtifactTitlesUsed = new Set<string>();
  let directTechnicalSourceCount = 0;
  let conventionConstraintsTotal = 0;
  let implementationReferenceCount = 0;
  let implementationReferenceOpportunities = 0;
  let implementationStepCount = 0;
  let stepsWithSourceRefs = 0;
  const evidencePackSamples: Array<HowtoEvidencePack["diagnostics"] & { target: string }> = [];

  await ctx.onProgress(`Generating plans for ${howtoTargetNodes.length} project targets...`, 5);

  for (let i = 0; i < howtoTargetNodes.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const node = howtoTargetNodes[i];

    const evidencePack = buildHowtoEvidencePack({
      targetNode: node,
      graphNodes,
      graphEdges,
      entityPages,
      parsedDocLookup,
      ownershipMap,
    });

    evidencePackSamples.push({
      target: node.display_name,
      ...evidencePack.diagnostics,
    });

    directTechnicalSourceCount += evidencePack.diagnostics.convention_source_count + evidencePack.diagnostics.precedent_source_count;
    conventionConstraintsTotal += evidencePack.convention_constraints.length;
    if (evidencePack.implementation_precedents.length > 0) {
      implementationReferenceOpportunities += 1;
      implementationReferenceCount += evidencePack.implementation_precedents.length;
    }

    const evidencePrompt = renderEvidencePackPrompt(evidencePack);

    const userPrompt = `Generate an implementation plan for this proposed project.

${evidencePrompt}

## Output Reminders
- Fill every requested section.
- For Implementation Steps, populate the steps array with 5-7 titled prose steps. Each step should have 3-5 sentences of detail.
- Each step must be either EVIDENCE-BACKED (cite artifacts in evidence_hints) or NEW-WORK-TO-DEFINE (start prose with "New work to define:").
- Name convention owners explicitly when applying their conventions.
- Use exact values from the evidence: colors, breakpoints, pixel sizes, component names, API paths.
- When no evidence supports a detail, mark it as new work to define rather than inventing it.
- CRITICAL: The source evidence contains dozens of specific implementation patterns. A thorough plan references 20-30 specific patterns from the evidence. Do not stop at convention constraints — the precedent evidence contains equally important patterns. Ensure ALL of the following appear if found in evidence:
  * Image: lazy loading, skeleton states, species-specific image fallbacks (onError silhouette)
  * Grid: responsive column counts, 44px touch targets, mobile bottom nav padding, hamburger menu at 768px
  * Components: React.memo + useCallback for card lists, Promise.all for parallel fetches, shared Toast for feedback, 200ms CSS fade transitions
  * Navigation: 1/3 left panel / 2/3 content split, single-column form layout (Tim's form rule), scrollable sidebar max-height
  * Data loading: load all for small lists (<20 items, client-side browsing, no pagination — attribute to Matt), cursor-based pagination for 30+ items
  * API: response envelope, idempotent DELETE, validate uniqueness (409), capacity check (422), parse DB strings into structured objects
  * Files: CSS Modules camelCase, page folder structure (src/pages/X/X.tsx), controller+routes+model, timestamped migrations in /db/migrations
  * Testing: Vitest+RTL (frontend), Jest (backend), Playwright E2E (note flakiness)
  * Process: Matt reviews backend PRs / Tim reviews frontend PRs, PR descriptions include what+why+screenshots, squash merge + auto-deploy, large table migrations reviewed by Matt
- The Requirements section should include specific technical requirements drawn from evidence (e.g., "must use lazy loading for pet card images per PR #18 precedent", "checkout form must be single-column per Tim's form convention").
- The Testing Plan should reference specific testing frameworks and patterns from the evidence (e.g., "use Vitest + React Testing Library for frontend tests", "use Jest for backend API tests", "Playwright for E2E — account for known flakiness with async content").`;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;

    const result = await structuredGenerate({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      schema: KB2GeneratedHowtoResultSchema,
      logger,
      onUsage: (u) => { usageData = u; },
      signal: ctx.signal,
    });

    totalLLMCalls++;
    const normalizedSections = normalizeGeneratedHowtoSections(result.sections ?? [], howtoSections)
      .filter((section) => section.section_name !== "Prompt Section");

    if (usageData) {
      const cost = calculateCostUsd(modelName, usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(
        stepId,
        modelName,
        `Plan: ${node.display_name}`,
        JSON.stringify(normalizedSections.slice(0, 2)).slice(0, 5000),
        usageData.promptTokens,
        usageData.completionTokens,
        cost,
        Date.now() - startMs,
      );
    }

    if (evidencePack.convention_constraints.length > 0) {
      const generatedText = normalizedSections
        .flatMap((section) => [
          section.content,
          ...(section.steps ?? []).flatMap((step) => [step.title, step.content]),
        ])
        .join(" ")
        .toLowerCase();
      for (const cc of evidencePack.convention_constraints) {
        const conventionNameLower = cc.title.toLowerCase();
        const ownerToken = cc.owner?.toLowerCase() ?? "";
        const keyTokens = conventionNameLower
          .replace(/[^a-z0-9\s-]/g, " ")
          .split(/\s+/)
          .filter((t) => t.length > 3 && !["convention", "pattern", "decision", "for", "the", "and", "with"].includes(t));
        const referenced = generatedText.includes(conventionNameLower)
          || (keyTokens.length >= 2 && keyTokens.filter((t) => generatedText.includes(t)).length >= Math.ceil(keyTokens.length * 0.6))
          || (ownerToken.length > 0 && generatedText.includes(ownerToken) && keyTokens.some((t) => generatedText.includes(t)));
        complianceResults.push({ node: node.display_name, convention: cc.title, referenced });
        if (!referenced) {
          logger.log(
            `How-to for "${node.display_name}" does not reference linked convention "${cc.title}"`,
          );
        }
      }
    }

    const relatedNodeIds = new Set<string>();
    for (const edge of graphEdges) {
      if (edge.source_node_id === node.node_id) relatedNodeIds.add(edge.target_node_id);
      if (edge.target_node_id === node.node_id) relatedNodeIds.add(edge.source_node_id);
    }
    relatedNodeIds.delete(node.node_id);

    const linkedEntityIds = [
      node.node_id,
      ...(result.linked_entity_ids ?? []).filter((id) => relatedNodeIds.has(id)),
    ];

    const contextPages = entityPages.filter((page) =>
      relatedNodeIds.has(page.node_id) ||
      evidencePack.implementation_precedents.some((p) =>
        entityPages.find((ep) => ep.node_id === page.node_id && ep.title === p.title),
      ),
    );

    const fallbackEvidenceRefs = dedupeHowtoEvidenceRefs([
      ...evidencePack.convention_constraints.flatMap((c) => c.evidence_refs),
      ...evidencePack.implementation_precedents.flatMap((p) => p.evidence_refs),
      ...evidencePack.customer_feedback.map((f) => f.ref),
    ]);

    const sectionsWithEvidence = buildPlanSectionEvidence(normalizedSections, {
      entityPages: contextPages,
      fallbackSourceRefs: fallbackEvidenceRefs,
    });

    const implementationSteps = sectionsWithEvidence.flatMap((section) => section.steps ?? []);
    implementationStepCount += implementationSteps.length;
    stepsWithSourceRefs += implementationSteps.filter((step) => (step.source_refs?.length ?? 0) > 0).length;
    for (const ref of [
      ...sectionsWithEvidence.flatMap((section) => section.source_refs ?? []),
      ...implementationSteps.flatMap((step) => step.source_refs ?? []),
    ]) {
      if (typeof ref.title === "string" && ref.title.trim().length > 0) {
        sourceArtifactTitlesUsed.add(ref.title.trim());
      }
    }
    const uniqueLinked = [...new Set([
      ...linkedEntityIds,
      ...sectionsWithEvidence.flatMap((section) => section.entity_refs?.map((ref) => ref.node_id) ?? []),
      ...sectionsWithEvidence.flatMap((section) =>
        section.steps?.flatMap((step) => step.entity_refs?.map((ref) => ref.node_id) ?? []) ?? [],
      ),
    ])];

    const linkedTicketKey = typeof node.attributes?.linked_ticket === "string"
      ? node.attributes.linked_ticket.toUpperCase()
      : null;
    const linkedTicketNode = linkedTicketKey ? ticketNodeByKey.get(linkedTicketKey) : null;

    const ownerName =
      getPrimaryOwnerName(linkedTicketNode ?? undefined, ownershipMap, {
        includeReporterFallback: Boolean(linkedTicketNode),
      }) ??
      getRelatedEntityOwnerName(node, nodeByName, ownershipMap) ??
      getPrimaryOwnerName(node, ownershipMap) ??
      getNodeOwnerNames(node, ownershipMap)[0] ??
      "";
    const nowIso = new Date().toISOString();

    const doc = {
      howto_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      ticket_id: null,
      project_node_id: node.node_id,
      title: buildPlanTitle(node.display_name),
      sections: sectionsWithEvidence,
      linked_entity_ids: uniqueLinked,
      created_at: nowIso,
      updated_at: nowIso,
      plan_status: "draft",
      owner_name: ownerName,
      reviewers: [],
      discussion: [],
    };
    howtoDocs.push(doc);
    if (howtoSamples.length < 5) {
      howtoSamples.push(summarizeHowtoSample(doc));
    }

    if ((i + 1) % 3 === 0 || i === howtoTargetNodes.length - 1) {
      const pct = Math.round(5 + ((i + 1) / howtoTargetNodes.length) * 90);
      await ctx.onProgress(`Generated ${i + 1}/${howtoTargetNodes.length} plans`, pct);
    }
  }

  if (howtoDocs.length > 0) {
    await tc.howto.insertMany(howtoDocs);
  }

  await ctx.onProgress(`Generated ${howtoDocs.length} plans`, 100);
  const referencedConventionCount = complianceResults.filter((result) => result.referenced).length;
  const conventionReferenceCoveragePct = complianceResults.length > 0
    ? Math.round((referencedConventionCount / complianceResults.length) * 100)
    : 100;
  const stepEvidenceCoveragePct = implementationStepCount > 0
    ? Math.round((stepsWithSourceRefs / implementationStepCount) * 100)
    : 0;
  return {
    total_howtos: howtoDocs.length,
    llm_calls: totalLLMCalls,
    target_node_count: howtoTargetNodes.length,
    target_nodes: howtoTargetNodes.map((node) => node.display_name),
    howto_titles: howtoDocs.map((doc) => doc.title),
    howto_samples: howtoSamples,
    direct_technical_source_count: directTechnicalSourceCount,
    convention_constraints_total: conventionConstraintsTotal,
    convention_refs_total: referencedConventionCount,
    convention_reference_coverage_pct: conventionReferenceCoveragePct,
    implementation_reference_count: implementationReferenceCount,
    implementation_reference_opportunities: implementationReferenceOpportunities,
    implementation_step_count: implementationStepCount,
    steps_with_source_refs: stepsWithSourceRefs,
    step_evidence_coverage_pct: stepEvidenceCoveragePct,
    source_artifact_titles_used: [...sourceArtifactTitlesUsed].sort((a, b) => a.localeCompare(b)),
    compliance_results: complianceResults,
    evidence_pack_samples: evidencePackSamples,
    distinct_convention_family_count: evidencePackSamples.reduce(
      (max, s) => Math.max(max, (s as any).distinct_convention_family_count ?? 0), 0,
    ),
    distinct_convention_owner_count: evidencePackSamples.reduce(
      (max, s) => Math.max(max, (s as any).distinct_convention_owner_count ?? 0), 0,
    ),
  };
};
