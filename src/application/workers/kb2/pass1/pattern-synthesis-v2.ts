import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import {
  calculateCostUsd,
  getReasoningModel,
  getReasoningModelName,
} from "@/lib/ai-model";
import type { KB2PatternCandidate } from "@/src/application/lib/kb2/pass1-v2-artifacts";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const ConventionResultSchema = z.object({
  create: z.boolean(),
  reject_reason: z.string().optional(),
  convention: z.object({
    convention_name: z.string(),
    summary: z.string(),
    pattern_rule: z.string(),
    established_by: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    documentation_level: z.enum(["undocumented", "partially_documented", "documented"]),
  }).optional(),
});

const CONVENTION_PROMPT = `You synthesize cross-cutting engineering conventions from repeated evidence packs.

Rules:
- A convention is a repeated pattern, not a single decision.
- Use the evidence pack first; canonical nodes are supporting context only.
- Create a convention when the evidence shows a reusable team rule, implementation norm, or design convention.
- Do not require a fixed number of decision entities if the repeated evidence itself is strong.
- Repeated UI rules, layout choices, and implementation habits across multiple documents should normally become conventions when the same owner repeatedly drives them.
`;

function deriveConventionDocumentationLevel(
  evidenceRefs: KB2PatternCandidate["evidence_refs"],
  suggested: "undocumented" | "partially_documented" | "documented",
): "undocumented" | "partially_documented" | "documented" {
  const sourceTypes = new Set(evidenceRefs.map((ref) => ref.source_type));
  const hasConfluence = sourceTypes.has("confluence");
  const hasBehavioralEvidence = sourceTypes.has("slack") || sourceTypes.has("github") || sourceTypes.has("jira");
  if (!hasConfluence) return "undocumented";
  if (hasBehavioralEvidence) return "partially_documented";
  return suggested === "undocumented" ? "documented" : suggested;
}

export const patternSynthesisStepV2: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-pattern-synthesis-v2");
  const stepId = "pass1-step-10";
  const tc = getTenantCollections(ctx.companySlug);

  const step7Artifact = await ctx.getStepArtifact("pass1", 7);
  const patternCandidates = (step7Artifact?.pattern_candidates ?? []) as KB2PatternCandidate[];

  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step9Nodes = (await tc.graph_nodes.find(
    step9ExecId ? { execution_id: step9ExecId } : { run_id: ctx.runId },
  ).toArray()) as unknown as KB2GraphNodeType[];
  const decisionNodes = step9Nodes.filter((node) => node.type === "decision" && !(node.attributes as Record<string, unknown>)?.is_convention);

  if (patternCandidates.length === 0) {
    await ctx.onProgress("No repeated evidence packs found for convention synthesis", 100);
    return {
      phase1_clusters: [],
      phase3_conventions: [],
      phase4_cross_check: [],
      phase5_consolidations: [],
      rejected_candidates: [],
      conventions_found: 0,
      documented_standards_filtered: 0,
      total_decisions_analyzed: decisionNodes.length,
      llm_calls: 0,
      artifact_version: "pass1_v2",
    };
  }

  await ctx.onProgress(`Synthesizing conventions from ${patternCandidates.length} evidence packs...`, 5);

  const reasoningModel = getReasoningModel(ctx.config?.pipeline_settings?.models);
  const reasoningModelName = getReasoningModelName(ctx.config?.pipeline_settings?.models);
  const conventionNodes: KB2GraphNodeType[] = [];
  const rejectedCandidates: Array<{ name: string; reason: string }> = [];
  const phase3Conventions: Array<Record<string, unknown>> = [];
  let llmCalls = 0;

  for (let i = 0; i < patternCandidates.length; i++) {
    const candidate = patternCandidates[i];
    const relatedDecisions = decisionNodes
      .filter((node) => node.source_refs.some((ref) => candidate.evidence_refs.some((candidateRef) => candidateRef.title === ref.title)))
      .map((node) => node.display_name);

    const prompt = `OWNER HINT: ${candidate.owner_hint}
PATTERN RULE HINT: ${candidate.pattern_rule}
RELATED DECISIONS: ${relatedDecisions.join(", ") || "(none)"}

EVIDENCE:
${candidate.evidence_refs.map((ref) => `[${ref.source_type}] ${ref.title}: ${ref.excerpt}`).join("\n\n")}`;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model: reasoningModel,
      system: ctx.config?.prompts?.pattern_synthesis?.system ?? CONVENTION_PROMPT,
      prompt,
      schema: ConventionResultSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    llmCalls++;

    if (usageData) {
      const cost = calculateCostUsd(reasoningModelName, usageData.promptTokens, usageData.completionTokens);
      await ctx.logLLMCall(
        stepId,
        reasoningModelName,
        prompt.slice(0, 12000),
        JSON.stringify(result, null, 2).slice(0, 12000),
        usageData.promptTokens,
        usageData.completionTokens,
        cost,
        Date.now() - startMs,
      );
    }

    if (!result.create || !result.convention) {
      const fallbackEligible =
        candidate.confidence === "high" &&
        candidate.owner_hint.trim().length > 0 &&
        candidate.owner_hint.toLowerCase() !== "unknown" &&
        /(convention|pattern)$/i.test(candidate.title);
      if (fallbackEligible) {
        const fallbackSummary = `Repeated evidence indicates a reusable team pattern: ${candidate.pattern_rule}`;
        const documentationLevel = deriveConventionDocumentationLevel(candidate.evidence_refs, "undocumented");
        const node: KB2GraphNodeType = {
          node_id: randomUUID(),
          run_id: ctx.runId,
          execution_id: ctx.executionId,
          type: "decision",
          display_name: candidate.title,
          aliases: [],
          attributes: {
            is_convention: true,
            pattern_rule: candidate.pattern_rule,
            summary: fallbackSummary,
            established_by: candidate.owner_hint,
            constituent_decisions: relatedDecisions,
            supporting_observation_ids: candidate.observation_ids,
            combined_evidence: candidate.evidence_refs.map((ref) => ref.excerpt).join("\n\n"),
            status: "decided",
            documentation_level: documentationLevel,
            description: fallbackSummary,
          },
          source_refs: candidate.evidence_refs,
          truth_status: "inferred",
          confidence: "medium",
        };
        conventionNodes.push(node);
        phase3Conventions.push({
          convention_name: candidate.title,
          established_by: candidate.owner_hint,
          pattern_rule: candidate.pattern_rule,
          constituent_decisions: relatedDecisions,
          documentation_level: documentationLevel,
          confidence: "medium",
          evidence_count: candidate.evidence_refs.length,
          evidence_sources: candidate.evidence_refs.map((ref) => `${ref.source_type}:${ref.title}`).slice(0, 6),
          source_refs: candidate.evidence_refs.slice(0, 6).map((ref) => ({
            source_type: ref.source_type,
            title: ref.title,
            excerpt: ref.excerpt,
          })),
        });
        continue;
      }
      rejectedCandidates.push({
        name: candidate.title,
        reason: result.reject_reason ?? "insufficient repeated evidence",
      });
      continue;
    }

    const documentationLevel = deriveConventionDocumentationLevel(
      candidate.evidence_refs,
      result.convention.documentation_level,
    );
    const node: KB2GraphNodeType = {
      node_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      type: "decision",
      display_name: result.convention.convention_name,
      aliases: [],
      attributes: {
        is_convention: true,
        pattern_rule: result.convention.pattern_rule,
        summary: result.convention.summary,
        established_by: result.convention.established_by,
        constituent_decisions: relatedDecisions,
        supporting_observation_ids: candidate.observation_ids,
        combined_evidence: candidate.evidence_refs.map((ref) => ref.excerpt).join("\n\n"),
        status: "decided",
        documentation_level: documentationLevel,
        description: result.convention.summary,
      },
      source_refs: candidate.evidence_refs,
      truth_status: "inferred",
      confidence: result.convention.confidence,
    };
    conventionNodes.push(node);
    phase3Conventions.push({
      convention_name: result.convention.convention_name,
      established_by: result.convention.established_by,
      pattern_rule: result.convention.pattern_rule,
      constituent_decisions: relatedDecisions,
      documentation_level: documentationLevel,
      confidence: result.convention.confidence,
      evidence_count: candidate.evidence_refs.length,
      evidence_sources: candidate.evidence_refs.map((ref) => `${ref.source_type}:${ref.title}`).slice(0, 6),
      source_refs: candidate.evidence_refs.slice(0, 6).map((ref) => ({
        source_type: ref.source_type,
        title: ref.title,
        excerpt: ref.excerpt,
      })),
    });
  }

  if (conventionNodes.length > 0) {
    await tc.graph_nodes.insertMany(conventionNodes as any[]);
  }

  await ctx.onProgress(`Created ${conventionNodes.length} convention entities`, 100);

  return {
    phase1_clusters: patternCandidates.map((candidate) => ({
      person: candidate.owner_hint,
      decisions: candidate.observation_ids,
      similarity_scores: [],
    })),
    phase3_conventions: phase3Conventions,
    phase4_cross_check: [],
    phase5_consolidations: [],
    rejected_candidates: rejectedCandidates,
    conventions_found: conventionNodes.length,
    documented_standards_filtered: 0,
    total_decisions_analyzed: decisionNodes.length,
    llm_calls: llmCalls,
    artifact_version: "pass1_v2",
  };
};
