import { NextRequest } from "next/server";
import { TestPipelineWorker } from "@/src/application/workers/test/test-pipeline.worker";

export const maxDuration = 300;

function toProjectId(slug: string): string {
  return `test-${slug}-project`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { confluence, jira, slack, github, customerFeedback, session } = body;

    if (
      confluence === undefined ||
      jira === undefined ||
      slack === undefined ||
      github === undefined ||
      customerFeedback === undefined
    ) {
      return Response.json(
        { error: "All 5 fields are required: confluence, jira, slack, github, customerFeedback" },
        { status: 400 }
      );
    }

    const hasContent = [confluence, jira, slack, github, customerFeedback].some(
      (v) => typeof v === "string" && v.trim().length > 0
    );

    if (!hasContent) {
      return Response.json(
        { error: "At least one field must be non-empty" },
        { status: 400 }
      );
    }

    const sessionSlug = session || "company";
    const projectId = toProjectId(sessionSlug);
    const companySlug = sessionSlug;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        const sendEvent = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        const onProgress = (progress: { phase: string; detail: string; percent: number }) => {
          sendEvent(progress);
        };

        try {
          const worker = new TestPipelineWorker();
          await worker.run(
            confluence || "",
            jira || "",
            slack || "",
            github || "",
            customerFeedback || "",
            onProgress,
            { projectId, companySlug, sessionName: sessionSlug }
          );
          sendEvent({ done: true, success: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown pipeline error";
          sendEvent({ done: true, success: false, error: message });
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
