import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, getCrossCheckModel, getCrossCheckModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { buildDeterministicJudge, mergeJudgeResults, runLLMJudge } from "@/src/application/lib/kb2/step-judge";
import { PrefixLogger } from "@/lib/utils";
import { KB2EdgeTypeEnum } from "@/src/entities/models/kb2-types";
import type { KB2GraphNodeType, KB2GraphEdgeType, KB2EdgeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const STEP_ID = "pass1-step-6";
const CO_OCCUR_BATCH_SIZE = 20;

const LLM_EDGE_TYPES = [
  "WORKS_ON", "REVIEWS", "DEPENDS_ON", "USES", "CONTAINS",
  "PART_OF", "APPLIES_TO", "PROPOSED_BY", "RESOLVES", "FEEDBACK_FROM",
  "MEMBER_OF", "BUILT_BY", "OWNED_BY", "DEPLOYED_TO", "RUNS_ON",
  "RELATED_TO", "NONE",
] as const;

const InferredEdgeSchema = z.object({
  edges: z.array(z.object({
    source: z.string(),
    target: z.string(),
    type: z.enum(LLM_EDGE_TYPES),
    evidence: z.string(),
  })),
});

interface EmbeddedRelationship {
  target: string;
  type: string;
  evidence?: string;
}

// ---------------------------------------------------------------------------
// Edge type/direction constraint rules
// ---------------------------------------------------------------------------

type NodeType = string;
interface EdgeRule { validSources: Set<NodeType>; validTargets: Set<NodeType>; reversible: boolean }

const PERSON_TYPES = new Set(["team_member", "client_person"]);
const WORK_ITEMS = new Set(["project", "ticket", "pull_request", "pipeline"]);
const TECH_ITEMS = new Set(["library", "infrastructure", "database", "environment", "repository"]);
const ORGS = new Set(["team", "client_company"]);
const CONTAINER_TYPES = new Set(["project", "team", "repository"]);
const CHILD_TYPES = new Set(["project", "ticket", "pull_request", "pipeline", "decision", "process", "library"]);
const ALL_TYPES = new Set([
  "project", "ticket", "pull_request", "pipeline", "decision", "process",
  "library", "infrastructure", "database", "environment", "repository",
  "team_member", "client_person", "team", "client_company",
  "integration", "customer_feedback",
]);

const EDGE_RULES: Record<string, EdgeRule> = {
  WORKS_ON:    { validSources: PERSON_TYPES, validTargets: new Set([...WORK_ITEMS, ...TECH_ITEMS, "process"]), reversible: true },
  REVIEWS:     { validSources: PERSON_TYPES, validTargets: new Set(["pull_request"]), reversible: true },
  USES:        { validSources: new Set([...PERSON_TYPES, ...WORK_ITEMS, "process"]), validTargets: new Set([...TECH_ITEMS, "integration"]), reversible: true },
  CONTAINS:    { validSources: CONTAINER_TYPES, validTargets: CHILD_TYPES, reversible: false },
  PART_OF:     { validSources: CHILD_TYPES, validTargets: CONTAINER_TYPES, reversible: false },
  APPLIES_TO:  { validSources: new Set(["decision", "process", "integration"]), validTargets: new Set([...WORK_ITEMS, "integration", "repository"]), reversible: true },
  PROPOSED_BY: { validSources: new Set(["decision"]), validTargets: PERSON_TYPES, reversible: true },
  BUILT_BY:    { validSources: WORK_ITEMS, validTargets: PERSON_TYPES, reversible: true },
  OWNED_BY:    { validSources: new Set([...WORK_ITEMS, "process", "repository"]), validTargets: new Set([...PERSON_TYPES, ...ORGS]), reversible: true },
  MEMBER_OF:   { validSources: PERSON_TYPES, validTargets: ORGS, reversible: true },
  DEPENDS_ON:  { validSources: ALL_TYPES, validTargets: ALL_TYPES, reversible: false },
  RESOLVES:    { validSources: new Set(["pull_request"]), validTargets: new Set(["ticket"]), reversible: true },
  FEEDBACK_FROM: { validSources: new Set(["customer_feedback"]), validTargets: new Set([...PERSON_TYPES, "client_company"]), reversible: true },
  DEPLOYED_TO: { validSources: new Set([...WORK_ITEMS, "repository"]), validTargets: new Set(["environment", "infrastructure"]), reversible: true },
  RUNS_ON:     { validSources: new Set(["pipeline", "process"]), validTargets: new Set(["infrastructure", "environment"]), reversible: true },
  RELATED_TO:  { validSources: ALL_TYPES, validTargets: ALL_TYPES, reversible: false },
};

function validateEdge(
  srcType: string, tgtType: string, edgeType: string,
): "valid" | "flip" | "drop" {
  const rule = EDGE_RULES[edgeType];
  if (!rule) return "drop";

  if (srcType === tgtType && srcType === "team_member" && edgeType === "WORKS_ON") return "drop";

  if (rule.validSources.has(srcType) && rule.validTargets.has(tgtType)) return "valid";
  if (rule.reversible && rule.validSources.has(tgtType) && rule.validTargets.has(srcType)) return "flip";
  return "drop";
}

// ---------------------------------------------------------------------------
// Name-resolution helpers
// ---------------------------------------------------------------------------

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function resolveTarget(
  name: string,
  nodeByDisplayName: Map<string, KB2GraphNodeType>,
  nodeByAlias: Map<string, KB2GraphNodeType>,
  allNodes: KB2GraphNodeType[],
): KB2GraphNodeType | null {
  const lower = name.toLowerCase();

  const exact = nodeByDisplayName.get(lower);
  if (exact) return exact;

  const alias = nodeByAlias.get(lower);
  if (alias) return alias;

  const queryTokens = tokenize(name);
  let bestJaccard = 0;
  let bestJaccardNode: KB2GraphNodeType | null = null;
  for (const node of allNodes) {
    const nodeTokens = tokenize(node.display_name);
    const score = jaccard(queryTokens, nodeTokens);
    if (score > 0.5 && score > bestJaccard) {
      bestJaccard = score;
      bestJaccardNode = node;
    }
  }
  if (bestJaccardNode) return bestJaccardNode;

  for (const node of allNodes) {
    const nodeLower = node.display_name.toLowerCase();
    if (nodeLower.includes(lower) || lower.includes(nodeLower)) return node;
    for (const a of node.aliases) {
      const aLower = a.toLowerCase();
      if (aLower.includes(lower) || lower.includes(aLower)) return node;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Co-occurrence helpers
// ---------------------------------------------------------------------------

function buildCoOccurrenceMap(nodes: KB2GraphNodeType[]): Map<string, Set<string>> {
  const docToNodes = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const ref of node.source_refs ?? []) {
      const docId = ref.doc_id;
      let set = docToNodes.get(docId);
      if (!set) { set = new Set(); docToNodes.set(docId, set); }
      set.add(node.node_id);
    }
  }

  const pairKey = (a: string, b: string) => a < b ? `${a}||${b}` : `${b}||${a}`;
  const pairs = new Map<string, Set<string>>();
  for (const [docId, nodeIds] of docToNodes) {
    const arr = [...nodeIds];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = pairKey(arr[i], arr[j]);
        let docs = pairs.get(key);
        if (!docs) { docs = new Set(); pairs.set(key, docs); }
        docs.add(docId);
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

export const graphBuildStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger(`[graph-build]`);

  const nodesExecId = await ctx.getStepExecutionId("pass1", 5)
    ?? await ctx.getStepExecutionId("pass1", 4);
  const nodesFilter = nodesExecId ? { execution_id: nodesExecId } : { run_id: ctx.runId };
  const nodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  if (nodes.length === 0) throw new Error("No graph nodes found — run step 3 first");

  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  const docs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];

  await ctx.onProgress(`Building graph from ${nodes.length} nodes...`, 5);

  const nodeIdSet = new Set(nodes.map((n) => n.node_id));
  const nodeById = new Map(nodes.map((n) => [n.node_id, n]));

  const nodeByDisplayName = new Map<string, KB2GraphNodeType>();
  const nodeByAlias = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) {
    nodeByDisplayName.set(node.display_name.toLowerCase(), node);
    for (const alias of node.aliases) {
      nodeByAlias.set(alias.toLowerCase(), node);
    }
  }

  const validEdgeTypes = new Set(KB2EdgeTypeEnum.options);
  const edges: KB2GraphEdgeType[] = [];
  const edgeKeySet = new Set<string>();
  const edgeKey = (src: string, tgt: string, type: string) => `${src}|${tgt}|${type}`;

  // ---- 1. Build document-mention map (metadata only, no graph edges) ----
  const docMentions: Record<string, string[]> = {};
  for (const doc of docs) {
    const contentLower = doc.content.toLowerCase();
    const mentioned: string[] = [];
    for (const node of nodes) {
      const names = [node.display_name, ...node.aliases];
      if (names.some((n) => contentLower.includes(n.toLowerCase()))) {
        mentioned.push(node.node_id);
      }
    }
    if (mentioned.length > 0) docMentions[doc.sourceId] = mentioned;
  }

  await ctx.onProgress("Resolving _relationships edges...", 15);

  // ---- 2. _relationships resolution with validation + auto-flip ----
  let relDropped = 0;
  let relFlipped = 0;
  for (const node of nodes) {
    const rels = (node.attributes?._relationships ?? []) as EmbeddedRelationship[];
    for (const rel of rels) {
      const targetNode = resolveTarget(rel.target, nodeByDisplayName, nodeByAlias, nodes);
      if (!targetNode || targetNode.node_id === node.node_id) continue;

      const edgeType = rel.type.toUpperCase().replace(/\s+/g, "_");
      if (!validEdgeTypes.has(edgeType as KB2EdgeType)) continue;

      const verdict = validateEdge(node.type, targetNode.type, edgeType);
      if (verdict === "drop") { relDropped++; continue; }

      let srcId = node.node_id;
      let tgtId = targetNode.node_id;
      if (verdict === "flip") { srcId = targetNode.node_id; tgtId = node.node_id; relFlipped++; }

      const key = edgeKey(srcId, tgtId, edgeType);
      if (edgeKeySet.has(key)) continue;
      edgeKeySet.add(key);

      edges.push({
        edge_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        source_node_id: srcId,
        target_node_id: tgtId,
        type: edgeType as KB2EdgeType,
        weight: 1,
        evidence: rel.evidence,
      });
    }
  }
  logger.log(`Relationship edges: ${edges.length} kept, ${relFlipped} flipped, ${relDropped} dropped`);

  await ctx.onProgress("Inferring edges for co-occurring entities...", 30);

  // ---- 3. LLM-inferred edges for co-occurring entity pairs ----
  const coOccurrencePairs = buildCoOccurrenceMap(nodes);

  const pairsToInfer: { sourceId: string; targetId: string; sharedDocs: string[] }[] = [];
  for (const [key, docIds] of coOccurrencePairs) {
    const [idA, idB] = key.split("||");
    const alreadyHasEdge =
      edgeKeySet.has(edgeKey(idA, idB, "")) ? true :
        [...edgeKeySet].some((k) => k.startsWith(`${idA}|${idB}|`) || k.startsWith(`${idB}|${idA}|`));
    if (alreadyHasEdge) continue;
    pairsToInfer.push({ sourceId: idA, targetId: idB, sharedDocs: [...docIds] });
  }

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  const modelName = getFastModelName(ctx.config?.pipeline_settings?.models);
  let llmInferredCount = 0;
  let llmDropped = 0;
  let llmFlipped = 0;

  for (let i = 0; i < pairsToInfer.length; i += CO_OCCUR_BATCH_SIZE) {
    if (ctx.signal.aborted) break;

    const batch = pairsToInfer.slice(i, i + CO_OCCUR_BATCH_SIZE);
    const pairDescriptions = batch.map((p, idx) => {
      const srcNode = nodeById.get(p.sourceId)!;
      const tgtNode = nodeById.get(p.targetId)!;
      const docTitles = p.sharedDocs
        .map((dId) => docs.find((d) => d.sourceId === dId)?.title ?? dId)
        .slice(0, 3);
      return `${idx + 1}. "${srcNode.display_name}" (${srcNode.type}) ↔ "${tgtNode.display_name}" (${tgtNode.type}) — co-occur in: ${docTitles.join(", ")}`;
    }).join("\n");

    const systemPrompt = `You are a knowledge-graph edge inference engine.
For each entity pair, determine the most likely directed relationship or NONE if no meaningful relationship exists.

CRITICAL RULES for source → target direction:
- WORKS_ON: person → project/ticket/PR (never person → person)
- REVIEWS: person → pull_request (never PR → person)
- USES: person/project → library/infrastructure/integration (never library → team)
- CONTAINS: parent → child (project → ticket, team → person)
- PART_OF: child → parent (ticket → project, library → repository)
- APPLIES_TO: decision/process → project/ticket (never project → decision)
- PROPOSED_BY: decision → person who proposed it
- BUILT_BY: project/ticket → person who built it
- RESOLVES: pull_request → ticket
- FEEDBACK_FROM: customer_feedback → person/company
- MEMBER_OF: person → team
- OWNED_BY: project/process → person/team
- RELATED_TO: only when no better type fits
- NONE: co-occurrence without a meaningful relationship (prefer this over guessing)

Valid types: ${LLM_EDGE_TYPES.join(", ")}
Return "source" and "target" as the exact display_name strings provided, respecting the direction rules above.`;

    const userPrompt = `Infer relationships for these co-occurring entity pairs:\n\n${pairDescriptions}`;

    const startMs = Date.now();
    let usage: { promptTokens: number; completionTokens: number } | null = null;
    const callId = randomUUID();

    try {
      const result = await structuredGenerate({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        schema: InferredEdgeSchema,
        logger,
        onUsage: (u) => { usage = u; },
        signal: ctx.signal,
      });

      if (usage) {
        const dur = Date.now() - startMs;
        const cost = calculateCostUsd(modelName, usage.promptTokens, usage.completionTokens);
        await ctx.logLLMCall(
          STEP_ID, modelName,
          systemPrompt + "\n\n" + userPrompt,
          JSON.stringify(result, null, 2),
          usage.promptTokens, usage.completionTokens, cost, dur, callId,
        );
      }

      for (const inferred of result.edges) {
        if (inferred.type === "NONE") continue;
        const matchedBatch = batch.find((p) => {
          const src = nodeById.get(p.sourceId)!;
          const tgt = nodeById.get(p.targetId)!;
          return (
            (src.display_name === inferred.source && tgt.display_name === inferred.target) ||
            (src.display_name === inferred.target && tgt.display_name === inferred.source)
          );
        });
        if (!matchedBatch) continue;

        let srcId = matchedBatch.sourceId;
        let tgtId = matchedBatch.targetId;
        const srcNode = nodeById.get(srcId)!;
        const tgtNode = nodeById.get(tgtId)!;

        if (inferred.source === tgtNode.display_name && inferred.target === srcNode.display_name) {
          srcId = matchedBatch.targetId;
          tgtId = matchedBatch.sourceId;
        }

        const srcType = nodeById.get(srcId)!.type;
        const tgtType = nodeById.get(tgtId)!.type;
        const verdict = validateEdge(srcType, tgtType, inferred.type);
        if (verdict === "drop") { llmDropped++; continue; }
        if (verdict === "flip") { const tmp = srcId; srcId = tgtId; tgtId = tmp; llmFlipped++; }

        const key = edgeKey(srcId, tgtId, inferred.type);
        if (edgeKeySet.has(key)) continue;
        edgeKeySet.add(key);

        edges.push({
          edge_id: randomUUID(),
          run_id: ctx.runId,
          execution_id: ctx.executionId,
          source_node_id: srcId,
          target_node_id: tgtId,
          type: inferred.type as KB2EdgeType,
          weight: 0.8,
          evidence: inferred.evidence,
        });
        llmInferredCount++;
      }
    } catch (err) {
      logger.log(`LLM edge inference batch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const pct = 30 + Math.round((i / Math.max(pairsToInfer.length, 1)) * 40);
    await ctx.onProgress(`Inferred edges: batch ${Math.floor(i / CO_OCCUR_BATCH_SIZE) + 1}`, pct);
  }

  logger.log(`LLM-inferred edges: ${llmInferredCount} kept, ${llmFlipped} flipped, ${llmDropped} dropped by type constraints`);

  await ctx.onProgress("Validating endpoints...", 75);

  // ---- 4. Hard endpoint validation ----
  let droppedCount = 0;
  const validEdges = edges.filter((e) => {
    if (nodeIdSet.has(e.source_node_id) && nodeIdSet.has(e.target_node_id)) return true;
    droppedCount++;
    return false;
  });

  if (validEdges.length > 0) {
    await tc.graph_edges.insertMany(validEdges);
  }

  await ctx.onProgress("Running quality judge...", 85);

  // ---- 5. LLM-as-Judge ----
  const uniqueEdgeTypes = new Set(validEdges.map((e) => e.type));
  const nodesWithEdge = new Set<string>();
  for (const e of validEdges) {
    nodesWithEdge.add(e.source_node_id);
    nodesWithEdge.add(e.target_node_id);
  }
  const connectivityPct = nodes.length > 0
    ? Math.round((nodesWithEdge.size / nodes.length) * 100)
    : 0;
  const avgEdgesPerEntity = nodes.length > 0
    ? Math.round(validEdges.length / nodes.length)
    : 0;

  const deterministicResult = buildDeterministicJudge([
    { name: "Dangling edge rate", actual: 0, target: 0, mode: "eq", weight: 2 },
    { name: "Edge type diversity", actual: uniqueEdgeTypes.size, target: 5, mode: "gte" },
    { name: "Entity connectivity", actual: connectivityPct, target: 50, mode: "gte" },
    { name: "Avg edges per entity", actual: avgEdgesPerEntity, target: 2, mode: "gte" },
  ], 70);

  const result = {
    total_edges: validEdges.length,
    relationship_edges: validEdges.length - llmInferredCount,
    llm_inferred_edges: llmInferredCount,
    dropped_dangling: droppedCount,
    dropped_by_type_constraint: llmDropped + relDropped,
    flipped_by_type_constraint: llmFlipped + relFlipped,
    nodes_processed: nodes.length,
    unique_edge_types: uniqueEdgeTypes.size,
    connectivity_pct: connectivityPct,
    doc_mentions: docMentions,
    judge_score: deterministicResult.overall_score,
    judge_pass: deterministicResult.pass,
  };

  try {
    const judgeModel = getFastModel(ctx.config?.pipeline_settings?.models);
    const judgeModelName = getFastModelName(ctx.config?.pipeline_settings?.models);
    const ccModel = getCrossCheckModel(ctx.config?.pipeline_settings?.models);
    const ccModelName = getCrossCheckModelName(ctx.config?.pipeline_settings?.models);

    const sampledEdges = [...validEdges].sort(() => Math.random() - 0.5).slice(0, 25);
    const edgeList = sampledEdges.map((e) => {
      const src = nodeById.get(e.source_node_id);
      const tgt = nodeById.get(e.target_node_id);
      return `"${src?.display_name ?? e.source_node_id}" (${src?.type ?? "?"}) --[${e.type}]--> "${tgt?.display_name ?? e.target_node_id}" (${tgt?.type ?? "?"})`;
    }).join("\n");

    const llmResult = await runLLMJudge({
      model: judgeModel,
      modelName: judgeModelName,
      systemPrompt: `You are evaluating graph construction quality. For each edge, assess: Is the relationship real? Is the type correct? Is the evidence sufficient? Rate each: CORRECT / WRONG_TYPE / FALSE.
Return sub_scores: "Precision" (0-100, % CORRECT), "Type accuracy" (0-100), "Evidence sufficiency" (0-100).
Also return issues for any problematic edges and recommendations for improvement.`,
      userPrompt: `Evaluate these ${sampledEdges.length} sampled edges from graph construction:\n\n${edgeList}`,
      crossCheckModel: ccModel,
      crossCheckModelName: ccModelName,
      logLLMCall: ctx.logLLMCall,
      stepId: STEP_ID,
      signal: ctx.signal,
    });

    const merged = mergeJudgeResults(deterministicResult, llmResult, 70);
    await ctx.persistJudgeResult(merged);
    result.judge_score = merged.overall_score;
    result.judge_pass = merged.pass;
  } catch (judgeErr) {
    const errMsg = judgeErr instanceof Error ? `${judgeErr.message}\n${judgeErr.stack}` : String(judgeErr);
    logger.log(`LLM judge failed: ${errMsg}`);
    await ctx.persistJudgeResult({ ...deterministicResult, llm_judge_error: errMsg });
  }

  await ctx.onProgress(`Built graph: ${validEdges.length} edges (${droppedCount} dropped)`, 100);

  return result;
};
