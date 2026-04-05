import { NextRequest } from "next/server";
import { getTenantCollections } from "@/lib/mongodb";
import {
  buildStructuredDataFromInput,
  compareTextToStructuredData,
  getStructuredDataItemCount,
} from "@/src/application/lib/kb2/structured-source-input";

const VALID_SOURCES = ["confluence", "jira", "slack", "github", "customerFeedback"] as const;
type SourceType = (typeof VALID_SOURCES)[number];

/**
 * GET  — list stored raw inputs for this company
 *        ?full=true  returns the actual stored data (text/json) per source
 * POST — upsert raw input data (human text or JSON) for a given source
 */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const full = request.nextUrl.searchParams.get("full") === "true";
  const includeStructured =
    request.nextUrl.searchParams.get("include_structured") === "true";
  const tc = getTenantCollections(companySlug);

  if (full) {
    const docs = await tc.raw_inputs
      .find({ company_slug: companySlug })
      .toArray();

    const sources: Record<string, {
      data: unknown;
      doc_count: number;
      updated_at: string;
      input_format?: string;
      structured_available?: boolean;
      structured_data?: unknown;
      structured_check?: unknown;
    }> = {};
    for (const doc of docs) {
      sources[doc.source as string] = {
        data: doc.data,
        doc_count: doc.doc_count ?? 0,
        updated_at: doc.updated_at as string,
        input_format: doc.input_format as string | undefined,
        structured_available: Boolean(doc.structured_data),
        ...(includeStructured
          ? {
              structured_data: doc.structured_data,
              structured_check: doc.structured_check,
            }
          : {}),
      };
    }
    return Response.json({ sources });
  }

  const docs = await tc.raw_inputs
    .find({ company_slug: companySlug })
    .project({ _id: 0, source: 1, updated_at: 1, doc_count: 1, input_format: 1, structured_at: 1 })
    .toArray();

  return Response.json({ sources: docs });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { source, data, action } = body;

  if (!source || !VALID_SOURCES.includes(source as SourceType)) {
    return Response.json(
      { error: `source must be one of: ${VALID_SOURCES.join(", ")}` },
      { status: 400 },
    );
  }

  if (data === undefined || data === null) {
    return Response.json({ error: "data is required" }, { status: 400 });
  }

  const inputFormat = typeof data === "string" ? "human_text" : "json";
  const structuredData = buildStructuredDataFromInput(source, data);
  const structuredCheck =
    typeof data === "string" && structuredData
      ? compareTextToStructuredData(source, data, structuredData)
      : null;

  if (action === "convert_preview") {
    return Response.json({
      ok: true,
      source,
      input_format: inputFormat,
      structured_data: structuredData,
      structured_check: structuredCheck,
      doc_count:
        structuredData
          ? Math.max(getStructuredDataItemCount(structuredData), 1)
          : 1,
    });
  }

  let docCount = 1;
  if (structuredData) {
    docCount = Math.max(getStructuredDataItemCount(structuredData), 1);
  } else if (Array.isArray(data)) {
    docCount = data.length;
  } else if (data.results) {
    docCount = data.results.length;
  } else if (data.issues) {
    docCount = data.issues.length;
  }

  await tc.raw_inputs.updateOne(
    { company_slug: companySlug, source },
    {
      $set: {
        company_slug: companySlug,
        source,
        data,
        raw_text: typeof data === "string" ? data : null,
        input_format: inputFormat,
        structured_data: structuredData,
        structured_check: structuredCheck,
        structured_at: structuredData ? new Date().toISOString() : null,
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
    message: `Stored ${source} data for ${companySlug}`,
  });
}
