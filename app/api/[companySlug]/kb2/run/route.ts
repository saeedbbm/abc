import { NextRequest } from "next/server";
import { ensureStepsRegistered } from "@/src/application/workers/kb2/register-steps";
import { runPipeline, getPass1Steps, getPass2Steps, cancelPipeline } from "@/src/application/workers/kb2/pipeline-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureStepsRegistered();
  return Response.json({
    pass1Steps: getPass1Steps(),
    pass2Steps: getPass2Steps(),
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const cancelled = cancelPipeline(companySlug);
  return Response.json({ cancelled });
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
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const send = async (data: any) => {
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch { /* stream closed */ }
  };

  (async () => {
    try {
      const result = await runPipeline({
        companySlug,
        pass: pass || "all",
        step: step ? Number(step) : undefined,
        fromStep: fromStep ? Number(fromStep) : undefined,
        reuseRunId,
        onProgress: async (detail, percent) => {
          await send({ type: "progress", detail, percent });
        },
      });

      await send({ type: "done", runId: result.run_id, status: result.status });
    } catch (err: any) {
      await send({ type: "error", message: err.message });
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
