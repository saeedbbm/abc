import { NextRequest } from "next/server";
import { cascadeVerification } from "@/src/application/workers/new-test/pidrax-pass2.worker";

function toProjectId(slug: string): string {
  return `newtest-${slug}-project`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session, group_id, action, newText, rewrites } = body;

    if (!session || !group_id || !action) {
      return Response.json(
        { error: "session, group_id, and action are required" },
        { status: 400 },
      );
    }

    if (!["verify", "edit", "reject"].includes(action)) {
      return Response.json(
        { error: "action must be one of: verify, edit, reject" },
        { status: 400 },
      );
    }

    const projectId = toProjectId(session);
    const result = await cascadeVerification(projectId, group_id, action, newText, rewrites);

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
