import { NextRequest } from "next/server";
import { z } from "zod";
import {
  kb2EntityPagesCollection,
  kb2TicketsCollection,
  kb2ClaimsCollection,
  kb2HumanPagesCollection,
} from "@/lib/mongodb";
import { getFastModel } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { PrefixLogger } from "@/lib/utils";

export const maxDuration = 60;

interface AcceptedImpact {
  id: string;
  summary: string;
  reason: string;
  recommended_action: string;
  target_type: string;
  target_id: string;
  severity: string;
  accepted: boolean;
}

const EntityPageUpdateSchema = z.object({
  section_index: z.number(),
  item_index: z.number(),
  new_text: z.string(),
});

async function applyEntityPagePropagation(
  targetId: string,
  recommendedAction: string,
): Promise<{ success: boolean; action: string }> {
  const page =
    (await kb2EntityPagesCollection.findOne({ page_id: targetId })) ??
    (await kb2EntityPagesCollection.findOne({ node_id: targetId }));

  if (!page) {
    return { success: false, action: `entity_page:${targetId} — page not found` };
  }

  const sections = (page as any).sections ?? [];
  const sectionList = sections.map(
    (s: any, si: number) =>
      `[${si}] ${s.section_name}: ${(s.items ?? []).map((i: any, ii: number) => `(${ii}) ${i.text}`).join("; ")}`,
  ).join("\n");

  const logger = new PrefixLogger("kb2-propagate");
  const result = await structuredGenerate({
    model: getFastModel(),
    system: `You determine which section item in an entity page needs to be updated based on a recommended action.
Given the page content and the recommended action, return the 0-based section_index, item_index, and the exact new_text for that item.
The new_text should incorporate the recommended action while preserving relevant context from the original.`,
    prompt: `Recommended action: ${recommendedAction}

Page sections (format: [section_index] section_name: (item_index) item_text):
${sectionList}

Return section_index, item_index, and new_text.`,
    schema: EntityPageUpdateSchema,
    logger,
  });

  const sectionIndex = result.section_index;
  const itemIndex = result.item_index;
  if (
    sectionIndex < 0 ||
    sectionIndex >= sections.length ||
    itemIndex < 0 ||
    (sections[sectionIndex]?.items?.length ?? 0) <= itemIndex
  ) {
    return {
      success: false,
      action: `entity_page:${targetId} — invalid indices from LLM`,
    };
  }

  await kb2EntityPagesCollection.updateOne(
    { page_id: (page as any).page_id },
    {
      $set: {
        [`sections.${sectionIndex}.items.${itemIndex}.text`]: result.new_text,
      },
    },
  );
  return {
    success: true,
    action: `entity_page:${targetId} — updated section ${sectionIndex} item ${itemIndex}`,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const { accepted_impacts } = (await request.json()) as {
    accepted_impacts: AcceptedImpact[];
  };

  let propagated = 0;
  const actions: string[] = [];

  for (const impact of accepted_impacts) {
    switch (impact.target_type) {
      case "entity_page": {
        const { success, action } = await applyEntityPagePropagation(
          impact.target_id,
          impact.recommended_action,
        );
        actions.push(action);
        if (success) propagated++;
        break;
      }

      case "ticket": {
        if (/creat/i.test(impact.recommended_action)) {
          await kb2TicketsCollection.insertOne({
            ticket_id: impact.id,
            title: impact.summary,
            description: impact.recommended_action,
            status: "open",
            severity: impact.severity,
            source: "impact_propagation",
            created_at: new Date().toISOString(),
          });
          actions.push(`ticket:${impact.id} — created`);
        } else {
          const ticket = await kb2TicketsCollection.findOne({
            ticket_id: impact.target_id,
          });
          if (ticket) {
            await kb2TicketsCollection.updateOne(
              { ticket_id: impact.target_id },
              {
                $set: {
                  description: impact.recommended_action,
                  title: impact.summary || ticket.title,
                  updated_at: new Date().toISOString(),
                },
              },
            );
            actions.push(`ticket:${impact.target_id} — updated`);
          } else {
            actions.push(`ticket:${impact.target_id} — not found`);
          }
        }
        propagated++;
        break;
      }

      case "claim": {
        const res = await kb2ClaimsCollection.updateOne(
          { claim_id: impact.target_id },
          {
            $set: {
              text: impact.recommended_action,
              truth_status: "human_asserted",
              confidence: "high",
            },
            $push: {
              source_refs: {
                source_type: "human_verification",
                doc_id: `propagate-${impact.id}`,
                title: "Propagation",
                excerpt: impact.reason,
              },
            } as any,
          },
        );
        if (res.matchedCount > 0) {
          actions.push(`claim:${impact.target_id} — marked human_asserted and updated text`);
          propagated++;
        } else {
          actions.push(`claim:${impact.target_id} — not found`);
        }
        break;
      }

      case "human_page": {
        const page = await kb2HumanPagesCollection.findOne({
          page_id: impact.target_id,
        });
        if (!page) {
          actions.push(`human_page:${impact.target_id} — not found`);
          break;
        }
        await kb2HumanPagesCollection.updateOne(
          { page_id: impact.target_id },
          {
            $push: {
              paragraphs: {
                heading: "Propagation Note",
                body: `[${impact.reason}]\n\n${impact.recommended_action}`,
                entity_refs: [],
                source_items: [],
              },
            } as any,
          },
        );
        actions.push(`human_page:${impact.target_id} — added note`);
        propagated++;
        break;
      }

      case "entity": {
        const { success, action } = await applyEntityPagePropagation(
          impact.target_id,
          impact.recommended_action,
        );
        actions.push(action);
        if (success) propagated++;
        break;
      }

      default: {
        actions.push(
          `${impact.target_type}:${impact.target_id} — skipped (unknown type)`,
        );
        break;
      }
    }
  }

  return Response.json({
    propagated,
    summary: `Processed ${accepted_impacts.length} impacts: ${actions.join("; ")}`,
  });
}
