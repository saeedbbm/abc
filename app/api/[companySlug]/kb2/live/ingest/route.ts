import { NextRequest } from "next/server";
import { processIncrementalDocument } from "@/src/application/workers/kb2/live/incremental-ingest";

export const maxDuration = 120;

const VALID_SOURCE_TYPES = ["confluence", "jira", "slack", "github", "customerFeedback"] as const;
type SourceType = (typeof VALID_SOURCE_TYPES)[number];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { source_type, document } = body;

  if (!source_type || !VALID_SOURCE_TYPES.includes(source_type as SourceType)) {
    return Response.json(
      { error: `source_type must be one of: ${VALID_SOURCE_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  if (!document) {
    return Response.json({ error: "document is required" }, { status: 400 });
  }

  const result = await processIncrementalDocument({ source_type, document, companySlug });
  return Response.json(result);
}
