import { randomUUID } from "crypto";
import {
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
  kb2InputSnapshotsCollection,
} from "@/lib/mongodb";
import type { KB2GraphNodeType, KB2GraphEdgeType, KB2EdgeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

interface EmbeddedRelationship {
  target: string;
  type: string;
  evidence?: string;
}

export const graphBuildStep: StepFunction = async (ctx) => {
  const nodes = (await kb2GraphNodesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  if (nodes.length === 0) throw new Error("No graph nodes found — run step 3 first");

  const snapshot = await kb2InputSnapshotsCollection.findOne({ run_id: ctx.runId });
  const docs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];

  ctx.onProgress(`Building graph from ${nodes.length} nodes...`, 10);

  const edges: KB2GraphEdgeType[] = [];
  const nodeByName = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) {
    nodeByName.set(node.display_name.toLowerCase(), node);
    for (const alias of node.aliases) {
      nodeByName.set(alias.toLowerCase(), node);
    }
  }

  const validEdgeTypes = new Set([
    "OWNED_BY", "DEPENDS_ON", "MENTIONED_IN", "RELATED_TO", "MEMBER_OF",
    "WORKS_ON", "LEADS", "USES", "STORES_IN", "DEPLOYED_TO",
    "BLOCKED_BY", "COMMUNICATES_VIA", "FEEDBACK_FROM",
    "CONTAINS", "RUNS_ON", "BUILT_BY", "RESOLVES",
  ]);

  for (const node of nodes) {
    const rels = (node.attributes?._relationships ?? []) as EmbeddedRelationship[];
    for (const rel of rels) {
      const targetNode = nodeByName.get(rel.target.toLowerCase());
      if (!targetNode || targetNode.node_id === node.node_id) continue;

      const edgeType = rel.type.toUpperCase().replace(/\s+/g, "_");
      if (!validEdgeTypes.has(edgeType)) continue;

      edges.push({
        edge_id: randomUUID(),
        run_id: ctx.runId,
        source_node_id: node.node_id,
        target_node_id: targetNode.node_id,
        type: edgeType as KB2EdgeType,
        weight: 1,
        evidence: rel.evidence,
      });
    }
  }

  ctx.onProgress("Scanning documents for MENTIONED_IN edges...", 50);

  for (const doc of docs) {
    const contentLower = doc.content.toLowerCase();
    for (const node of nodes) {
      const names = [node.display_name, ...node.aliases];
      const mentioned = names.some((name) => contentLower.includes(name.toLowerCase()));
      if (!mentioned) continue;

      const alreadyLinked = edges.some(
        (e) =>
          e.source_node_id === node.node_id &&
          e.type === "MENTIONED_IN" &&
          e.evidence?.includes(doc.sourceId),
      );
      if (alreadyLinked) continue;

      edges.push({
        edge_id: randomUUID(),
        run_id: ctx.runId,
        source_node_id: node.node_id,
        target_node_id: doc.sourceId,
        type: "MENTIONED_IN",
        weight: 1,
        evidence: `Entity "${node.display_name}" found in doc "${doc.title}" (${doc.sourceId})`,
      });
    }
  }

  if (edges.length > 0) {
    await kb2GraphEdgesCollection.deleteMany({ run_id: ctx.runId });
    await kb2GraphEdgesCollection.insertMany(edges);
  }

  const relEdges = edges.filter((e) => e.type !== "MENTIONED_IN");
  const mentionEdges = edges.filter((e) => e.type === "MENTIONED_IN");

  ctx.onProgress(`Built graph: ${edges.length} edges`, 100);
  return {
    total_edges: edges.length,
    relationship_edges: relEdges.length,
    mentioned_in_edges: mentionEdges.length,
    nodes_processed: nodes.length,
  };
};
