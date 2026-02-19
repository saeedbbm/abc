import { NextRequest } from "next/server";
import { runComparison } from "@/src/application/lib/test/comparison-engine";

export const maxDuration = 120;

function toProjectId(slug: string): string {
  return `test-${slug}-project`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { gaps, tickets, howto, conflicts, outdated, session } = body;

    const fields = { gaps, tickets, howto, conflicts, outdated };
    const missing = Object.entries(fields)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);

    if (missing.length > 0) {
      return Response.json(
        { error: `Missing required fields: ${missing.join(", ")}` },
        { status: 400 }
      );
    }

    const sessionSlug = session || "company";
    const projectId = toProjectId(sessionSlug);

    const analysis = await runComparison(projectId, {
      gaps,
      tickets,
      howto,
      conflicts,
      outdated,
    });

    return Response.json(analysis);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Comparison analysis failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
