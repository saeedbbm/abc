import { embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/ai-model";
import { qdrantClient } from "@/lib/qdrant";
import { kb2ClaimsCollection } from "@/lib/mongodb";
import type { StepFunction } from "../pipeline-runner";

const KB2_COLLECTION = "kb2_embeddings";

export const evidenceUpgradeStep: StepFunction = async (ctx) => {
  ctx.onProgress("Loading low-confidence claims...", 0);

  const claims = await kb2ClaimsCollection
    .find({ run_id: ctx.runId, confidence: "low" })
    .toArray();

  if (claims.length === 0) {
    return { upgraded: 0, total_checked: 0 };
  }

  let upgradedCount = 0;

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];

    try {
      const { embeddings } = await embedMany({
        model: getEmbeddingModel(),
        values: [claim.text as string],
      });

      const results = await qdrantClient.search(KB2_COLLECTION, {
        vector: embeddings[0],
        limit: 5,
        filter: {
          must: [{ key: "run_id", match: { value: ctx.runId } }],
        },
        with_payload: true,
        score_threshold: 0.8,
      });

      if (results.length >= 2) {
        await kb2ClaimsCollection.updateOne(
          { claim_id: claim.claim_id, run_id: ctx.runId },
          { $set: { confidence: "medium" } },
        );
        upgradedCount++;
      }
    } catch {
      // Skip if vector search fails for this claim
    }

    if ((i + 1) % 10 === 0) {
      ctx.onProgress(
        `Checked ${i + 1}/${claims.length} claims (${upgradedCount} upgraded)`,
        Math.round(((i + 1) / claims.length) * 100),
      );
    }
  }

  return { upgraded: upgradedCount, total_checked: claims.length };
};
