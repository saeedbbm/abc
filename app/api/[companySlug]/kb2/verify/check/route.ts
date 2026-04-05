import { NextRequest } from "next/server";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { generateText } from "ai";
import { PrefixLogger } from "@/lib/utils";
import { getCompanyConfig } from "@/src/application/lib/kb2/company-config";
import { getLatestCompletedRunId, getLatestRunIdFromCollection } from "@/src/application/lib/kb2/run-scope";
import {
  buildBaselineRunFilter,
  buildStateFilter,
  isWorkspaceLikeState,
  resolveActiveDemoState,
} from "@/src/application/lib/kb2/demo-state";

export const maxDuration = 120;

const AffectedNodesSchema = z.object({
  affected_node_names: z.array(z.string()).describe(
    "Display names of ALL graph nodes whose entity page content would need to change",
  ),
  reasoning: z.string().describe("Brief explanation of why these nodes are affected"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const config = await getCompanyConfig(companySlug);
  const { cardId, modificationText, answers } = await request.json();
  const logger = new PrefixLogger("verify-check");
  const activeDemoState = await resolveActiveDemoState(tc, companySlug);
  let activeStateFilter: Record<string, unknown>;
  if (isWorkspaceLikeState(activeDemoState)) {
    activeStateFilter = buildStateFilter(activeDemoState.state_id);
  } else if (activeDemoState) {
    activeStateFilter = buildBaselineRunFilter(activeDemoState.base_run_id);
  } else {
    activeStateFilter = { demo_state_id: { $exists: false } };
  }

  if (!cardId || !modificationText) {
    return Response.json({ error: "Missing cardId or modificationText" }, { status: 400 });
  }

  const card = await tc.verification_cards.findOne({ card_id: cardId, ...activeStateFilter });
  if (!card) return Response.json({ error: "Card not found" }, { status: 404 });

  const runId =
    (typeof card.run_id === "string" && card.run_id.trim().length > 0 ? card.run_id : null)
    ?? await getLatestRunIdFromCollection(tc, companySlug, tc.entity_pages)
    ?? await getLatestCompletedRunId(tc, companySlug);
  const runFilter: Record<string, any> = {};
  if (isWorkspaceLikeState(activeDemoState)) {
    Object.assign(runFilter, buildStateFilter(activeDemoState.state_id));
  } else if (runId) {
    Object.assign(runFilter, buildBaselineRunFilter(runId));
  }

  // ── Step 1: Get all graph nodes and entity pages for context ──
  const allNodes = await tc.graph_nodes.find(runFilter).toArray();
  const edgeFilter = runId ? buildBaselineRunFilter(runId) : {};
  const allEdges = await tc.graph_edges.find(edgeFilter).toArray();
  const allPages = await tc.entity_pages.find(runFilter).toArray();

  const nodeList = allNodes.map((n: any) => `- ${n.display_name} [${n.type}] (node_id: ${n.node_id})`).join("\n");

  logger.log(`Loaded ${allNodes.length} nodes, ${allEdges.length} edges, ${allPages.length} pages`);

  // ── Step 2: Identify which nodes are affected ──
  const preComputedEntities = (card as any).affected_entities ?? [];
  let affectedNames: Set<string>;
  let identifyReasoning = "";

  if (preComputedEntities.length > 0) {
    affectedNames = new Set(
      preComputedEntities.map((e: any) => (e.entity_name as string).toLowerCase().trim()),
    );
    identifyReasoning = `Skipped LLM — used ${preComputedEntities.length} pre-computed affected entities from verify card`;
    logger.log(`Using ${affectedNames.size} pre-computed affected entities: ${[...affectedNames].join(", ")}`);
  } else {
    const identifyResult = await structuredGenerate({
      model: getFastModel(config?.pipeline_settings?.models),
      system: config?.prompts?.verify_analyst?.system ?? `You are a knowledge graph analyst. Given a user's modification request and a list of all entity nodes in the knowledge base, identify EVERY node whose entity page would need to be updated.

Think through the graph relationships:
- If the user says "use X instead of Y", find the node for Y AND every node that mentions or depends on Y (people who work with Y, repos that use Y, projects involving Y, etc.)
- Include both directly and indirectly affected nodes
- Be thorough — missing an affected node means the knowledge base becomes inconsistent`,
      prompt: `Verification Card: ${card.title}
Description: ${(card as any).description || (card as any).explanation}

User's Change Request: "${modificationText}"

All nodes in the knowledge base:
${nodeList}

Which nodes have entity pages that would need to change? List ALL of them by display_name.`,
      schema: AffectedNodesSchema,
      logger,
    });

    affectedNames = new Set(
      identifyResult.affected_node_names.map((n: string) => n.toLowerCase().trim()),
    );
    identifyReasoning = identifyResult.reasoning;
    logger.log(`LLM identified ${affectedNames.size} affected nodes: ${[...affectedNames].join(", ")}`);
  }

  // ── Step 3: Match to actual pages and also walk graph edges ──
  const matchedNodeIds = new Set<string>();
  for (const node of allNodes) {
    if (affectedNames.has((node as any).display_name.toLowerCase().trim())) {
      matchedNodeIds.add((node as any).node_id);
    }
  }

  // Walk 1-hop edges from matched nodes to find additional connected nodes
  const neighborIds = new Set<string>();
  for (const edge of allEdges) {
    const src = (edge as any).source_node_id;
    const tgt = (edge as any).target_node_id;
    if (matchedNodeIds.has(src)) neighborIds.add(tgt);
    if (matchedNodeIds.has(tgt)) neighborIds.add(src);
  }

  // Check if neighbor pages actually mention the relevant terms (don't blindly include all neighbors)
  const allRelevantNodeIds = new Set([...matchedNodeIds]);
  for (const nid of neighborIds) {
    if (matchedNodeIds.has(nid)) continue;
    const page = allPages.find((p: any) => p.node_id === nid);
    if (page) {
      const pageText = (page as any).sections
        ?.flatMap((s: any) => (s.items ?? []).map((it: any) => it.text))
        .join(" ") ?? "";
      const fullText = `${(page as any).title} ${pageText}`.toLowerCase();
      // Check if this neighbor page actually references any of the affected node names
      if ([...affectedNames].some((name) => fullText.includes(name))) {
        allRelevantNodeIds.add(nid);
      }
    }
  }

  // ── Step 4: Gather full content of all affected pages ──
  const affectedPages: any[] = [];
  const contextParts: string[] = [];

  for (const page of allPages) {
    if (!allRelevantNodeIds.has((page as any).node_id)) continue;
    affectedPages.push(page);
    contextParts.push(`\n=== Entity Page: ${(page as any).title} (page_id: ${(page as any).page_id}) ===`);
    for (const section of (page as any).sections ?? []) {
      for (const item of section.items ?? []) {
        contextParts.push(`[${section.section_name}] ${item.text}`);
      }
    }
  }

  // Also check tickets
  const allTickets = await tc.tickets.find(runFilter).toArray();
  const affectedTickets: any[] = [];
  for (const ticket of allTickets) {
    const linkedIds = (ticket as any).linked_entity_ids ?? [];
    if (linkedIds.some((id: string) => allRelevantNodeIds.has(id))) {
      affectedTickets.push(ticket);
      contextParts.push(`\n=== Ticket: ${(ticket as any).title} (ticket_id: ${(ticket as any).ticket_id}) ===`);
      contextParts.push((ticket as any).description ?? "");
    }
  }

  logger.log(`Graph traversal found ${affectedPages.length} affected pages, ${affectedTickets.length} affected tickets`);

  if (affectedPages.length === 0 && affectedTickets.length === 0) {
    return Response.json({
      drafts: [],
      questions: [`No affected pages found. The LLM identified these nodes as affected: ${[...affectedNames].join(", ")}. But no matching entity pages were found.`],
      debug: { reasoning: identifyReasoning, affectedNames: [...affectedNames], nodesTotal: allNodes.length, pagesTotal: allPages.length },
    });
  }

  // ── Step 5: For each affected page, apply changes individually ──
  // Process pages one-by-one to avoid massive single LLM call that times out
  const model = getFastModel(config?.pipeline_settings?.models);
  const allDrafts: any[] = [];
  const allQuestions: string[] = [];

  // Process in parallel batches of 5
  const BATCH_SIZE = config?.pipeline_settings?.verify_check?.batch_size ?? 5;
  const items: { type: "entity_page" | "ticket"; id: string; title: string; content: string }[] = [];

  for (const page of affectedPages) {
    const parts: string[] = [];
    for (const section of (page as any).sections ?? []) {
      for (const item of section.items ?? []) {
        parts.push(`[${section.section_name}] ${item.text}`);
      }
    }
    items.push({
      type: "entity_page",
      id: (page as any).page_id,
      title: (page as any).title,
      content: parts.join("\n"),
    });
  }

  for (const ticket of affectedTickets) {
    items.push({
      type: "ticket",
      id: (ticket as any).ticket_id,
      title: (ticket as any).title,
      content: (ticket as any).description ?? "",
    });
  }

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchContext = batch.map((item) =>
      `\n=== ${item.type === "entity_page" ? "Entity Page" : "Ticket"}: ${item.title} (${item.type === "entity_page" ? "page_id" : "ticket_id"}: ${item.id}) ===\n${item.content}`
    ).join("\n");

    logger.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(items.length / BATCH_SIZE)} (${batch.length} items)`);

    try {
      const result = await generateText({
        model,
        system: config?.prompts?.verify_editor?.system ?? `You are a precise knowledge base editor. Apply the user's change to the given pages/tickets.

RULES:
1. ONLY change what the user explicitly asked to change.
2. If the user says "use X instead of Y", replace every literal mention of "Y" with "X" in the text — nothing more.
3. Do NOT rename related tools, libraries, or dependencies unless the user specifically mentioned them.
4. Keep all other text, section names, structure, and formatting exactly as-is.
5. If a page mentions Y in a person's expertise or a project's tech stack, update that mention too.
6. If a page does NOT actually contain text that needs changing, SKIP it entirely.

Return ONLY a JSON object (no markdown fences):
{
  "drafts": [
    {
      "id": "draft-N",
      "title": "Page title",
      "target_type": "entity_page" or "ticket",
      "target_id": "page_id or ticket_id",
      "before_text": "full current content",
      "after_text": "full content with ONLY the requested change"
    }
  ],
  "questions": []
}`,
        prompt: `User's Change Request: "${modificationText}"
${answers ? `\nUser's Answers: ${answers}` : ""}

Pages to process:
${batchContext}

Apply the change. Skip pages that don't need changes.`,
        maxOutputTokens: config?.pipeline_settings?.verify_check?.max_tokens ?? 16384,
      });

      let parsed: { drafts: any[]; questions: string[] };
      try {
        const jsonStr = result.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        logger.log(`Failed to parse batch ${Math.floor(i / BATCH_SIZE) + 1} response`);
        continue;
      }

      for (const d of parsed.drafts ?? []) {
        allDrafts.push({
          id: d.id ?? `draft-${allDrafts.length}`,
          title: d.title ?? `Change ${allDrafts.length + 1}`,
          targetType: d.target_type ?? "entity_page",
          targetId: d.target_id ?? "",
          beforeText: d.before_text ?? "",
          afterText: d.after_text ?? "",
          accepted: null,
        });
      }
      allQuestions.push(...(parsed.questions ?? []));
    } catch (err: any) {
      logger.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
    }
  }

  logger.log(`Done: ${allDrafts.length} drafts generated from ${items.length} items`);

  return Response.json({
    drafts: allDrafts,
    questions: allQuestions,
    debug: {
      reasoning: identifyReasoning,
      affectedNames: [...affectedNames],
      nodesTotal: allNodes.length,
      pagesScanned: allPages.length,
      pagesMatched: affectedPages.length,
      ticketsMatched: affectedTickets.length,
    },
  });
}
