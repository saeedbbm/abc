import { NextRequest } from "next/server";
import { kb2RawInputsCollection } from "@/lib/mongodb";

const VALID_SOURCES = ["confluence", "jira", "slack", "github", "customerFeedback"] as const;
type SourceType = (typeof VALID_SOURCES)[number];

/**
 * GET  — list stored raw inputs for this company
 * POST — upsert raw API response JSON for a given source
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const docs = await kb2RawInputsCollection
    .find({ company_slug: companySlug })
    .project({ _id: 0, source: 1, updated_at: 1, doc_count: 1 })
    .toArray();

  return Response.json({ sources: docs });
}

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

  const { source, data } = body;

  if (!source || !VALID_SOURCES.includes(source as SourceType)) {
    return Response.json(
      { error: `source must be one of: ${VALID_SOURCES.join(", ")}` },
      { status: 400 },
    );
  }

  if (!data) {
    return Response.json({ error: "data is required" }, { status: 400 });
  }

  const docCount = Array.isArray(data)
    ? data.length
    : data.results
      ? data.results.length
      : data.issues
        ? data.issues.length
        : 1;

  await kb2RawInputsCollection.updateOne(
    { company_slug: companySlug, source },
    {
      $set: {
        company_slug: companySlug,
        source,
        data,
        doc_count: docCount,
        updated_at: new Date().toISOString(),
      },
      $setOnInsert: { created_at: new Date().toISOString() },
    },
    { upsert: true },
  );

  return Response.json({
    ok: true,
    source,
    doc_count: docCount,
    message: `Stored ${docCount} ${source} documents for ${companySlug}`,
  });
}
