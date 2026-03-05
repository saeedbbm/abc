import { randomUUID } from "crypto";
import { z } from "zod";
import { kb2GraphNodesCollection, kb2VerificationCardsCollection } from "@/lib/mongodb";
import { getFastModel, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType, KB2VerificationCardType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const SIMILARITY_THRESHOLD = 0.4;
const LLM_BATCH_SIZE = 15;

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[._@]/g, " ")
      .replace(/[^a-z0-9\s\-]/g, "")
      .split(/[\s\-]+/)
      .filter((t) => t.length > 1),
  );
}

function tokenSimilarity(a: string, b: string): number {
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) {
    if (tokB.has(t)) overlap++;
  }
  return overlap / Math.max(tokA.size, tokB.size);
}

function aliasOverlap(a: KB2GraphNodeType, b: KB2GraphNodeType): boolean {
  const allA = new Set([a.display_name.toLowerCase(), ...a.aliases.map((s) => s.toLowerCase())]);
  const allB = new Set([b.display_name.toLowerCase(), ...b.aliases.map((s) => s.toLowerCase())]);
  for (const name of allA) {
    if (allB.has(name)) return true;
  }
  return false;
}

function substringMatch(a: string, b: string): boolean {
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();
  if (la === lb) return false;
  return (la.length >= 3 && lb.includes(la)) || (lb.length >= 3 && la.includes(lb));
}

interface CandidatePair {
  nodeA: KB2GraphNodeType;
  nodeB: KB2GraphNodeType;
  reason: string;
  score: number;
  ambiguous?: boolean;
}

const MergeDecisionSchema = z.object({
  decisions: z.array(z.object({
    entity_a: z.string(),
    entity_b: z.string(),
    should_merge: z.boolean(),
    unsure: z.boolean().optional().describe("Set true if you cannot confidently decide"),
    canonical_name: z.string().optional(),
    reason: z.string(),
  })),
});

export const entityResolutionStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-entity-resolution");
  const nodes = (await kb2GraphNodesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];

  if (nodes.length === 0) throw new Error("No entities found — run entity extraction first");

  const model = getFastModel();
  const stepId = "pass1-step-5";

  ctx.onProgress(`Finding merge candidates among ${nodes.length} entities...`, 5);

  const byType = new Map<string, KB2GraphNodeType[]>();
  for (const node of nodes) {
    const list = byType.get(node.type) ?? [];
    list.push(node);
    byType.set(node.type, list);
  }

  const candidates: CandidatePair[] = [];

  for (const [type, typeNodes] of byType) {
    for (let i = 0; i < typeNodes.length; i++) {
      for (let j = i + 1; j < typeNodes.length; j++) {
        const a = typeNodes[i];
        const b = typeNodes[j];

        if (aliasOverlap(a, b)) {
          candidates.push({ nodeA: a, nodeB: b, reason: "alias overlap", score: 1.0 });
          continue;
        }

        if (substringMatch(a.display_name, b.display_name)) {
          candidates.push({ nodeA: a, nodeB: b, reason: `substring match: "${a.display_name}" / "${b.display_name}"`, score: 0.8, ambiguous: true });
          continue;
        }

        const nameSim = tokenSimilarity(a.display_name, b.display_name);
        if (nameSim >= SIMILARITY_THRESHOLD) {
          candidates.push({ nodeA: a, nodeB: b, reason: `name similarity ${nameSim.toFixed(2)}`, score: nameSim });
          continue;
        }

        for (const aliasA of a.aliases) {
          for (const aliasB of [...b.aliases, b.display_name]) {
            const aliasSim = tokenSimilarity(aliasA, aliasB);
            if (aliasSim >= SIMILARITY_THRESHOLD) {
              candidates.push({ nodeA: a, nodeB: b, reason: `alias similarity: "${aliasA}" ~ "${aliasB}" (${aliasSim.toFixed(2)})`, score: aliasSim });
              break;
            }
          }
          if (candidates.length > 0 && candidates[candidates.length - 1].nodeA === a && candidates[candidates.length - 1].nodeB === b) break;
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  ctx.onProgress(`Found ${candidates.length} candidate pairs for LLM review`, 15);

  if (candidates.length === 0) {
    ctx.onProgress("No merge candidates found — entities are distinct", 100);
    return {
      total_entities_before: nodes.length,
      total_entities_after: nodes.length,
      candidates_found: 0,
      merges_performed: 0,
      llm_calls: 0,
    };
  }

  let totalLLMCalls = 0;
  const merges: { from: string; into: string; canonicalName: string; reason: string }[] = [];
  const mergedNodeIds = new Set<string>();

  const totalBatches = Math.ceil(candidates.length / LLM_BATCH_SIZE);
  for (let i = 0; i < candidates.length; i += LLM_BATCH_SIZE) {
    const batch = candidates.slice(i, i + LLM_BATCH_SIZE);
    const batchNum = Math.floor(i / LLM_BATCH_SIZE) + 1;

    const pairsText = batch.map((pair, idx) => {
      const aAliases = pair.nodeA.aliases.length > 0 ? ` (aliases: ${pair.nodeA.aliases.join(", ")})` : "";
      const bAliases = pair.nodeB.aliases.length > 0 ? ` (aliases: ${pair.nodeB.aliases.join(", ")})` : "";
      return `${idx + 1}. Entity A: "${pair.nodeA.display_name}" [${pair.nodeA.type}]${aAliases} (${pair.nodeA.source_refs.length} sources, confidence: ${pair.nodeA.confidence})
   Entity B: "${pair.nodeB.display_name}" [${pair.nodeB.type}]${bAliases} (${pair.nodeB.source_refs.length} sources, confidence: ${pair.nodeB.confidence})
   Candidate reason: ${pair.reason}`;
    }).join("\n\n");

    ctx.onProgress(`LLM call ${batchNum}/${totalBatches}: reviewing ${batch.length} candidate pairs`, Math.round(15 + (i / candidates.length) * 70));

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;

    const result = await structuredGenerate({
      model,
      system: `You are an entity resolution engine. Given pairs of entities that might be duplicates, decide whether they should be merged.

RULES:
- Merge if they clearly refer to the same real-world thing (e.g. "brewgo-app" and "BrewGo App" are the same mobile app repo)
- Do NOT merge if they are genuinely different things (e.g. "brewgo-api" and "brewgo-app" are different repos)
- Do NOT merge if one is a component/part of the other (e.g. "Redis" the database vs "ElastiCache Redis" the cloud resource)
- When merging, pick the most precise/canonical name as the canonical_name
- Be conservative — only merge when confident they are the same entity
- If you are unsure (e.g. "Priya" might or might not be "Priya Nair"), set unsure: true and should_merge: false. A human will review.`,
      prompt: pairsText,
      schema: MergeDecisionSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
    });
    totalLLMCalls++;

    if (usageData) {
      const durationMs = Date.now() - startMs;
      const cost = calculateCostUsd("claude-sonnet-4-6", usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, "claude-sonnet-4-6", pairsText, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, durationMs);
    }

    const ambiguousCards: KB2VerificationCardType[] = [];
    for (const decision of result.decisions ?? []) {
      if (!decision.should_merge && decision.unsure) {
        const pair = batch.find((p) =>
          (p.nodeA.display_name === decision.entity_a && p.nodeB.display_name === decision.entity_b) ||
          (p.nodeA.display_name === decision.entity_b && p.nodeB.display_name === decision.entity_a),
        );
        if (pair && !mergedNodeIds.has(pair.nodeA.node_id) && !mergedNodeIds.has(pair.nodeB.node_id)) {
          ambiguousCards.push({
            card_id: randomUUID(),
            run_id: ctx.runId,
            card_type: "duplicate_cluster",
            severity: "S3",
            title: `Possible duplicate: "${pair.nodeA.display_name}" and "${pair.nodeB.display_name}"`,
            explanation: `These two ${pair.nodeA.type} entities might be the same. ${decision.reason}`,
            canonical_text: JSON.stringify({
              entity_a: { node_id: pair.nodeA.node_id, display_name: pair.nodeA.display_name, aliases: pair.nodeA.aliases },
              entity_b: { node_id: pair.nodeB.node_id, display_name: pair.nodeB.display_name, aliases: pair.nodeB.aliases },
            }),
            page_occurrences: [],
            source_refs: [...pair.nodeA.source_refs.slice(0, 3), ...pair.nodeB.source_refs.slice(0, 3)],
            assigned_to: [],
            claim_ids: [],
            status: "open",
            discussion: [],
          });
        }
        continue;
      }
      if (!decision.should_merge) continue;

      const pair = batch.find((p) =>
        (p.nodeA.display_name === decision.entity_a && p.nodeB.display_name === decision.entity_b) ||
        (p.nodeA.display_name === decision.entity_b && p.nodeB.display_name === decision.entity_a),
      );
      if (!pair) continue;
      if (mergedNodeIds.has(pair.nodeA.node_id) || mergedNodeIds.has(pair.nodeB.node_id)) continue;

      const keepNode = pair.nodeA.source_refs.length >= pair.nodeB.source_refs.length ? pair.nodeA : pair.nodeB;
      const removeNode = keepNode === pair.nodeA ? pair.nodeB : pair.nodeA;

      const canonicalName = decision.canonical_name || keepNode.display_name;
      const mergedAliases = [...new Set([
        keepNode.display_name,
        removeNode.display_name,
        ...keepNode.aliases,
        ...removeNode.aliases,
      ])].filter((a) => a.toLowerCase() !== canonicalName.toLowerCase());

      await kb2GraphNodesCollection.updateOne(
        { node_id: keepNode.node_id, run_id: ctx.runId },
        {
          $set: {
            display_name: canonicalName,
            aliases: mergedAliases,
            attributes: { ...removeNode.attributes, ...keepNode.attributes },
            confidence: keepNode.confidence === "high" || removeNode.confidence === "high" ? "high" : keepNode.confidence,
          },
          $push: {
            source_refs: { $each: removeNode.source_refs },
          } as any,
        },
      );

      await kb2GraphNodesCollection.deleteOne({ node_id: removeNode.node_id, run_id: ctx.runId });
      mergedNodeIds.add(removeNode.node_id);

      merges.push({
        from: removeNode.display_name,
        into: canonicalName,
        canonicalName,
        reason: decision.reason,
      });
    }

    if (ambiguousCards.length > 0) {
      await kb2VerificationCardsCollection.insertMany(ambiguousCards);
    }
  }

  const finalCount = nodes.length - merges.length;
  ctx.onProgress(`Entity resolution complete: ${nodes.length} → ${finalCount} entities (${merges.length} merges)`, 100);

  return {
    total_entities_before: nodes.length,
    total_entities_after: finalCount,
    candidates_found: candidates.length,
    merges_performed: merges.length,
    llm_calls: totalLLMCalls,
    merges,
  };
};
