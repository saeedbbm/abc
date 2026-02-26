import { resolveCompanySlug } from "@/lib/company-resolver";
import { db } from "@/lib/mongodb";

/**
 * Build a query filter that works whether the company is resolved via
 * projectId or only has data stored by companySlug.
 */
async function buildFilter(companySlug: string): Promise<Record<string, string> | null> {
  const projectId = await resolveCompanySlug(companySlug);
  if (projectId) return { projectId };
  // Fallback: pidrax replication stores companySlug on documents
  return { companySlug };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ companySlug: string }> },
): Promise<Response> {
  const { companySlug } = await params;
  const filter = await buildFilter(companySlug);
  if (!filter) return Response.json({ error: "Company not found" }, { status: 404 });

  const url = new URL(req.url);
  const type = url.searchParams.get("type");

  if (!type || !["inputs", "pass1", "pass2"].includes(type)) {
    return Response.json({ error: "type must be one of: inputs, pass1, pass2" }, { status: 400 });
  }

  try {
    if (type === "inputs") {
      const doc = await db.collection("pidrax_inputs").findOne(
        filter,
        { sort: { updatedAt: -1 } },
      );
      return Response.json({ inputs: doc?.inputs || null, createdAt: doc?.createdAt });
    }

    if (type === "pass1") {
      const doc = await db.collection("pidrax_pass1_results").findOne(
        filter,
        { sort: { updatedAt: -1 } },
      );
      return Response.json({
        data: doc?.data || null,
        pagePlan: doc?.pagePlan || null,
        crossValidation: doc?.crossValidation || null,
        metrics: doc?.metrics || null,
        createdAt: doc?.createdAt,
      });
    }

    if (type === "pass2") {
      const doc = await db.collection("pidrax_pass2_results").findOne(
        filter,
        { sort: { updatedAt: -1 } },
      );
      return Response.json({
        data: doc?.data || null,
        verificationGroups: doc?.verificationGroups || null,
        factClusters: doc?.factClusters || null,
        metrics: doc?.metrics || null,
        createdAt: doc?.createdAt,
      });
    }

    return Response.json({ error: "Unknown type" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
