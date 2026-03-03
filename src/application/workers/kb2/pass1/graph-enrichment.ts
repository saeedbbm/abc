import { randomUUID } from "crypto";
import { z } from "zod";
import {
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
} from "@/lib/mongodb";
import { getFastModel, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { KB2EdgeTypeEnum } from "@/src/entities/models/kb2-types";
import type { KB2GraphNodeType, KB2GraphEdgeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const BATCH_SIZE = 15;

const EnrichmentResultSchema = z.object({
  new_relationships: z.array(z.object({
    source_name: z.string(),
    target_name: z.string(),
    type: KB2EdgeTypeEnum,
    evidence: z.string(),
  })),
});

export const graphEnrichmentStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-graph-enrichment");
  const nodes = (await kb2GraphNodesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  const edges = (await kb2GraphEdgesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphEdgeType[];

  if (nodes.length === 0) throw new Error("No graph nodes found — run step 3 first");

  const model = getFastModel();
  const stepId = "pass1-step-7";

  const nodeIdSet = new Set(nodes.map((n) => n.node_id));
  const nodeByName = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) {
    nodeByName.set(node.display_name.toLowerCase(), node);
  }

  const entityEdges = edges.filter(
    (e) => e.type !== "MENTIONED_IN" && nodeIdSet.has(e.source_node_id) && nodeIdSet.has(e.target_node_id),
  );

  let newEdges = 0;
  let totalLLMCalls = 0;
  const addedEdges: { source: string; target: string; type: string; evidence: string }[] = [];

  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    const batch = nodes.slice(i, i + BATCH_SIZE);
    const batchNodeIds = new Set(batch.map((n) => n.node_id));

    const batchEdges = entityEdges.filter((e) =>
      batchNodeIds.has(e.source_node_id) || batchNodeIds.has(e.target_node_id),
    );

    const graphSummary = batch.map((n) => {
      const attrs: string[] = [];
      if (n.attributes) {
        for (const [k, v] of Object.entries(n.attributes)) {
          if (k.startsWith("_")) continue;
          if (typeof v === "string" || typeof v === "number") attrs.push(`${k}=${v}`);
        }
      }
      const attrStr = attrs.length > 0 ? ` {${attrs.slice(0, 5).join(", ")}}` : "";
      return `- ${n.display_name} [${n.type}]${attrStr}`;
    }).join("\n");

    const edgeSummary = batchEdges.length > 0
      ? batchEdges.slice(0, 30).map((e) => {
          const src = nodes.find((n) => n.node_id === e.source_node_id)?.display_name ?? "?";
          const tgt = nodes.find((n) => n.node_id === e.target_node_id)?.display_name ?? "?";
          return `  ${src} --[${e.type}]--> ${tgt}`;
        }).join("\n")
      : "  (no entity-to-entity relationships yet)";

    const promptText = `Entities:\n${graphSummary}\n\nExisting Relationships:\n${edgeSummary}`;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: `You are a knowledge graph relationship discoverer. Given a batch of entities from a software company's knowledge base, identify missing relationships between them.

Your ONLY job is to find relationships between the entities listed below. Do NOT suggest new entities or reclassify existing ones — those steps are already handled by earlier pipeline stages.

Valid relationship types:
- OWNED_BY: team/person owns a repository, pipeline, or project
- DEPENDS_ON: one entity depends on another (e.g. repository depends on a database or library)
- USES: an entity uses another (e.g. repository uses a library, pipeline uses an integration)
- STORES_IN: a repository or service stores data in a database
- DEPLOYED_TO: a repository is deployed to an environment or cloud resource
- MEMBER_OF: a person is a member of a team
- WORKS_ON: a person works on a project or repository
- LEADS: a person leads a team, project, or repository
- CONTAINS: a project contains tickets, a repository contains pipelines
- RUNS_ON: a pipeline or infrastructure runs on a cloud resource
- BUILT_BY: a pipeline builds a repository
- RESOLVES: a pull request resolves a ticket
- RELATED_TO: a generic relationship when no specific type fits
- BLOCKED_BY: a ticket is blocked by another ticket
- COMMUNICATES_VIA: an entity communicates via an integration (e.g. team communicates via Slack)
- FEEDBACK_FROM: feedback comes from a client

Rules:
- Both source and target MUST be entities from the list above — use their exact display_name
- Only suggest relationships you are confident about based on the entity names, types, and attributes
- Return an empty array if no clear relationships can be inferred
- Do NOT invent relationships based on guessing — only suggest when the connection is obvious from naming, type, or attributes`,
      prompt: promptText,
      schema: EnrichmentResultSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
    });
    totalLLMCalls++;
    if (usageData) {
      const cost = calculateCostUsd("claude-sonnet-4-6", usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, "claude-sonnet-4-6", promptText, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    for (const rel of result.new_relationships) {
      const srcNode = nodeByName.get(rel.source_name.toLowerCase());
      const tgtNode = nodeByName.get(rel.target_name.toLowerCase());
      if (!srcNode || !tgtNode) continue;
      if (srcNode.node_id === tgtNode.node_id) continue;

      const duplicate = edges.some(
        (e) => e.source_node_id === srcNode.node_id && e.target_node_id === tgtNode.node_id && e.type === rel.type,
      );
      if (duplicate) continue;

      const newEdge: KB2GraphEdgeType = {
        edge_id: randomUUID(),
        run_id: ctx.runId,
        source_node_id: srcNode.node_id,
        target_node_id: tgtNode.node_id,
        type: rel.type,
        weight: 0.8,
        evidence: `[enrichment] ${rel.evidence}`,
      };
      await kb2GraphEdgesCollection.insertOne(newEdge);
      edges.push(newEdge);
      newEdges++;
      addedEdges.push({ source: srcNode.display_name, target: tgtNode.display_name, type: rel.type, evidence: rel.evidence });
    }

    const pct = Math.round(((i + batch.length) / nodes.length) * 95);
    ctx.onProgress(`Enriched batch ${Math.ceil((i + 1) / BATCH_SIZE)} — ${newEdges} new relationships so far`, pct);
  }

  ctx.onProgress(`Graph enrichment complete: +${newEdges} relationships`, 100);
  return {
    new_edges: newEdges,
    total_nodes: nodes.length,
    llm_calls: totalLLMCalls,
    added_edges: addedEdges,
  };
};
