import { randomUUID } from "crypto";
import { embedMany } from "ai";
import { getTenantCollections } from "@/lib/mongodb";
import { getEmbeddingModel } from "@/lib/ai-model";
import { qdrantClient } from "@/lib/qdrant";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const KB2_COLLECTION = "kb2_embeddings";

interface TextChunk {
  chunkId: string;
  docIndex: number;
  docId: string;
  provider: string;
  title: string;
  text: string;
}

function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    start += size - overlap;
  }
  return chunks;
}

export const embedDocumentsStep: StepFunction = async (ctx) => {
  const CHUNK_SIZE = ctx.config?.pipeline_settings?.embed?.chunk_size ?? 1000;
  const CHUNK_OVERLAP = ctx.config?.pipeline_settings?.embed?.chunk_overlap ?? 200;
  const EMBED_BATCH = ctx.config?.pipeline_settings?.embed?.embed_batch_size ?? 96;

  const tc = getTenantCollections(ctx.companySlug);
  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  if (!snapshot) throw new Error("No input snapshot found — run step 1 first");

  const docs = snapshot.parsed_documents as KB2ParsedDocument[];
  await ctx.onProgress(`Chunking ${docs.length} documents...`, 5);

  const allChunks: TextChunk[] = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const textChunks = chunkText(doc.content, CHUNK_SIZE, CHUNK_OVERLAP);
    for (const text of textChunks) {
      allChunks.push({
        chunkId: randomUUID(),
        docIndex: i,
        docId: doc.sourceId,
        provider: doc.provider,
        title: doc.title,
        text,
      });
    }
  }

  await ctx.onProgress(`Embedding ${allChunks.length} chunks...`, 15);
  const embeddingModel = getEmbeddingModel();
  let embeddedCount = 0;

  for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_BATCH);
    const { embeddings } = await embedMany({
      model: embeddingModel,
      values: batch.map((c) => c.text),
    });

    const points = batch.map((chunk, idx) => ({
      id: chunk.chunkId,
      vector: embeddings[idx],
      payload: {
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        doc_id: chunk.docId,
        doc_index: chunk.docIndex,
        provider: chunk.provider,
        title: chunk.title,
        text: chunk.text,
      },
    }));

    await qdrantClient.upsert(KB2_COLLECTION, { wait: true, points });
    embeddedCount += batch.length;

    const pct = Math.round(15 + (embeddedCount / allChunks.length) * 80);
    await ctx.onProgress(`Embedded ${embeddedCount}/${allChunks.length} chunks`, pct);
  }

  await ctx.onProgress(`Embedded all ${allChunks.length} chunks`, 100);

  const byProvider: Record<string, { docs: number; chunks: number }> = {};
  const byDoc: { title: string; provider: string; contentLen: number; chunks: number }[] = [];

  for (const doc of docs) {
    const docChunks = allChunks.filter((c) => c.docId === doc.sourceId);
    byDoc.push({ title: doc.title, provider: doc.provider, contentLen: doc.content.length, chunks: docChunks.length });
    if (!byProvider[doc.provider]) byProvider[doc.provider] = { docs: 0, chunks: 0 };
    byProvider[doc.provider].docs++;
    byProvider[doc.provider].chunks += docChunks.length;
  }

  return {
    total_documents: docs.length,
    total_chunks: allChunks.length,
    chunk_size: CHUNK_SIZE,
    chunk_overlap: CHUNK_OVERLAP,
    qdrant_collection: KB2_COLLECTION,
    by_provider: byProvider,
    by_document: byDoc,
  };
};
