import { getTenantCollections } from "@/lib/mongodb";
import type { StepFunction } from "../pipeline-runner";

export const finalizeStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  await ctx.onProgress("Collecting final stats...", 0);

  const runDoc = await tc.runs.findOne({ run_id: ctx.runId });
  if (!runDoc) {
    throw new Error(`Run document not found for run_id=${ctx.runId}. Cannot finalize.`);
  }

  const nodesExecId = await ctx.getStepExecutionId("pass1", 5);
  const edgesExecId = await ctx.getStepExecutionId("pass1", 6);
  const epExecId = await ctx.getStepExecutionId("pass1", 11);
  const hpExecId = await ctx.getStepExecutionId("pass1", 12);
  const claimsExecId = await ctx.getStepExecutionId("pass1", 14);
  const cardsExecId = await ctx.getStepExecutionId("pass1", 15);
  const fgExecId = await ctx.getStepExecutionId("pass2", 1);

  const nf = nodesExecId ? { execution_id: nodesExecId } : { run_id: ctx.runId };
  const edf = edgesExecId ? { execution_id: edgesExecId } : { run_id: ctx.runId };
  const epf = epExecId ? { execution_id: epExecId } : { run_id: ctx.runId };
  const hpf = hpExecId ? { execution_id: hpExecId } : { run_id: ctx.runId };
  const clf = claimsExecId ? { execution_id: claimsExecId } : { run_id: ctx.runId };
  const vcf = cardsExecId ? { execution_id: cardsExecId } : { run_id: ctx.runId };
  const fgf = fgExecId ? { execution_id: fgExecId } : { run_id: ctx.runId };

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
    tc.graph_nodes.countDocuments(nf),
    tc.graph_edges.countDocuments(edf),
    tc.entity_pages.countDocuments(epf),
    tc.human_pages.countDocuments(hpf),
    tc.claims.countDocuments(clf),
    tc.verification_cards.countDocuments(vcf),
    tc.fact_groups.find(fgf).toArray(),
    tc.claims.find(clf).toArray(),
    tc.verification_cards.find(vcf).toArray(),
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
