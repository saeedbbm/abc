import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType, KB2GraphEdgeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const AppliesToSchema = z.object({
  applies_to: z.array(z.object({
    convention_name: z.string(),
    feature_name: z.string(),
    relevance: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

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

  const edgeSet = new Set(existingEdges.map((e) => `${e.source_node_id}|${e.target_node_id}|${e.type}`));
  const newEdges: KB2GraphEdgeType[] = [];
  let discoveryEdgesAdded = 0;
  let conventionEdgesAdded = 0;
  let appliesToEdgesAdded = 0;
  let llmCalls = 0;

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
      });
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

    const constituents = (attrs.constituent_decisions ?? []) as string[];
    for (const decName of constituents) {
      const decNode = nodeByName.get(decName.toLowerCase().trim());
      if (!decNode || decNode.node_id === conv.node_id) continue;
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
      });
      conventionEdgesAdded++;
    }

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
          });
          conventionEdgesAdded++;
        }
      }
    }
  }

  await ctx.onProgress(`Added ${conventionEdgesAdded} convention edges. Finding APPLIES_TO relationships...`, 50);

  // 3. Connect conventions to proposed features via LLM
  const proposedFeatures = allNodes.filter((n) => {
    const cat = (n.attributes as any)?.discovery_category ?? "";
    return cat.startsWith("proposed_") || (n.attributes as any)?.status === "proposed";
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

    const prompt = `CONVENTIONS:\n${convContext}\n\nPROPOSED FEATURES:\n${featureContext}\n\nFor each proposed feature, determine which conventions should apply when implementing it. Only include high-confidence matches.`;

    try {
      const startMs = Date.now();
      let usageData: { promptTokens: number; completionTokens: number } | null = null;
      const result = await structuredGenerate({
        model,
        system: "You match design conventions to proposed features. A convention APPLIES_TO a feature when the feature would need to follow that convention's pattern_rule during implementation.",
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
        });
        appliesToEdgesAdded++;
      }
    } catch (err) {
      logger.log(`APPLIES_TO LLM call failed (non-fatal): ${err}`);
    }
  }

  if (newEdges.length > 0) {
    await tc.graph_edges.insertMany(newEdges);
  }

  await ctx.onProgress(`Graph re-enrichment complete: ${newEdges.length} new edges`, 100);
  return {
    discovery_edges_added: discoveryEdgesAdded,
    convention_edges_added: conventionEdgesAdded,
    applies_to_edges_added: appliesToEdgesAdded,
    total_new_edges: newEdges.length,
    llm_calls: llmCalls,
  };
};
