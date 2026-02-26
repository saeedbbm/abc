import { NextRequest } from "next/server";
import { runPidraxPipeline, type PidraxProgressEvent } from "@/src/application/workers/new-test/pidrax-pipeline.worker";
import { db } from "@/lib/mongodb";
import { PrefixLogger } from "@/lib/utils";

export const maxDuration = 300;

const routeLogger = new PrefixLogger("pidrax-run-route");

function toProjectId(slug: string): string {
  return `newtest-${slug}-project`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session, resumeRunId } = body;

    if (!session) {
      return Response.json({ error: "session is required" }, { status: 400 });
    }

    const projectId = toProjectId(session);
    const startTime = Date.now();

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let controllerClosed = false;

        const sendEvent = (data: Record<string, unknown>) => {
          if (controllerClosed) return;
          try {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...data, elapsed: `${elapsed}s` })}\n\n`));
          } catch {
            controllerClosed = true;
          }
        };

        const closeController = () => {
          if (controllerClosed) return;
          controllerClosed = true;
          try { controller.close(); } catch { /* already closed */ }
        };

        try {
          sendEvent({ phase: "loading", detail: resumeRunId ? "Resuming pipeline..." : "Loading input data...", percent: 1 });
          const existing = await db.collection("new_test_inputs").findOne(
            { projectId },
            { sort: { createdAt: -1 } },
          );
          if (!existing?.inputs) {
            throw new Error("No input data found. Please save input data first.");
          }
          const inputs = existing.inputs as {
            confluence: string;
            jira: string;
            slack: string;
            github: string;
            customerFeedback: string;
          };

          sendEvent({
            phase: "pipeline",
            detail: resumeRunId
              ? `Resuming pipeline from checkpoint (run ${resumeRunId})...`
              : "Starting Pidrax pipeline (8 steps)...",
            percent: 2,
          });

          const onProgress = (event: PidraxProgressEvent) => {
            sendEvent(event as unknown as Record<string, unknown>);
          };

          await runPidraxPipeline(inputs, projectId, onProgress, resumeRunId ? { resumeRunId } : undefined);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown pipeline error";
          routeLogger.log(`Pipeline error: ${message}`);
          sendEvent({
            phase: "error",
            detail: message,
            percent: -1,
            done: true,
            success: false,
            error: message,
          });
        } finally {
          closeController();
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
