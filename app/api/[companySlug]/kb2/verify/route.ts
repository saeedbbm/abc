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
  const { cardId, action, editText, comment } = body;
  const author = body.author ?? "anonymous";
  const writableState = await ensureWritableDemoState(tc, companySlug);

  if (action === "create") {
    const cardData = body.card;
    if (!cardData) return Response.json({ error: "Missing card data" }, { status: 400 });
    const newCardId = randomUUID();
    const runId = cardData.run_id ?? writableState.base_run_id ?? await getLatestCompletedRunId(tc, companySlug);
    await tc.verification_cards.insertOne({
      card_id: newCardId,
      run_id: runId,
      demo_state_id: writableState.state_id,
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

  const card = await tc.verification_cards.findOne({ card_id: cardId, demo_state_id: writableState.state_id });
  if (!card) return Response.json({ error: "Card not found" }, { status: 404 });

  switch (action) {
    case "validate": {
      await tc.verification_cards.updateOne(
        { card_id: cardId, demo_state_id: writableState.state_id },
        { $set: { status: "validated" } },
      );
      for (const claimId of (card.claim_ids ?? [])) {
        const claim = await tc.claims.findOne({ claim_id: claimId, demo_state_id: writableState.state_id });
        await tc.claims.updateOne(
          { claim_id: claimId, demo_state_id: writableState.state_id },
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
          await tc.entity_pages.updateOne(
            { page_id: claim.source_page_id, demo_state_id: writableState.state_id },
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
      await tc.verification_cards.updateOne(
        { card_id: cardId, demo_state_id: writableState.state_id },
        { $set: { status: "edited", proposed_text: editText } },
      );
      if (card.claim_ids?.length === 1 && editText) {
        const claim = await tc.claims.findOne({ claim_id: card.claim_ids[0], demo_state_id: writableState.state_id });
        await tc.claims.updateOne(
          { claim_id: card.claim_ids[0], demo_state_id: writableState.state_id },
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
          await tc.entity_pages.updateOne(
            { page_id: claim.source_page_id, demo_state_id: writableState.state_id },
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
      await tc.verification_cards.updateOne(
        { card_id: cardId, demo_state_id: writableState.state_id },
        { $set: { status: "rejected" } },
      );
      break;
    }
    case "comment": {
      await tc.verification_cards.updateOne(
        { card_id: cardId, demo_state_id: writableState.state_id },
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
      const nodeA = await tc.graph_nodes.findOne({ node_id: canonical.entity_a.node_id, demo_state_id: writableState.state_id });
      const nodeB = await tc.graph_nodes.findOne({ node_id: canonical.entity_b.node_id, demo_state_id: writableState.state_id });
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

      await tc.graph_nodes.updateOne(
        { node_id: keepNode.node_id, demo_state_id: writableState.state_id },
        {
          $set: { aliases: mergedAliases, attributes: { ...(removeNode.attributes ?? {}), ...(keepNode.attributes ?? {}) } },
          $push: { source_refs: { $each: removeNode.source_refs ?? [] } } as any,
        },
      );
      await tc.graph_nodes.deleteOne({ node_id: removeNode.node_id, demo_state_id: writableState.state_id });
      await tc.entity_pages.updateMany(
        { node_id: removeNode.node_id, demo_state_id: writableState.state_id },
        { $set: { node_id: keepNode.node_id } },
      );
      await tc.claims.updateMany(
        { entity_ids: removeNode.node_id, demo_state_id: writableState.state_id },
        { $set: { "entity_ids.$": keepNode.node_id } },
      );
      await tc.verification_cards.updateOne(
        { card_id: cardId, demo_state_id: writableState.state_id },
        { $set: { status: "validated" } },
      );
      break;
    }
    case "keep_separate": {
      await tc.verification_cards.updateOne(
        { card_id: cardId, demo_state_id: writableState.state_id },
        { $set: { status: "validated" } },
      );
      break;
    }
    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }

  return Response.json({ success: true, status: action });
}
