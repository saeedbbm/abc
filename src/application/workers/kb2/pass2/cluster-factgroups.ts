import { randomUUID } from "crypto";
import { embedMany } from "ai";
import { getEmbeddingModel, getFastModel } from "@/lib/ai-model";
import { z } from "zod";
import { PrefixLogger } from "@/lib/utils";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import {
  kb2ClaimsCollection,
  kb2FactGroupsCollection,
  kb2VerificationCardsCollection,
} from "@/lib/mongodb";
import type { StepFunction } from "../pipeline-runner";

const logger = new PrefixLogger("kb2-cluster-factgroups");

const ClusterValidation = z.object({
  clusters: z.array(
    z.object({
      canonical_index: z.number(),
      member_indices: z.array(z.number()),
      group_type: z.enum(["duplicate", "conflict", "related"]),
    }),
  ),
});

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10);
}

export const clusterFactGroupsStep: StepFunction = async (ctx) => {
  ctx.onProgress("Loading claims...", 0);

  const claims = await kb2ClaimsCollection.find({ run_id: ctx.runId }).toArray();
  if (claims.length === 0) return { groups_created: 0, total_claims: 0 };

  await kb2FactGroupsCollection.deleteMany({ run_id: ctx.runId });

  ctx.onProgress(`Embedding ${claims.length} claim texts...`, 10);

  const EMBED_BATCH = 96;
  const embeddings: number[][] = [];
  for (let i = 0; i < claims.length; i += EMBED_BATCH) {
    const batch = claims.slice(i, i + EMBED_BATCH).map((c) => c.text as string);
    const { embeddings: batchEmbeddings } = await embedMany({
      model: getEmbeddingModel(),
      values: batch,
    });
    embeddings.push(...batchEmbeddings);
  }

  ctx.onProgress("Finding similar claim pairs...", 40);

  const SIM_THRESHOLD = 0.85;
  const candidatePairs: [number, number][] = [];

  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const entityIdsA = (claims[i].entity_ids ?? []) as string[];
      const entityIdsB = (claims[j].entity_ids ?? []) as string[];
      const overlap = entityIdsA.some((e) => entityIdsB.includes(e));
      if (!overlap && entityIdsA.length > 0 && entityIdsB.length > 0) continue;

      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim >= SIM_THRESHOLD) {
        candidatePairs.push([i, j]);
      }
    }
  }

  ctx.onProgress(`Validating ${candidatePairs.length} candidate pairs...`, 60);

  const groups: any[] = [];
  const claimToGroup = new Map<string, string>();

  if (candidatePairs.length > 0) {
    const stepId = "pass2-step-1";
    const start = Date.now();

    const pairsText = candidatePairs
      .slice(0, 50)
      .map(([i, j]) => `[${i}] "${claims[i].text}"\n[${j}] "${claims[j].text}"`)
      .join("\n\n");

    try {
      const result = await structuredGenerate({
        model: getFastModel(),
        system: "You validate whether pairs of claims are duplicates, conflicts, or merely related.",
        prompt: `Review these claim pairs and group them into clusters.\nFor each cluster, pick the best canonical claim.\nMark group_type: "duplicate" if same thing, "conflict" if contradict, "related" if same topic but different facts.\n\nClaim pairs:\n${pairsText}`,
        schema: ClusterValidation,
        logger,
        onUsage: async (usage) => {
          const cost = (usage.promptTokens * 3 + usage.completionTokens * 15) / 1_000_000;
          await ctx.logLLMCall(stepId, "claude-sonnet-4-6", pairsText.slice(0, 2000), "", usage.promptTokens, usage.completionTokens, cost, Date.now() - start);
        },
      });

      for (const cluster of result.clusters) {
        if (cluster.member_indices.length < 2) continue;
        const canonClaim = claims[cluster.canonical_index];
        if (!canonClaim) continue;

        const groupId = randomUUID();
        const memberIds = cluster.member_indices
          .filter((idx) => claims[idx])
          .map((idx) => (claims[idx] as any).claim_id as string);

        groups.push({
          group_id: groupId,
          run_id: ctx.runId,
          canonical_claim_id: (canonClaim as any).claim_id,
          member_claim_ids: memberIds,
          group_type: cluster.group_type,
        });

        for (const mid of memberIds) {
          claimToGroup.set(mid, groupId);
        }
      }
    } catch (err: any) {
      logger.log(`Cluster validation failed: ${err.message}`);
    }
  }

  if (groups.length > 0) {
    await kb2FactGroupsCollection.insertMany(groups);
  }

  for (const [claimId, groupId] of claimToGroup) {
    await kb2ClaimsCollection.updateOne(
      { claim_id: claimId, run_id: ctx.runId },
      { $set: { fact_group_id: groupId } },
    );
  }

  return { groups_created: groups.length, total_claims: claims.length, pairs_found: candidatePairs.length };
};
