import { randomUUID } from "crypto";
import { embedMany } from "ai";
import {
  kb2FactGroupsCollection,
  kb2ClaimsCollection,
  kb2EntityPagesCollection,
  kb2HumanPagesCollection,
} from "@/lib/mongodb";
import { getEmbeddingModel } from "@/lib/ai-model";
import { qdrantClient } from "@/lib/qdrant";
import type { StepFunction } from "../pipeline-runner";

const KB2_COLLECTION = "kb2_embeddings";
const CHUNK_SIZE = 1000;
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
  ctx.onProgress("Loading fact groups and claims...", 0);

  const groups = await kb2FactGroupsCollection.find({ run_id: ctx.runId }).toArray();
  const claims = await kb2ClaimsCollection.find({ run_id: ctx.runId }).toArray();
  const claimById = new Map(claims.map((c) => [c.claim_id, c]));

  let claimsUpdated = 0;
  let entityPagesUpdated = 0;
  let humanPagesUpdated = 0;
  const updatedEntityPageIds = new Set<string>();
  const updatedHumanPageIds = new Set<string>();

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (group.group_type === "conflict") continue;

    const canonical = claimById.get(group.canonical_claim_id as string) as any;
    if (!canonical) continue;

    for (const memberId of group.member_claim_ids as string[]) {
      if (memberId === group.canonical_claim_id) continue;
      const member = claimById.get(memberId) as any;
      if (!member || member.text === canonical.text) continue;

      await kb2ClaimsCollection.updateOne(
        { claim_id: memberId, run_id: ctx.runId },
        { $set: { text: canonical.text } },
      );
      claimsUpdated++;

      if (member.source_page_id && member.source_page_type === "entity" &&
          member.source_section_index !== undefined && member.source_item_index !== undefined) {
        await kb2EntityPagesCollection.updateOne(
          { page_id: member.source_page_id, run_id: ctx.runId },
          { $set: { [`sections.${member.source_section_index}.items.${member.source_item_index}.text`]: canonical.text } },
        );
        entityPagesUpdated++;
        updatedEntityPageIds.add(member.source_page_id);
      }
    }

    if ((gi + 1) % 10 === 0) {
      ctx.onProgress(
        `Propagated ${gi + 1}/${groups.length} groups (${claimsUpdated} claims, ${entityPagesUpdated} entity pages)`,
        Math.round(((gi + 1) / groups.length) * 50),
      );
    }
  }

  ctx.onProgress("Propagating changes to human pages...", 55);

  if (updatedEntityPageIds.size > 0) {
    const humanPages = await kb2HumanPagesCollection.find({ run_id: ctx.runId }).toArray();
    for (const hp of humanPages) {
      const paragraphs = (hp as any).paragraphs ?? [];
      let pageUpdated = false;
      for (const para of paragraphs) {
        for (const si of para.source_items ?? []) {
          if (updatedEntityPageIds.has(si.entity_page_id)) {
            pageUpdated = true;
            break;
          }
        }
        if (pageUpdated) break;
      }
      if (pageUpdated) {
        updatedHumanPageIds.add((hp as any).page_id);
        humanPagesUpdated++;
      }
    }
  }

  let embeddingsUpdated = 0;
  const allUpdatedPageIds = new Set([...updatedEntityPageIds, ...updatedHumanPageIds]);

  if (allUpdatedPageIds.size > 0) {
    ctx.onProgress(`Re-embedding ${allUpdatedPageIds.size} updated pages...`, 65);

    const embeddingModel = getEmbeddingModel();
    const allChunks: { id: string; text: string; pageId: string; title: string; provider: string }[] = [];

    for (const pageId of updatedEntityPageIds) {
      const page = await kb2EntityPagesCollection.findOne({ page_id: pageId, run_id: ctx.runId }) as any;
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
    }

    for (const pageId of updatedHumanPageIds) {
      const hp = await kb2HumanPagesCollection.findOne({ page_id: pageId, run_id: ctx.runId }) as any;
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
    }

    for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);
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

      try {
        await qdrantClient.upsert(KB2_COLLECTION, { wait: true, points });
        embeddingsUpdated += points.length;
      } catch {
        // Collection may not exist
      }

      ctx.onProgress(
        `Re-embedded ${Math.min(i + EMBED_BATCH_SIZE, allChunks.length)}/${allChunks.length} chunks`,
        Math.round(65 + ((i + batch.length) / allChunks.length) * 35),
      );
    }
  }

  return {
    claims_updated: claimsUpdated,
    entity_pages_updated: entityPagesUpdated,
    human_pages_updated: humanPagesUpdated,
    groups_processed: groups.length,
    embeddings_updated: embeddingsUpdated,
  };
};
