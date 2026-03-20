import { getTenantCollections } from "@/lib/mongodb";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const logger = new PrefixLogger("kb2-admin-refinements");

function findNodeByDisplayName(
  nodes: KB2GraphNodeType[],
  displayName: string,
): KB2GraphNodeType | undefined {
  return nodes.find(
    (n) => n.display_name.trim().toLowerCase() === displayName.trim().toLowerCase(),
  );
}

export const adminRefinementsStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const refinements = ctx.config?.refinements;
  const result = {
    merges_applied: 0,
    entities_removed: 0,
    discoveries_accepted: 0,
    discoveries_rejected: 0,
    total_changes: 0,
  };

  if (!refinements) {
    return result;
  }

  await ctx.onProgress("Loading graph data...", 0);

  const nodesExecId = await ctx.getStepExecutionId("pass1", 5);
  const edgesExecId = await ctx.getStepExecutionId("pass1", 6);
  const epExecId = await ctx.getStepExecutionId("pass1", 11);
  const claimsExecId = await ctx.getStepExecutionId("pass1", 14);
  const nf = nodesExecId ? { execution_id: nodesExecId } : { run_id: ctx.runId };
  const ef = edgesExecId ? { execution_id: edgesExecId } : { run_id: ctx.runId };
  const epf = epExecId ? { execution_id: epExecId } : { run_id: ctx.runId };
  const cf = claimsExecId ? { execution_id: claimsExecId } : { run_id: ctx.runId };
  let nodes = (await tc.graph_nodes
    .find(nf)
    .toArray()) as unknown as KB2GraphNodeType[];

  // ---------------------------------------------------------------------------
  // 1. Entity merges
  // ---------------------------------------------------------------------------
  for (const merge of refinements.entity_merges ?? []) {
    const keepNode = findNodeByDisplayName(nodes, merge.keep_name);
    if (!keepNode) {
      logger.log(`Merge skip: keep node "${merge.keep_name}" not found`);
      continue;
    }

    for (const mergeName of merge.merge_names ?? []) {
      const mergedNode = findNodeByDisplayName(nodes, mergeName);
      if (!mergedNode || mergedNode.node_id === keepNode.node_id) {
        if (mergedNode?.node_id !== keepNode.node_id) {
          logger.log(`Merge skip: merge node "${mergeName}" not found`);
        }
        continue;
      }

      const mergedAliases = [
        ...new Set([
          ...(keepNode.aliases ?? []),
          ...(mergedNode.aliases ?? []),
          mergedNode.display_name,
        ]),
      ].filter(
        (a) => a.trim().toLowerCase() !== keepNode.display_name.trim().toLowerCase(),
      );
      const mergedSourceRefs = [
        ...(keepNode.source_refs ?? []),
        ...(mergedNode.source_refs ?? []),
      ];

      await tc.graph_nodes.updateOne(
        { node_id: keepNode.node_id, ...nf },
        {
          $set: {
            aliases: mergedAliases,
            source_refs: mergedSourceRefs,
          },
        },
      );

      const affectedEdges = await tc.graph_edges
        .find({
          ...ef,
          $or: [
            { source_node_id: mergedNode.node_id },
            { target_node_id: mergedNode.node_id },
          ],
        })
        .toArray();

      for (const edge of affectedEdges) {
        const newSource =
          edge.source_node_id === mergedNode.node_id
            ? keepNode.node_id
            : edge.source_node_id;
        const newTarget =
          edge.target_node_id === mergedNode.node_id
            ? keepNode.node_id
            : edge.target_node_id;

        if (newSource === newTarget) {
          await tc.graph_edges.deleteOne({
            edge_id: edge.edge_id,
            ...ef,
          });
        } else {
          await tc.graph_edges.updateOne(
            { edge_id: edge.edge_id, ...ef },
            { $set: { source_node_id: newSource, target_node_id: newTarget } },
          );
        }
      }

      await tc.claims.updateMany(
        { ...cf, entity_ids: mergedNode.node_id },
        { $set: { "entity_ids.$[elem]": keepNode.node_id } },
        { arrayFilters: [{ elem: mergedNode.node_id }] },
      );

      await tc.entity_pages.deleteMany({
        ...epf,
        node_id: mergedNode.node_id,
      });

      await tc.graph_nodes.deleteOne({
        node_id: mergedNode.node_id,
        ...nf,
      });

      nodes = nodes.filter((n) => n.node_id !== mergedNode.node_id);
      result.merges_applied++;
    }
  }

  await ctx.onProgress("Applying entity removals...", 30);

  // ---------------------------------------------------------------------------
  // 2. Entity removals
  // ---------------------------------------------------------------------------
  for (const { display_name } of refinements.entity_removals ?? []) {
    const node = findNodeByDisplayName(nodes, display_name);
    if (!node) continue;

    await tc.graph_edges.deleteMany({
      ...ef,
      $or: [
        { source_node_id: node.node_id },
        { target_node_id: node.node_id },
      ],
    });
    await tc.entity_pages.deleteMany({
      ...epf,
      node_id: node.node_id,
    });
    await tc.graph_nodes.deleteOne({
      node_id: node.node_id,
      ...nf,
    });

    nodes = nodes.filter((n) => n.node_id !== node.node_id);
    result.entities_removed++;
  }

  await ctx.onProgress("Applying discovery decisions...", 60);

  // ---------------------------------------------------------------------------
  // 3. Discovery decisions
  // ---------------------------------------------------------------------------
  for (const { display_name, accepted } of refinements.discovery_decisions ?? []) {
    const node = findNodeByDisplayName(nodes, display_name);
    if (!node) continue;

    if (!accepted) {
      await tc.graph_edges.deleteMany({
        ...ef,
        $or: [
          { source_node_id: node.node_id },
          { target_node_id: node.node_id },
        ],
      });
      await tc.entity_pages.deleteMany({
        ...epf,
        node_id: node.node_id,
      });
      await tc.graph_nodes.deleteOne({
        node_id: node.node_id,
        ...nf,
      });

      nodes = nodes.filter((n) => n.node_id !== node.node_id);
      result.discoveries_rejected++;
    } else {
      await tc.graph_nodes.updateOne(
        { node_id: node.node_id, ...nf },
        {
          $set: {
            truth_status: "human_asserted" as const,
            confidence: "high" as const,
          },
        },
      );
      result.discoveries_accepted++;
    }
  }

  result.total_changes =
    result.merges_applied +
    result.entities_removed +
    result.discoveries_accepted +
    result.discoveries_rejected;

  await ctx.onProgress(`Admin refinements complete: ${result.total_changes} changes`, 100);

  return result;
};
