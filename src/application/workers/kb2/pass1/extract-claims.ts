import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
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
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-extract-claims");
  const stepId = "pass1-step-17";
  const extractClaimsSystemPrompt = ctx.config?.prompts?.extract_claims?.system ?? `You extract atomic factual claims from knowledge base pages.
Each claim should be a single, self-contained factual statement that can be independently verified.

Rules:
- Break compound sentences into separate claims.
- Preserve entity names exactly as written.
- Rate confidence based on how definitive the source text is.
- Mark truth_status as "direct" if stated explicitly, "inferred" if derived from context.
- List entity names referenced in each claim in entity_refs.`;

  const epExecId = await ctx.getStepExecutionId("pass1", 15);
  const epFilter = epExecId ? { execution_id: epExecId } : { run_id: ctx.runId };
  const entityPages = (await tc.entity_pages.find(epFilter).toArray()) as unknown as KB2EntityPageType[];
  const hpExecId = await ctx.getStepExecutionId("pass1", 15);
  const hpFilter = hpExecId ? { execution_id: hpExecId } : { run_id: ctx.runId };
  const humanPages = (await tc.human_pages.find(hpFilter).toArray()) as unknown as KB2HumanPageType[];

  const claims: KB2ClaimType[] = [];
  let totalLLMCalls = 0;

  await ctx.onProgress(`Extracting claims from ${entityPages.length} entity pages...`, 5);

  for (let i = 0; i < entityPages.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const page = entityPages[i];
    for (let si = 0; si < page.sections.length; si++) {
      const section = page.sections[si];
      for (let ii = 0; ii < section.items.length; ii++) {
        const item = section.items[ii];
        const claimId = randomUUID();
        claims.push({
          claim_id: claimId,
          run_id: ctx.runId,
          execution_id: ctx.executionId,
          text: item.text,
          entity_ids: [page.node_id],
          source_page_id: page.page_id,
          source_page_type: "entity",
          source_section_index: si,
          source_item_index: ii,
          truth_status: "direct",
          confidence: item.confidence ?? "medium",
          source_refs: (item.source_refs ?? []).map((r) => ({
            source_type: r.source_type as any,
            doc_id: r.doc_id,
            title: r.title,
            excerpt: (r as any).excerpt ?? "",
            section_heading: (r as any).section_heading,
          })),
        });
      }
    }

    if ((i + 1) % 10 === 0) {
      const pct = Math.round(5 + ((i + 1) / entityPages.length) * 40);
      await ctx.onProgress(`Processed ${i + 1}/${entityPages.length} entity pages`, pct);
    }
  }

  await ctx.onProgress(`Extracting claims from ${humanPages.length} human pages via LLM...`, 50);

  const model = getFastModel(ctx.config?.pipeline_settings?.models);

  for (let i = 0; i < humanPages.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const page = humanPages[i];
    const paragraphTexts = page.paragraphs.map(
      (p) => `### ${p.heading}\n${p.body}`,
    ).join("\n\n");

    if (!paragraphTexts.trim()) continue;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: extractClaimsSystemPrompt,
      prompt: `Extract atomic claims from this "${page.title}" page:\n\n${paragraphTexts}`,
      schema: ExtractedClaimsSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;
    if (usageData) {
      const claimPreview = (result.claims ?? []).slice(0, 5).map((c: any) => c.text).join("\n");
      const cost = calculateCostUsd(getFastModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getFastModelName(ctx.config?.pipeline_settings?.models), `Claims from: ${page.title}\n\n${paragraphTexts}`, `Extracted ${(result.claims ?? []).length} claims:\n${claimPreview}...`, usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    for (const claim of result.claims) {
      const humanSourceRefs = page.paragraphs.flatMap((p) =>
        (p.source_items ?? []).map(() => ({
          source_type: "confluence" as const,
          doc_id: page.page_id,
          title: page.title,
          excerpt: claim.text.slice(0, 200),
        })),
      ).slice(0, 3);
      claims.push({
        claim_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        text: claim.text,
        entity_ids: [],
        source_page_id: page.page_id,
        source_page_type: "human",
        truth_status: claim.truth_status,
        confidence: claim.confidence,
        source_refs: humanSourceRefs,
      });
    }

    if ((i + 1) % 3 === 0 || i === humanPages.length - 1) {
      const pct = Math.round(50 + ((i + 1) / humanPages.length) * 45);
      await ctx.onProgress(`Extracted claims from ${i + 1}/${humanPages.length} human pages`, pct);
    }
  }

  if (claims.length > 0) {
    await tc.claims.insertMany(claims);
  }

  const entityClaims = claims.filter((c) => c.source_page_type === "entity");
  const humanClaims = claims.filter((c) => c.source_page_type === "human");

  await ctx.onProgress(`Extracted ${claims.length} total claims`, 100);
  return {
    total_claims: claims.length,
    entity_page_claims: entityClaims.length,
    human_page_claims: humanClaims.length,
    llm_calls: totalLLMCalls,
  };
};
