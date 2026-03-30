import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import {
  getReasoningModel,
  getReasoningModelName,
  getCrossCheckModel,
  getCrossCheckModelName,
  calculateCostUsd,
} from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import { tokenSimilarity } from "@/src/application/workers/kb2/utils/text-similarity";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ConventionSchema = z.object({
  conventions: z.array(
    z.object({
      convention_name: z.string(),
      summary: z.string(),
      pattern_rule: z.string(),
      established_by: z.string(),
      constituent_decisions: z.array(z.string()),
      combined_evidence: z.string(),
      source_documents: z.array(z.string()),
      confidence: z.enum(["high", "medium", "low"]),
      documentation_level: z.enum([
        "undocumented",
        "partially_documented",
        "documented",
      ]),
    }),
  ),
});

const CrossCheckSchema = z.object({
  established_by: z.string(),
  reasoning: z.string(),
});

const AdjudicationOwnerSchema = z.object({
  established_by: z.string(),
  reasoning: z.string(),
  chose: z.enum(["model_a", "model_b", "new_answer"]),
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CLUSTER_SYNTHESIS_PROMPT = `You are analyzing a CLUSTER of related decisions made within a company to identify CROSS-CUTTING CONVENTIONS —
recurring patterns where the same person or team makes the same TYPE of choice
across multiple features over time.

A convention is NOT a single decision. It is a PATTERN that appears when you look at
3+ decisions together and realize they follow the same rule.

Examples of what we're looking for:
- A designer who always uses the same color scheme (green = money, blue = navigation)
  across 5+ different pages over 2 years
- An architect who always recommends the same data-loading pattern (load-all for small
  lists) across 4+ PRs
- A developer who always uses the same layout approach (vertical sidebar for selection)
  across 3+ features

For each convention, provide:
- convention_name: A descriptive name (e.g. "Gender-Color and Money-Color UI Convention")
- summary: One paragraph describing the pattern
- pattern_rule: The generalizable rule (e.g. "Green CTAs for financial actions,
  blue for non-financial, pink/blue for gender indicators")
- established_by: The person who ESTABLISHED this convention based on provenance evidence.
  Look at source_ref excerpts carefully — who authored, proposed, or enforced this pattern?
  Do NOT simply count which person appears most often as decided_by.
  The person who wrote the original proposal or standard is the true establisher.
- constituent_decisions: List of decision entity names that are instances of this convention
- combined_evidence: Key quotes from sources proving the pattern
- source_documents: List of source document titles where evidence appears
- confidence: high/medium/low
- documentation_level: "documented" if there is an official standard or style guide,
  "partially_documented" if mentioned in some docs but not formal,
  "undocumented" if it's purely inferred from behavior

RULES:
- Only identify conventions backed by 3+ individual decisions.
- The constituent_decisions MUST use the exact display_name values from the provided decision entities.
- Do NOT create conventions for single decisions or unrelated groups.
- Focus on patterns that a new team member would need to know about.
- For established_by: use PROVENANCE evidence (who wrote the source doc, who proposed
  in the PR, who authored the design spec). Do NOT use majority-vote counting of decided_by.`;

const CROSS_CHECK_PROMPT = `You are verifying the ownership attribution of a convention.
Given the evidence below, determine who truly ESTABLISHED this convention.
Look at the source evidence carefully — who authored the original proposal, standard, or design spec?
Return the person who established the convention based on provenance evidence.`;

// ---------------------------------------------------------------------------
// Phase 1: Programmatic clustering
// ---------------------------------------------------------------------------

interface DecisionCluster {
  owner: string;
  decisions: KB2GraphNodeType[];
  similarity_scores: { a: string; b: string; score: number }[];
}

function clusterDecisionsBySimilarity(
  decisions: KB2GraphNodeType[],
  threshold: number,
  minClusterSize: number,
): DecisionCluster[] {
  const byOwner = new Map<string, KB2GraphNodeType[]>();
  for (const d of decisions) {
    const owner =
      ((d.attributes as Record<string, any>)?.decided_by as string) ??
      "unknown";
    const group = byOwner.get(owner) ?? [];
    group.push(d);
    byOwner.set(owner, group);
  }

  const clusters: DecisionCluster[] = [];

  for (const [owner, group] of byOwner) {
    if (group.length < minClusterSize) continue;

    const pairScores: { a: string; b: string; score: number }[] = [];
    const adjacency = new Map<number, Set<number>>();

    for (let i = 0; i < group.length; i++) {
      adjacency.set(i, new Set());
    }

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const attrsI = (group[i].attributes ?? {}) as Record<string, any>;
        const attrsJ = (group[j].attributes ?? {}) as Record<string, any>;
        const nameSim = tokenSimilarity(group[i].display_name, group[j].display_name);
        const rationaleSim = (attrsI.rationale && attrsJ.rationale)
          ? tokenSimilarity(attrsI.rationale, attrsJ.rationale) : 0;
        const scopeSim = (attrsI.scope && attrsJ.scope)
          ? tokenSimilarity(attrsI.scope, attrsJ.scope) : 0;
        const score = 0.5 * nameSim + 0.3 * rationaleSim + 0.2 * scopeSim;
        pairScores.push({
          a: group[i].display_name,
          b: group[j].display_name,
          score,
        });
        if (score >= threshold) {
          adjacency.get(i)!.add(j);
          adjacency.get(j)!.add(i);
        }
      }
    }

    // Connected-component clustering on the similarity graph
    const visited = new Set<number>();
    for (let i = 0; i < group.length; i++) {
      if (visited.has(i)) continue;
      const component: number[] = [];
      const stack = [i];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        component.push(cur);
        for (const nb of adjacency.get(cur)!) {
          if (!visited.has(nb)) stack.push(nb);
        }
      }
      if (component.length >= minClusterSize) {
        const clusterDecisions = component.map((idx) => group[idx]);
        const clusterScores = pairScores.filter(
          (s) =>
            clusterDecisions.some((d) => d.display_name === s.a) &&
            clusterDecisions.some((d) => d.display_name === s.b),
        );
        clusters.push({
          owner,
          decisions: clusterDecisions,
          similarity_scores: clusterScores,
        });
      }
    }

    // If no clusters formed but the whole group qualifies, treat it as one cluster
    if (
      clusters.filter((c) => c.owner === owner).length === 0 &&
      group.length >= minClusterSize
    ) {
      clusters.push({
        owner,
        decisions: group,
        similarity_scores: pairScores,
      });
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Phase 2: Evidence collection
// ---------------------------------------------------------------------------

interface ClusterEvidence {
  cluster: DecisionCluster;
  evidenceText: string;
}

function collectClusterEvidence(
  cluster: DecisionCluster,
  docs: KB2ParsedDocument[],
): ClusterEvidence {
  const docById = new Map<string, KB2ParsedDocument>();
  for (const d of docs) docById.set((d as any).doc_id ?? d.title, d);

  const parts: string[] = [];
  for (const decision of cluster.decisions) {
    const attrs = (decision.attributes ?? {}) as Record<string, any>;
    const attrLines: string[] = [];
    if (attrs.decided_by) attrLines.push(`decided_by: ${attrs.decided_by}`);
    if (attrs.scope) attrLines.push(`scope: ${attrs.scope}`);
    if (attrs.rationale) attrLines.push(`rationale: ${attrs.rationale}`);
    for (const ref of decision.source_refs) {
      const refAttrs = ref as Record<string, unknown>;
      if (refAttrs.pr_author) attrLines.push(`pr_author: ${refAttrs.pr_author}`);
      if (refAttrs.pr_reviewers) attrLines.push(`pr_reviewers: ${refAttrs.pr_reviewers}`);
      if (refAttrs.slack_speaker) attrLines.push(`slack_speaker: ${refAttrs.slack_speaker}`);
    }

    parts.push(
      `DECISION: "${decision.display_name}"${attrLines.length > 0 ? ` {${attrLines.join(", ")}}` : ""}`,
    );

    for (const ref of decision.source_refs) {
      const doc = docById.get(ref.doc_id);
      const fullExcerpt = doc
        ? extractSection(doc.content, ref.excerpt)
        : ref.excerpt;
      parts.push(
        `  [${ref.source_type}] ${ref.title}${ref.section_heading ? ` > ${ref.section_heading}` : ""}:\n  ${fullExcerpt}`,
      );
    }
    parts.push("");
  }

  return { cluster, evidenceText: parts.join("\n") };
}

function extractSection(
  docContent: string,
  excerpt: string,
): string {
  if (!excerpt || !docContent) return excerpt ?? "";
  const idx = docContent.indexOf(excerpt.slice(0, 80));
  if (idx < 0) return excerpt;
  const start = Math.max(0, idx - 200);
  const end = Math.min(docContent.length, idx + excerpt.length + 200);
  return docContent.slice(start, end);
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

export const patternSynthesisStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-pattern-synthesis");
  const stepId = "pass1-step-10";
  const tc = getTenantCollections(ctx.companySlug);

  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step9Filter = step9ExecId
    ? { execution_id: step9ExecId }
    : { run_id: ctx.runId };
  const allNodes = (await tc.graph_nodes
    .find(step9Filter)
    .toArray()) as unknown as KB2GraphNodeType[];

  const decisions = allNodes.filter((n) => n.type === "decision");

  if (decisions.length < 3) {
    await ctx.onProgress(
      "Not enough decisions to analyze for patterns",
      100,
    );
    return {
      conventions_found: 0,
      total_decisions_analyzed: decisions.length,
      llm_calls: 0,
      phase1_clusters: [],
      phase3_conventions: [],
      phase4_cross_check: [],
      phase5_consolidations: [],
      rejected_candidates: [],
      documented_standards_filtered: 0,
    };
  }

  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId
      ? { execution_id: snapshotExecId }
      : { run_id: ctx.runId },
  );
  const docs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];

  let llmCalls = 0;
  const models = ctx.config?.pipeline_settings?.models;

  // -----------------------------------------------------------------------
  // Phase 1: Programmatic clustering
  // -----------------------------------------------------------------------
  await ctx.onProgress(
    `Phase 1: Clustering ${decisions.length} decisions by similarity...`,
    5,
  );

  const phase1Clusters = clusterDecisionsBySimilarity(decisions, 0.4, 3);

  logger.log(
    `Phase 1 produced ${phase1Clusters.length} cluster(s) from ${decisions.length} decisions`,
  );

  const phase1Artifact = phase1Clusters.map((c) => ({
    person: c.owner,
    decisions: c.decisions.map((d) => d.display_name),
    similarity_scores: c.similarity_scores,
  }));

  if (phase1Clusters.length === 0) {
    await ctx.onProgress("No decision clusters found", 100);
    return {
      conventions_found: 0,
      total_decisions_analyzed: decisions.length,
      llm_calls: 0,
      phase1_clusters: phase1Artifact,
      phase3_conventions: [],
      phase4_cross_check: [],
      phase5_consolidations: [],
      rejected_candidates: [],
      documented_standards_filtered: 0,
    };
  }

  // -----------------------------------------------------------------------
  // Phase 2: Per-cluster evidence collection
  // -----------------------------------------------------------------------
  await ctx.onProgress(
    `Phase 2: Collecting evidence for ${phase1Clusters.length} clusters...`,
    15,
  );

  const clusterEvidences = phase1Clusters.map((c) =>
    collectClusterEvidence(c, docs),
  );

  // -----------------------------------------------------------------------
  // Phase 3: Per-cluster LLM synthesis (Reasoning model – Claude Opus)
  // -----------------------------------------------------------------------
  await ctx.onProgress(
    `Phase 3: LLM synthesis for ${clusterEvidences.length} clusters...`,
    25,
  );

  const reasoningModel = getReasoningModel(models);
  const reasoningModelName = getReasoningModelName(models);

  type ConventionResult = z.infer<typeof ConventionSchema>["conventions"][number];
  const allConventions: ConventionResult[] = [];
  const rejectedCandidates: { name: string; reason: string }[] = [];

  for (let i = 0; i < clusterEvidences.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");

    const { cluster, evidenceText } = clusterEvidences[i];
    const clusterLabel = `${cluster.owner} (${cluster.decisions.length} decisions)`;

    await ctx.onProgress(
      `Phase 3: Synthesizing cluster ${i + 1}/${clusterEvidences.length} — ${clusterLabel}`,
      25 + Math.round((i / clusterEvidences.length) * 20),
    );

    const prompt = `CLUSTER OWNER: ${cluster.owner}\nDECISIONS IN CLUSTER (${cluster.decisions.length}):\n\n${evidenceText}`;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null =
      null;

    const result = await structuredGenerate({
      model: reasoningModel,
      system:
        ctx.config?.prompts?.pattern_synthesis?.system ??
        CLUSTER_SYNTHESIS_PROMPT,
      prompt,
      schema: ConventionSchema,
      logger,
      onUsage: (u) => {
        usageData = u;
      },
      signal: ctx.signal,
    });
    llmCalls++;

    if (usageData) {
      const cost = calculateCostUsd(
        reasoningModelName,
        (usageData as any).promptTokens,
        (usageData as any).completionTokens,
      );
      ctx.logLLMCall(
        stepId,
        reasoningModelName,
        prompt.slice(0, 50000),
        JSON.stringify(result, null, 2).slice(0, 10000),
        (usageData as any).promptTokens,
        (usageData as any).completionTokens,
        cost,
        Date.now() - startMs,
      );
    }

    for (const conv of result.conventions ?? []) {
      if (conv.constituent_decisions.length < 3) {
        rejectedCandidates.push({
          name: conv.convention_name,
          reason: `Only ${conv.constituent_decisions.length} constituent decisions (need 3+)`,
        });
        continue;
      }
      allConventions.push(conv);
    }
  }

  logger.log(
    `Phase 3 produced ${allConventions.length} conventions, rejected ${rejectedCandidates.length}`,
  );

  const phase3Artifact = allConventions.map((c) => ({
    convention_name: c.convention_name,
    established_by: c.established_by,
    pattern_rule: c.pattern_rule,
    constituent_decisions: c.constituent_decisions,
    documentation_level: c.documentation_level,
    confidence: c.confidence,
  }));

  // -----------------------------------------------------------------------
  // Phase 4: Attribution cross-check (GPT-4o)
  // -----------------------------------------------------------------------
  await ctx.onProgress(
    `Phase 4: Cross-checking attribution for ${allConventions.length} conventions...`,
    55,
  );

  const crossCheckModelInstance = getCrossCheckModel(models);
  const crossCheckName = getCrossCheckModelName(models);

  const phase4CrossCheck: {
    convention_name: string;
    agreed: boolean;
    primary_owner: string;
    cross_check_owner: string;
    adjudication?: string;
    adjudicated_owner?: string;
  }[] = [];

  for (let i = 0; i < allConventions.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");

    const conv = allConventions[i];

    await ctx.onProgress(
      `Phase 4: Cross-check ${i + 1}/${allConventions.length} — ${conv.convention_name}`,
      55 + Math.round((i / allConventions.length) * 15),
    );

    const evidenceForConv = clusterEvidences
      .filter((ce) =>
        ce.cluster.decisions.some((d) =>
          conv.constituent_decisions
            .map((n) => n.toLowerCase().trim())
            .includes(d.display_name.toLowerCase().trim()),
        ),
      )
      .map((ce) => ce.evidenceText)
      .join("\n---\n");

    const crossCheckPrompt = `CONVENTION: ${conv.convention_name}
PATTERN RULE: ${conv.pattern_rule}
PRIMARY ATTRIBUTION: ${conv.established_by}

EVIDENCE:
${evidenceForConv}

Who truly established this convention? Look at authorship provenance in the evidence.`;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null =
      null;

    const crossResult = await structuredGenerate({
      model: crossCheckModelInstance,
      system: CROSS_CHECK_PROMPT,
      prompt: crossCheckPrompt,
      schema: CrossCheckSchema,
      logger,
      onUsage: (u) => {
        usageData = u;
      },
      signal: ctx.signal,
    });
    llmCalls++;

    if (usageData) {
      const cost = calculateCostUsd(
        crossCheckName,
        (usageData as any).promptTokens,
        (usageData as any).completionTokens,
      );
      ctx.logLLMCall(
        stepId,
        crossCheckName,
        crossCheckPrompt.slice(0, 50000),
        JSON.stringify(crossResult, null, 2).slice(0, 10000),
        (usageData as any).promptTokens,
        (usageData as any).completionTokens,
        cost,
        Date.now() - startMs,
      );
    }

    const originalPrimaryOwner = conv.established_by;

    const agreed =
      crossResult.established_by.toLowerCase().trim() ===
      conv.established_by.toLowerCase().trim();

    let adjudicatedOwner = conv.established_by;
    let adjudicationReasoning: string | undefined;

    if (!agreed) {
      logger.log(
        `Attribution disagreement on "${conv.convention_name}": Opus="${conv.established_by}" vs GPT-4o="${crossResult.established_by}" — running adjudication`,
      );

      const adjEvidence = clusterEvidences
        .filter((ce) => ce.cluster.decisions.some((d) =>
          conv.constituent_decisions.map((n) => n.toLowerCase().trim()).includes(d.display_name.toLowerCase().trim()),
        ))
        .map((ce) => ce.evidenceText)
        .join("\n---\n")
        .slice(0, 8000);

      try {
        const adjResult = await structuredGenerate({
          model: reasoningModel,
          system: "You are adjudicating a disagreement about who established a coding convention. Use provenance evidence (PR authors, reviewers, Slack speakers, doc authors) to determine the true originator.",
          prompt: `CONVENTION: "${conv.convention_name}"
Pattern: ${conv.pattern_rule}

Model A says established_by: "${conv.established_by}"
Model B says established_by: "${crossResult.established_by}" because: ${crossResult.reasoning}

Evidence:
${adjEvidence}

Who truly established this convention?`,
          schema: AdjudicationOwnerSchema,
          logger,
          signal: ctx.signal,
        });
        llmCalls++;

        adjudicatedOwner = adjResult.established_by;
        adjudicationReasoning = adjResult.reasoning;
        conv.established_by = adjudicatedOwner;

        logger.log(
          `Adjudication for "${conv.convention_name}": chose "${adjudicatedOwner}" (${adjResult.chose})`,
        );
      } catch (err) {
        logger.log(`Adjudication failed for "${conv.convention_name}", keeping primary: ${err}`);
        adjudicationReasoning = "adjudication_failed";
      }
    }

    phase4CrossCheck.push({
      convention_name: conv.convention_name,
      agreed,
      primary_owner: originalPrimaryOwner,
      cross_check_owner: crossResult.established_by,
      adjudication: adjudicationReasoning,
      adjudicated_owner: adjudicatedOwner,
    });
  }

  // -----------------------------------------------------------------------
  // Phase 5: Convention consolidation
  // -----------------------------------------------------------------------
  await ctx.onProgress("Phase 5: Consolidating overlapping conventions...", 75);

  const phase5Consolidations: {
    merged_from: string;
    merged_into: string;
    reason: string;
  }[] = [];

  const consolidated = [...allConventions];
  const removed = new Set<number>();

  for (let i = 0; i < consolidated.length; i++) {
    if (removed.has(i)) continue;
    for (let j = i + 1; j < consolidated.length; j++) {
      if (removed.has(j)) continue;

      const sameOwner =
        consolidated[i].established_by.toLowerCase().trim() ===
        consolidated[j].established_by.toLowerCase().trim();
      if (!sameOwner) continue;

      const ruleSim = tokenSimilarity(
        consolidated[i].pattern_rule,
        consolidated[j].pattern_rule,
      );
      if (ruleSim < 0.4) continue;

      // Require overlapping constituent decisions or shared source documents
      const decisionsI = new Set(consolidated[i].constituent_decisions.map((d) => d.toLowerCase().trim()));
      const hasOverlappingDecisions = consolidated[j].constituent_decisions.some(
        (d) => decisionsI.has(d.toLowerCase().trim()),
      );
      const docsI = new Set(consolidated[i].source_documents.map((d) => d.toLowerCase().trim()));
      const hasOverlappingDocs = consolidated[j].source_documents.some(
        (d) => docsI.has(d.toLowerCase().trim()),
      );
      if (!hasOverlappingDecisions && !hasOverlappingDocs) continue;

      const mergedDecisions = [
        ...new Set([
          ...consolidated[i].constituent_decisions,
          ...consolidated[j].constituent_decisions,
        ]),
      ];
      const mergedSources = [
        ...new Set([
          ...consolidated[i].source_documents,
          ...consolidated[j].source_documents,
        ]),
      ];

      phase5Consolidations.push({
        merged_from: consolidated[j].convention_name,
        merged_into: consolidated[i].convention_name,
        reason: `Same owner (${consolidated[i].established_by}) and pattern_rule similarity ${ruleSim.toFixed(2)}`,
      });

      consolidated[i] = {
        ...consolidated[i],
        constituent_decisions: mergedDecisions,
        source_documents: mergedSources,
        combined_evidence:
          consolidated[i].combined_evidence +
          "\n" +
          consolidated[j].combined_evidence,
      };
      removed.add(j);
    }
  }

  const finalConventions = consolidated.filter((_, idx) => !removed.has(idx));

  logger.log(
    `Phase 5: ${phase5Consolidations.length} merges, ${finalConventions.length} conventions remaining`,
  );

  // -----------------------------------------------------------------------
  // Filter documented standards
  // -----------------------------------------------------------------------
  const decisionsByName = new Map<string, KB2GraphNodeType>();
  for (const d of decisions)
    decisionsByName.set(d.display_name.toLowerCase().trim(), d);

  const beforeFilter = finalConventions.length;
  const activeConventions = finalConventions.filter((conv) => {
    if (conv.documentation_level === "documented") {
      rejectedCandidates.push({
        name: conv.convention_name,
        reason: "Fully documented standard — filtered out",
      });
      return false;
    }

    if (conv.constituent_decisions.length === 1) {
      const node = decisionsByName.get(
        conv.constituent_decisions[0].toLowerCase().trim(),
      );
      const docLevel = (node?.attributes as any)?.documentation_level;
      if (docLevel === "documented") {
        rejectedCandidates.push({
          name: conv.convention_name,
          reason: "Single-constituent documented decision — filtered out",
        });
        return false;
      }
    }

    return true;
  });

  const documentedStandardsFiltered = beforeFilter - activeConventions.length;

  // -----------------------------------------------------------------------
  // Create graph nodes
  // -----------------------------------------------------------------------
  await ctx.onProgress(
    `Creating ${activeConventions.length} convention entities...`,
    85,
  );

  const conventionNodes: KB2GraphNodeType[] = [];
  for (const conv of activeConventions) {
    // Dedup source_refs by doc_id + section_heading
    const combinedSourceRefs = conv.constituent_decisions
      .flatMap((name) => {
        const node = decisionsByName.get(name.toLowerCase().trim());
        return node?.source_refs ?? [];
      })
      .filter(
        (r, i, arr) =>
          arr.findIndex(
            (x) =>
              x.doc_id === r.doc_id &&
              x.section_heading === r.section_heading,
          ) === i,
      );

    const node: KB2GraphNodeType = {
      node_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      type: "decision",
      display_name: conv.convention_name,
      aliases: [],
      attributes: {
        is_convention: true,
        pattern_rule: conv.pattern_rule,
        summary: conv.summary,
        established_by: conv.established_by,
        constituent_decisions: conv.constituent_decisions,
        combined_evidence: conv.combined_evidence,
        status: "decided",
        documentation_level: conv.documentation_level,
        description: conv.summary,
      },
      source_refs: combinedSourceRefs.slice(0, 20),
      truth_status: "inferred",
      confidence: conv.confidence as any,
    };
    conventionNodes.push(node);
  }

  if (conventionNodes.length > 0) {
    await tc.graph_nodes.insertMany(conventionNodes);
  }

  await ctx.onProgress(
    `Created ${conventionNodes.length} convention entities`,
    100,
  );

  return {
    phase1_clusters: phase1Artifact,
    phase3_conventions: phase3Artifact,
    phase4_cross_check: phase4CrossCheck,
    phase5_consolidations: phase5Consolidations,
    rejected_candidates: rejectedCandidates,
    conventions_found: conventionNodes.length,
    documented_standards_filtered: documentedStandardsFiltered,
    total_decisions_analyzed: decisions.length,
    llm_calls: llmCalls,
  };
};
