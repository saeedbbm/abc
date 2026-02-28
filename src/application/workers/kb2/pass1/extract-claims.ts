import { randomUUID } from "crypto";
import { z } from "zod";
import {
  kb2EntityPagesCollection,
  kb2HumanPagesCollection,
  kb2ClaimsCollection,
} from "@/lib/mongodb";
import { getFastModel, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/workers/test/structured-generate";
import type {
  KB2EntityPageType,
  KB2HumanPageType,
  KB2ClaimType,
} from "@/src/entities/models/kb2-types";
import { KB2ConfidenceEnum, KB2TruthStatusEnum } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const ExtractedClaimsSchema = z.object({
  claims: z.array(z.object({
    text: z.string(),
    confidence: KB2ConfidenceEnum,
    truth_status: KB2TruthStatusEnum,
    entity_refs: z.array(z.string()),
  })),
});

export const extractClaimsStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-extract-claims");
  const stepId = "pass1-step-13";

  const entityPages = (await kb2EntityPagesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2EntityPageType[];
  const humanPages = (await kb2HumanPagesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2HumanPageType[];

  const claims: KB2ClaimType[] = [];
  let totalLLMCalls = 0;

  ctx.onProgress(`Extracting claims from ${entityPages.length} entity pages...`, 5);

  for (let i = 0; i < entityPages.length; i++) {
    const page = entityPages[i];
    for (let si = 0; si < page.sections.length; si++) {
      const section = page.sections[si];
      for (let ii = 0; ii < section.items.length; ii++) {
        const item = section.items[ii];
        const claimId = randomUUID();
        claims.push({
          claim_id: claimId,
          run_id: ctx.runId,
          text: item.text,
          entity_ids: [page.node_id],
          source_page_id: page.page_id,
          source_page_type: "entity",
          source_section_index: si,
          source_item_index: ii,
          truth_status: "direct",
          confidence: item.confidence ?? "medium",
          source_refs: [],
        });

        await kb2EntityPagesCollection.updateOne(
          { page_id: page.page_id, run_id: ctx.runId },
          { $set: { [`sections.${si}.items.${ii}.claim_id`]: claimId } },
        );
      }
    }

    if ((i + 1) % 10 === 0) {
      const pct = Math.round(5 + ((i + 1) / entityPages.length) * 40);
      ctx.onProgress(`Processed ${i + 1}/${entityPages.length} entity pages`, pct);
    }
  }

  ctx.onProgress(`Extracting claims from ${humanPages.length} human pages via LLM...`, 50);

  const model = getFastModel();

  for (let i = 0; i < humanPages.length; i++) {
    const page = humanPages[i];
    const paragraphTexts = page.paragraphs.map(
      (p) => `### ${p.heading}\n${p.body}`,
    ).join("\n\n");

    if (!paragraphTexts.trim()) continue;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: `You extract atomic factual claims from knowledge base pages.
Each claim should be a single, self-contained factual statement that can be independently verified.

Rules:
- Break compound sentences into separate claims.
- Preserve entity names exactly as written.
- Rate confidence based on how definitive the source text is.
- Mark truth_status as "direct" if stated explicitly, "inferred" if derived from context.
- List entity names referenced in each claim in entity_refs.`,
      prompt: `Extract atomic claims from this "${page.title}" page:\n\n${paragraphTexts}`,
      schema: ExtractedClaimsSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
    });
    totalLLMCalls++;
    if (usageData) {
      const claimPreview = (result.claims ?? []).slice(0, 5).map((c: any) => c.text).join("\n");
      const cost = calculateCostUsd("claude-sonnet-4-6", usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, "claude-sonnet-4-6", `Claims from: ${page.title}\n\n${paragraphTexts}`, `Extracted ${(result.claims ?? []).length} claims:\n${claimPreview}...`, usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    for (const claim of result.claims) {
      claims.push({
        claim_id: randomUUID(),
        run_id: ctx.runId,
        text: claim.text,
        entity_ids: [],
        source_page_id: page.page_id,
        source_page_type: "human",
        truth_status: claim.truth_status,
        confidence: claim.confidence,
        source_refs: [],
      });
    }

    if ((i + 1) % 3 === 0 || i === humanPages.length - 1) {
      const pct = Math.round(50 + ((i + 1) / humanPages.length) * 45);
      ctx.onProgress(`Extracted claims from ${i + 1}/${humanPages.length} human pages`, pct);
    }
  }

  if (claims.length > 0) {
    await kb2ClaimsCollection.deleteMany({ run_id: ctx.runId });
    await kb2ClaimsCollection.insertMany(claims);
  }

  const entityClaims = claims.filter((c) => c.source_page_type === "entity");
  const humanClaims = claims.filter((c) => c.source_page_type === "human");

  ctx.onProgress(`Extracted ${claims.length} total claims`, 100);
  return {
    total_claims: claims.length,
    entity_page_claims: entityClaims.length,
    human_page_claims: humanClaims.length,
    llm_calls: totalLLMCalls,
  };
};
