import { NextRequest } from "next/server";
import { generateMockInputs, generateGroundTruth, generatePagePlan } from "@/src/application/workers/new-test/mock-generator.worker";
import { runKBGenerationPipeline } from "@/src/application/workers/new-test/kb-generator.worker";
import { runAnalysis } from "@/src/application/workers/new-test/analysis-engine";
import { db } from "@/lib/mongodb";

export const maxDuration = 300;

function toProjectId(slug: string): string {
  return `newtest-${slug}-project`;
}

export async function POST(request: NextRequest) {
  try {
    const { session, messages, generateOnly, runPidraxOnly, gtOnly, planOnly, analyzeOnly } = await request.json();

    if (!session || !messages || !Array.isArray(messages)) {
      return Response.json(
        { error: "session and messages array are required" },
        { status: 400 },
      );
    }

    const projectId = toProjectId(session);
    const startTime = Date.now();

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
            // --- MODE: Generate mock data + ground truth ONLY ---
            sendEvent({ phase: "mock", detail: "Starting mock data generation (5 source bundles, streamed)...", percent: 2 });

            const inputs = await generateMockInputs(messages, projectId, onProgress,
              (source, textSoFar) => {
                sendEvent({ phase: "input_stream", source, text: textSoFar, percent: -1 });
              },
            );

            sendEvent({ phase: "mock_done", detail: `All 5 inputs generated`, percent: 20 });

            sendEvent({ phase: "ground_truth", detail: "Starting ground truth (4 parts: KB, conv tickets, feedback tickets, how-to)...", percent: 21 });

            const gt = await generateGroundTruth(messages, inputs, projectId, onProgress,
              (part, data) => {
                sendEvent({ phase: "gt_part", gtPart: part, gtData: data, percent: -1 });
              },
            );

            sendEvent({ phase: "gt_done", detail: `Ground truth complete — ${gt.kb_pages?.length || 0} KB pages, ${gt.conversation_tickets?.length || 0} conv tickets, ${gt.feedback_tickets?.length || 0} feedback tickets, ${gt.howto_pages?.length || 0} how-to pages`, percent: 98 });

            sendEvent({ phase: "done", detail: "Mock data + Ground truth generation complete! Go to 'Input & Ground Truth' to review.", percent: 100, done: true, success: true });

          } else if (planOnly) {
            // --- MODE: Plan KB page structure ONLY ---
            sendEvent({ phase: "loading", detail: "Loading input data...", percent: 2 });
            const existing = await db.collection("new_test_inputs").findOne(
              { projectId },
              { sort: { createdAt: -1 } },
            );
            if (!existing?.inputs) {
              throw new Error("No input data found. Generate or save input data first.");
            }
            const inputs = existing.inputs as { confluence: string; jira: string; slack: string; github: string; customerFeedback: string };

            sendEvent({ phase: "planning", detail: "Planning KB pages for 9 categories...", percent: 5 });
            const plan = await generatePagePlan(messages, inputs, projectId, onProgress);

            sendEvent({ phase: "page_plan", plan, percent: 98 });
            sendEvent({ phase: "done", detail: `Page plan complete — ${plan.length} pages across 9 categories`, percent: 100, done: true, success: true });

          } else if (gtOnly) {
            // --- MODE: Generate ground truth ONLY from existing inputs + plan ---
            sendEvent({ phase: "loading", detail: "Loading input data...", percent: 2 });
            const existing = await db.collection("new_test_inputs").findOne(
              { projectId },
              { sort: { createdAt: -1 } },
            );
            if (!existing?.inputs) {
              throw new Error("No input data found. Generate or save input data first.");
            }
            const inputs = existing.inputs as { confluence: string; jira: string; slack: string; github: string; customerFeedback: string };
            sendEvent({ phase: "loaded", detail: `Input data loaded`, percent: 5 });

            sendEvent({ phase: "ground_truth", detail: "Generating GT pages from plan...", percent: 10 });
            const gt = await generateGroundTruth(messages, inputs, projectId, onProgress,
              (part, data) => {
                sendEvent({ phase: "gt_part", gtPart: part, gtData: data, percent: -1 });
              },
            );

            sendEvent({ phase: "gt_done", detail: `Ground truth complete — ${gt.kb_pages?.length || 0} KB pages, ${gt.conversation_tickets?.length || 0} conv tickets, ${gt.feedback_tickets?.length || 0} feedback tickets, ${gt.howto_pages?.length || 0} how-to pages`, percent: 98 });
            sendEvent({ phase: "done", detail: "Ground truth generation complete!", percent: 100, done: true, success: true });

          } else if (analyzeOnly) {
            sendEvent({ phase: "analysis", detail: "Starting evaluation analysis (5 metric categories)...", percent: 5 });
            await runAnalysis(projectId, onProgress);
            sendEvent({ phase: "done", detail: "Analysis complete!", percent: 100, done: true, success: true });

          } else if (runPidraxOnly) {
            sendEvent({ phase: "loading", detail: "Loading existing input data from database...", percent: 2 });
            const existing = await db.collection("new_test_inputs").findOne(
              { projectId },
              { sort: { createdAt: -1 } },
            );
            if (!existing?.inputs) {
              throw new Error("No input data found. Run the full pipeline from Chat first.");
            }
            const inputs = existing.inputs as { confluence: string; jira: string; slack: string; github: string; customerFeedback: string };
            sendEvent({ phase: "loaded", detail: `Input data loaded — ${Object.values(inputs).reduce((s, v) => s + v.length, 0)} total chars`, percent: 5 });

            sendEvent({ phase: "pidrax", detail: "Starting Pidrax KB generation pipeline (blind)...", percent: 8 });
            await runKBGenerationPipeline(inputs, projectId, onProgress);

            sendEvent({ phase: "analysis", detail: "Starting evaluation analysis (5 metric categories)...", percent: 80 });
            await runAnalysis(projectId, onProgress);

            sendEvent({ phase: "done", detail: "Pidrax pipeline + analysis complete!", percent: 100, done: true, success: true });

          } else {
            sendEvent({ phase: "mock", detail: "Starting mock data generation...", percent: 2 });
            const inputs = await generateMockInputs(messages, projectId, onProgress,
              (source, textSoFar) => {
                sendEvent({ phase: "input_stream", source, text: textSoFar, percent: -1 });
              },
            );

            sendEvent({ phase: "ground_truth", detail: "Starting ground truth generation...", percent: 22 });
            await generateGroundTruth(messages, inputs, projectId, onProgress,
              (part, data) => {
                sendEvent({ phase: "gt_part", gtPart: part, gtData: data, percent: -1 });
              },
            );

            sendEvent({ phase: "pidrax", detail: "Starting Pidrax pipeline (blind)...", percent: 45 });
            await runKBGenerationPipeline(inputs, projectId, onProgress);

            sendEvent({ phase: "analysis", detail: "Running analysis...", percent: 87 });
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
