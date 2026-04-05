import { NextRequest } from "next/server";
import { evaluateStep } from "@/src/application/lib/kb2/step-judge-configs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const body = await request.json();
  const { executionId } = body;

  if (!executionId) {
    return Response.json({ error: "executionId is required" }, { status: 400 });
  }

  try {
    const judgeResult = await evaluateStep(companySlug, executionId);
    return Response.json({ success: true, judge_result: judgeResult });
  } catch (err: any) {
    const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    return Response.json({ success: false, error: errMsg }, { status: 500 });
  }
}
