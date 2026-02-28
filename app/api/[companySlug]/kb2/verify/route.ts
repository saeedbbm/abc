import { NextRequest } from "next/server";
import {
  kb2VerificationCardsCollection,
  kb2ClaimsCollection,
  kb2EntityPagesCollection,
} from "@/lib/mongodb";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const body = await request.json();
  const { cardId, action, editText, comment } = body;
  const author = body.author ?? "anonymous";

  const card = await kb2VerificationCardsCollection.findOne({ card_id: cardId });
  if (!card) return Response.json({ error: "Card not found" }, { status: 404 });

  switch (action) {
    case "validate": {
      await kb2VerificationCardsCollection.updateOne(
        { card_id: cardId },
        { $set: { status: "validated" } },
      );
      for (const claimId of (card.claim_ids ?? [])) {
        const claim = await kb2ClaimsCollection.findOne({ claim_id: claimId });
        await kb2ClaimsCollection.updateOne(
          { claim_id: claimId },
          {
            $set: { truth_status: "human_asserted", confidence: "high" },
            $push: {
              source_refs: {
                source_type: "human_verification",
                doc_id: `verify-${cardId}`,
                title: `Verified by ${author}`,
                excerpt: `Validated on ${new Date().toISOString()}`,
              },
            } as any,
          },
        );

        if (claim?.source_page_id && claim.source_page_type === "entity" &&
            claim.source_section_index !== undefined && claim.source_item_index !== undefined) {
          await kb2EntityPagesCollection.updateOne(
            { page_id: claim.source_page_id, run_id: claim.run_id },
            {
              $push: {
                [`sections.${claim.source_section_index}.items.${claim.source_item_index}.source_refs`]: {
                  source_type: "human_verification",
                  doc_id: `verify-${cardId}`,
                  title: `Verified by ${author}`,
                },
              } as any,
            },
          );
        }
      }
      break;
    }
    case "edit": {
      await kb2VerificationCardsCollection.updateOne(
        { card_id: cardId },
        { $set: { status: "edited", proposed_text: editText } },
      );
      if (card.claim_ids?.length === 1 && editText) {
        const claim = await kb2ClaimsCollection.findOne({ claim_id: card.claim_ids[0] });
        await kb2ClaimsCollection.updateOne(
          { claim_id: card.claim_ids[0] },
          {
            $set: { text: editText, truth_status: "human_asserted", confidence: "high" },
            $push: {
              source_refs: {
                source_type: "human_verification",
                doc_id: `edit-${cardId}`,
                title: `Edited by ${author}`,
                excerpt: editText.slice(0, 200),
              },
            } as any,
          },
        );

        if (claim?.source_page_id && claim.source_page_type === "entity" &&
            claim.source_section_index !== undefined && claim.source_item_index !== undefined) {
          await kb2EntityPagesCollection.updateOne(
            { page_id: claim.source_page_id, run_id: claim.run_id },
            {
              $set: {
                [`sections.${claim.source_section_index}.items.${claim.source_item_index}.text`]: editText,
              },
              $push: {
                [`sections.${claim.source_section_index}.items.${claim.source_item_index}.source_refs`]: {
                  source_type: "human_verification",
                  doc_id: `edit-${cardId}`,
                  title: `Edited by ${author}`,
                },
              } as any,
            },
          );
        }
      }
      break;
    }
    case "reject": {
      await kb2VerificationCardsCollection.updateOne(
        { card_id: cardId },
        { $set: { status: "rejected" } },
      );
      break;
    }
    case "comment": {
      await kb2VerificationCardsCollection.updateOne(
        { card_id: cardId },
        {
          $push: {
            discussion: {
              author,
              text: comment,
              timestamp: new Date().toISOString(),
            },
          } as any,
        },
      );
      break;
    }
    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  return Response.json({ success: true, status: action });
}
