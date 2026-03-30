import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType, KB2GraphEdgeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import { tokenSimilarity } from "@/src/application/workers/kb2/utils/text-similarity";

const AppliesToSchema = z.object({
  applies_to: z.array(z.object({
    convention_name: z.string(),
    feature_name: z.string(),
    relevance: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

const TYPE_PREFIXES = /^(Decision:\s*|Process:\s*|Project:\s*|PR\s*#?\s*|Ticket:\s*)/i;

function stripTypePrefix(name: string): string {
  return name.replace(TYPE_PREFIXES, "").trim();
}

function findNodeByName(
  name: string,
  nodeByName: Map<string, KB2GraphNodeType>,
  candidates: KB2GraphNodeType[],
): { node: KB2GraphNodeType | null; method: "exact_name" | "prefix_stripped" | "token_similarity" } {
  const normalized = name.toLowerCase().trim();
  const exact = nodeByName.get(normalized);
  if (exact) return { node: exact, method: "exact_name" };

  const stripped = stripTypePrefix(name).toLowerCase().trim();
  if (stripped !== normalized) {
    const strippedMatch = nodeByName.get(stripped);
    if (strippedMatch) return { node: strippedMatch, method: "prefix_stripped" };
  }

  let bestNode: KB2GraphNodeType | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const sim = tokenSimilarity(stripped, candidate.display_name.toLowerCase().trim());
    if (sim > bestScore && sim >= 0.7) {
      bestScore = sim;
      bestNode = candidate;
    }
  }
  if (bestNode) return { node: bestNode, method: "token_similarity" };
  return { node: null, method: "exact_name" };
}

export const graphReEnrichmentStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-graph-re-enrichment");
  const stepId = "pass1-step-11";
  const tc = getTenantCollections(ctx.companySlug);

  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step9Filter = step9ExecId ? { execution_id: step9ExecId } : { run_id: ctx.runId };
  const step9Nodes = (await tc.graph_nodes.find(step9Filter).toArray()) as unknown as KB2GraphNodeType[];

  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  const step10Nodes = step10ExecId
    ? (await tc.graph_nodes.find({ execution_id: step10ExecId }).toArray()) as unknown as KB2GraphNodeType[]
    : [];

  const existingIds = new Set(step9Nodes.map((n) => n.node_id));
  const allNodes = [...step9Nodes];
  for (const n of step10Nodes) {
    if (!existingIds.has(n.node_id)) { allNodes.push(n); existingIds.add(n.node_id); }
  }

  const step6ExecId = await ctx.getStepExecutionId("pass1", 6);
  const step6Filter = step6ExecId ? { execution_id: step6ExecId } : { run_id: ctx.runId };
  const step7ExecId = await ctx.getStepExecutionId("pass1", 7);
  const step7Filter = step7ExecId ? { execution_id: step7ExecId } : { run_id: ctx.runId };
  const existingEdges = [
    ...(await tc.graph_edges.find(step6Filter).toArray()) as unknown as KB2GraphEdgeType[],
    ...(await tc.graph_edges.find(step7Filter).toArray()) as unknown as KB2GraphEdgeType[],
  ];

  const nodeByName = new Map<string, KB2GraphNodeType>();
  for (const n of allNodes) nodeByName.set(n.display_name.toLowerCase().trim(), n);

  const decisionNodes = allNodes.filter(n => n.type === "decision");

  const edgeSet = new Set(existingEdges.map((e) => `${e.source_node_id}|${e.target_node_id}|${e.type}`));
  const newEdges: KB2GraphEdgeType[] = [];
  let discoveryEdgesAdded = 0;
  let conventionEdgesAdded = 0;
  let appliesToEdgesAdded = 0;
  let llmCalls = 0;

  const conventionWiring: Array<{ name: string; contains_created: number; contains_missed: string[]; proposed_by_created: boolean }> = [];
  const appliesToResults: Array<{ convention: string; feature: string; relevance: string; confidence: string }> = [];

  await ctx.onProgress("Connecting discovery nodes to graph...", 10);

  // 1. Connect discovery nodes to related entities
  const discoveryNodes = allNodes.filter((n) =>
    (n.attributes as any)?.discovery_category,
  );

  for (const disc of discoveryNodes) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const related = (disc.attributes as any)?.related_entities as string[] ?? [];
    for (const relName of related) {
      const target = nodeByName.get(relName.toLowerCase().trim());
      if (!target || target.node_id === disc.node_id) continue;
      const key = `${disc.node_id}|${target.node_id}|RELATED_TO`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      newEdges.push({
        edge_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        source_node_id: disc.node_id,
        target_node_id: target.node_id,
        type: "RELATED_TO",
        weight: 0.7,
        evidence: `[re-enrichment] Discovery "${disc.display_name}" references "${target.display_name}"`,
        source_step: "step-11",
        match_method: "exact_name",
      } as any);
      discoveryEdgesAdded++;
    }
  }

  await ctx.onProgress(`Added ${discoveryEdgesAdded} discovery edges. Connecting conventions...`, 30);

  // 2. Connect convention entities (Step 10) to constituent decisions and team members
  const conventionNodes = step10Nodes.filter((n) =>
    (n.attributes as any)?.is_convention === true,
  );

  for (const conv of conventionNodes) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const attrs = conv.attributes as Record<string, any>;
    let containsCreated = 0;
    const containsMissed: string[] = [];

    const constituents = (attrs.constituent_decisions ?? []) as string[];
    for (const decName of constituents) {
      const { node: decNode, method } = findNodeByName(decName, nodeByName, decisionNodes);
      if (!decNode || decNode.node_id === conv.node_id) {
        containsMissed.push(decName);
        continue;
      }
      const key = `${conv.node_id}|${decNode.node_id}|CONTAINS`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      newEdges.push({
        edge_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        source_node_id: conv.node_id,
        target_node_id: decNode.node_id,
        type: "CONTAINS",
        weight: 1.0,
        evidence: `[re-enrichment] Convention "${conv.display_name}" contains decision "${decNode.display_name}"`,
        source_step: "step-11",
        match_method: method,
      } as any);
      containsCreated++;
      conventionEdgesAdded++;
    }

    let proposedByCreated = false;
    if (attrs.established_by) {
      const person = nodeByName.get(attrs.established_by.toLowerCase().trim());
      if (person && person.node_id !== conv.node_id) {
        const key = `${conv.node_id}|${person.node_id}|PROPOSED_BY`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          newEdges.push({
            edge_id: randomUUID(),
            run_id: ctx.runId,
            execution_id: ctx.executionId,
            source_node_id: conv.node_id,
            target_node_id: person.node_id,
            type: "PROPOSED_BY",
            weight: 1.0,
            evidence: `[re-enrichment] Convention "${conv.display_name}" established by "${person.display_name}"`,
            source_step: "step-11",
            match_method: "exact_name",
          } as any);
          conventionEdgesAdded++;
          proposedByCreated = true;
        }
      }
    }

    conventionWiring.push({ name: conv.display_name, contains_created: containsCreated, contains_missed: containsMissed, proposed_by_created: proposedByCreated });
  }

  await ctx.onProgress(`Added ${conventionEdgesAdded} convention edges. Finding APPLIES_TO relationships...`, 50);

  // 3. Connect conventions to proposed features via LLM (tightened filter)
  const proposedFeatures = allNodes.filter((n) => {
    const cat = (n.attributes as any)?.discovery_category ?? "";
    return cat === "proposed_from_feedback" || cat === "proposed_project" || (n.type === "project" && (n.attributes as any)?.status === "proposed");
  });

  if (conventionNodes.length > 0 && proposedFeatures.length > 0) {
    const model = getFastModel(ctx.config?.pipeline_settings?.models);

    const convContext = conventionNodes.map((c) => {
      const attrs = c.attributes as Record<string, any>;
      return `- "${c.display_name}": ${attrs.pattern_rule ?? attrs.summary ?? ""}`;
    }).join("\n");

    const featureContext = proposedFeatures.map((f) => {
      const attrs = f.attributes as Record<string, any>;
      return `- "${f.display_name}" [${f.type}]: ${attrs.description ?? ""}`;
    }).join("\n");

    const prompt = `CONVENTIONS:\n${convContext}\n\nPROPOSED FEATURES/PROJECTS:\n${featureContext}\n\nFor each proposed feature or project, determine which conventions should apply when implementing it. Only include high-confidence matches where the convention's pattern_rule is clearly relevant to the feature.`;

    try {
      const startMs = Date.now();
      let usageData: { promptTokens: number; completionTokens: number } | null = null;
      const result = await structuredGenerate({
        model,
        system: "You match design conventions to proposed features. A convention APPLIES_TO a feature when the feature would need to follow that convention's pattern_rule during implementation. Only include high-confidence matches. Do not match conventions to features just because they share a topic area.",
        prompt,
        schema: AppliesToSchema,
        logger,
        onUsage: (u) => { usageData = u; },
        signal: ctx.signal,
      });
      llmCalls++;

      if (usageData) {
        const cost = calculateCostUsd(getFastModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
        ctx.logLLMCall(stepId, getFastModelName(ctx.config?.pipeline_settings?.models), prompt, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
      }

      for (const match of result.applies_to ?? []) {
        const convNode = nodeByName.get(match.convention_name.toLowerCase().trim());
        const featNode = nodeByName.get(match.feature_name.toLowerCase().trim());
        if (!convNode || !featNode || convNode.node_id === featNode.node_id) continue;
        const key = `${convNode.node_id}|${featNode.node_id}|APPLIES_TO`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        newEdges.push({
          edge_id: randomUUID(),
          run_id: ctx.runId,
          execution_id: ctx.executionId,
          source_node_id: convNode.node_id,
          target_node_id: featNode.node_id,
          type: "APPLIES_TO",
          weight: 0.9,
          evidence: `[re-enrichment] ${match.relevance}`,
          source_step: "step-11",
          match_method: "llm",
        } as any);
        appliesToEdgesAdded++;
        appliesToResults.push({ convention: match.convention_name, feature: match.feature_name, relevance: match.relevance, confidence: match.confidence });
      }
    } catch (err) {
      logger.log(`APPLIES_TO LLM call failed (non-fatal): ${err}`);
    }
  }

  if (newEdges.length > 0) {
    await tc.graph_edges.insertMany(newEdges);
  }

  const edgeSummary: Record<string, number> = {};
  for (const e of newEdges) {
    edgeSummary[e.type] = (edgeSummary[e.type] || 0) + 1;
  }

  await ctx.onProgress(`Graph re-enrichment complete: ${newEdges.length} new edges`, 100);
  return {
    discovery_edges_added: discoveryEdgesAdded,
    convention_edges_added: conventionEdgesAdded,
    applies_to_edges_added: appliesToEdgesAdded,
    total_new_edges: newEdges.length,
    llm_calls: llmCalls,
    execution_id_debug: {
      step9_exec_id: step9ExecId,
      step10_exec_id: step10ExecId,
      step10_node_count: step10Nodes.length,
      step10_convention_count: conventionNodes.length,
    },
    convention_wiring: conventionWiring,
    applies_to_results: appliesToResults,
    edge_summary: { total: newEdges.length, by_type: edgeSummary },
  };
};
