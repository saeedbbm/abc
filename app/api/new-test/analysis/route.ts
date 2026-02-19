import { NextRequest } from "next/server";
import { db } from "@/lib/mongodb";

function toProjectId(slug: string): string {
  return `newtest-${slug}-project`;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const session = searchParams.get("session") || "";
    const projectId = toProjectId(session);

    const doc = await db.collection("new_test_analysis").findOne(
      { projectId },
      { sort: { analyzedAt: -1 } },
    );

    if (!doc) {
      return Response.json({ metrics: null, analyzedAt: null });
    }

    return Response.json(doc);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch analysis";
    return Response.json({ error: message }, { status: 500 });
  }
}
