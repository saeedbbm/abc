import { randomUUID } from "crypto";
import { z } from "zod";
import { kb2InputSnapshotsCollection, kb2GraphNodesCollection, kb2VerificationCardsCollection } from "@/lib/mongodb";
import { getFastModel } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { PrefixLogger } from "@/lib/utils";
import { parseConfluenceApiResponse, type KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { parseJiraApiResponse } from "@/src/application/lib/kb2/jira-parser";
import { parseSlackApiResponse } from "@/src/application/lib/kb2/slack-parser";
import { parseGithubApiResponse } from "@/src/application/lib/kb2/github-parser";
import { parseFeedbackApiResponse } from "@/src/application/lib/kb2/feedback-parser";

const logger = new PrefixLogger("kb2-incremental-ingest");

const SOURCE_PARSERS: Record<string, (data: unknown) => KB2ParsedDocument[]> = {
  confluence: parseConfluenceApiResponse,
  jira: parseJiraApiResponse,
  slack: parseSlackApiResponse,
  github: parseGithubApiResponse,
  customerFeedback: parseFeedbackApiResponse,
};

const ExtractedEntitySchema = z.object({
  entities: z.array(z.object({
    display_name: z.string(),
    type: z.string(),
    aliases: z.array(z.string()),
    attributes: z.object({}).passthrough(),
    confidence: z.enum(["high", "medium", "low"]),
    evidence_excerpt: z.string(),
  })),
});

const EXTRACTION_SYSTEM_PROMPT = `You are an entity extraction engine for a software company knowledge base.
Extract every distinct entity from the provided document.

ENTITY TYPES: person, team, client, repository, integration, infrastructure, cloud_resource, library, database, environment, project, ticket, pull_request, pipeline, customer_feedback

RULES:
- Each entity gets a canonical display_name and optional aliases
- Include key attributes as a JSON object (e.g. role, owner, tech_stack, version)
- Rate confidence: high = multiple sources confirm, medium = single clear mention, low = inferred
- Provide a short evidence_excerpt from the source text
- Extract liberally — deduplication happens later`;

interface ImpactCard {
  id: string;
  summary: string;
  reason: string;
  recommended_action: string;
  target_type: string;
  target_id: string;
  severity: string;
}

export interface IncrementalIngestResult {
  new_entities: number;
  updated_entities: number;
  conflicts: number;
  impact_cards: ImpactCard[];
}

export async function processIncrementalDocument(opts: {
  source_type: string;
  document: any;
  run_id?: string;
}): Promise<IncrementalIngestResult> {
  const { source_type, document, run_id } = opts;

  const parser = SOURCE_PARSERS[source_type];
  if (!parser) {
    throw new Error(`Unknown source_type: ${source_type}`);
  }

  const parsedDocs = parser(document);
  if (parsedDocs.length === 0) {
    return { new_entities: 0, updated_entities: 0, conflicts: 0, impact_cards: [] };
  }

  const latestSnapshot = await kb2InputSnapshotsCollection
    .find({})
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();

  const existingDocs: KB2ParsedDocument[] =
    latestSnapshot.length > 0
      ? (latestSnapshot[0].parsed_documents as KB2ParsedDocument[] ?? [])
      : [];

  const existingBySourceId = new Map<string, KB2ParsedDocument>();
  for (const doc of existingDocs) {
    existingBySourceId.set(doc.sourceId, doc);
  }

  const newOrChangedDocs: KB2ParsedDocument[] = [];
  for (const doc of parsedDocs) {
    const existing = existingBySourceId.get(doc.sourceId);
    if (!existing || existing.content !== doc.content) {
      newOrChangedDocs.push(doc);
    }
  }

  if (newOrChangedDocs.length === 0) {
    return { new_entities: 0, updated_entities: 0, conflicts: 0, impact_cards: [] };
  }

  const batchText = newOrChangedDocs
    .map((d, idx) => `--- Document ${idx + 1}: ${d.title} (${d.provider}) ---\n${d.content}`)
    .join("\n\n");

  const model = getFastModel();
  const result = await structuredGenerate({
    model,
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: batchText,
    schema: ExtractedEntitySchema,
    logger,
  });

  const extracted = Array.isArray(result?.entities) ? result.entities : [];

  const lookupRunId = run_id ?? latestSnapshot[0]?.run_id;
  const existingNodes = lookupRunId
    ? await kb2GraphNodesCollection.find({ run_id: lookupRunId }).toArray()
    : [];

  const existingNodesByName = new Map<string, (typeof existingNodes)[number]>();
  for (const node of existingNodes) {
    existingNodesByName.set(node.display_name.toLowerCase().trim(), node);
    if (Array.isArray(node.aliases)) {
      for (const alias of node.aliases) {
        existingNodesByName.set(alias.toLowerCase().trim(), node);
      }
    }
  }

  let newCount = 0;
  let updatedCount = 0;
  let conflictCount = 0;
  const impactCards: ImpactCard[] = [];

  for (const entity of extracted) {
    if (!entity.display_name) continue;
    const key = entity.display_name.toLowerCase().trim();
    const existingNode = existingNodesByName.get(key);

    if (!existingNode) {
      newCount++;
      impactCards.push({
        id: randomUUID(),
        summary: `New entity discovered: ${entity.display_name} (${entity.type})`,
        reason: `Found in incremental ingest from ${source_type}. Not present in existing knowledge graph.`,
        recommended_action: "Review and approve addition to the knowledge base",
        target_type: entity.type,
        target_id: entity.display_name,
        severity: "S3",
      });
    } else {
      const existingAttrs = existingNode.attributes && typeof existingNode.attributes === "object"
        ? JSON.stringify(existingNode.attributes)
        : "{}";
      const newAttrs = entity.attributes && typeof entity.attributes === "object"
        ? JSON.stringify(entity.attributes)
        : "{}";

      const hasConflict = existingNode.type !== entity.type.toLowerCase().replace(/\s+/g, "_");

      if (hasConflict) {
        conflictCount++;
        impactCards.push({
          id: randomUUID(),
          summary: `Conflicting type for entity: ${entity.display_name}`,
          reason: `Existing type "${existingNode.type}" conflicts with new type "${entity.type}" from ${source_type} source.`,
          recommended_action: "Resolve entity type conflict — verify which type is correct",
          target_type: existingNode.type as string,
          target_id: existingNode.node_id as string,
          severity: "S2",
        });
      } else if (existingAttrs !== newAttrs) {
        updatedCount++;
        impactCards.push({
          id: randomUUID(),
          summary: `Updated info for entity: ${entity.display_name}`,
          reason: `New attributes found in ${source_type} source differ from existing record.`,
          recommended_action: "Review attribute changes and approve update",
          target_type: existingNode.type as string,
          target_id: existingNode.node_id as string,
          severity: "S3",
        });
      }
    }
  }

  if (impactCards.length > 0) {
    const cardsToInsert = impactCards.map((card) => ({
      card_id: card.id,
      run_id: run_id ?? "",
      card_type: "edit_proposal" as const,
      severity: card.severity,
      title: card.summary,
      explanation: card.reason,
      recommended_action: card.recommended_action,
      page_occurrences: [],
      assigned_to: [],
      claim_ids: [],
      status: "open" as const,
      discussion: [],
      source: "incremental_ingest",
      target_type: card.target_type,
      target_id: card.target_id,
    }));
    await kb2VerificationCardsCollection.insertMany(cardsToInsert);
  }

  return {
    new_entities: newCount,
    updated_entities: updatedCount,
    conflicts: conflictCount,
    impact_cards: impactCards,
  };
}
