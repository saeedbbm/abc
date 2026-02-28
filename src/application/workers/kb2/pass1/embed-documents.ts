import { randomUUID } from "crypto";
import { embedMany } from "ai";
import { kb2InputSnapshotsCollection } from "@/lib/mongodb";
import { getEmbeddingModel } from "@/lib/ai-model";
import { qdrantClient } from "@/lib/qdrant";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const KB2_COLLECTION = "kb2_embeddings";
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH = 96;

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
  const snapshot = await kb2InputSnapshotsCollection.findOne({ run_id: ctx.runId });
  if (!snapshot) throw new Error("No input snapshot found — run step 1 first");

  const docs = snapshot.parsed_documents as KB2ParsedDocument[];
  ctx.onProgress(`Chunking ${docs.length} documents...`, 5);

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

  ctx.onProgress(`Embedding ${allChunks.length} chunks...`, 15);
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
    ctx.onProgress(`Embedded ${embeddedCount}/${allChunks.length} chunks`, pct);
  }

  ctx.onProgress(`Embedded all ${allChunks.length} chunks`, 100);
  return {
    total_documents: docs.length,
    total_chunks: allChunks.length,
    qdrant_collection: KB2_COLLECTION,
  };
};
