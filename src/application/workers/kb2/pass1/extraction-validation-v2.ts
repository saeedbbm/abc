import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import {
  calculateCostUsd,
  getCrossCheckModel,
  getCrossCheckModelName,
} from "@/lib/ai-model";
import {
  normalizeEntityType,
  projectCandidateReview,
} from "@/src/application/lib/kb2/pass1-v2-artifacts";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const ValidationSchema = z.object({
  decisions: z.array(z.object({
    item_index: z.number().int().positive(),
    candidate_id: z.string().optional(),
    action: z.enum(["keep", "retype", "reject"]),
    final_type: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    reason: z.string(),
  })),
});

const VALIDATION_PROMPT = `You validate candidate entities before canonicalization.

Rules:
- A project must be a real initiative or feature body of work, not a single Jira ticket, PR, bug fix, copy update, or maintenance item.
- Jira issues are tickets unless the evidence clearly points to a broader initiative.
- GitHub pull requests are pull_request entities, not projects.
- Prefer retype over keep when the ontology boundary is wrong.
- Prefer reject over invent when the evidence is weak.
- Decision and process candidates with explicit standards, tradeoffs, or workflow language should be protected from demotion.
- Return item_index exactly as shown for each reviewed candidate.`;

const WRONG_UNIT_PROCESS_RE = /\b(onboarding|runbook|playbook|workflow|guide|checklist|postmortem)\b/i;
const WRONG_UNIT_TICKET_RE = /\b(planning|roadmap|copy|mockups?|review|touch target|fix|bug|cleanup|maintenance|e2e|test|hiring|1:1)\b/i;
const DECISION_TEXT_RE = /\b(decided|decision|prefer|better than|instead of|tradeoff|going with|makes more sense|standardize|suggested|opted|convention)\b/i;
const PROCESS_TEXT_RE = /\b(process|workflow|runbook|playbook|checklist|triage|handoff|manual process|review flow|deployment pipeline|daily|weekly|every \d+)\b/i;
const FEATURE_PROJECT_LABEL_RE = /\b(page|portal|browser|browse|tracking|calendar|chooser|navigation|comparison|feature|volunteer|api|integration|pipeline|responsiveness|standardization|form|orders)\b/i;
const PROJECT_FRAGMENT_LABEL_RE = /\b(card|cards|button|buttons|layout|designs?|endpoint|tests?|cta|nav pr)\b/i;
const PLACEHOLDER_TEAM_MEMBER_RE = /^(message|comment|thread|ticket|doc|page)\s+author\b/i;
const REPOISH_NAME_RE = /(?:^|[-/])(api|web|app|service|repo)\b/i;
const UI_SURFACE_REPOISH_RE = /\b(dashboard|page|portal|browser|form|screen)\b/i;

function collectNodeEvidenceText(node: KB2GraphNodeType): string {
  const attrs = (node.attributes ?? {}) as Record<string, unknown>;
  return [
    node.display_name,
    ...node.aliases,
    String(attrs.summary ?? ""),
    String(attrs.description ?? ""),
    String(attrs._reasoning ?? ""),
    ...((node.source_refs ?? []).flatMap((ref) => [ref.title ?? "", ref.excerpt ?? "", ref.section_heading ?? ""])),
  ]
    .join("\n")
    .toLowerCase();
}

function summarizeNodeSupport(node: KB2GraphNodeType): string {
  const sourceTypes = [...new Set((node.source_refs ?? []).map((ref) => ref.source_type))];
  const firstRef = node.source_refs?.[0];
  return `${node.source_refs?.length ?? 0} source(s) across ${sourceTypes.join(", ") || "unknown"}${firstRef ? `; sample: ${firstRef.title}` : ""}`;
}

function hasProtectedDecisionOrProcessEvidence(node: KB2GraphNodeType): boolean {
  const attrs = (node.attributes ?? {}) as Record<string, unknown>;
  const observationKind = String(attrs._observation_kind ?? "");
  const text = collectNodeEvidenceText(node);
  if (node.type === "decision" || observationKind === "decision_signal" || observationKind === "pattern_signal") {
    return DECISION_TEXT_RE.test(text) || Boolean(attrs.signal_family);
  }
  if (node.type === "process" || observationKind === "process_signal") {
    return PROCESS_TEXT_RE.test(text);
  }
  return false;
}

function getDeterministicProjectDecision(
  node: KB2GraphNodeType,
): { action: "retype" | "reject"; final_type?: string; reason: string } | null {
  const text = collectNodeEvidenceText(node);
  const support = summarizeNodeSupport(node);
  const featureShapedLabel = FEATURE_PROJECT_LABEL_RE.test(node.display_name.toLowerCase());
  const sourceTypes = new Set((node.source_refs ?? []).map((ref) => ref.source_type));
  const processMatch = text.match(WRONG_UNIT_PROCESS_RE);
  if (processMatch && !featureShapedLabel) {
    return {
      action: "retype",
      final_type: "process",
      reason: `Evidence centers on ${processMatch[0]} work in ${support}, which is safer as a process than a standalone project.`,
    };
  }

  const ticketMatch = text.match(WRONG_UNIT_TICKET_RE);
  if (ticketMatch && !featureShapedLabel) {
    return {
      action: "retype",
      final_type: "ticket",
      reason: `Evidence centers on ${ticketMatch[0]} work in ${support}, which looks like a bounded work item rather than a project.`,
    };
  }

  if (
    PROJECT_FRAGMENT_LABEL_RE.test(node.display_name.toLowerCase()) &&
    (node.source_refs?.length ?? 0) <= 1 &&
    sourceTypes.size === 1
  ) {
    return {
      action: "retype",
      final_type: "ticket",
      reason: `Label reads like a feature fragment or implementation task (${node.display_name}) rather than a standalone project (${support}).`,
    };
  }

  const review = projectCandidateReview(node);
  if (!review.keep_as_project && node.confidence === "low" && (node.source_refs?.length ?? 0) <= 1) {
    if (featureShapedLabel) {
      return null;
    }
    return {
      action: "reject",
      reason: `${review.reason} Source support is too thin to keep this as a canonical-bound candidate (${support}).`,
    };
  }

  if (!review.keep_as_project && (review.score <= 1 || (node.source_refs?.length ?? 0) <= 1)) {
    if (featureShapedLabel) {
      return null;
    }
    return {
      action: "retype",
      final_type: review.suggested_type,
      reason: `${review.reason} Source support: ${support}.`,
    };
  }

  return null;
}

function getDeterministicTeamMemberDecision(
  node: KB2GraphNodeType,
): { action: "reject"; reason: string } | null {
  const support = summarizeNodeSupport(node);
  if (PLACEHOLDER_TEAM_MEMBER_RE.test(node.display_name.toLowerCase())) {
    return {
      action: "reject",
      reason: `Label reads like a placeholder author marker (${node.display_name}) rather than a real person (${support}).`,
    };
  }
  return null;
}

function getDeterministicRepositoryDecision(
  node: KB2GraphNodeType,
): { action: "reject"; reason: string } | null {
  const attrs = (node.attributes ?? {}) as Record<string, unknown>;
  const sourceTypes = new Set((node.source_refs ?? []).map((ref) => ref.source_type));
  const support = summarizeNodeSupport(node);
  const text = collectNodeEvidenceText(node);
  const hasExplicitRepoSignal =
    typeof attrs.repo === "string" ||
    REPOISH_NAME_RE.test(node.display_name.toLowerCase()) ||
    /\b(repository|repo|github|gitlab|codebase|service)\b/i.test(text);
  if (
    !hasExplicitRepoSignal &&
    (node.source_refs?.length ?? 0) <= 1 &&
    sourceTypes.size === 1 &&
    sourceTypes.has("slack") &&
    UI_SURFACE_REPOISH_RE.test(node.display_name.toLowerCase())
  ) {
    return {
      action: "reject",
      reason: `Single-source Slack mention looks like a product surface (${node.display_name}) rather than a repository (${support}).`,
    };
  }
  return null;
}

export const extractionValidationStepV2: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-extraction-validation-v2");
  const stepId = "pass1-step-4";
  const tc = getTenantCollections(ctx.companySlug);

  const step3ExecId = await ctx.getStepExecutionId("pass1", 3);
  const sourceNodes = (await tc.graph_nodes_pre_resolution.find(
    step3ExecId ? { execution_id: step3ExecId } : { run_id: ctx.runId },
  ).toArray()) as unknown as KB2GraphNodeType[];
  const step3Artifact = await ctx.getStepArtifact("pass1", 3);

  if (sourceNodes.length === 0) {
    throw new Error("No candidate entities found — run step 3 first");
  }

  await ctx.onProgress(`Validating ${sourceNodes.length} candidate entities...`, 5);

  const validatedNodes: KB2GraphNodeType[] = [];
  const deterministicActions: Array<{
    name: string;
    action: "keep" | "retype" | "reject";
    previous_type?: string;
    final_type?: string;
    reason: string;
    source_count: number;
    source_types: string[];
    observation_kind?: string;
  }> = [];
  const ambiguousNodes: KB2GraphNodeType[] = [];

  for (const sourceNode of sourceNodes) {
    const node: KB2GraphNodeType = {
      ...sourceNode,
      execution_id: ctx.executionId,
      attributes: { ...(sourceNode.attributes ?? {}) },
    };

    const attrs = (node.attributes ?? {}) as Record<string, any>;
    const sourceCount = node.source_refs?.length ?? 0;
    const sourceTypes = new Set(node.source_refs?.map((ref) => ref.source_type));
    const supportSummary = summarizeNodeSupport(node);
    const observationKind = typeof attrs._observation_kind === "string" ? attrs._observation_kind : undefined;

    if (hasProtectedDecisionOrProcessEvidence(node)) {
      node.attributes = {
        ...attrs,
        _validation_status: "validated",
        _validation_reason: `Protected ${node.type} evidence preserved during deterministic validation (${supportSummary}).`,
      };
      validatedNodes.push(node);
      deterministicActions.push({
        name: node.display_name,
        action: "keep",
        reason: `Protected ${node.type} evidence preserved during deterministic validation (${supportSummary}).`,
        source_count: sourceCount,
        source_types: [...sourceTypes],
        observation_kind: observationKind,
      });
      continue;
    }

    if (node.type === "team_member") {
      const teamMemberDecision = getDeterministicTeamMemberDecision(node);
      if (teamMemberDecision) {
        deterministicActions.push({
          name: node.display_name,
          action: "reject",
          reason: teamMemberDecision.reason,
          source_count: sourceCount,
          source_types: [...sourceTypes],
          observation_kind: observationKind,
        });
        continue;
      }
    }

    if (node.type === "repository") {
      const repositoryDecision = getDeterministicRepositoryDecision(node);
      if (repositoryDecision) {
        deterministicActions.push({
          name: node.display_name,
          action: "reject",
          reason: repositoryDecision.reason,
          source_count: sourceCount,
          source_types: [...sourceTypes],
          observation_kind: observationKind,
        });
        continue;
      }
    }

    if (node.type === "project") {
      const deterministicProjectDecision = getDeterministicProjectDecision(node);
      if (deterministicProjectDecision) {
        if (deterministicProjectDecision.action === "reject") {
          deterministicActions.push({
            name: node.display_name,
            action: "reject",
            reason: deterministicProjectDecision.reason,
            source_count: sourceCount,
            source_types: [...sourceTypes],
            observation_kind: observationKind,
          });
          continue;
        }

        node.type = normalizeEntityType(deterministicProjectDecision.final_type ?? "ticket");
        node.attributes = {
          ...attrs,
          _validation_status: "retyped",
          _validation_reason: deterministicProjectDecision.reason,
        };
        validatedNodes.push(node);
        deterministicActions.push({
          name: node.display_name,
          action: "retype",
          previous_type: sourceNode.type,
          final_type: node.type,
          reason: deterministicProjectDecision.reason,
          source_count: sourceCount,
          source_types: [...sourceTypes],
          observation_kind: observationKind,
        });
        continue;
      }

      const review = projectCandidateReview(node);
      if (!review.keep_as_project) {
        if (FEATURE_PROJECT_LABEL_RE.test(node.display_name.toLowerCase())) {
          node.attributes = {
            ...attrs,
            _validation_status: "validated",
            _validation_reason: `Feature-shaped project candidate preserved with low-evidence caution (${supportSummary}).`,
            _needs_corroboration: true,
          };
          validatedNodes.push(node);
          deterministicActions.push({
            name: node.display_name,
            action: "keep",
            reason: `Feature-shaped project candidate preserved with low-evidence caution (${supportSummary}).`,
            source_count: sourceCount,
            source_types: [...sourceTypes],
            observation_kind: observationKind,
          });
          continue;
        }
        ambiguousNodes.push(node);
        continue;
      }
    }

    if (
      node.confidence === "low" &&
      sourceCount === 1 &&
      sourceTypes.size === 1 &&
      attrs._candidate_origin !== "deterministic-jira" &&
      attrs._candidate_origin !== "deterministic-github"
    ) {
      deterministicActions.push({
        name: node.display_name,
        action: "reject",
        reason: `Single weak source unit with no strong canonical evidence (${supportSummary}).`,
        source_count: sourceCount,
        source_types: [...sourceTypes],
        observation_kind: observationKind,
      });
      continue;
    }

    node.attributes = {
      ...attrs,
      _validation_status: "validated",
      _validation_reason: `Passed deterministic validation with ${supportSummary}.`,
    };
    validatedNodes.push(node);
    deterministicActions.push({
      name: node.display_name,
      action: "keep",
      reason: `Passed deterministic validation with ${supportSummary}.`,
      source_count: sourceCount,
      source_types: [...sourceTypes],
      observation_kind: observationKind,
    });
  }

  let llmCalls = 0;
  if (ambiguousNodes.length > 0) {
    await ctx.onProgress(`Cross-checking ${ambiguousNodes.length} ambiguous candidates...`, 35);
    const model = getCrossCheckModel(ctx.config?.pipeline_settings?.models);
    const modelName = getCrossCheckModelName(ctx.config?.pipeline_settings?.models);
    const batchSize = 12;

    for (let i = 0; i < ambiguousNodes.length; i += batchSize) {
      const batch = ambiguousNodes.slice(i, i + batchSize);
      const prompt = batch.map((node, index) => {
        const attrs = (node.attributes ?? {}) as Record<string, unknown>;
        const evidence = node.source_refs
          .slice(0, 3)
          .map((ref) => `[${ref.source_type}] ${ref.title}: ${ref.excerpt}`)
          .join("\n")
          .slice(0, 2400);
        return `${index + 1}. [candidate_id=${node.node_id}] "${node.display_name}" [${node.type}] confidence=${node.confidence} observation_kind=${String(attrs._observation_kind ?? "unknown")} sources=${node.source_refs.length}\n${evidence}`;
      }).join("\n\n---\n\n");

      const startMs = Date.now();
      let usageData: { promptTokens: number; completionTokens: number } | null = null;
      const result = await structuredGenerate({
        model,
        system: ctx.config?.prompts?.extraction_validation?.system_judge ?? VALIDATION_PROMPT,
        prompt,
        schema: ValidationSchema,
        logger,
        onUsage: (usage) => { usageData = usage; },
        signal: ctx.signal,
      });
      llmCalls++;

      if (usageData) {
        const cost = calculateCostUsd(modelName, usageData.promptTokens, usageData.completionTokens);
        await ctx.logLLMCall(
          stepId,
          modelName,
          prompt.slice(0, 10000),
          JSON.stringify(result, null, 2).slice(0, 10000),
          usageData.promptTokens,
          usageData.completionTokens,
          cost,
          Date.now() - startMs,
        );
      }

      const decisionsByIndex = new Map(
        (result.decisions ?? []).map((decision) => [decision.item_index, decision]),
      );
      const decisionsById = new Map(
        (result.decisions ?? [])
          .filter((decision) => typeof decision.candidate_id === "string" && decision.candidate_id.length > 0)
          .map((decision) => [decision.candidate_id!, decision]),
      );

      for (const [batchIndex, node] of batch.entries()) {
        const decision = decisionsByIndex.get(batchIndex + 1) ?? decisionsById.get(node.node_id);
        if (!decision) continue;
        const sourceTypes = [...new Set((node.source_refs ?? []).map((ref) => ref.source_type))];
        const observationKind = typeof node.attributes?._observation_kind === "string"
          ? node.attributes._observation_kind as string
          : undefined;
        let finalAction = decision.action;
        let finalType = decision.final_type;
        let finalReason = decision.reason;

        if (
          finalAction === "reject" &&
          node.type === "project" &&
          FEATURE_PROJECT_LABEL_RE.test(node.display_name.toLowerCase())
        ) {
          finalAction = "keep";
          finalType = undefined;
          finalReason = `Feature-shaped project candidate preserved after LLM review because the label still describes a plausible product surface (${summarizeNodeSupport(node)}).`;
          node.attributes = {
            ...(node.attributes ?? {}),
            _needs_corroboration: true,
          };
        }

        deterministicActions.push({
          name: node.display_name,
          action: finalAction,
          previous_type: finalAction === "retype" ? node.type : undefined,
          final_type: finalType,
          reason: finalReason,
          source_count: node.source_refs?.length ?? 0,
          source_types: sourceTypes,
          observation_kind: observationKind,
        });

        if (finalAction === "reject") continue;

        node.type = finalAction === "retype" && finalType
          ? normalizeEntityType(finalType)
          : node.type;
        node.confidence = decision.confidence;
        node.attributes = {
          ...(node.attributes ?? {}),
          _validation_status: finalAction === "retype" ? "retyped" : "validated",
          _validation_reason: finalReason,
        };
        validatedNodes.push(node);
      }
    }
  }

  if (validatedNodes.length > 0) {
    await tc.graph_nodes.insertMany(validatedNodes as any[]);
  }

  const retyped = deterministicActions.filter((action) => action.action === "retype");
  const rejected = deterministicActions.filter((action) => action.action === "reject");
  const byType = validatedNodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.type] = (acc[node.type] || 0) + 1;
    return acc;
  }, {});

  await ctx.onProgress(`Validation complete: ${validatedNodes.length} entities remain`, 100);

  return {
    original_count: sourceNodes.length,
    final_count: validatedNodes.length,
    llm_calls: llmCalls,
    opus_confirmed: deterministicActions.filter((action) => action.action === "keep").length,
    opus_rejected: rejected.length,
    retyped_count: retyped.length,
    entities_by_type: byType,
    recovery_details: {
      deterministic_actions: deterministicActions,
      ambiguous_reviewed: ambiguousNodes.length,
      kept: deterministicActions
        .filter((action) => action.action === "keep")
        .slice(0, 20)
        .map((action) => ({
          name: action.name,
          reason: action.reason,
          source_count: action.source_count,
          source_types: action.source_types,
          observation_kind: action.observation_kind,
        })),
      rejected: rejected.map((action) => ({
        name: action.name,
        reason: action.reason,
        source_count: action.source_count,
        source_types: action.source_types,
        observation_kind: action.observation_kind,
      })),
      retyped: retyped.map((action) => ({
        name: action.name,
        previous_type: action.previous_type,
        final_type: action.final_type,
        reason: action.reason,
        source_count: action.source_count,
        source_types: action.source_types,
        observation_kind: action.observation_kind,
      })),
    },
    validation_log: deterministicActions.map((action) => ({
      ...action,
    })),
    upstream_suppressed_candidates: step3Artifact?.suppressed_candidate_samples ?? [],
    upstream_observation_only_counts_by_type: step3Artifact?.observation_only_counts_by_type ?? {},
    project_demotions: deterministicActions
      .filter((action) => action.action !== "keep" && action.previous_type === "project")
      .map((action) => ({
        name: action.name,
        action: action.action,
        final_type: action.final_type,
        reason: action.reason,
        source_count: action.source_count,
        source_types: action.source_types,
      })),
    retyped_entities: retyped.map((action) => ({
      name: action.name,
      previous_type: action.previous_type,
      final_type: action.final_type,
      reason: action.reason,
    })),
    artifact_version: "pass1_v2",
  };
};
