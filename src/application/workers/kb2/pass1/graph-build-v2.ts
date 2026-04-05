import { randomUUID } from "crypto";
import { getTenantCollections } from "@/lib/mongodb";
import type { KB2GraphNodeType, KB2GraphEdgeType, KB2EdgeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

function resolveTarget(
  name: string,
  nodes: KB2GraphNodeType[],
): KB2GraphNodeType | null {
  const needle = name.toLowerCase().trim();
  for (const node of nodes) {
    if (node.display_name.toLowerCase() === needle) return node;
    if (node.aliases.some((alias) => alias.toLowerCase() === needle)) return node;
  }
  return null;
}

function addEdge(
  edges: KB2GraphEdgeType[],
  edgeSet: Set<string>,
  ctx: { runId: string; executionId: string },
  sourceId: string,
  targetId: string,
  type: KB2EdgeType,
  evidence: string,
) {
  if (sourceId === targetId) return;
  const key = `${sourceId}|${targetId}|${type}`;
  if (edgeSet.has(key)) return;
  edgeSet.add(key);
  edges.push({
    edge_id: randomUUID(),
    run_id: ctx.runId,
    execution_id: ctx.executionId,
    source_node_id: sourceId,
    target_node_id: targetId,
    type,
    weight: 1,
    evidence,
  });
}

export const graphBuildStepV2: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-graph-build-v2");
  const tc = getTenantCollections(ctx.companySlug);

  const nodesExecId = await ctx.getStepExecutionId("pass1", 5)
    ?? await ctx.getStepExecutionId("pass1", 4);
  const nodes = (await tc.graph_nodes.find(
    nodesExecId ? { execution_id: nodesExecId } : { run_id: ctx.runId },
  ).toArray()) as unknown as KB2GraphNodeType[];
  if (nodes.length === 0) {
    throw new Error("No graph nodes found — run steps 3-5 first");
  }

  await ctx.onProgress(`Building explicit graph edges from ${nodes.length} entities...`, 5);

  const edges: KB2GraphEdgeType[] = [];
  const edgeSet = new Set<string>();
  const edgeExamples: Array<{ source: string; target: string; type: string; evidence: string }> = [];

  for (const node of nodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    const relationships = Array.isArray(attrs._relationships) ? attrs._relationships : [];
    for (const rel of relationships) {
      if (!rel?.target || !rel?.type) continue;
      const target = resolveTarget(String(rel.target), nodes);
      if (!target) continue;
      const type = String(rel.type).toUpperCase().replace(/\s+/g, "_") as KB2EdgeType;
      addEdge(edges, edgeSet, ctx, node.node_id, target.node_id, type, String(rel.evidence ?? "explicit relationship"));
    }

    if (node.type === "pull_request") {
      if (typeof attrs.author === "string") {
        const person = resolveTarget(attrs.author, nodes);
        if (person) addEdge(edges, edgeSet, ctx, node.node_id, person.node_id, "BUILT_BY", `PR author ${attrs.author}`);
      }
    }

    if (node.type === "ticket" && typeof attrs.assignee === "string") {
      const person = resolveTarget(attrs.assignee, nodes);
      if (person) addEdge(edges, edgeSet, ctx, node.node_id, person.node_id, "OWNED_BY", `Ticket assignee ${attrs.assignee}`);
    }

    if ((node.type === "project" || node.type === "process") && typeof attrs.owner === "string") {
      const owner = resolveTarget(attrs.owner, nodes);
      if (owner) addEdge(edges, edgeSet, ctx, node.node_id, owner.node_id, "OWNED_BY", `Explicit owner ${attrs.owner}`);
    }

    if (node.type === "decision") {
      if (typeof attrs.scope === "string") {
        const scopeTarget = resolveTarget(attrs.scope, nodes);
        if (scopeTarget) addEdge(edges, edgeSet, ctx, node.node_id, scopeTarget.node_id, "RELATED_TO", `Decision scope ${attrs.scope}`);
      }
      if (typeof attrs.decided_by === "string") {
        const owner = resolveTarget(attrs.decided_by, nodes);
        if (owner) addEdge(edges, edgeSet, ctx, node.node_id, owner.node_id, "PROPOSED_BY", `Decision established by ${attrs.decided_by}`);
      }
    }

    if (node.type === "customer_feedback" && typeof attrs.requester === "string") {
      const requester = resolveTarget(attrs.requester, nodes);
      if (requester) addEdge(edges, edgeSet, ctx, node.node_id, requester.node_id, "FEEDBACK_FROM", `Feedback requester ${attrs.requester}`);
    }
  }

  if (edges.length > 0) {
    await tc.graph_edges.insertMany(edges);
  }

  for (const edge of edges.slice(0, 40)) {
    const source = nodes.find((node) => node.node_id === edge.source_node_id)?.display_name ?? edge.source_node_id;
    const target = nodes.find((node) => node.node_id === edge.target_node_id)?.display_name ?? edge.target_node_id;
    edgeExamples.push({
      source,
      target,
      type: edge.type,
      evidence: edge.evidence ?? "",
    });
  }

  logger.log(`Built ${edges.length} explicit/source-derived edges`);
  await ctx.onProgress(`Built ${edges.length} explicit/source-derived edges`, 100);

  return {
    total_edges: edges.length,
    relationship_edges: edges.length,
    explicit_edges: edges.length,
    mentioned_in_edges: 0,
    zero_co_occurrence_semantic_edges: true,
    edge_examples: edgeExamples,
    artifact_version: "pass1_v2",
  };
};
