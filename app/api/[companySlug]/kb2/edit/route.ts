import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { kb2VerificationCardsCollection } from "@/lib/mongodb";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const body = await request.json();
  const { pageId, pageType, section, itemIndex, originalText, proposedText, author } = body;

  const cardId = randomUUID();
  await kb2VerificationCardsCollection.insertOne({
    card_id: cardId,
    run_id: "",
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
