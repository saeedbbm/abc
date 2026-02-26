import { NextRequest } from "next/server";
import { runPidraxPass2 } from "@/src/application/workers/new-test/pidrax-pass2.worker";
import type { PidraxProgressEvent } from "@/src/application/workers/new-test/pidrax-pipeline.worker";
import { PrefixLogger } from "@/lib/utils";

export const maxDuration = 300;

const routeLogger = new PrefixLogger("pidrax-pass2-route");

function toProjectId(slug: string): string {
  return `newtest-${slug}-project`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session } = body;

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
          sendEvent({ phase: "pass2", detail: "Starting second pass...", percent: 1 });

          const onProgress = (event: PidraxProgressEvent) => {
            sendEvent(event as unknown as Record<string, unknown>);
          };

          const result = await runPidraxPass2(projectId, onProgress);

          sendEvent({
            phase: "pass2",
            detail: "Second pass complete",
            percent: 100,
            done: true,
            success: true,
            metrics: result.metrics,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown pass2 error";
          routeLogger.log(`Pass2 error: ${message}`);
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
