import { randomUUID } from "crypto";
import { z } from "zod";
import {
  kb2ClaimsCollection,
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
  kb2EntityPagesCollection,
  kb2VerificationCardsCollection,
} from "@/lib/mongodb";
import { getFastModel, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type {
  KB2ClaimType,
  KB2GraphNodeType,
  KB2GraphEdgeType,
  KB2EntityPageType,
  KB2VerificationCardType,
  KB2VerifyCardType,
  KB2Severity,
  KB2EvidenceRefType,
} from "@/src/entities/models/kb2-types";
import { ENTITY_PAGE_TEMPLATES } from "@/src/entities/models/kb2-templates";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

interface RawCandidate {
  type: KB2VerifyCardType;
  raw_text: string;
  entity_name?: string;
  page_id?: string;
  page_type?: "entity" | "human";
  page_title?: string;
  claim_ids: string[];
  source_refs: KB2EvidenceRefType[];
}

const LLMVerifyCardSchema = z.object({
  cards: z.array(z.object({
    index: z.number(),
    keep: z.boolean(),
    title: z.string(),
    description: z.string(),
    severity: z.enum(["S1", "S2", "S3", "S4"]),
    recommended_action: z.string(),
  })),
});

export const createVerifyCardsStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-verify-cards");
  const stepId = "pass1-step-14";

  const claims = (await kb2ClaimsCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2ClaimType[];
  const nodes = (await kb2GraphNodesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  const edges = (await kb2GraphEdgesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphEdgeType[];
  const entityPages = (await kb2EntityPagesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2EntityPageType[];

  const nodeById = new Map<string, KB2GraphNodeType>();
  for (const n of nodes) nodeById.set(n.node_id, n);
  const pageById = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) pageById.set(ep.page_id, ep);

  // ------ Phase 1: Gather all candidates ------
  ctx.onProgress("Phase 1: Gathering verification candidates...", 5);

  const candidates: RawCandidate[] = [];

  for (const claim of claims) {
    if (claim.truth_status === "inferred") {
      const page = claim.source_page_id ? pageById.get(claim.source_page_id) : undefined;
      candidates.push({
        type: "inferred_claim",
        raw_text: claim.text,
        entity_name: page?.title,
        page_id: claim.source_page_id,
        page_type: claim.source_page_type,
        page_title: page?.title,
        claim_ids: [claim.claim_id],
        source_refs: claim.source_refs ?? [],
      });
    }
    if (claim.confidence === "low" && claim.truth_status !== "inferred") {
      const page = claim.source_page_id ? pageById.get(claim.source_page_id) : undefined;
      candidates.push({
        type: "low_confidence",
        raw_text: claim.text,
        entity_name: page?.title,
        page_id: claim.source_page_id,
        page_type: claim.source_page_type,
        page_title: page?.title,
        claim_ids: [claim.claim_id],
        source_refs: claim.source_refs ?? [],
      });
    }
  }

  for (const page of entityPages) {
    const template = ENTITY_PAGE_TEMPLATES[page.node_type];
    if (!template) continue;
    for (const spec of template.sections) {
      if (spec.requirement !== "MUST") continue;
      const section = page.sections.find((s) => s.section_name === spec.name);
      if (!section || section.items.length === 0) {
        candidates.push({
          type: "missing_must",
          raw_text: `Missing "${spec.name}" on ${page.title} (${page.node_type}). Intent: ${spec.intent}`,
          entity_name: page.title,
          page_id: page.page_id,
          page_type: "entity",
          page_title: page.title,
          claim_ids: [],
          source_refs: [],
        });
      }
    }
  }

  const ownerableTypes = new Set(["repository", "infrastructure", "database", "project"]);
  const nodesWithOwner = new Set<string>();
  for (const page of entityPages) {
    for (const section of page.sections) {
      if (section.section_name.toLowerCase().includes("identity") || section.section_name.toLowerCase().includes("ownership")) {
        for (const item of section.items) {
          if (item.text.toLowerCase().includes("owner") || item.text.toLowerCase().includes("lead")) {
            nodesWithOwner.add(page.node_id);
          }
        }
      }
    }
  }
  for (const edge of edges) {
    if (edge.type === "OWNED_BY" || edge.type === "LEADS") {
      nodesWithOwner.add(edge.source_node_id);
    }
  }
  for (const node of nodes) {
    if (!ownerableTypes.has(node.type)) continue;
    if (nodesWithOwner.has(node.node_id)) continue;
    candidates.push({
      type: "unknown_owner",
      raw_text: `No owner for ${node.type} "${node.display_name}"`,
      entity_name: node.display_name,
      claim_ids: [],
      source_refs: node.source_refs ?? [],
    });
  }

  ctx.onProgress(`Phase 1 complete: ${candidates.length} raw candidates`, 20);

  if (candidates.length === 0) {
    ctx.onProgress("No verification candidates found", 100);
    return { total_cards: 0, by_type: {}, by_severity: {}, llm_calls: 0 };
  }

  // ------ Phase 2: LLM pass for filtering and rewriting ------
  ctx.onProgress("Phase 2: LLM filtering and rewriting...", 25);

  const model = getFastModel();
  let totalLLMCalls = 0;
  const BATCH_SIZE = 25;
  const survivingCards: z.infer<typeof LLMVerifyCardSchema>["cards"][number][] = [];
  const survivingCandidates: RawCandidate[] = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchText = batch.map((c, idx) =>
      `${i + idx}. [${c.type}] Entity: ${c.entity_name ?? "unknown"}\n   "${c.raw_text}"`,
    ).join("\n\n");

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: `You review verification card candidates for a company knowledge base.
For each candidate, decide whether to keep it and rewrite it for a human reviewer.

SEVERITY RUBRIC:
- S1 (Critical): Affects production systems, could cause wrong AI chat answers, factual contradiction about infrastructure/payments/auth
- S2 (High): Important factual claim about system behavior needing verification, integration details, data flow
- S3 (Medium): Organizational/process claims, team membership, project status
- S4 (Low): Nice-to-know, cosmetic, low-impact gaps like missing optional info

RULES:
- Filter out noise: if a candidate is trivially true, obvious, or would waste a reviewer's time, set keep: false
- Write a specific, human-friendly title (not generic like "Inferred claim needs verification")
- Write a description that explains what's at stake if this is wrong
- Missing section cards for sections unlikely to have data should be S4 or filtered
- Unknown owner cards for minor libraries or tools should be S4 or filtered
- Inferred claims about critical systems (payments, auth, databases) should be S1 or S2`,
      prompt: `Review these ${batch.length} verification candidates:\n\n${batchText}`,
      schema: LLMVerifyCardSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
    });
    totalLLMCalls++;

    if (usageData) {
      const cost = calculateCostUsd("claude-sonnet-4-6", usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, "claude-sonnet-4-6", batchText.slice(0, 3000), JSON.stringify(result, null, 2).slice(0, 3000), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    for (const card of result.cards ?? []) {
      if (!card.keep) continue;
      if (card.index >= 0 && card.index < candidates.length) {
        survivingCards.push(card);
        survivingCandidates.push(candidates[card.index]);
      }
    }

    const pct = Math.round(25 + ((i + batch.length) / candidates.length) * 40);
    ctx.onProgress(`Phase 2: processed ${Math.min(i + BATCH_SIZE, candidates.length)}/${candidates.length} candidates`, pct);
  }

  ctx.onProgress(`Phase 2 complete: ${survivingCards.length}/${candidates.length} cards kept`, 65);

  // ------ Phase 3: Attach source refs mechanically ------
  ctx.onProgress("Phase 3: Attaching source references...", 70);

  // ------ Phase 4: Auto-assign from graph ownership ------
  ctx.onProgress("Phase 4: Auto-assigning...", 80);

  const ownershipMap = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type === "OWNED_BY" || edge.type === "LEADS") {
      const target = nodeById.get(edge.target_node_id);
      if (target && target.type === "person") {
        const existing = ownershipMap.get(edge.source_node_id) ?? [];
        existing.push(target.display_name);
        ownershipMap.set(edge.source_node_id, existing);
      }
    }
  }

  const finalCards: KB2VerificationCardType[] = [];

  for (let i = 0; i < survivingCards.length; i++) {
    const llmCard = survivingCards[i];
    const candidate = survivingCandidates[i];

    let assignedTo: string[] = [];
    if (candidate.page_id) {
      const page = pageById.get(candidate.page_id);
      if (page) {
        assignedTo = ownershipMap.get(page.node_id) ?? [];
      }
    }

    finalCards.push({
      card_id: randomUUID(),
      run_id: ctx.runId,
      card_type: candidate.type,
      severity: llmCard.severity as KB2Severity,
      title: llmCard.title,
      explanation: llmCard.description,
      recommended_action: llmCard.recommended_action,
      page_occurrences: candidate.page_id
        ? [{ page_id: candidate.page_id, page_type: candidate.page_type ?? "entity", page_title: candidate.page_title }]
        : [],
      source_refs: candidate.source_refs,
      assigned_to: assignedTo,
      claim_ids: candidate.claim_ids,
      status: "open",
      discussion: [],
    });
  }

  const existingDupCards = await kb2VerificationCardsCollection
    .find({ run_id: ctx.runId, card_type: "duplicate_cluster" })
    .toArray();

  await kb2VerificationCardsCollection.deleteMany({ run_id: ctx.runId, card_type: { $ne: "duplicate_cluster" } });
  if (finalCards.length > 0) {
    await kb2VerificationCardsCollection.insertMany(finalCards);
  }

  const totalCards = finalCards.length + existingDupCards.length;
  const byType = finalCards.reduce((acc, c) => {
    acc[c.card_type] = (acc[c.card_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  if (existingDupCards.length > 0) {
    byType["duplicate_cluster"] = existingDupCards.length;
  }

  ctx.onProgress(`Created ${totalCards} verification cards (${candidates.length - survivingCards.length} filtered as noise)`, 100);
  return {
    total_cards: totalCards,
    candidates_gathered: candidates.length,
    filtered_out: candidates.length - survivingCards.length,
    by_type: byType,
    by_severity: finalCards.reduce((acc, c) => {
      acc[c.severity] = (acc[c.severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    llm_calls: totalLLMCalls,
  };
};
