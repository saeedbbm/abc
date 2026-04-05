import { randomUUID } from "crypto";
import { embedMany } from "ai";
import { getTenantCollections } from "@/lib/mongodb";
import { getEmbeddingModel } from "@/lib/ai-model";
import { qdrantClient } from "@/lib/qdrant";
import type { StepFunction } from "../pipeline-runner";

const KB2_COLLECTION = "kb2_embeddings";
const EMBED_BATCH_SIZE = 96;

function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize - 200) {
    chunks.push(text.slice(i, i + chunkSize));
    if (i + chunkSize >= text.length) break;
  }
  return chunks;
}

export const propagationStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const CHUNK_SIZE = ctx.config?.pipeline_settings?.pass2?.propagation_chunk_size ?? 1000;

  await ctx.onProgress("Loading fact groups and claims...", 0);

  const fgExecId = await ctx.getStepExecutionId("pass2", 1);
  const fgFilter = fgExecId ? { execution_id: fgExecId } : { run_id: ctx.runId };
  const groups = await tc.fact_groups.find(fgFilter).toArray();
  const claimsExecId = await ctx.getStepExecutionId("pass1", 14);
  const claimsFilter = claimsExecId ? { execution_id: claimsExecId } : { run_id: ctx.runId };
  const claims = await tc.claims.find(claimsFilter).toArray();
  const claimById = new Map(claims.map((c) => [c.claim_id, c]));

  let claimsUpdated = 0;
  let entityPagesUpdated = 0;
  const updatedEntityPageIds = new Set<string>();
  const errors: string[] = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (group.group_type === "conflict") continue;

    const canonical = claimById.get(group.canonical_claim_id as string) as any;
    if (!canonical) continue;

    for (const memberId of group.member_claim_ids as string[]) {
      if (memberId === group.canonical_claim_id) continue;
      const member = claimById.get(memberId) as any;
      if (!member || member.text === canonical.text) continue;

      try {
        const claimUpdFilter = claimsExecId
          ? { claim_id: memberId, execution_id: claimsExecId }
          : { claim_id: memberId, run_id: ctx.runId };
        await tc.claims.updateOne(
          claimUpdFilter,
          { $set: { text: canonical.text } },
        );
        claimsUpdated++;
      } catch (e) {
        errors.push(`Claim update failed (claim_id=${memberId}): ${(e as Error).message}`);
        continue;
      }

      if (member.source_page_id && member.source_page_type === "entity" &&
          member.source_section_index !== undefined && member.source_item_index !== undefined) {
        try {
          const epExecId = await ctx.getStepExecutionId("pass1", 11);
          const epUpdFilter = epExecId
            ? { page_id: member.source_page_id, execution_id: epExecId }
            : { page_id: member.source_page_id, run_id: ctx.runId };
          await tc.entity_pages.updateOne(
            epUpdFilter,
            { $set: { [`sections.${member.source_section_index}.items.${member.source_item_index}.text`]: canonical.text } },
          );
          entityPagesUpdated++;
          updatedEntityPageIds.add(member.source_page_id);
        } catch (e) {
          errors.push(`Entity page update failed (page_id=${member.source_page_id}): ${(e as Error).message}`);
        }
      }
    }

    if ((gi + 1) % 10 === 0) {
      await ctx.onProgress(
        `Propagated ${gi + 1}/${groups.length} groups (${claimsUpdated} claims, ${entityPagesUpdated} entity pages)`,
        Math.round(((gi + 1) / groups.length) * 50),
      );
    }
  }

  await ctx.onProgress("Marking affected human pages for regeneration...", 55);

  let humanPagesAffected = 0;
  const updatedHumanPageIds = new Set<string>();

  if (updatedEntityPageIds.size > 0) {
    const epExecId2 = await ctx.getStepExecutionId("pass1", 11);
    const epReadFilter = epExecId2
      ? { page_id: { $in: Array.from(updatedEntityPageIds) }, execution_id: epExecId2 }
      : { page_id: { $in: Array.from(updatedEntityPageIds) }, run_id: ctx.runId };
    const modifiedEntityPages = await tc.entity_pages
      .find(epReadFilter)
      .toArray();
    const modifiedNodeIds = new Set(modifiedEntityPages.map((p: any) => p.node_id).filter(Boolean));

    const hpExecId = await ctx.getStepExecutionId("pass1", 12);
    const hpReadFilter = hpExecId ? { execution_id: hpExecId } : { run_id: ctx.runId };
    const humanPages = await tc.human_pages.find(hpReadFilter).toArray();
    for (const hp of humanPages) {
      const linkedIds = (hp as any).linked_entity_page_ids ?? [];
      const referencesModified = linkedIds.some((id: string) => modifiedNodeIds.has(id));
      if (referencesModified) {
        try {
          const hpUpdFilter = hpExecId
            ? { page_id: (hp as any).page_id, execution_id: hpExecId }
            : { page_id: (hp as any).page_id, run_id: ctx.runId };
          await tc.human_pages.updateOne(
            hpUpdFilter,
            { $set: { needs_regeneration: true } },
          );
          humanPagesAffected++;
          updatedHumanPageIds.add((hp as any).page_id);
        } catch (e) {
          errors.push(`Human page regeneration mark failed (page_id=${(hp as any).page_id}): ${(e as Error).message}`);
        }
      }
    }
  }

  let embeddingsUpdated = 0;
  const allUpdatedPageIds = new Set([...updatedEntityPageIds, ...updatedHumanPageIds]);

  if (allUpdatedPageIds.size > 0) {
    await ctx.onProgress(`Re-embedding ${allUpdatedPageIds.size} updated pages...`, 65);

    const embeddingModel = getEmbeddingModel();
    const allChunks: { id: string; text: string; pageId: string; title: string; provider: string }[] = [];

    const epExecIdEmbed = await ctx.getStepExecutionId("pass1", 11);
    for (const pageId of updatedEntityPageIds) {
      try {
        const epFindFilter = epExecIdEmbed
          ? { page_id: pageId, execution_id: epExecIdEmbed }
          : { page_id: pageId, run_id: ctx.runId };
        const page = await tc.entity_pages.findOne(epFindFilter) as any;
        if (!page) continue;

        const pageText = (page.sections ?? [])
          .map((s: any) => `${s.section_name}:\n${(s.items ?? []).map((i: any) => `- ${i.text}`).join("\n")}`)
          .join("\n\n");

        const chunks = chunkText(pageText, CHUNK_SIZE);
        for (const chunk of chunks) {
          allChunks.push({
            id: randomUUID(),
            text: chunk,
            pageId: page.page_id,
            title: page.title ?? "Entity Page",
            provider: "kb2_page",
          });
        }
      } catch (e) {
        errors.push(`Entity page read for embed failed (page_id=${pageId}): ${(e as Error).message}`);
      }
    }

    const hpExecIdEmbed = await ctx.getStepExecutionId("pass1", 12);
    for (const pageId of updatedHumanPageIds) {
      try {
        const hpFindFilter = hpExecIdEmbed
          ? { page_id: pageId, execution_id: hpExecIdEmbed }
          : { page_id: pageId, run_id: ctx.runId };
        const hp = await tc.human_pages.findOne(hpFindFilter) as any;
        if (!hp) continue;

        const pageText = (hp.paragraphs ?? [])
          .map((p: any) => `${p.heading}:\n${p.body}`)
          .join("\n\n");

        const chunks = chunkText(pageText, CHUNK_SIZE);
        for (const chunk of chunks) {
          allChunks.push({
            id: randomUUID(),
            text: chunk,
            pageId: hp.page_id,
            title: hp.title ?? "Human Page",
            provider: "kb2_page",
          });
        }
      } catch (e) {
        errors.push(`Human page read for embed failed (page_id=${pageId}): ${(e as Error).message}`);
      }
    }

    for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);
      try {
        const { embeddings } = await embedMany({
          model: embeddingModel,
          values: batch.map((c) => c.text),
        });

        const points = batch.map((chunk, idx) => ({
          id: chunk.id,
          vector: embeddings[idx],
          payload: {
            run_id: ctx.runId,
            doc_id: chunk.pageId,
            provider: chunk.provider,
            title: chunk.title,
            text: chunk.text,
          },
        }));

        await qdrantClient.upsert(KB2_COLLECTION, { wait: true, points });
        embeddingsUpdated += points.length;
      } catch (e) {
        errors.push(`Embed batch failed (chunks ${i}-${i + batch.length}): ${(e as Error).message}`);
      }

      await ctx.onProgress(
        `Re-embedded ${Math.min(i + EMBED_BATCH_SIZE, allChunks.length)}/${allChunks.length} chunks`,
        Math.round(65 + ((i + batch.length) / allChunks.length) * 35),
      );
    }
  }

  return {
    entity_pages_updated: entityPagesUpdated,
    human_pages_affected: humanPagesAffected,
    total_propagations: claimsUpdated,
    errors,
  };
};
