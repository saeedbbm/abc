import { randomUUID } from "crypto"; 
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, calculateCostUsd } from "@/lib/ai-model";
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
    problem_explanation: z.string().describe("Clear explanation of the problem: what is wrong/uncertain and what's at stake if it's incorrect"),
    supporting_evidence: z.array(z.object({
      text: z.string().describe("Factual statement from the source that supports the claim"),
      source_title: z.string().optional().describe("Document title where this evidence was found"),
      confidence: z.enum(["high", "medium", "low"]).optional(),
    })).describe("Evidence found in source documents that relates to this issue"),
    missing_evidence: z.array(z.string()).describe("Specific information that is missing and would be needed to resolve this"),
    affected_entity_names: z.array(z.string()).describe("Display names of other entities that would be impacted if this issue is confirmed"),
    required_data: z.array(z.string()).describe("Specific data points the reviewer needs to provide (e.g., 'correct database URL', 'actual owner name')"),
    verification_question: z.string().describe("A single clear yes/no or specific-answer question the reviewer should answer"),
    severity: z.enum(["S1", "S2", "S3", "S4"]),
    recommended_action: z.string(),
  })),
});

export const createVerifyCardsStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-verify-cards");
  const stepId = "pass1-step-18";
  const BATCH_SIZE = ctx.config?.pipeline_settings?.verification?.batch_size ?? 25;
  const createVerifyCardsSystemPrompt = ctx.config?.prompts?.create_verify_cards?.system ?? `You review verification card candidates for a company knowledge base.
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
- Inferred claims about critical systems (payments, auth, databases) should be S1 or S2
- Discovery items (truth_status=inferred, from conversation analysis) should only get S1/S2 cards if they represent critical factual claims. Most discovery items are S3 or should be filtered.
- Convention/pattern entities are inherently inferred — do NOT create cards questioning their existence. Only create cards if a specific factual claim within them is questionable.`;

  const claimsExecId = await ctx.getStepExecutionId("pass1", 17);
  const claimsFilter = claimsExecId ? { execution_id: claimsExecId } : { run_id: ctx.runId };
  const claims = (await tc.claims.find(claimsFilter).toArray()) as unknown as KB2ClaimType[];
  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  const nodeExecIds = [step9ExecId, step10ExecId].filter(Boolean);
  const nodesFilter = nodeExecIds.length > 0
    ? { execution_id: { $in: nodeExecIds } }
    : { run_id: ctx.runId };
  const nodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  const step6ExecId = await ctx.getStepExecutionId("pass1", 6);
  const step7ExecId = await ctx.getStepExecutionId("pass1", 7);
  const step11ExecId = await ctx.getStepExecutionId("pass1", 11);
  const edgeExecIds = [step6ExecId, step7ExecId, step11ExecId].filter(Boolean);
  const edgesFilter = edgeExecIds.length > 0
    ? { execution_id: { $in: edgeExecIds } }
    : { run_id: ctx.runId };
  const edges = (await tc.graph_edges.find(edgesFilter).toArray()) as unknown as KB2GraphEdgeType[];
  const epExecId = await ctx.getStepExecutionId("pass1", 14);
  const epFilter = epExecId ? { execution_id: epExecId } : { run_id: ctx.runId };
  const entityPages = (await tc.entity_pages.find(epFilter).toArray()) as unknown as KB2EntityPageType[];

  const nodeById = new Map<string, KB2GraphNodeType>();
  for (const n of nodes) nodeById.set(n.node_id, n);
  const pageById = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) pageById.set(ep.page_id, ep);

  // ------ Phase 1: Gather all candidates ------
  await ctx.onProgress("Phase 1: Gathering verification candidates...", 5);

  const candidates: RawCandidate[] = [];

  for (const claim of claims) {
    if (claim.truth_status === "inferred") {
      const sourcePage = claim.source_page_id ? pageById.get(claim.source_page_id) : undefined;
      if (sourcePage) {
        const sourceNode = nodeById.get(sourcePage.node_id);
        if (sourceNode?.attributes?.is_convention) continue;
      }
      candidates.push({
        type: "inferred_claim",
        raw_text: claim.text,
        entity_name: sourcePage?.title,
        page_id: claim.source_page_id,
        page_type: claim.source_page_type,
        page_title: sourcePage?.title,
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

  await ctx.onProgress(`Phase 1 complete: ${candidates.length} raw candidates`, 20);

  if (candidates.length === 0) {
    await ctx.onProgress("No verification candidates found", 100);
    return { total_cards: 0, by_type: {}, by_severity: {}, llm_calls: 0 };
  }

  // ------ Phase 2: LLM pass for filtering and rewriting ------
  await ctx.onProgress("Phase 2: LLM filtering and rewriting...", 25);

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  let totalLLMCalls = 0;
  const survivingCards: z.infer<typeof LLMVerifyCardSchema>["cards"][number][] = [];
  const survivingCandidates: RawCandidate[] = [];

  const edgesByNode = new Map<string, { edge: KB2GraphEdgeType; other: KB2GraphNodeType | undefined }[]>();
  for (const edge of edges) {
    const srcEntry = edgesByNode.get(edge.source_node_id) ?? [];
    srcEntry.push({ edge, other: nodeById.get(edge.target_node_id) });
    edgesByNode.set(edge.source_node_id, srcEntry);
    const tgtEntry = edgesByNode.get(edge.target_node_id) ?? [];
    tgtEntry.push({ edge, other: nodeById.get(edge.source_node_id) });
    edgesByNode.set(edge.target_node_id, tgtEntry);
  }

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchText = batch.map((c, idx) => {
      const parts = [`${i + idx}. [${c.type}] Entity: ${c.entity_name ?? "unknown"}\n   Claim: "${c.raw_text}"`];
      if (c.source_refs.length > 0) {
        parts.push(`   Sources: ${c.source_refs.map((r) => `${r.title} (${r.source_type})${r.excerpt ? ` — "${r.excerpt.slice(0, 150)}"` : ""}`).join("; ")}`);
      }
      if (c.page_id) {
        const page = pageById.get(c.page_id);
        if (page) {
          const relSection = page.sections.find((s) => s.items.some((it) => it.text.toLowerCase().includes(c.raw_text.toLowerCase().slice(0, 40))));
          if (relSection) parts.push(`   Page section [${relSection.section_name}]: ${relSection.items.map((it) => it.text).join(" | ").slice(0, 300)}`);
        }
      }
      const node = nodes.find((n) => n.display_name.toLowerCase() === (c.entity_name ?? "").toLowerCase());
      if (node) {
        const nodeEdges = edgesByNode.get(node.node_id) ?? [];
        if (nodeEdges.length > 0) {
          parts.push(`   Graph connections: ${nodeEdges.slice(0, 8).map((e) => `${e.edge.type} → ${e.other?.display_name ?? "?"}`).join(", ")}`);
        }
      }
      return parts.join("\n");
    }).join("\n\n");

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: createVerifyCardsSystemPrompt,
      prompt: `Review these ${batch.length} verification candidates. For each one, provide a structured analysis with problem explanation, evidence, affected entities, and a clear verification question.\n\n${batchText}`,
      schema: LLMVerifyCardSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;

    if (usageData) {
      const cost = calculateCostUsd(getFastModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getFastModelName(ctx.config?.pipeline_settings?.models), batchText.slice(0, 3000), JSON.stringify(result, null, 2).slice(0, 3000), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    for (const card of result.cards ?? []) {
      if (!card.keep) continue;
      if (card.index >= 0 && card.index < candidates.length) {
        survivingCards.push(card);
        survivingCandidates.push(candidates[card.index]);
      }
    }

    const pct = Math.round(25 + ((i + batch.length) / candidates.length) * 40);
    await ctx.onProgress(`Phase 2: processed ${Math.min(i + BATCH_SIZE, candidates.length)}/${candidates.length} candidates`, pct);
  }

  const MAX_CARDS = 30;
  if (survivingCards.length > MAX_CARDS) {
    const severityOrder: Record<string, number> = { S1: 0, S2: 1, S3: 2, S4: 3 };
    const indices = survivingCards.map((_, i) => i);
    indices.sort((a, b) => (severityOrder[survivingCards[a].severity] ?? 4) - (severityOrder[survivingCards[b].severity] ?? 4));
    const kept = indices.slice(0, MAX_CARDS);
    const keptSet = new Set(kept);
    const trimmedCards = survivingCards.filter((_, i) => keptSet.has(i));
    const trimmedCandidates = survivingCandidates.filter((_, i) => keptSet.has(i));
    survivingCards.length = 0;
    survivingCards.push(...trimmedCards);
    survivingCandidates.length = 0;
    survivingCandidates.push(...trimmedCandidates);
  }

  await ctx.onProgress(`Phase 2 complete: ${survivingCards.length}/${candidates.length} cards kept`, 65);

  // ------ Phase 3: Attach source refs mechanically ------
  await ctx.onProgress("Phase 3: Attaching source references...", 70);

  // ------ Phase 4: Auto-assign from graph ownership ------
  await ctx.onProgress("Phase 4: Auto-assigning...", 80);

  const ownershipMap = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type === "OWNED_BY" || edge.type === "LEADS") {
      const target = nodeById.get(edge.target_node_id);
      if (target && target.type === "team_member") {
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

    const affectedEntities: { entity_name: string; entity_type?: string; relationship?: string }[] = [];
    for (const name of llmCard.affected_entity_names ?? []) {
      const found = nodes.find((n) => n.display_name.toLowerCase() === name.toLowerCase());
      affectedEntities.push({ entity_name: name, entity_type: found?.type, relationship: "potentially affected" });
    }

    finalCards.push({
      card_id: randomUUID(),
      run_id: ctx.runId,
      card_type: candidate.type,
      severity: llmCard.severity as KB2Severity,
      title: llmCard.title,
      explanation: llmCard.problem_explanation ?? llmCard.title,
      problem_explanation: llmCard.problem_explanation,
      supporting_evidence: llmCard.supporting_evidence ?? [],
      missing_evidence: llmCard.missing_evidence ?? [],
      affected_entities: affectedEntities,
      required_data: llmCard.required_data ?? [],
      verification_question: llmCard.verification_question,
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

  const dupExecId = await ctx.getStepExecutionId("pass1", 5);
  const dupCardFilter = dupExecId
    ? { execution_id: dupExecId, card_type: "duplicate_cluster" }
    : { run_id: ctx.runId, card_type: "duplicate_cluster" };
  const existingDupCards = await tc.verification_cards
    .find(dupCardFilter)
    .toArray();

  if (finalCards.length > 0) {
    await tc.verification_cards.insertMany(finalCards);
  }

  const totalCards = finalCards.length + existingDupCards.length;
  const byType = finalCards.reduce((acc, c) => {
    acc[c.card_type] = (acc[c.card_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  if (existingDupCards.length > 0) {
    byType["duplicate_cluster"] = existingDupCards.length;
  }

  await ctx.onProgress(`Created ${totalCards} verification cards (${candidates.length - survivingCards.length} filtered as noise)`, 100);
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
