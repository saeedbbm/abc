import {
  kb2RunsCollection,
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
  kb2EntityPagesCollection,
  kb2HumanPagesCollection,
  kb2ClaimsCollection,
  kb2VerificationCardsCollection,
} from "@/lib/mongodb";
import type { StepFunction } from "../pipeline-runner";

export const finalizeStep: StepFunction = async (ctx) => {
  ctx.onProgress("Collecting final stats...", 0);

  const [nodeCount, edgeCount, entityPageCount, humanPageCount, claimCount, verifyCardCount] =
    await Promise.all([
      kb2GraphNodesCollection.countDocuments({ run_id: ctx.runId }),
      kb2GraphEdgesCollection.countDocuments({ run_id: ctx.runId }),
      kb2EntityPagesCollection.countDocuments({ run_id: ctx.runId }),
      kb2HumanPagesCollection.countDocuments({ run_id: ctx.runId }),
      kb2ClaimsCollection.countDocuments({ run_id: ctx.runId }),
      kb2VerificationCardsCollection.countDocuments({ run_id: ctx.runId }),
    ]);

  await kb2RunsCollection.updateOne(
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
        },
      },
    },
  );

  ctx.onProgress("Finalized", 100);

  return {
    nodes: nodeCount,
    edges: edgeCount,
    entity_pages: entityPageCount,
    human_pages: humanPageCount,
    claims: claimCount,
    verify_cards: verifyCardCount,
  };
};
