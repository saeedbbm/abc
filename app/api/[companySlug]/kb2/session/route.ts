import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const body = await request.json();
  const { action } = body;

  switch (action) {
    case "create": {
      const sessionId = randomUUID();
      // In production: copy baseline data with session_id scope
      // For now: return a session ID that can be used for isolation
      return Response.json({
        success: true,
        sessionId,
        message: `Session created for ${companySlug}`,
      });
    }
    case "reset": {
      const { sessionId } = body;
      if (!sessionId) return Response.json({ error: "Missing sessionId" }, { status: 400 });
      // In production: delete all docs with this session_id, re-copy from baseline
      // Also: delete git branch sandbox/session-{sessionId}
      return Response.json({
        success: true,
        message: `Session ${sessionId} reset for ${companySlug}`,
      });
    }
    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
