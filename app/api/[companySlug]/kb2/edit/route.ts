import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { getTenantCollections } from "@/lib/mongodb";
import { getLatestCompletedRunId } from "@/src/application/lib/kb2/run-scope";
import { ensureWritableDemoState } from "@/src/application/lib/kb2/demo-state";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const body = await request.json();
  const { pageId, pageType, section, itemIndex, originalText, proposedText, author } = body;
  const writableState = await ensureWritableDemoState(tc, companySlug);

  const cardId = randomUUID();
  await tc.verification_cards.insertOne({
    card_id: cardId,
    run_id: body.run_id ?? writableState.base_run_id ?? await getLatestCompletedRunId(tc, companySlug),
    demo_state_id: writableState.state_id,
    card_type: "edit_proposal",
    severity: "S3",
    title: `Edit: ${section || pageId}`,
    explanation: `${author || "anonymous"} proposed an edit.`,
    canonical_text: originalText,
    proposed_text: proposedText,
    page_occurrences: [{
      page_id: pageId,
      page_type: pageType || "entity",
      section: section || "",
    }],
    assigned_to: [],
    claim_ids: [],
    status: "open",
    discussion: [],
  });

  return Response.json({ success: true, cardId });
}
