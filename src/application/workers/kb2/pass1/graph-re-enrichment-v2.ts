import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import {
  calculateCostUsd,
  getFastModel,
  getFastModelName,
} from "@/lib/ai-model";
import { buildTraversalQa } from "@/src/application/lib/kb2/pass1-v2-artifacts";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType, KB2GraphEdgeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const AppliesToSchema = z.object({
  matches: z.array(z.object({
    convention_name: z.string(),
    feature_name: z.string(),
    relevance: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

function normalizeLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectNodeNames(node: KB2GraphNodeType): string[] {
  return [node.display_name, ...(node.aliases ?? [])]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
}

function findNodeByName(name: string, nodes: KB2GraphNodeType[]): KB2GraphNodeType | null {
  const needle = normalizeLookupText(name);
  for (const node of nodes) {
    if (collectNodeNames(node).some((candidate) => normalizeLookupText(candidate) === needle)) {
      return node;
    }
  }
  return null;
}

function buildHypothesisText(node: KB2GraphNodeType): string {
  const attrs = (node.attributes ?? {}) as Record<string, unknown>;
  return [
    node.display_name,
    String(attrs.description ?? ""),
    ...(node.source_refs ?? []).map((ref) => ref.excerpt ?? ""),
  ].join("\n");
}

function detectConventionFamily(node: KB2GraphNodeType): string | null {
  const name = normalizeLookupText(node.display_name);
  const rule = normalizeLookupText(String((node.attributes as Record<string, unknown>)?.pattern_rule ?? ""));
  const combined = `${name} ${rule}`;
  if (/\b(color|pink|blue|green|accent)\b/.test(combined) && /\b(ui|cta|button|card|gender|visual)\b/.test(combined)) {
    return "color_ui";
  }
  if (/\b(vertical|sidebar|layout|navigation|tabs)\b/.test(combined) && /\b(selection|browse|choose|category|comparison)\b/.test(combined)) {
    return "layout_selection";
  }
  if (/\b(client.side|load all|pagination|single.api|on mount|filter locally)\b/.test(combined) && /\b(browse|list|small|data)\b/.test(combined)) {
    return "data_loading";
  }
  return null;
}

function scoreDiscoveryTarget(hypothesis: KB2GraphNodeType, target: KB2GraphNodeType): number {
  const hypothesisRefs = hypothesis.source_refs ?? [];
  const targetRefs = target.source_refs ?? [];
  const hypothesisDocIds = new Set(hypothesisRefs.map((ref) => String(ref.doc_id ?? "")).filter(Boolean));
  const hypothesisTitles = new Set(hypothesisRefs.map((ref) => String(ref.title ?? "")).filter(Boolean));
  const hypothesisAuthors = new Set<string>();
  for (const ref of hypothesisRefs as Array<Record<string, unknown>>) {
    for (const key of ["source_author", "comment_author", "pr_author", "slack_speaker"]) {
      const value = ref[key];
      if (typeof value === "string" && value.trim()) hypothesisAuthors.add(normalizeLookupText(value));
    }
  }

  let score = 0;
  if (targetRefs.some((ref) => hypothesisDocIds.has(String(ref.doc_id ?? "")) || hypothesisTitles.has(String(ref.title ?? "")))) {
    score += 1;
  }
  const hypothesisText = ` ${normalizeLookupText(buildHypothesisText(hypothesis))} `;
  if (collectNodeNames(target).some((candidate) => {
    const needle = normalizeLookupText(candidate);
    return needle.length >= 3 && hypothesisText.includes(` ${needle} `);
  })) {
    score += 2;
  }
  if (
    target.type === "team_member" &&
    collectNodeNames(target).some((candidate) => hypothesisAuthors.has(normalizeLookupText(candidate)))
  ) {
    score += 2;
  }
  return score;
}

function findFallbackDiscoveryTargets(
  hypothesis: KB2GraphNodeType,
  candidates: KB2GraphNodeType[],
): KB2GraphNodeType[] {
  return candidates
    .map((target) => ({ target, score: scoreDiscoveryTarget(hypothesis, target) }))
    .filter(({ target, score }) =>
      target.node_id !== hypothesis.node_id &&
      normalizeLookupText(target.display_name) !== normalizeLookupText(hypothesis.display_name) &&
      score >= 2,
    )
    .sort((a, b) => b.score - a.score || a.target.display_name.localeCompare(b.target.display_name))
    .slice(0, 3)
    .map(({ target }) => target);
}

function getSignificantTokens(value: string): string[] {
  return normalizeLookupText(value)
    .split(" ")
    .filter((token) =>
      token.length >= 4 &&
      !["page", "feature", "project", "backend", "frontend", "single", "selection"].includes(token)
    );
}

function collectPeopleNames(node: KB2GraphNodeType): string[] {
  const names = new Set<string>();
  for (const ref of (node.source_refs ?? []) as Array<Record<string, unknown>>) {
    for (const key of ["source_author", "comment_author", "pr_author", "slack_speaker"]) {
      const value = ref[key];
      if (typeof value === "string" && value.trim()) {
        names.add(value.replace(/\s*\[[^\]]+\]\s*$/g, "").trim());
      }
    }
  }
  return [...names];
}

function buildSyntheticDecisionSpecs(convention: KB2GraphNodeType): Array<{ name: string; summary: string; refs: KB2GraphNodeType["source_refs"] }> {
  const refs = convention.source_refs ?? [];
  const family = detectConventionFamily(convention);
  if (!family || refs.length === 0) return [];

  const patternRule = String((convention.attributes as Record<string, unknown>)?.pattern_rule ?? "");
  const conventionName = convention.display_name;

  if (family === "color_ui") {
    const colorGroups: Array<{ filter: RegExp; context: RegExp; label: string }> = [
      { filter: /\b(pink|blue)\b/i, context: /\b(gender|male|female|boy|girl|card|pet)\b/i, label: "Gender Accent" },
      { filter: /\b(green)\b/i, context: /\b(donate|donation|sponsor|money|financial|cta)\b/i, label: "Financial CTA Color" },
    ];
    const specs: Array<{ name: string; summary: string; refs: KB2GraphNodeType["source_refs"] }> = [];
    for (const group of colorGroups) {
      const matching = refs.filter((ref) => group.filter.test(ref.excerpt ?? "") && group.context.test(ref.excerpt ?? ""));
      if (matching.length > 0) {
        specs.push({
          name: `${group.label} Decision — ${conventionName}`,
          summary: `Supporting decision for convention "${conventionName}": ${patternRule || "color usage pattern"}`.slice(0, 200),
          refs: matching.slice(0, 3),
        });
      }
    }
    return specs;
  }

  return [{
    name: `Supporting Decision — ${conventionName}`,
    summary: `Supporting decision for convention "${conventionName}": ${patternRule || convention.display_name}`.slice(0, 200),
    refs: refs.slice(0, 4),
  }];
}

function scoreConventionFit(hypothesis: KB2GraphNodeType, convention: KB2GraphNodeType): number {
  const hypothesisText = normalizeLookupText(buildHypothesisText(hypothesis));
  const conventionText = normalizeLookupText(buildHypothesisText(convention));

  const conventionTokens = conventionText
    .split(" ")
    .filter((t) => t.length >= 4 && !["this", "that", "with", "from", "have", "been", "should", "could", "would"].includes(t));

  const uniqueTokens = [...new Set(conventionTokens)];
  let matches = 0;
  for (const token of uniqueTokens) {
    if (hypothesisText.includes(token)) matches++;
  }

  if (matches >= 3) return 2;
  if (matches >= 1) return 1;
  return 0;
}

export const graphReEnrichmentStepV2: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-graph-re-enrichment-v2");
  const stepId = "pass1-step-11";
  const tc = getTenantCollections(ctx.companySlug);

  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  const step6ExecId = await ctx.getStepExecutionId("pass1", 6);

  const step9Nodes = (await tc.graph_nodes.find(
    step9ExecId ? { execution_id: step9ExecId } : { run_id: ctx.runId },
  ).toArray()) as unknown as KB2GraphNodeType[];
  const step10Nodes = step10ExecId
    ? (await tc.graph_nodes.find({ execution_id: step10ExecId }).toArray()) as unknown as KB2GraphNodeType[]
    : [];
  const existingEdges = step6ExecId
    ? (await tc.graph_edges.find({ execution_id: step6ExecId }).toArray()) as unknown as KB2GraphEdgeType[]
    : [];

  const nodeById = new Map<string, KB2GraphNodeType>(step9Nodes.map((node) => [node.node_id, node]));
  const allNodes = [...step9Nodes];
  for (const node of step10Nodes) {
    if (!nodeById.has(node.node_id)) allNodes.push(node);
  }
  for (const node of allNodes) nodeById.set(node.node_id, node);

  const conventionNodes = step10Nodes.filter((node) => (node.attributes as Record<string, unknown>)?.is_convention === true);
  const hypothesisNodes = step9Nodes.filter((node) => (node.attributes as Record<string, unknown>)?._hypothesis === true);
  const canonicalNodes = step9Nodes.filter((node) => (node.attributes as Record<string, unknown>)?._hypothesis !== true);

  const edgeSet = new Set(existingEdges.map((edge) => `${edge.source_node_id}|${edge.target_node_id}|${edge.type}`));
  const newEdges: KB2GraphEdgeType[] = [];
  const syntheticDecisionNodes: KB2GraphNodeType[] = [];
  let discoveryEdgesAdded = 0;
  const discoveryWiring: Array<{
    name: string;
    resolved_related_entities: string[];
    fallback_related_entities: string[];
    unresolved_related_entities: string[];
    applied_conventions?: string[];
  }> = [];
  const conventionWiring: Array<{
    name: string;
    established_by?: string;
    pattern_rule?: string;
    contains_created: number;
    contains_missed: string[];
    proposed_by_created: boolean;
  }> = [];

  const addEdge = (
    sourceNodeId: string,
    targetNodeId: string,
    type: KB2GraphEdgeType["type"],
    weight: number,
    evidence: string,
  ): boolean => {
    const key = `${sourceNodeId}|${targetNodeId}|${type}`;
    if (edgeSet.has(key)) return false;
    edgeSet.add(key);
    newEdges.push({
      edge_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      type,
      weight,
      evidence,
    });
    return true;
  };

  await ctx.onProgress("Connecting discovery hypotheses...", 10);

  for (const hypothesis of hypothesisNodes) {
    const attrs = (hypothesis.attributes ?? {}) as Record<string, unknown>;
    const relatedNames = Array.isArray(attrs.related_entities)
      ? attrs.related_entities.map((name) => String(name))
      : [];
    const resolved: string[] = [];
    const unresolved: string[] = [];
    const fallback: string[] = [];
    let ownerEdgeCreated = false;

    for (const relatedName of relatedNames) {
      const target = findNodeByName(relatedName, allNodes);
      if (!target || target.node_id === hypothesis.node_id) {
        unresolved.push(relatedName);
        continue;
      }
      if (target.type === "team_member") {
        if (addEdge(
          hypothesis.node_id,
          target.node_id,
          "PROPOSED_BY",
          0.9,
          `Discovery hypothesis "${hypothesis.display_name}" is associated with ${target.display_name}`,
        )) {
          discoveryEdgesAdded++;
          ownerEdgeCreated = true;
        }
        resolved.push(target.display_name);
        continue;
      }
      if (addEdge(
        hypothesis.node_id,
        target.node_id,
        "RELATED_TO",
        0.8,
        `Discovery hypothesis "${hypothesis.display_name}" references "${target.display_name}"`,
      )) {
        discoveryEdgesAdded++;
      }
      resolved.push(target.display_name);
    }

    if (!ownerEdgeCreated) {
      for (const personName of collectPeopleNames(hypothesis)) {
        const person = findNodeByName(personName, allNodes);
        if (!person || person.type !== "team_member") continue;
        if (addEdge(
          hypothesis.node_id,
          person.node_id,
          "PROPOSED_BY",
          0.75,
          `Discovery hypothesis "${hypothesis.display_name}" is evidenced by ${person.display_name}`,
        )) {
          discoveryEdgesAdded++;
          ownerEdgeCreated = true;
        }
      }
    }

    if (resolved.length === 0) {
      for (const target of findFallbackDiscoveryTargets(hypothesis, [...canonicalNodes, ...hypothesisNodes])) {
        if (addEdge(
          hypothesis.node_id,
          target.node_id,
          "RELATED_TO",
          0.6,
          `Discovery hypothesis "${hypothesis.display_name}" shares evidence context with "${target.display_name}"`,
        )) {
          discoveryEdgesAdded++;
        }
        fallback.push(target.display_name);
      }
    }

    if (resolved.length === 0 && fallback.length === 0) {
      const hypothesisTokens = getSignificantTokens(hypothesis.display_name);
      for (const sibling of [...hypothesisNodes, ...canonicalNodes]) {
        if (sibling.node_id === hypothesis.node_id) continue;
        const siblingTokens = getSignificantTokens(sibling.display_name);
        const shared = hypothesisTokens.filter((token) => siblingTokens.includes(token));
        if (shared.length === 0) continue;
        if (addEdge(
          hypothesis.node_id,
          sibling.node_id,
          "RELATED_TO",
          0.5,
          `Discovery hypothesis "${hypothesis.display_name}" shares a project family token with "${sibling.display_name}"`,
        )) {
          discoveryEdgesAdded++;
          fallback.push(sibling.display_name);
          break;
        }
      }
    }

    if (!ownerEdgeCreated) {
      const hypothesisTokens = getSignificantTokens(hypothesis.display_name);
      for (const sibling of hypothesisNodes) {
        if (sibling.node_id === hypothesis.node_id) continue;
        const siblingTokens = getSignificantTokens(sibling.display_name);
        const shared = hypothesisTokens.filter((token) => siblingTokens.includes(token));
        if (shared.length === 0) continue;
        const siblingAttrs = (sibling.attributes ?? {}) as Record<string, unknown>;
        const siblingRelated = Array.isArray(siblingAttrs.related_entities)
          ? siblingAttrs.related_entities.map((value) => String(value))
          : [];
        for (const personName of siblingRelated) {
          const person = findNodeByName(personName, allNodes);
          if (!person || person.type !== "team_member") continue;
          if (addEdge(
            hypothesis.node_id,
            person.node_id,
            "PROPOSED_BY",
            0.55,
            `Discovery hypothesis "${hypothesis.display_name}" shares workstream context with "${sibling.display_name}"`,
          )) {
            discoveryEdgesAdded++;
            ownerEdgeCreated = true;
          }
        }
      }
    }

    discoveryWiring.push({
      name: hypothesis.display_name,
      resolved_related_entities: resolved,
      fallback_related_entities: fallback,
      unresolved_related_entities: unresolved,
    });
  }

  await ctx.onProgress(`Connected ${discoveryEdgesAdded} discovery edges. Wiring convention edges...`, 25);

  for (const convention of conventionNodes) {
    const attrs = (convention.attributes ?? {}) as Record<string, any>;
    const constituentDecisions = Array.isArray(attrs.constituent_decisions) ? attrs.constituent_decisions : [];
    const containsMissed: string[] = [];
    let containsCreated = 0;
    let proposedByCreated = false;

    for (const decisionName of constituentDecisions) {
      const decision = findNodeByName(String(decisionName), step9Nodes);
      if (!decision) {
        containsMissed.push(String(decisionName));
        continue;
      }
      const key = `${convention.node_id}|${decision.node_id}|CONTAINS`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      newEdges.push({
        edge_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        source_node_id: convention.node_id,
        target_node_id: decision.node_id,
        type: "CONTAINS",
        weight: 1,
        evidence: `Convention contains decision ${decision.display_name}`,
      });
      containsCreated++;
    }

    const syntheticSpecs = buildSyntheticDecisionSpecs(convention);
    for (const spec of syntheticSpecs) {
      if (findNodeByName(spec.name, [...step9Nodes, ...syntheticDecisionNodes])) continue;
      const syntheticDecision: KB2GraphNodeType = {
        node_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        type: "decision",
        display_name: spec.name,
        aliases: [],
        attributes: {
          summary: spec.summary,
          description: spec.summary,
          status: "decided",
          documentation_level: "undocumented",
          derived_from_convention: convention.display_name,
        },
        source_refs: spec.refs ?? [],
        truth_status: "inferred",
        confidence: convention.confidence,
      };
      syntheticDecisionNodes.push(syntheticDecision);
      nodeById.set(syntheticDecision.node_id, syntheticDecision);
      allNodes.push(syntheticDecision);
      if (addEdge(
        convention.node_id,
        syntheticDecision.node_id,
        "CONTAINS",
        0.9,
        `Convention "${convention.display_name}" includes synthetic supporting decision "${spec.name}"`,
      )) {
        containsCreated++;
      }
    }

    if (typeof attrs.established_by === "string") {
      const owner = findNodeByName(attrs.established_by, allNodes);
      if (owner) {
        const key = `${convention.node_id}|${owner.node_id}|PROPOSED_BY`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          newEdges.push({
            edge_id: randomUUID(),
            run_id: ctx.runId,
            execution_id: ctx.executionId,
            source_node_id: convention.node_id,
            target_node_id: owner.node_id,
            type: "PROPOSED_BY",
            weight: 1,
            evidence: `Convention established by ${attrs.established_by}`,
          });
          proposedByCreated = true;
        }
      }
    }

    conventionWiring.push({
      name: convention.display_name,
      established_by: typeof attrs.established_by === "string" ? attrs.established_by : undefined,
      pattern_rule: typeof attrs.pattern_rule === "string" ? attrs.pattern_rule : undefined,
      contains_created: containsCreated,
      contains_missed: containsMissed,
      proposed_by_created: proposedByCreated,
    });
  }

  let appliesToEdgesAdded = 0;
  let llmCalls = 0;
  const appliesToResults: Array<{ convention: string; feature: string; relevance: string; confidence: string }> = [];
  const featureCandidates = [
    ...hypothesisNodes,
    ...canonicalNodes.filter((node) => node.type === "project"),
  ];

  if (conventionNodes.length > 0 && featureCandidates.length > 0) {
    await ctx.onProgress("Matching conventions to discovery hypotheses...", 55);
    const model = getFastModel(ctx.config?.pipeline_settings?.models);
    const modelName = getFastModelName(ctx.config?.pipeline_settings?.models);
    const prompt = `CONVENTIONS:
${conventionNodes.map((node) => `- "${node.display_name}": ${(node.attributes as Record<string, unknown>).pattern_rule ?? (node.attributes as Record<string, unknown>).summary ?? ""}`).join("\n")}

FEATURES OR HYPOTHESES:
${featureCandidates.map((node) => `- "${node.display_name}": ${(node.attributes as Record<string, unknown>).description ?? ""}`).join("\n")}

Return only convention-to-feature matches where the convention should clearly influence implementation.`;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: "You match implementation conventions to features. Only include high-confidence, implementation-relevant matches.",
      prompt,
      schema: AppliesToSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    llmCalls++;

    if (usageData) {
      const cost = calculateCostUsd(modelName, usageData.promptTokens, usageData.completionTokens);
      await ctx.logLLMCall(
        stepId,
        modelName,
        prompt.slice(0, 10000),
        JSON.stringify(result, null, 2).slice(0, 10000),
        usageData.promptTokens,
        usageData.completionTokens,
        cost,
        Date.now() - startMs,
      );
    }

    for (const match of result.matches ?? []) {
      if (match.confidence === "low") continue;
      const convention = findNodeByName(match.convention_name, conventionNodes);
      const feature = findNodeByName(match.feature_name, featureCandidates);
      if (!convention || !feature) continue;
      if (addEdge(
        convention.node_id,
        feature.node_id,
        "APPLIES_TO",
        match.confidence === "high" ? 1 : 0.8,
        match.relevance,
      )) {
        appliesToEdgesAdded++;
        appliesToResults.push({
          convention: match.convention_name,
          feature: match.feature_name,
          relevance: match.relevance,
          confidence: match.confidence,
        });
      }
    }
  }

  const currentEdges = [...existingEdges, ...newEdges];
  for (const hypothesis of hypothesisNodes) {
    const relatedTargets = currentEdges
      .filter((edge) => edge.source_node_id === hypothesis.node_id && edge.type === "RELATED_TO")
      .map((edge) => nodeById.get(edge.target_node_id))
      .filter((node): node is KB2GraphNodeType => Boolean(node));

    for (const target of relatedTargets) {
      const inheritedConventionEdges = currentEdges.filter((edge) => edge.type === "APPLIES_TO" && edge.target_node_id === target.node_id);
      for (const inherited of inheritedConventionEdges) {
        const convention = nodeById.get(inherited.source_node_id);
        if (!convention) continue;
        if (addEdge(
          convention.node_id,
          hypothesis.node_id,
          "APPLIES_TO",
          0.7,
          `Convention "${convention.display_name}" also applies to "${hypothesis.display_name}" via related entity "${target.display_name}"`,
        )) {
          appliesToEdgesAdded++;
          appliesToResults.push({
            convention: convention.display_name,
            feature: hypothesis.display_name,
            relevance: `Inherited from related entity ${target.display_name}`,
            confidence: "medium",
          });
        }
      }
    }
  }

  const edgesAfterPropagation = [...existingEdges, ...newEdges];
  for (const hypothesis of hypothesisNodes) {
    const hasConventionPath = edgesAfterPropagation.some((edge) =>
      (edge.source_node_id === hypothesis.node_id && edge.type === "RELATED_TO" && Boolean(nodeById.get(edge.target_node_id)?.attributes && (nodeById.get(edge.target_node_id)?.attributes as Record<string, unknown>)?.is_convention)) ||
      (edge.target_node_id === hypothesis.node_id && edge.type === "APPLIES_TO" && Boolean(nodeById.get(edge.source_node_id)?.attributes && (nodeById.get(edge.source_node_id)?.attributes as Record<string, unknown>)?.is_convention))
    );
    if (hasConventionPath) continue;

    const rankedConvention = conventionNodes
      .map((convention) => ({ convention, score: scoreConventionFit(hypothesis, convention) }))
      .sort((a, b) => b.score - a.score || a.convention.display_name.localeCompare(b.convention.display_name))[0];

    if (!rankedConvention || rankedConvention.score < 2) continue;
    if (addEdge(
      rankedConvention.convention.node_id,
      hypothesis.node_id,
      "APPLIES_TO",
      0.72,
      `Fallback convention match for "${hypothesis.display_name}" based on semantic fit with "${rankedConvention.convention.display_name}"`,
    )) {
      appliesToEdgesAdded++;
      appliesToResults.push({
        convention: rankedConvention.convention.display_name,
        feature: hypothesis.display_name,
        relevance: "Fallback semantic convention fit",
        confidence: "medium",
      });
    }
    if (addEdge(
      hypothesis.node_id,
      rankedConvention.convention.node_id,
      "RELATED_TO",
      0.55,
      `Fallback convention association between "${hypothesis.display_name}" and "${rankedConvention.convention.display_name}"`,
    )) {
      discoveryEdgesAdded++;
    }
  }

  if (syntheticDecisionNodes.length > 0) {
    await tc.graph_nodes.insertMany(syntheticDecisionNodes as any[]);
  }
  if (newEdges.length > 0) {
    await tc.graph_edges.insertMany(newEdges);
  }

  const allEdges = [...existingEdges, ...newEdges];
  const traversalQa = buildTraversalQa(allNodes, allEdges);
  const appliedConventionMap = new Map<string, Set<string>>();
  for (const result of appliesToResults) {
    const list = appliedConventionMap.get(result.feature) ?? new Set<string>();
    list.add(result.convention);
    appliedConventionMap.set(result.feature, list);
  }
  const discoveryWiringWithConventions = discoveryWiring.map((entry) => ({
    ...entry,
    applied_conventions: [...(appliedConventionMap.get(entry.name) ?? [])],
  }));

  logger.log(`Graph re-enrichment added ${newEdges.length} edges and checked ${traversalQa.summary.checked} traversal paths`);
  await ctx.onProgress(`Graph re-enrichment complete: ${newEdges.length} new edges`, 100);

  return {
    discovery_edges_added: discoveryEdgesAdded,
    convention_edges_added: newEdges.filter((edge) => edge.type === "CONTAINS" || edge.type === "PROPOSED_BY").length,
    applies_to_edges_added: appliesToEdgesAdded,
    total_new_edges: newEdges.length,
    llm_calls: llmCalls,
    execution_id_debug: {
      step9_exec_id: step9ExecId,
      step10_exec_id: step10ExecId,
      step10_node_count: step10Nodes.length,
      step10_convention_count: conventionNodes.length,
    },
    discovery_wiring: discoveryWiringWithConventions,
    convention_wiring: conventionWiring,
    applies_to_results: appliesToResults,
    edge_summary: {
      total: newEdges.length,
      by_type: newEdges.reduce<Record<string, number>>((acc, edge) => {
        acc[edge.type] = (acc[edge.type] || 0) + 1;
        return acc;
      }, {}),
    },
    traversal_qa: traversalQa,
    artifact_version: "pass1_v2",
  };
};
