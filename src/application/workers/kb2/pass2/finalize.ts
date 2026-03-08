import { getTenantCollections } from "@/lib/mongodb";
import type { StepFunction } from "../pipeline-runner";

export const finalizeStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  await ctx.onProgress("Collecting final stats...", 0);

  const runDoc = await tc.runs.findOne({ run_id: ctx.runId });
  if (!runDoc) {
    throw new Error(`Run document not found for run_id=${ctx.runId}. Cannot finalize.`);
  }

  const [
    nodeCount,
    edgeCount,
    entityPageCount,
    humanPageCount,
    claimCount,
    verifyCardCount,
    factGroups,
    claims,
    verifyCards,
  ] = await Promise.all([
    tc.graph_nodes.countDocuments({ run_id: ctx.runId }),
    tc.graph_edges.countDocuments({ run_id: ctx.runId }),
    tc.entity_pages.countDocuments({ run_id: ctx.runId }),
    tc.human_pages.countDocuments({ run_id: ctx.runId }),
    tc.claims.countDocuments({ run_id: ctx.runId }),
    tc.verification_cards.countDocuments({ run_id: ctx.runId }),
    tc.fact_groups.find({ run_id: ctx.runId }).toArray(),
    tc.claims.find({ run_id: ctx.runId }).toArray(),
    tc.verification_cards.find({ run_id: ctx.runId }).toArray(),
  ]);

  const factGroupCounts = {
    total: factGroups.length,
    duplicate: factGroups.filter((g: any) => g.group_type === "duplicate").length,
    related: factGroups.filter((g: any) => g.group_type === "related").length,
    conflict: factGroups.filter((g: any) => g.group_type === "conflict").length,
  };

  const confidenceDistribution = {
    high: claims.filter((c: any) => c.confidence === "high").length,
    medium: claims.filter((c: any) => c.confidence === "medium").length,
    low: claims.filter((c: any) => c.confidence === "low").length,
  };

  const conflictBreakdown = {
    fact_groups_conflict: factGroupCounts.conflict,
    verify_cards_conflict: verifyCards.filter((c: any) => c.card_type === "conflict").length,
    by_severity: verifyCards
      .filter((c: any) => c.card_type === "conflict")
      .reduce((acc: Record<string, number>, c: any) => {
        acc[c.severity ?? "unknown"] = (acc[c.severity ?? "unknown"] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
  };

  await tc.runs.updateOne(
    { run_id: ctx.runId },
    {
      $set: {
        stats: {
          nodes: nodeCount,
          edges: edgeCount,
          entity_pages: entityPageCount,
          human_pages: humanPageCount,
          claims: claimCount,
          verify_cards: verifyCardCount,
          fact_groups: factGroupCounts,
          confidence_distribution: confidenceDistribution,
          conflict_breakdown: conflictBreakdown,
        },
      },
    },
  );

  await ctx.onProgress("Finalized", 100);

  return {
    nodes: nodeCount,
    edges: edgeCount,
    entity_pages: entityPageCount,
    human_pages: humanPageCount,
    claims: claimCount,
    verify_cards: verifyCardCount,
    fact_groups: factGroupCounts,
    confidence_distribution: confidenceDistribution,
    conflict_breakdown: conflictBreakdown,
  };
};
