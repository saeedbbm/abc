import { NextRequest } from "next/server";
import { generateMockInputs, generateGroundTruth } from "@/src/application/workers/new-test/mock-generator.worker";
import { runKBGenerationPipeline } from "@/src/application/workers/new-test/kb-generator.worker";
import { runAnalysis } from "@/src/application/workers/new-test/analysis-engine";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { embedKnowledgeDocument } from "@/src/application/lib/knowledge/embedding-service";
import { parseBundles, type ParsedDocument } from "@/src/application/lib/test/bundle-parser";
import { db } from "@/lib/mongodb";
import { PrefixLogger } from "@/lib/utils";
import { QdrantClient } from "@qdrant/js-client-rest";
import { nanoid } from "nanoid";

export const maxDuration = 300;

const sharedLogger = new PrefixLogger("shared-embed");

function toProjectId(slug: string): string {
  return `newtest-${slug}-project`;
}

/**
 * Shared embedding step — embeds ONLY raw input data.
 * BLIND EVALUATION: Does NOT accept scenarioSpec. Never embeds GT outputs.
 */
async function embedSharedInputs(
  inputs: { confluence: string; jira: string; slack: string; github: string; customerFeedback: string },
  projectId: string,
  onProgress?: (detail: string, percent: number) => void,
): Promise<void> {
  const docsRepo = new MongoDBKnowledgeDocumentsRepository();

  onProgress?.("[Embed] Clearing previous source data...", -1);
  await Promise.all([
    db.collection("knowledge_documents").deleteMany({ projectId }),
    db.collection("knowledge_entities").deleteMany({ projectId }),
  ]);
  try {
    const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || "http://localhost:6333", checkCompatibility: false });
    await qdrant.delete("knowledge_embeddings", {
      filter: { must: [{ key: "projectId", match: { value: projectId } }] },
    });
  } catch (err) {
    sharedLogger.log(`Qdrant cleanup warning: ${err}`);
  }

  onProgress?.("[Embed] Parsing input bundles...", -1);
  const bundles = parseBundles(inputs.confluence, inputs.jira, inputs.slack, inputs.github, inputs.customerFeedback);
  sharedLogger.log(`Parsed ${bundles.totalDocuments} documents`);

  const allParsed: ParsedDocument[] = [
    ...bundles.confluence, ...bundles.jira, ...bundles.slack,
    ...bundles.github, ...bundles.customerFeedback,
  ];

  onProgress?.(`[Embed] Storing ${allParsed.length} documents...`, -1);
  const stored = [];
  for (const parsed of allParsed) {
    const doc = await docsRepo.create({
      projectId,
      provider: parsed.provider as any,
      sourceType: parsed.sourceType as any,
      sourceId: parsed.sourceId,
      title: parsed.title,
      content: parsed.content,
      metadata: parsed.metadata,
      entityRefs: parsed.entityRefs,
      syncedAt: new Date().toISOString(),
    });
    stored.push(doc);
  }

  onProgress?.(`[Embed] Embedding ${stored.length} documents...`, -1);
  let embedded = 0;
  for (const doc of stored) {
    try {
      await embedKnowledgeDocument(doc, sharedLogger);
      embedded++;
    } catch (err) {
      sharedLogger.log(`Embedding failed for ${doc.title}: ${err}`);
    }
  }
  sharedLogger.log(`Shared embedding done: ${embedded}/${stored.length} embedded`);
  onProgress?.(`[Embed] Done — ${embedded} documents embedded`, -1);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session, messages, generateOnly, runPidraxOnly, gtOnly, analyzeOnly } = body;

    if (!session) {
      return Response.json({ error: "session is required" }, { status: 400 });
    }

    const projectId = toProjectId(session);
    const startTime = Date.now();
    const runId = nanoid();

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        const sendEvent = (data: Record<string, unknown>) => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...data, elapsed: `${elapsed}s` })}\n\n`));
        };

        const onProgress = (detail: string, percent: number) => {
          sendEvent({ phase: "pipeline", detail, percent });
        };

        try {
          if (generateOnly) {
            // Mock inputs → shared embedding → GT
            sendEvent({ phase: "mock", detail: "Starting mock data generation...", percent: 2 });
            const inputs = await generateMockInputs(messages || [], projectId, onProgress,
              (source, textSoFar) => {
                sendEvent({ phase: "input_stream", source, text: textSoFar, percent: -1 });
              },
            );
            sendEvent({ phase: "mock_done", detail: "All 5 inputs generated", percent: 20 });

            sendEvent({ phase: "embedding", detail: "Embedding inputs for RAG...", percent: 21 });
            await embedSharedInputs(inputs, projectId, onProgress);

            sendEvent({ phase: "ground_truth", detail: "Starting ground truth (7 phases)...", percent: 22 });
            const gt = await generateGroundTruth(messages || [], inputs, projectId,
              { embeddingsReady: true, runId },
              onProgress,
              (part, data) => {
                sendEvent({ phase: "gt_part", gtPart: part, gtData: data, percent: -1 });
              },
            );
            sendEvent({ phase: "gt_done", detail: `GT complete — ${gt.kb_pages?.length || 0} pages, ${gt.conversation_tickets?.length || 0} conv, ${gt.customer_tickets?.length || 0} customer, ${gt.howto_pages?.length || 0} howto`, percent: 98 });
            sendEvent({ phase: "done", detail: "Mock + GT complete!", percent: 100, done: true, success: true });

          } else if (gtOnly) {
            // Load inputs → embed if needed → GT
            sendEvent({ phase: "loading", detail: "Loading input data...", percent: 2 });
            const existing = await db.collection("new_test_inputs").findOne({ projectId }, { sort: { createdAt: -1 } });
            if (!existing?.inputs) throw new Error("No input data found.");
            const inputs = existing.inputs as any;

            sendEvent({ phase: "embedding", detail: "Embedding inputs for RAG...", percent: 5 });
            await embedSharedInputs(inputs, projectId, onProgress);

            sendEvent({ phase: "ground_truth", detail: "Generating GT (7 phases)...", percent: 10 });
            const gt = await generateGroundTruth(messages || [], inputs, projectId,
              { embeddingsReady: true, runId },
              onProgress,
              (part, data) => {
                sendEvent({ phase: "gt_part", gtPart: part, gtData: data, percent: -1 });
              },
            );
            sendEvent({ phase: "gt_done", detail: `GT done — ${gt.kb_pages?.length || 0} pages`, percent: 98 });
            sendEvent({ phase: "done", detail: "GT generation complete!", percent: 100, done: true, success: true });

          } else if (analyzeOnly) {
            sendEvent({ phase: "analysis", detail: "Running analysis...", percent: 5 });
            await runAnalysis(projectId, onProgress);
            sendEvent({ phase: "done", detail: "Analysis complete!", percent: 100, done: true, success: true });

          } else if (runPidraxOnly) {
            // Load inputs → Pidrax (handles its own embedding) → analysis
            sendEvent({ phase: "loading", detail: "Loading input data...", percent: 2 });
            const existing = await db.collection("new_test_inputs").findOne({ projectId }, { sort: { createdAt: -1 } });
            if (!existing?.inputs) throw new Error("No input data found.");
            const inputs = existing.inputs as any;

            sendEvent({ phase: "pidrax", detail: "Starting Pidrax pipeline (blind, 7 phases)...", percent: 8 });
            await runKBGenerationPipeline(inputs, projectId, { runId }, onProgress);

            sendEvent({ phase: "analysis", detail: "Running analysis...", percent: 92 });
            await runAnalysis(projectId, onProgress);

            sendEvent({ phase: "done", detail: "Pidrax + analysis complete!", percent: 100, done: true, success: true });

          } else {
            // Full: mock → shared embed → GT → Pidrax (reuses embeddings) → analysis
            sendEvent({ phase: "mock", detail: "Starting mock data generation...", percent: 2 });
            const inputs = await generateMockInputs(messages || [], projectId, onProgress,
              (source, textSoFar) => {
                sendEvent({ phase: "input_stream", source, text: textSoFar, percent: -1 });
              },
            );

            sendEvent({ phase: "embedding", detail: "Embedding inputs for RAG...", percent: 20 });
            await embedSharedInputs(inputs, projectId, onProgress);

            sendEvent({ phase: "ground_truth", detail: "Starting GT (7 phases)...", percent: 22 });
            await generateGroundTruth(messages || [], inputs, projectId,
              { embeddingsReady: true, runId },
              onProgress,
              (part, data) => {
                sendEvent({ phase: "gt_part", gtPart: part, gtData: data, percent: -1 });
              },
            );

            sendEvent({ phase: "pidrax", detail: "Starting Pidrax (blind, 7 phases)...", percent: 45 });
            await runKBGenerationPipeline(inputs, projectId,
              { embeddingsReady: true, runId },
              onProgress,
            );

            sendEvent({ phase: "analysis", detail: "Running analysis...", percent: 92 });
            await runAnalysis(projectId, onProgress);

            sendEvent({ phase: "done", detail: "Full pipeline complete!", percent: 100, done: true, success: true });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown pipeline error";
          sendEvent({ phase: "error", detail: message, percent: -1, done: true, success: false, error: message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return Response.json({ error: message }, { status: 400 });
  }
}
