import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import {
  kb2VerificationCardsCollection,
  kb2ClaimsCollection,
  kb2EntityPagesCollection,
  kb2GraphNodesCollection,
} from "@/lib/mongodb";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const body = await request.json();
  const { cardId, action, editText, comment } = body;
  const author = body.author ?? "anonymous";

  if (action === "create") {
    const cardData = body.card;
    if (!cardData) return Response.json({ error: "Missing card data" }, { status: 400 });
    const newCardId = randomUUID();
    await kb2VerificationCardsCollection.insertOne({
      card_id: newCardId,
      card_type: cardData.card_type ?? "edit_proposal",
      severity: cardData.severity ?? "S3",
      title: cardData.title ?? "Untitled",
      explanation: cardData.description ?? "",
      description: cardData.description ?? "",
      canonical_text: cardData.canonical_text ?? "",
      proposed_text: cardData.proposed_text ?? "",
      recommended_action: cardData.recommended_action ?? "",
      source_refs: cardData.source_refs ?? [],
      page_occurrences: cardData.page_occurrences ?? [],
      claim_ids: cardData.claim_ids ?? [],
      assigned_to: cardData.assigned_to ?? [],
      status: "open",
      discussion: [],
      created_at: new Date().toISOString(),
    });
    return Response.json({ success: true, cardId: newCardId });
  }

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
    case "merge_entities": {
      const canonical = card.canonical_text ? JSON.parse(card.canonical_text) : null;
      if (!canonical?.entity_a?.node_id || !canonical?.entity_b?.node_id) {
        return Response.json({ error: "Card missing entity data" }, { status: 400 });
      }
      const nodeA = await kb2GraphNodesCollection.findOne({ node_id: canonical.entity_a.node_id });
      const nodeB = await kb2GraphNodesCollection.findOne({ node_id: canonical.entity_b.node_id });
      if (!nodeA || !nodeB) {
        return Response.json({ error: "One or both entities not found" }, { status: 404 });
      }
      const keepNode = (nodeA.source_refs?.length ?? 0) >= (nodeB.source_refs?.length ?? 0) ? nodeA : nodeB;
      const removeNode = keepNode === nodeA ? nodeB : nodeA;
      const mergedAliases = [...new Set([
        ...(keepNode.aliases ?? []),
        ...(removeNode.aliases ?? []),
        removeNode.display_name,
      ])].filter((a: string) => a.toLowerCase() !== keepNode.display_name.toLowerCase());

      await kb2GraphNodesCollection.updateOne(
        { node_id: keepNode.node_id },
        {
          $set: { aliases: mergedAliases, attributes: { ...(removeNode.attributes ?? {}), ...(keepNode.attributes ?? {}) } },
          $push: { source_refs: { $each: removeNode.source_refs ?? [] } } as any,
        },
      );
      await kb2GraphNodesCollection.deleteOne({ node_id: removeNode.node_id });
      await kb2EntityPagesCollection.updateMany(
        { node_id: removeNode.node_id },
        { $set: { node_id: keepNode.node_id } },
      );
      await kb2ClaimsCollection.updateMany(
        { entity_ids: removeNode.node_id },
        { $set: { "entity_ids.$": keepNode.node_id } },
      );
      await kb2VerificationCardsCollection.updateOne(
        { card_id: cardId },
        { $set: { status: "validated" } },
      );
      break;
    }
    case "keep_separate": {
      await kb2VerificationCardsCollection.updateOne(
        { card_id: cardId },
        { $set: { status: "validated" } },
      );
      break;
    }
    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  return Response.json({ success: true, status: action });
}
