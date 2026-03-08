import { randomUUID } from "crypto";
import { z } from "zod";
import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { getTenantCollections } from "@/lib/mongodb";
import type { StepFunction } from "../pipeline-runner";

const logger = new PrefixLogger("kb2-conflict-detection");

const ConflictResult = z.object({
  conflicts: z.array(
    z.object({
      group_id: z.string(),
      explanation: z.string(),
      severity: z.enum(["S1", "S2", "S3"]),
    }),
  ),
});

export const conflictDetectionStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const BATCH_SIZE = ctx.config?.pipeline_settings?.pass2?.conflict_batch_size ?? 10;
  const conflictDetectionSystemPrompt = ctx.config?.prompts?.conflict_detection?.system ?? "You detect contradictions between claims in the same fact group.";

  await ctx.onProgress("Analyzing fact groups for conflicts...", 0);

  const groups = await tc.fact_groups.find({ run_id: ctx.runId }).toArray();
  const claims = await tc.claims.find({ run_id: ctx.runId }).toArray();
  const claimById = new Map(claims.map((c) => [c.claim_id, c]));

  const multiMemberGroups = groups.filter((g) => (g.member_claim_ids as string[]).length >= 2);
  if (multiMemberGroups.length === 0) {
    return { conflicts_found: 0, groups_checked: 0 };
  }

  let newConflicts = 0;

  for (let i = 0; i < multiMemberGroups.length; i += BATCH_SIZE) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const batch = multiMemberGroups.slice(i, i + BATCH_SIZE);
    const groupTexts = batch
      .map((g) => {
        const memberTexts = (g.member_claim_ids as string[])
          .map((id) => (claimById.get(id) as any)?.text ?? "(missing)")
          .join("\n  - ");
        return `Group ${g.group_id} (${g.group_type}):\n  - ${memberTexts}`;
      })
      .join("\n\n");

    const stepId = "pass2-step-2";
    const start = Date.now();

    try {
      const result = await structuredGenerate({
        model: getFastModel(ctx.config?.pipeline_settings?.models),
        system: conflictDetectionSystemPrompt,
        prompt: `Check these fact groups for internal contradictions:\n\n${groupTexts}\n\nFor each group with a genuine conflict, explain the contradiction and rate severity.`,
        schema: ConflictResult,
        logger,
        onUsage: async (usage) => {
          const cost = (usage.promptTokens * 3 + usage.completionTokens * 15) / 1_000_000;
          await ctx.logLLMCall(stepId, "claude-sonnet-4-6", groupTexts.slice(0, 2000), "", usage.promptTokens, usage.completionTokens, cost, Date.now() - start);
        },
        signal: ctx.signal,
      });

      for (const conflict of result.conflicts) {
        const group = batch.find((g) => g.group_id === conflict.group_id);
        if (!group) continue;

        await tc.fact_groups.updateOne(
          { group_id: group.group_id, run_id: ctx.runId },
          { $set: { group_type: "conflict" } },
        );

        const canonClaim = claimById.get(group.canonical_claim_id as string) as any;
        await tc.verification_cards.insertOne({
          card_id: randomUUID(),
          run_id: ctx.runId,
          card_type: "conflict",
          severity: conflict.severity,
          title: `Conflict: ${(canonClaim?.text ?? "Unknown").slice(0, 80)}`,
          explanation: conflict.explanation,
          canonical_text: canonClaim?.text ?? "",
          page_occurrences: [],
          assigned_to: [],
          claim_ids: (group.member_claim_ids as string[]),
          status: "open",
          discussion: [],
        });

        newConflicts++;
      }
    } catch (err: any) {
      logger.log(`Conflict detection batch failed: ${err.message}`);
    }

    await ctx.onProgress(
      `Checked ${Math.min(i + BATCH_SIZE, multiMemberGroups.length)}/${multiMemberGroups.length} groups (${newConflicts} conflicts)`,
      Math.round(((i + BATCH_SIZE) / multiMemberGroups.length) * 100),
    );
  }

  return { conflicts_found: newConflicts, groups_checked: multiMemberGroups.length };
};
