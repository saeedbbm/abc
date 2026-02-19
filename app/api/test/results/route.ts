import { NextRequest } from "next/server";
import { db } from "@/lib/mongodb";

const VALID_TYPES = ["gaps", "tickets", "howto", "conflicts", "outdated"] as const;
type ResultType = (typeof VALID_TYPES)[number];

function toProjectId(slug: string): string {
  return `test-${slug}-project`;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const type = searchParams.get("type");
    const session = searchParams.get("session") || "company";
    const projectId = toProjectId(session);

    if (!type || !VALID_TYPES.includes(type as ResultType)) {
      return Response.json(
        { error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    const doc = await db
      .collection("test_results")
      .findOne(
        { projectId, type },
        { sort: { createdAt: -1 } }
      );

    if (!doc) {
      return Response.json({ type, results: [], createdAt: null });
    }

    return Response.json({
      type,
      results: doc.results ?? [],
      createdAt: doc.createdAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch results";
    return Response.json({ error: message }, { status: 500 });
  }
}
