import { NextRequest } from "next/server";
import { resolveCompanySlug } from "@/lib/company-resolver";
import { db } from "@/lib/mongodb";
import type { ScoreFormatOutputType, AtomicItemType } from "@/src/entities/models/score-format";
import type { VerificationGroup } from "@/src/application/workers/new-test/pidrax-pass2.worker";

const COLLECTION = "pidrax_pass2_results";

async function buildFilter(companySlug: string): Promise<Record<string, string>> {
  const projectId = await resolveCompanySlug(companySlug);
  if (projectId) return { projectId };
  return { companySlug };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
): Promise<Response> {
  const { companySlug } = await params;
  const filter = await buildFilter(companySlug);

  try {
    const body = await request.json();
    const { group_id, action, newText, rewrites } = body;

    if (!group_id || !action) {
      return Response.json({ error: "group_id and action are required" }, { status: 400 });
    }
    if (!["verify", "edit", "reject"].includes(action)) {
      return Response.json({ error: "action must be one of: verify, edit, reject" }, { status: 400 });
    }

    const doc = await db.collection(COLLECTION).findOne(
      filter,
      { sort: { updatedAt: -1 } },
    );
    if (!doc?.data) return Response.json({ error: "No pass2 results found" }, { status: 404 });

    const data = doc.data as ScoreFormatOutputType;
    let updatedCount = 0;
    const pagesAffected = new Set<string>();

    const rewriteMap = new Map<string, string>();
    if (rewrites) {
      for (const r of rewrites) rewriteMap.set(r.item_id, r.new_text);
    }

    const markVerified = (bullet: AtomicItemType) => {
      bullet.verification = { status: "verified_human", verifier: bullet.verification?.verifier || null };
      bullet.action_routing = { ...bullet.action_routing, action: "none", severity: "S4" };
      bullet.confidence_bucket = "high";
      if (bullet.item_type === "conflict") bullet.item_type = "fact";
    };

    const updateItem = (bullet: AtomicItemType, pageId: string) => {
      if (bullet.group_id !== group_id) return;
      switch (action) {
        case "verify":
          markVerified(bullet);
          break;
        case "edit": {
          const perItemText = rewriteMap.get(bullet.item_id);
          if (perItemText) bullet.item_text = perItemText;
          else if (newText) bullet.item_text = newText;
          markVerified(bullet);
          break;
        }
        case "reject":
          bullet.verification = { status: "needs_verification", verifier: bullet.verification?.verifier || null };
          bullet.action_routing = { ...bullet.action_routing, action: "none", reason: "Rejected by human reviewer" };
          break;
      }
      updatedCount++;
      pagesAffected.add(pageId);
    };

    for (const source of ["kb_pages", "howto_pages"] as const) {
      for (const page of data[source] || []) {
        for (const section of page.sections) {
          for (const bullet of section.bullets) {
            updateItem(bullet, page.page_id);
          }
        }
      }
    }

    const groups = (doc.verificationGroups || []) as VerificationGroup[];
    const group = groups.find(g => g.group_id === group_id);
    if (group && (action === "verify" || action === "edit")) {
      group.severity = "none" as any;
    }

    await db.collection(COLLECTION).updateOne(
      { _id: doc._id },
      { $set: { data, verificationGroups: groups, updatedAt: new Date().toISOString() } },
    );

    return Response.json({ updated_count: updatedCount, pages_affected: [...pagesAffected] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
