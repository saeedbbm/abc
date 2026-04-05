import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, getCrossCheckModel, getCrossCheckModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { KB2EdgeTypeEnum } from "@/src/entities/models/kb2-types";
import type { KB2GraphNodeType, KB2GraphEdgeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const EnrichmentResultSchema = z.object({
  new_relationships: z.array(z.object({
    source_name: z.string(),
    target_name: z.string(),
    type: KB2EdgeTypeEnum,
    evidence: z.string(),
  })),
});

const VerificationResultSchema = z.object({
  verdicts: z.array(z.object({
    source_name: z.string(),
    target_name: z.string(),
    type: z.string(),
    answer: z.enum(["YES", "WEAK", "NO"]),
  })),
});

const RELATED_TO_UPGRADE_MAP: Record<string, Record<string, string>> = {
  team_member:    { project: "WORKS_ON", ticket: "WORKS_ON", pull_request: "REVIEWS", team: "MEMBER_OF", repository: "WORKS_ON" },
  client_person:  { project: "WORKS_ON", ticket: "WORKS_ON", client_company: "MEMBER_OF" },
  pipeline:       { infrastructure: "RUNS_ON", environment: "RUNS_ON", repository: "BUILT_BY" },
  pull_request:   { ticket: "RESOLVES" },
  decision:       { team_member: "PROPOSED_BY", client_person: "PROPOSED_BY" },
  customer_feedback: { client_person: "FEEDBACK_FROM", client_company: "FEEDBACK_FROM" },
};

export const graphEnrichmentStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-graph-enrichment");
  const BATCH_SIZE = ctx.config?.pipeline_settings?.graph_enrichment?.batch_size ?? 15;
  const nodesExecId = await ctx.getStepExecutionId("pass1", 5);
  const nodesFilter = nodesExecId ? { execution_id: nodesExecId } : { run_id: ctx.runId };
  const nodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  const edgesExecId = await ctx.getStepExecutionId("pass1", 6);
  const edgesFilter = edgesExecId ? { execution_id: edgesExecId } : { run_id: ctx.runId };
  const edges = (await tc.graph_edges.find(edgesFilter).toArray()) as unknown as KB2GraphEdgeType[];

  if (nodes.length === 0) throw new Error("No graph nodes found — run step 3 first");

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  const stepId = "pass1-step-7";
  const verificationModel = getCrossCheckModel(ctx.config?.pipeline_settings?.models);
  const verificationModelName = getCrossCheckModelName(ctx.config?.pipeline_settings?.models);

  const nodeIdSet = new Set(nodes.map((n) => n.node_id));
  const nodeByName = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) {
    nodeByName.set(node.display_name.toLowerCase(), node);
  }

  // Consume cross-type link_relationships from Step 5
  const step5Artifact = await ctx.getStepArtifact("pass1", 5);
  let linkRelEdgesCreated = 0;
  if (step5Artifact?.link_relationships && Array.isArray(step5Artifact.link_relationships)) {
    for (const link of step5Artifact.link_relationships as { nodeA: string; nodeB: string; relationship: string }[]) {
      const srcNode = nodeByName.get(link.nodeA.toLowerCase()) ?? nodes.find((n) => n.display_name.toLowerCase() === link.nodeA.toLowerCase());
      const tgtNode = nodeByName.get(link.nodeB.toLowerCase()) ?? nodes.find((n) => n.display_name.toLowerCase() === link.nodeB.toLowerCase());
      if (!srcNode || !tgtNode || srcNode.node_id === tgtNode.node_id) continue;

      const duplicate = edges.some(
        (e) => e.source_node_id === srcNode.node_id && e.target_node_id === tgtNode.node_id,
      );
      if (duplicate) continue;

      const newEdge: KB2GraphEdgeType = {
        edge_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        source_node_id: srcNode.node_id,
        target_node_id: tgtNode.node_id,
        type: "RELATED_TO",
        weight: 0.7,
        evidence: `[identity-anchor cross-type: ${link.relationship}] ${link.nodeA} references ${link.nodeB}`,
      };
      await tc.graph_edges.insertOne(newEdge);
      edges.push(newEdge);
      linkRelEdgesCreated++;
    }
    if (linkRelEdgesCreated > 0) {
      logger.log(`Created ${linkRelEdgesCreated} edges from Step 5 cross-type link_relationships`);
    }
  }

  const entityEdges = edges.filter(
    (e) => e.type !== "MENTIONED_IN" && nodeIdSet.has(e.source_node_id) && nodeIdSet.has(e.target_node_id),
  );

  let newEdges = 0;
  let totalLLMCalls = 0;
  const addedEdges: { source: string; target: string; type: string; evidence: string }[] = [];

  for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
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

    let enrichmentPrompt = `You are a knowledge graph relationship discoverer. Given a batch of entities from a software company's knowledge base, identify missing relationships between them.

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
- Do NOT invent relationships based on guessing — only suggest when the connection is obvious from naming, type, or attributes`;
    if (ctx.config?.prompts?.graph_enrichment?.system) {
      enrichmentPrompt = ctx.config.prompts.graph_enrichment.system;
    }

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: enrichmentPrompt,
      prompt: promptText,
      schema: EnrichmentResultSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;
    if (usageData) {
      const cost = calculateCostUsd(getFastModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getFastModelName(ctx.config?.pipeline_settings?.models), promptText, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
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
        execution_id: ctx.executionId,
        source_node_id: srcNode.node_id,
        target_node_id: tgtNode.node_id,
        type: rel.type,
        weight: ctx.config?.pipeline_settings?.graph_enrichment?.edge_weight ?? 0.8,
        evidence: `[enrichment] ${rel.evidence}`,
      };
      await tc.graph_edges.insertOne(newEdge);
      edges.push(newEdge);
      newEdges++;
      addedEdges.push({ source: srcNode.display_name, target: tgtNode.display_name, type: rel.type, evidence: rel.evidence });
    }

    const pct = Math.round(((i + batch.length) / nodes.length) * 95);
    await ctx.onProgress(`Enriched batch ${Math.ceil((i + 1) / BATCH_SIZE)} — ${newEdges} new relationships so far`, pct);
  }

  // ---- Verification pass: keep only edges the LLM confirms as YES ----
  let verifiedCount = addedEdges.length;
  let removedByVerification = 0;
  const rejectedKeys = new Set<string>();
  if (addedEdges.length > 0) {
    await ctx.onProgress("Verifying enriched edges...", 96);

    const VERIFY_BATCH = 30;
    const edgesToRemove = new Set<string>();

    for (let v = 0; v < addedEdges.length; v += VERIFY_BATCH) {
      if (ctx.signal.aborted) break;
      const verifyBatch = addedEdges.slice(v, v + VERIFY_BATCH);
      const listing = verifyBatch.map(
        (e, idx) => `${idx + 1}. "${e.source}" --[${e.type}]--> "${e.target}" | evidence: ${e.evidence}`,
      ).join("\n");

      try {
        const vResult = await structuredGenerate({
          model: verificationModel,
          system: `You are a strict knowledge-graph edge verifier. For each proposed edge, decide if the relationship is real and well-supported.\nAnswer YES only if the evidence clearly supports the relationship. Answer WEAK if plausible but not well-supported. Answer NO if incorrect or speculative.`,
          prompt: `Verify these edges:\n\n${listing}`,
          schema: VerificationResultSchema,
          logger,
          signal: ctx.signal,
        });
        totalLLMCalls++;

        for (const verdict of vResult.verdicts) {
          if (verdict.answer !== "YES") {
            edgesToRemove.add(`${verdict.source_name.toLowerCase()}|${verdict.target_name.toLowerCase()}|${verdict.type}`);
          }
        }
      } catch (err) {
        logger.log(`Verification batch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (edgesToRemove.size > 0) {
      for (const key of edgesToRemove) {
        const [srcName, tgtName, edgeType] = key.split("|");
        rejectedKeys.add(`${srcName}|${tgtName}|${edgeType}`);
        const srcNode = nodeByName.get(srcName);
        const tgtNode = nodeByName.get(tgtName);
        if (srcNode && tgtNode) {
          await tc.graph_edges.deleteOne({
            execution_id: ctx.executionId,
            source_node_id: srcNode.node_id,
            target_node_id: tgtNode.node_id,
            type: edgeType,
          });
        }
      }
      removedByVerification = edgesToRemove.size;
      verifiedCount = addedEdges.length - removedByVerification;
      logger.log(`Verification: kept ${verifiedCount}, removed ${removedByVerification}`);
    }
  }

  // ---- Upgrade remaining RELATED_TO edges where clear mapping exists ----
  let upgradedCount = 0;
  const allCurrentEdges = (await tc.graph_edges.find({ execution_id: ctx.executionId }).toArray()) as unknown as KB2GraphEdgeType[];
  const relatedToEdges = allCurrentEdges.filter((e) => e.type === "RELATED_TO");
  for (const edge of relatedToEdges) {
    const srcNode = nodes.find((n) => n.node_id === edge.source_node_id);
    const tgtNode = nodes.find((n) => n.node_id === edge.target_node_id);
    if (!srcNode || !tgtNode) continue;

    const mapping = RELATED_TO_UPGRADE_MAP[srcNode.type]?.[tgtNode.type]
      ?? RELATED_TO_UPGRADE_MAP[tgtNode.type]?.[srcNode.type];
    if (mapping) {
      await tc.graph_edges.updateOne(
        { edge_id: edge.edge_id },
        { $set: { type: mapping } },
      );
      upgradedCount++;
    }
  }
  if (upgradedCount > 0) {
    logger.log(`Upgraded ${upgradedCount} RELATED_TO edges to specific types`);
  }

  await ctx.onProgress(`Graph enrichment complete: +${verifiedCount} relationships (${removedByVerification} rejected, ${upgradedCount} upgraded)`, 100);
  return {
    new_edges: verifiedCount,
    removed_by_verification: removedByVerification,
    upgraded_related_to: upgradedCount,
    link_relationship_edges: linkRelEdgesCreated,
    total_nodes: nodes.length,
    llm_calls: totalLLMCalls,
    added_edges: addedEdges.filter(
      (e) => !rejectedKeys.has(`${e.source.toLowerCase()}|${e.target.toLowerCase()}|${e.type}`),
    ),
  };
};
