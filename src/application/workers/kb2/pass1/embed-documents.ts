import { randomUUID } from "crypto";
import { embedMany } from "ai";
import { getTenantCollections } from "@/lib/mongodb";
import { getEmbeddingModel } from "@/lib/ai-model";
import { qdrantClient } from "@/lib/qdrant";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import {
  buildEvidenceSpansForDoc,
  getDocSourceUnits,
} from "@/src/application/lib/kb2/pass1-v2-artifacts";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const KB2_COLLECTION = "kb2_embeddings";

interface TextChunk {
  chunkId: string;
  docIndex: number;
  docId: string;
  parentDocId: string;
  provider: string;
  title: string;
  unitId: string;
  unitKind: string;
  anchor: string;
  text: string;
  chunkMeta: Record<string, unknown>;
}

function buildSourcePrefix(doc: KB2ParsedDocument, anchor: string): string {
  return `[Source: ${doc.provider} | doc="${doc.sourceId}" | anchor="${anchor}" | title="${doc.title}"]`;
}

export const embedDocumentsStep: StepFunction = async (ctx) => {
  const chunkSize = ctx.config?.pipeline_settings?.embed?.chunk_size ?? 1000;
  const chunkOverlap = ctx.config?.pipeline_settings?.embed?.chunk_overlap ?? 200;
  const embedBatch = ctx.config?.pipeline_settings?.embed?.embed_batch_size ?? 96;

  const tc = getTenantCollections(ctx.companySlug);
  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  if (!snapshot) throw new Error("No input snapshot found — run step 1 first");

  const docs = snapshot.parsed_documents as KB2ParsedDocument[];
  await ctx.onProgress(`Building evidence spans from ${docs.length} documents...`, 5);

  const allChunks: TextChunk[] = [];
  const byProvider: Record<string, { docs: number; units: number; spans: number; chunks: number }> = {};
  const byDocument: Array<{ title: string; provider: string; source_units: number; spans: number }> = [];
  const byUnitKind: Record<string, number> = {};

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const units = getDocSourceUnits(doc);
    const spans = buildEvidenceSpansForDoc(doc, chunkSize, chunkOverlap);

    byDocument.push({
      title: doc.title,
      provider: doc.provider,
      source_units: units.length,
      spans: spans.length,
    });
    if (!byProvider[doc.provider]) {
      byProvider[doc.provider] = { docs: 0, units: 0, spans: 0, chunks: 0 };
    }
    byProvider[doc.provider].docs++;
    byProvider[doc.provider].units += units.length;
    byProvider[doc.provider].spans += spans.length;

    for (const span of spans) {
      byUnitKind[span.unit_kind] = (byUnitKind[span.unit_kind] || 0) + 1;
      allChunks.push({
        chunkId: randomUUID(),
        docIndex: i,
        docId: doc.sourceId,
        parentDocId: doc.id,
        provider: doc.provider,
        title: doc.title,
        unitId: span.unit_id,
        unitKind: span.unit_kind,
        anchor: span.anchor,
        text: `${buildSourcePrefix(doc, span.anchor)}\n${span.text}`,
        chunkMeta: {
          unit_id: span.unit_id,
          unit_kind: span.unit_kind,
          anchor: span.anchor,
          start_offset: span.start_offset,
          end_offset: span.end_offset,
          ...span.metadata,
        },
      });
    }
  }

  for (const provider of Object.keys(byProvider)) {
    byProvider[provider].chunks = byProvider[provider].spans;
  }

  await ctx.onProgress(`Embedding ${allChunks.length} evidence spans...`, 15);
  const embeddingModel = getEmbeddingModel();
  let embeddedCount = 0;

  for (let i = 0; i < allChunks.length; i += embedBatch) {
    const batch = allChunks.slice(i, i + embedBatch);
    const { embeddings } = await embedMany({
      model: embeddingModel,
      values: batch.map((chunk) => chunk.text),
    });

    const points = batch.map((chunk, index) => ({
      id: chunk.chunkId,
      vector: embeddings[index],
      payload: {
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        doc_id: chunk.docId,
        parent_doc_id: chunk.parentDocId,
        doc_index: chunk.docIndex,
        provider: chunk.provider,
        title: chunk.title,
        text: chunk.text,
        chunk_meta: chunk.chunkMeta,
      },
    }));

    await qdrantClient.upsert(KB2_COLLECTION, { wait: true, points });
    embeddedCount += batch.length;
    const pct = Math.round(15 + (embeddedCount / Math.max(allChunks.length, 1)) * 80);
    await ctx.onProgress(`Embedded ${embeddedCount}/${allChunks.length} evidence spans`, pct);
  }

  await ctx.onProgress(`Embedded all ${allChunks.length} evidence spans`, 100);

  const chunkSamples = allChunks.slice(0, 12).map((chunk) => ({
    chunk_id: chunk.chunkId,
    doc_id: chunk.docId,
    parent_doc_id: chunk.parentDocId,
    provider: chunk.provider,
    title: chunk.title,
    unit_id: chunk.unitId,
    unit_kind: chunk.unitKind,
    anchor: chunk.anchor,
    excerpt: chunk.text.slice(0, 320),
    chunk_meta: chunk.chunkMeta,
  }));

  return {
    total_documents: docs.length,
    total_source_units: Object.values(byProvider).reduce((sum, entry) => sum + entry.units, 0),
    total_evidence_spans: allChunks.length,
    total_chunks: allChunks.length,
    chunk_size: chunkSize,
    chunk_overlap: chunkOverlap,
    qdrant_collection: KB2_COLLECTION,
    by_provider: byProvider,
    by_document: byDocument,
    by_unit_kind: byUnitKind,
    chunk_samples: chunkSamples,
    artifact_version: "pass1_v2",
  };
};
