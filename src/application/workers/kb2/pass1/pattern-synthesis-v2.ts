import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import {
  calculateCostUsd,
  getReasoningModel,
  getReasoningModelName,
} from "@/lib/ai-model";
import { cleanEntityTitle } from "@/src/application/lib/kb2/title-cleanup";
import type { KB2PatternCandidate } from "@/src/application/lib/kb2/pass1-v2-artifacts";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const SingleConventionSchema = z.object({
  convention_name: z.string(),
  summary: z.string(),
  pattern_rule: z.string(),
  established_by: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  documentation_level: z.enum(["undocumented", "partially_documented", "documented"]),
});

const ConventionResultSchema = z.object({
  conventions: z.array(SingleConventionSchema).describe("One or more conventions found. Return an empty array if no conventions are supported by the evidence."),
  reject_reason: z.string().optional(),
});

const CONVENTION_PROMPT = `You synthesize cross-cutting engineering conventions from repeated evidence packs.

Rules:
- A convention is a repeated pattern, not a single decision.
- Use the evidence pack first; canonical nodes are supporting context only.
- Create a convention when the evidence shows a reusable team rule, implementation norm, or design convention.
- Do not require a fixed number of decision entities if the repeated evidence itself is strong.
- Repeated UI rules, layout choices, and implementation habits across multiple documents should normally become conventions when the same owner repeatedly drives them.
- convention_name must be a concise canonical title suitable for an entity page heading, not a raw quote, sentence fragment, or truncated excerpt.
- Preserve concrete implementation prescriptions in summary and pattern_rule when the evidence supports them, including exact colors, layout direction, breakpoints, thresholds, and loading behavior.
- The evidence pack may contain MULTIPLE distinct conventions by the same person. If so, return each as a separate convention object. For example, one person may have a layout convention AND a data-loading convention — these are separate conventions.
- Each convention must be backed by evidence from at least 2 distinct sources.
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
    const fallbackConventionName = cleanEntityTitle(candidate.title, "decision");
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

    const conventions = result.conventions ?? [];

    if (conventions.length === 0) {
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
          display_name: fallbackConventionName,
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
          convention_name: fallbackConventionName,
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

    for (const conv of conventions) {
      const documentationLevel = deriveConventionDocumentationLevel(
        candidate.evidence_refs,
        conv.documentation_level,
      );
      const cleanedConventionName = cleanEntityTitle(
        conv.convention_name || fallbackConventionName,
        "decision",
      );
      const ruleTokens = new Set(
        (conv.pattern_rule + " " + conv.convention_name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(" ")
          .filter((t) => t.length >= 4),
      );
      const filteredConstituents = relatedDecisions.filter((name) => {
        const nameTokens = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length >= 4);
        const overlap = nameTokens.filter((t) => ruleTokens.has(t)).length;
        return overlap >= 2 || nameTokens.length <= 2;
      });
      const node: KB2GraphNodeType = {
        node_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        type: "decision",
        display_name: cleanedConventionName,
        aliases: [],
        attributes: {
          is_convention: true,
          pattern_rule: conv.pattern_rule,
          summary: conv.summary,
          established_by: conv.established_by,
          constituent_decisions: filteredConstituents,
          supporting_observation_ids: candidate.observation_ids,
          combined_evidence: candidate.evidence_refs.map((ref) => ref.excerpt).join("\n\n"),
          status: "decided",
          documentation_level: documentationLevel,
          description: conv.summary,
        },
        source_refs: candidate.evidence_refs,
        truth_status: "inferred",
        confidence: conv.confidence,
      };
      conventionNodes.push(node);
      phase3Conventions.push({
        convention_name: cleanedConventionName,
        established_by: conv.established_by,
        pattern_rule: conv.pattern_rule,
        constituent_decisions: relatedDecisions,
        documentation_level: documentationLevel,
        confidence: conv.confidence,
        evidence_count: candidate.evidence_refs.length,
        evidence_sources: candidate.evidence_refs.map((ref) => `${ref.source_type}:${ref.title}`).slice(0, 6),
        source_refs: candidate.evidence_refs.slice(0, 6).map((ref) => ({
          source_type: ref.source_type,
          title: ref.title,
          excerpt: ref.excerpt,
        })),
      });
    }
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
