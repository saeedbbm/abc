import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getFastModel } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { PrefixLogger } from "@/lib/utils";
import {
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
  kb2EntityPagesCollection,
} from "@/lib/mongodb";
import { getCompanyConfig } from "@/src/application/lib/kb2/company-config";

export const maxDuration = 60;

const ImpactSchema = z.object({
  impacts: z.array(
    z.object({
      summary: z.string(),
      reason: z.string(),
      recommended_action: z.string(),
      target_type: z.enum([
        "entity_page",
        "human_page",
        "ticket",
        "entity",
        "claim",
      ]),
      target_id: z.string(),
      severity: z.enum(["S1", "S2", "S3", "S4"]),
    }),
  ),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const config = await getCompanyConfig(companySlug);
  const logger = new PrefixLogger("kb2-impact");

  const { change_type, entity_id, old_value, new_value, context } =
    await request.json();

  if (
    change_type === "comment" &&
    typeof new_value === "string" &&
    new_value.length < (config?.pipeline_settings?.impact?.min_value_length ?? 50)
  ) {
    return Response.json({ impacts: [] });
  }

  logger.log("Analyzing impact for", entity_id, "change_type:", change_type);

  const startNode = await kb2GraphNodesCollection.findOne({
    node_id: entity_id,
  });

  const edges = await kb2GraphEdgesCollection
    .find({
      $or: [
        { source_node_id: entity_id },
        { target_node_id: entity_id },
      ],
    })
    .limit(config?.pipeline_settings?.impact?.edges_limit ?? 50)
    .toArray();

  const neighborIds = new Set<string>();
  for (const e of edges) {
    neighborIds.add(e.source_node_id as string);
    neighborIds.add(e.target_node_id as string);
  }
  neighborIds.delete(entity_id);

  const neighborNodes = neighborIds.size > 0
    ? await kb2GraphNodesCollection
        .find({ node_id: { $in: [...neighborIds] } })
        .toArray()
    : [];

  const relatedPages = await kb2EntityPagesCollection
    .find({ node_id: { $in: [entity_id, ...neighborIds] } })
    .limit(config?.pipeline_settings?.impact?.related_pages_limit ?? 20)
    .toArray();

  const graphContext = [
    startNode
      ? `Changed entity: [${startNode.type}: ${startNode.display_name}]`
      : `Changed entity ID: ${entity_id}`,
    "",
    "1-hop neighbors:",
    ...neighborNodes.map((n: any) => {
      const rel = edges.find(
        (e: any) =>
          e.source_node_id === n.node_id || e.target_node_id === n.node_id,
      );
      return `- [${n.type}: ${n.display_name}] via ${rel?.type ?? "unknown"}`;
    }),
    "",
    "Related entity pages:",
    ...relatedPages.map(
      (p: any) => `- ${p.title} (node_id: ${p.node_id})`,
    ),
  ].join("\n");

  const result = await structuredGenerate({
    model: getFastModel(config?.pipeline_settings?.models),
    system: config?.prompts?.impact_analysis?.system ?? `You are a knowledge-base impact analyzer. Given a change to an entity, identify all downstream impacts on related entities, pages, tickets, and claims. Be precise about severity:
- S1: Critical — breaks correctness of a core entity or claim
- S2: High — significant factual change that should be propagated
- S3: Medium — minor update that may need propagation
- S4: Low — cosmetic or unlikely to affect other artifacts`,
    prompt: `A change was made:
- Change type: ${change_type}
- Entity: ${entity_id}
- Old value: ${JSON.stringify(old_value)}
- New value: ${JSON.stringify(new_value)}
- Additional context: ${context ?? "none"}

Graph neighborhood:
${graphContext}

Identify all impacts this change has on related entities, pages, tickets, and claims. For each impact, specify the target_type and target_id of the affected artifact.`,
    schema: ImpactSchema,
    logger,
  });

  const impacts = result.impacts.map((impact) => ({
    id: randomUUID(),
    ...impact,
  }));

  logger.log("Found", impacts.length, "impacts for", entity_id);

  return Response.json({ impacts });
}
