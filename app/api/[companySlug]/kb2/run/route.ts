import { NextRequest } from "next/server";
import { ensureStepsRegistered } from "@/src/application/workers/kb2/register-steps";
import { runPipeline, getPass1Steps, getPass2Steps } from "@/src/application/workers/kb2/pipeline-runner";

export async function GET() {
  ensureStepsRegistered();
  return Response.json({
    pass1Steps: getPass1Steps(),
    pass2Steps: getPass2Steps(),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const body = await request.json();
  const { pass, step, fromStep, reuseRunId } = body;

  ensureStepsRegistered();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { /* stream closed */ }
      };

      try {
        const result = await runPipeline({
          companySlug,
          pass: pass || "all",
          step: step ? Number(step) : undefined,
          fromStep: fromStep ? Number(fromStep) : undefined,
          reuseRunId,
          onProgress: (detail, percent) => {
            send({ type: "progress", detail, percent });
          },
        });

        send({ type: "done", runId: result.run_id, status: result.status });
      } catch (err: any) {
        send({ type: "error", message: err.message });
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
}
