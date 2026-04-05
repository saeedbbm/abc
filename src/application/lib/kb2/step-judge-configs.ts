import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { getTenantCollections } from "@/lib/mongodb";
import { getCompanyConfig } from "@/src/application/lib/kb2/company-config";
import { getFastModel, getFastModelName, getCrossCheckModel, getCrossCheckModelName } from "@/lib/ai-model";
import { runLLMJudge, buildDeterministicJudge, mergeJudgeResults } from "@/src/application/lib/kb2/step-judge";
import type { JudgeResult, DeterministicCheck } from "@/src/application/lib/kb2/step-judge";

interface StepJudgeConfig {
  systemPrompt: string;
  buildUserPrompt: (artifact: Record<string, unknown>) => string;
  deterministicChecks?: (artifact: Record<string, unknown>) => DeterministicCheck[];
}

const STEP_JUDGE_CONFIGS: Record<string, StepJudgeConfig> = {
  "Input Snapshot": {
    systemPrompt: `You are evaluating source normalization quality for a knowledge base pipeline. Assess source fidelity, unit preservation, and traceability. Return sub_scores for "Source fidelity" (0-100), "Unit preservation" (0-100), "Traceability" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const bySource = ((a.by_provider ?? a.by_source) as Record<string, number> | undefined);
      const providers = bySource
        ? Object.entries(bySource).map(([k, v]) => `${k}: ${v}`).join(", ")
        : "unknown";
      return `Input snapshot v${a.artifact_version ?? "?"}: ${a.total_documents ?? "?"} documents from providers: ${providers}. Source units by source: ${JSON.stringify(a.source_units_by_source ?? {})}. Raw stats: ${JSON.stringify(a.raw_stats ?? {}).slice(0, 800)}`;
    },
    deterministicChecks: (a) => {
      const bySource = ((a.by_provider ?? a.by_source) as Record<string, number> | undefined);
      const providers = bySource ? Object.keys(bySource) : [];
      return [
        { name: "Document count", actual: Number(a.total_documents ?? 0), target: 10, mode: "gte" as const },
        { name: "Source diversity", actual: providers.length, target: 3, mode: "gte" as const },
        { name: "Source units present", actual: Number(Object.values((a.source_units_by_source as Record<string, number> | undefined) ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0)), target: 1, mode: "gte" as const },
      ];
    },
  },
  "Embed Documents": {
    systemPrompt: `You are evaluating evidence-span embedding quality. Assess chunk boundary quality, source-unit coverage, and traceability. Return sub_scores for "Chunk boundary quality" (0-100), "Source-unit coverage" (0-100), "Traceability" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      return `Embedded ${a.total_evidence_spans ?? a.total_chunks ?? "?"} evidence spans from ${a.total_documents ?? a.total_docs ?? "?"} documents and ${a.total_source_units ?? "?"} source units. Chunk size: ${a.chunk_size ?? "?"}, overlap: ${a.chunk_overlap ?? "?"}. By provider: ${JSON.stringify(a.by_provider ?? {})}. By unit kind: ${JSON.stringify(a.by_unit_kind ?? {})}.`;
    },
    deterministicChecks: (a) => [
      { name: "Chunks generated", actual: Number(a.total_chunks ?? 0), target: 50, mode: "gte" as const },
      { name: "Documents processed", actual: Number(a.total_documents ?? a.total_docs ?? 0), target: 10, mode: "gte" as const },
      { name: "Source units processed", actual: Number(a.total_source_units ?? 0), target: 10, mode: "gte" as const },
    ],
  },
  "Entity Extraction": {
    systemPrompt: `You are evaluating candidate extraction quality. Assess observation quality, candidate recall, and provenance richness.

Important evaluation rules:
- This is a high-recall candidate stage, not final canonical truth. Candidate project counts may exceed ground truth as long as the candidates remain evidence-backed and later steps can safely demote, merge, or reject them.
- Do not block this step solely because some section-level or implementation-fragment candidates are present; block only when the step hardens wrong ontology so aggressively that later cleanup would be implausible.
- If the prompt shows only sampled entity titles or truncated examples, do not infer that a benchmark item is absent from the run. Missing-from-sample is not the same as missing-from-artifact.
- A section-scoped label such as "Future Considerations" may remain as a candidate work item when it carries explicit provenance; that is acceptable here so long as later steps can distinguish planning context from canonical project truth.
- Partial multi-source aggregation is acceptable here if the source refs are still meaningful enough for later matching and attribution.
- Pattern and convention evidence at this stage may appear as decision_signal or pattern_signal observations rather than explicit convention entities; do not require a final convention node type yet.
- Customer feedback may remain as customer_feedback entities plus feedback observations at Step 3. Do not require the step to already cluster multiple submissions into one proposed feature node if the raw feedback evidence is present for downstream discovery.
- Benchmark-critical toy-related feedback may remain as multiple customer_feedback entities or feedback observations. Do not require a single "Toy Donation Feature" node yet if the toy-donation evidence is clearly present for downstream discovery.
- Use owner-attribution counts and signal summaries together. Do not conclude that Kim/Tim/Matt evidence is missing solely because a tiny sample happens to show different names.

Return sub_scores for "Observation quality" (0-100), "Candidate recall" (0-100), "Provenance richness" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const byType = a.entities_by_type as Record<string, unknown[]> | undefined;
      const typeSummary = byType ? Object.entries(byType).map(([k, v]) => `${k}: ${v.length}`).join(", ") : "unknown";
      const samples = Array.isArray(a.entity_samples) ? a.entity_samples as Array<Record<string, unknown>> : [];
      const sampleText = samples.slice(0, 6).map((sample) =>
        `"${String(sample.display_name ?? "")}" [${String(sample.type ?? "")}] ${String(sample.confidence ?? "")} refs=${Array.isArray(sample.source_refs) ? sample.source_refs.length : 0}`,
      ).join("; ");
      const signalSamples = a.signal_samples_by_kind as Record<string, Array<Record<string, unknown>>> | undefined;
      const signalOwnerCounts = a.signal_owner_counts_by_kind as Record<string, Array<Record<string, unknown>>> | undefined;
      const signalSummary = signalSamples
        ? Object.entries(signalSamples)
          .map(([kind, entries]) => {
            const prioritizedEntries = [...(entries ?? [])].sort((left, right) => {
              const score = (entry: Record<string, unknown>): number => {
                const ref = (entry.source_ref ?? {}) as Record<string, unknown>;
                let value = 0;
                if (String(ref.slack_speaker ?? "").trim()) value += 20;
                if (String(ref.comment_author ?? "").trim()) value += 12;
                if (String(ref.pr_author ?? "").trim()) value += 10;
                if (String(ref.source_type ?? "").trim().toLowerCase() === "slack") value += 5;
                return value;
              };
              return score(right) - score(left);
            });
            return `${kind}: ${prioritizedEntries.slice(0, 2).map((entry) => {
              const ref = (entry.source_ref ?? {}) as Record<string, unknown>;
              const speaker = String(ref.slack_speaker ?? ref.comment_author ?? ref.pr_author ?? ref.source_author ?? "").trim();
              return `${String(entry.label ?? "")}${speaker ? ` @${speaker}` : ""}`;
            }).join(" | ") || "(none)"}`;
          })
          .join("; ")
        : "(none)";
      const signalOwnerSummary = signalOwnerCounts
        ? Object.entries(signalOwnerCounts)
          .map(([kind, entries]) => {
            const summary = (entries ?? [])
              .map((entry) => `${String(entry.owner ?? "unknown")}:${String(entry.count ?? "?")}`)
              .join(", ");
            return `${kind}: ${summary || "(none)"}`;
          })
          .join("; ")
        : "(none)";
      const feedbackEntries = byType?.customer_feedback
        ? (byType.customer_feedback as Array<Record<string, unknown>>)
        : [];
      const feedbackSamples = feedbackEntries
        .slice(0, 6)
        .map((entry) => String(entry.display_name ?? ""))
        .join(", ") || "(none)";
      const toyFeedbackSamples = feedbackEntries
        .filter((entry) => {
          const haystack = `${String(entry.display_name ?? "")} ${JSON.stringify(entry.source_refs ?? [])}`.toLowerCase();
          return haystack.includes("toy") || haystack.includes("toys") || haystack.includes("donat");
        })
        .slice(0, 6)
        .map((entry) => String(entry.display_name ?? ""))
        .join(", ") || "(none)";
      return `Extracted ${a.total_observations ?? "?"} observations and ${a.total_entities ?? "?"} candidate entities. By type: ${typeSummary}. Observation kinds: ${JSON.stringify(a.observations_by_kind ?? {})}. Signal samples with attribution: ${signalSummary}. Signal owner counts: ${signalOwnerSummary}. Toy-related feedback signals: ${toyFeedbackSamples}. Customer feedback entities: ${feedbackSamples}. Samples: ${sampleText || "(none)"}. LLM calls: ${a.llm_calls ?? "?"}`;
    },
    deterministicChecks: (a) => {
      const byType = a.entities_by_type as Record<string, unknown[]> | undefined;
      return [
        { name: "Observation count", actual: Number(a.total_observations ?? 0), target: 1, mode: "gte" as const },
        { name: "Candidate count", actual: Number(a.total_entities ?? 0), target: 1, mode: "gte" as const },
        { name: "Type diversity", actual: byType ? Object.keys(byType).length : 0, target: 5, mode: "gte" as const },
      ];
    },
  },
  "Extraction Validation": {
    systemPrompt: `You are evaluating candidate validation quality. Assess wrong-unit demotion, retyping accuracy, and filtering quality.

Important evaluation rule: if a benchmark-known non-project item (for example roadmap planning, copy updates, onboarding docs, maintenance, or postmortems) is already preserved as a ticket/process/non-project type rather than a project, treat that as success. Do not require an extra demotion just because the item still exists in the validated set under the correct ontology.

This step is still operating on candidate-stage inputs before canonical resolution. Do not block solely because the retype count is small or the pass-through rate is high if the surviving candidates carry explicit validation reasons and later steps can still merge or demote them safely.

Do not require Kim/Tim/Matt hidden conventions to appear as explicit validated entities here; preserving the underlying decision and pattern signals is sufficient at Step 4.

Reserve "no-go" for clear wrong-unit project candidates that survive without meaningful caution/reasoning, or for missing validation audit trails that later steps cannot repair.

Return sub_scores for "Demotion quality" (0-100), "Retyping accuracy" (0-100), "Filtering quality" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const retyped = Array.isArray(a.retyped_entities) ? a.retyped_entities as Array<Record<string, unknown>> : [];
      const rejected = ((a.recovery_details as Record<string, unknown> | undefined)?.rejected ?? []) as Array<Record<string, unknown>>;
      const upstreamSuppressed = Array.isArray(a.upstream_suppressed_candidates) ? a.upstream_suppressed_candidates as Array<Record<string, unknown>> : [];
      const validationLog = Array.isArray(a.validation_log) ? a.validation_log as Array<Record<string, unknown>> : [];
      const benchmarkNonProjectNames = [
        "about page copy",
        "roadmap planning",
        "onboarding",
        "postmortem",
        "dependency updates",
        "maintenance",
      ];
      const preservedNonProjects = validationLog
        .filter((entry) => {
          const name = String(entry.name ?? "").toLowerCase();
          const reason = String(entry.reason ?? "").toLowerCase();
          return benchmarkNonProjectNames.some((needle) => name.includes(needle) || reason.includes(needle));
        })
        .slice(0, 10);
      return `Validated ${a.original_count ?? "?"} candidates → ${a.final_count ?? "?"} validated entities. Rejected: ${a.opus_rejected ?? "?"}, retyped: ${a.retyped_count ?? "?"}. Retyped sample: ${JSON.stringify(retyped.slice(0, 6)).slice(0, 1500)}. Rejected sample: ${JSON.stringify(rejected.slice(0, 6)).slice(0, 1500)}. Validation log sample: ${JSON.stringify(validationLog.slice(0, 12)).slice(0, 2200)}. Benchmark non-project items already preserved under non-project ontology: ${JSON.stringify(preservedNonProjects).slice(0, 1200)}. Upstream observation-only suppressions: ${JSON.stringify(upstreamSuppressed.slice(0, 6)).slice(0, 1500)}`;
    },
  },
  "Entity Resolution": {
    systemPrompt: `You are evaluating entity resolution (deduplication) quality. Assess: merge accuracy, false merge avoidance, coverage.

Important evaluation rule: do not penalize the step for keeping cross-type references (for example project<->ticket, project<->pull_request, project<->decision, or project<->process) as link_relationships instead of merges. Coverage should focus on same-type duplicate consolidation and human-readable canonical naming.

Use the resolved title lists when deciding whether a critical entity is present or still fragmented. Do not infer absence from the small merge sample alone.

Return sub_scores for "Merge accuracy" (0-100), "Coverage" (0-100), "False merge avoidance" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const merges = Array.isArray(a.merges) ? a.merges as Array<Record<string, unknown>> : [];
      const keptSeparate = Array.isArray(a.kept_separate) ? a.kept_separate as Array<Record<string, unknown>> : [];
      const links = Array.isArray(a.link_relationships) ? a.link_relationships as Array<Record<string, unknown>> : [];
      const familyReviews = Array.isArray(a.project_family_reviews) ? a.project_family_reviews as Array<Record<string, unknown>> : [];
      return `Resolved ${a.total_entities_before ?? "?"} → ${a.total_entities_after ?? "?"} entities. ${a.merges_performed ?? "?"} merges from ${a.candidates_found ?? "?"} same-type merge candidates. Identity merge summary: ${JSON.stringify(a.identity_merges ?? {}).slice(0, 800)}. Resolved repository titles: ${JSON.stringify(a.resolved_repository_titles ?? []).slice(0, 500)}. Resolved project titles: ${JSON.stringify(a.resolved_project_titles ?? []).slice(0, 1400)}. Resolved team-member titles: ${JSON.stringify(a.resolved_team_member_titles ?? []).slice(0, 400)}. Merge sample: ${JSON.stringify(merges.slice(0, 6)).slice(0, 1400)}. Kept-separate sample: ${JSON.stringify(keptSeparate.slice(0, 6)).slice(0, 1200)}. Link-only cross-type references: ${JSON.stringify(links.slice(0, 10)).slice(0, 1200)}. Project family review sample: ${JSON.stringify(familyReviews.slice(0, 10)).slice(0, 1200)}`;
    },
  },
  "Graph Build": {
    systemPrompt: `You are evaluating explicit graph construction. Assess edge validity, source grounding, and over-inference avoidance. Return sub_scores for "Precision" (0-100), "Source grounding" (0-100), "Over-inference avoidance" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      return `Built graph: ${a.total_edges ?? "?"} explicit/source-derived edges. zero_co_occurrence_semantic_edges=${String(a.zero_co_occurrence_semantic_edges ?? false)}. Edge examples: ${JSON.stringify(a.edge_examples ?? []).slice(0, 1200)}`;
    },
    deterministicChecks: (a) => [
      { name: "Edges created", actual: Number(a.total_edges ?? 0), target: 5, mode: "gte" as const },
      { name: "No co-occurrence semantic edges", actual: a.zero_co_occurrence_semantic_edges ? 1 : 0, target: 1, mode: "eq" as const },
    ],
  },
  "Graph Enrichment": {
    systemPrompt: `You are evaluating repeated-pattern mining quality. Assess whether the step finds meaningful evidence packs without adding graph noise. Return sub_scores for "Pattern evidence quality" (0-100), "Repeat detection" (0-100), "Noise avoidance" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const candidates = Array.isArray(a.pattern_candidates) ? a.pattern_candidates as Array<Record<string, unknown>> : [];
      const sample = candidates
        .slice(0, 6)
        .map((candidate) => {
          const refs = Array.isArray(candidate.evidence_refs) ? candidate.evidence_refs as Array<Record<string, unknown>> : [];
          return `"${String(candidate.title ?? "")}" @${String(candidate.owner_hint ?? "unknown")} refs=${refs.length} rule=${String(candidate.pattern_rule ?? "").slice(0, 140)}`;
        })
        .join("; ");
      return `Pattern mining reviewed ${a.total_nodes ?? "?"} observations and produced ${candidates.length} pattern candidates. Candidate summary: ${sample || "(none)"}. Raw evidence pack sample: ${JSON.stringify(candidates.slice(0, 3)).slice(0, 2200)}`;
    },
    deterministicChecks: (a) => {
      return [
        { name: "Pattern candidates found", actual: Array.isArray(a.pattern_candidates) ? a.pattern_candidates.length : 0, target: 1, mode: "gte" as const },
        { name: "No graph edges added", actual: Number(a.new_edges ?? 0), target: 0, mode: "eq" as const },
      ];
    },
  },
  "Project & Ticket Discovery": {
    systemPrompt: `You are evaluating a discovery step that finds undocumented work items, past activities, and proposed tickets from conversations and source data. Assess: discovery coverage across categories, description quality, and confidence distribution.

Before saying a benchmark item is missing, check the full discovery title list as well as the sampled descriptions. Do not infer absence from the first sample page alone.

Treat obvious surface-label variants that differ only by generic suffixes like "page", "feature", "browser", or narrow scope qualifiers as likely equivalents unless the artifact clearly separates them semantically.

Important evaluation rule: if the suppression log marks an item as "already_canonical", that means an earlier step already produced a same-type canonical entity for that work item. Do not count those as missed discoveries unless the artifact gives affirmative evidence that the canonical entity was not actually produced.

Reserve "no-go" for material discovery failures: missing benchmark-critical items, invalid Jira-only project promotion, or clearly wrong suppression. A weaker description on a secondary discovery can be an issue or recommendation without blocking the step if benchmark-critical coverage is otherwise intact.

Return sub_scores for "Discovery coverage" (0-100), "Description quality" (0-100), "Confidence calibration" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const discoveries = Array.isArray(a.discoveries)
        ? a.discoveries as Array<{
            display_name: string;
            type: string;
            category: string;
            confidence: string;
            description: string;
            related_entities?: string[];
            source_count?: number;
          }>
        : [];
      const byCategory = a.by_category as Record<string, number> | undefined;
      const suppressionLog = Array.isArray(a.suppression_log)
        ? a.suppression_log as Array<{ label: string; reason: string; stage: string }>
        : [];
      const catSummary = byCategory ? Object.entries(byCategory).map(([k, v]) => `${k}: ${v}`).join(", ") : "unknown";
      const confCounts: Record<string, number> = {};
      for (const d of discoveries) confCounts[d.confidence] = (confCounts[d.confidence] || 0) + 1;
      const confSummary = Object.entries(confCounts).map(([k, v]) => `${k}: ${v}`).join(", ");
      const allTitles = discoveries.map((d) => `[${d.category}] ${d.display_name}`).join("; ");
      const suppressionCountsByReason = suppressionLog.reduce<Record<string, number>>((acc, item) => {
        acc[item.reason] = (acc[item.reason] || 0) + 1;
        return acc;
      }, {});
      const alreadyCanonical = suppressionLog
        .filter((item) => item.reason === "already_canonical")
        .map((item) => item.label);
      const sample = discoveries.slice(0, 10).map((d) =>
        `  [${d.category}] "${d.display_name}" (${d.confidence}, ${d.source_count ?? "?"} sources) — ${d.description.slice(0, 420)} | related: ${(d.related_entities ?? []).join(", ") || "(none)"} | source docs: ${((d as any).source_documents ?? []).join(", ") || "(none)"}`
      ).join("\n");
      const suppressionSummary = suppressionLog
        .filter((item) => item.reason !== "already_canonical")
        .slice(0, 12)
        .map((item) => `  [${item.stage}] "${item.label}" -> ${item.reason}`)
        .join("\n");
      return `Discovery found ${a.total_discoveries ?? "?"} items using ${a.llm_calls ?? "?"} LLM calls.

Categories: ${catSummary}
Confidence distribution: ${confSummary}
Zero Jira-only project promotions: ${a.zero_jira_auto_project_promotions ? "yes" : "no"}
All discovery titles: ${allTitles.slice(0, 3200)}
Suppression counts by reason: ${JSON.stringify(suppressionCountsByReason)}
Already-canonical labels (${alreadyCanonical.length}): ${alreadyCanonical.join("; ").slice(0, 3200)}
Suppression note: "already_canonical" means the same-type canonical entity already existed before Step 8.

Sample discoveries (${Math.min(10, discoveries.length)} of ${discoveries.length}):
${sample}

Other suppressed candidates (${Math.min(12, Math.max(0, suppressionLog.length - alreadyCanonical.length))} sampled, ${suppressionLog.length} total):
${suppressionSummary || "(none beyond already_canonical)"}`;
    },
    deterministicChecks: (a) => {
      const byCategory = a.by_category as Record<string, number> | undefined;
      return [
        { name: "Discovery count", actual: Number(a.total_discoveries ?? 0), target: 1, mode: "gte" as const },
        { name: "Category diversity", actual: byCategory ? Object.keys(byCategory).length : 0, target: 2, mode: "gte" as const },
        { name: "No Jira-only project promotions", actual: a.zero_jira_auto_project_promotions ? 1 : 0, target: 1, mode: "eq" as const },
      ];
    },
  },
  "Attribute Completion": {
    systemPrompt: `You are evaluating an attribute completion step. This step fills missing entity attributes across a knowledge graph. It works in phases:
1. Promote existing _description → description (deterministic)
2. Generate descriptions via LLM for entities that had NO description at all
3. Fill documentation_level based on source types (deterministic)
4. Infer status via LLM ONLY for project/process nodes missing valid status
5. Fix decided_by/rationale/scope on decision nodes via LLM
6. Uniform fill: ensure all nodes of same type have same attribute keys (sets missing to null for schema consistency)

IMPORTANT evaluation guidelines:
- If "statuses_needed" is 0, that means ALL project/process nodes already had valid statuses from earlier steps — this is GOOD, not bad. Do NOT penalize for 0 statuses filled when 0 were needed.
- If "statuses_corrected" is 0, do NOT assume failure by itself. Zero explicit status corrections is acceptable when inherited non-null statuses already agree with Jira/PR evidence and the step mainly needed to fill blanks.
- If "decided_by_corrected" is 0, do NOT assume failure by itself. Zero explicit decided_by corrections is acceptable when the step validated existing ownership or mainly filled blanks, as long as overall decided_by coverage is strong and there is no visible implementer-vs-decision-maker drift.
- "uniform_fills" is structural consistency (filling null for missing keys). A high number is normal and expected.
- LLM calls should be proportional to entities actually needing inference, not total entities.
- Focus on: description coverage (what % of entities now have descriptions), status completeness, and decision attribute completeness.
- Do NOT require benchmark conventions like Kim/Tim/Matt to already exist here; convention synthesis happens later. Judge this step on how well it completes attributes for the decision nodes that actually enter Step 9.

Return sub_scores for "Description coverage" (0-100), "Status completeness" (0-100), "Decision attributes" (0-100), "Documentation level coverage" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const total = Number(a.total_entities_processed ?? 0);
      const descPromoted = Number(a.descriptions_promoted ?? 0);
      const descGenerated = Number(a.descriptions_generated ?? 0);
      const descMissingBefore = Number(a.descriptions_missing_before ?? 0);
      const descMissingAfter = Number(a.descriptions_missing_after ?? 0);
      const descWithDesc = total - descMissingAfter;
      const descPct = total > 0 ? Math.round((descWithDesc / total) * 100) : 0;

      const totalPP = Number(a.total_project_process_nodes ?? 0);
      const statusNeeded = Number(a.statuses_needed ?? 0);
      const statusAlready = Number(a.statuses_already_valid ?? 0);
      const statusFilled = Number(a.statuses_filled ?? 0);
      const statusCorrected = Number(a.statuses_corrected ?? 0);
      const statusComplete = statusAlready + statusFilled + statusCorrected;
      const statusPct = totalPP > 0 ? Math.round((statusComplete / totalPP) * 100) : 100;

      const totalDec = Number(a.total_decisions ?? 0);
      const decNeeding = Number(a.decisions_needing_fix ?? 0);
      const decFixed =
        Number(a.decided_by_fixed ?? 0) +
        Number(a.decided_by_corrected ?? 0) +
        Number(a.rationales_filled ?? 0);
      const decWithDecidedBy = Number(a.decisions_with_decided_by_after ?? 0);

      return `Processed ${total} entities.

DESCRIPTIONS:
- ${descPromoted} promoted from _description → description
- ${descGenerated} generated via LLM (were completely missing)
- ${descMissingBefore} had no description before this step
- ${descMissingAfter} still have no description after
- ${descPct}% of entities now have a description

STATUS (project/process nodes only):
- ${totalPP} project/process nodes total
- ${statusAlready} already had valid status from earlier steps
- ${statusNeeded} needed status inference
- ${statusFilled} statuses filled by LLM
- ${statusCorrected} statuses corrected from invalid/wrong values
- ${statusPct}% now have valid status

DECISIONS:
- ${totalDec} decision nodes total
- Hidden conventions are synthesized later in Step 10; evaluate only the decision nodes entering this step
- ${decNeeding} needed attribute fixes (decided_by/rationale/scope)
- ${decFixed} attributes fixed via LLM
- ${decWithDecidedBy} decisions end this step with decided_by set
- ${a.cross_check_targets ?? 0} decisions were cross-checked for attribution disagreements
- ${a.adjudication_count ?? 0} adjudications were needed

OTHER:
- ${a.doc_levels_filled ?? 0} documentation levels filled
- ${a.uniform_fills ?? 0} uniform attribute fills (structural consistency)
- ${a.llm_calls ?? 0} LLM calls used`;
    },
    deterministicChecks: (a) => {
      const total = Number(a.total_entities_processed ?? 0);
      const descMissingAfter = Number(a.descriptions_missing_after ?? 0);
      const descCoverage = total > 0 ? Math.round(((total - descMissingAfter) / total) * 100) : 100;

      const totalPP = Number(a.total_project_process_nodes ?? 0);
      const statusAlready = Number(a.statuses_already_valid ?? 0);
      const statusFilled = Number(a.statuses_filled ?? 0);
      const statusCorrected = Number(a.statuses_corrected ?? 0);
      const statusPct = totalPP > 0 ? Math.round(((statusAlready + statusFilled + statusCorrected) / totalPP) * 100) : 100;

      return [
        { name: "Description coverage", actual: descCoverage, target: 85, mode: "gte" as const },
        { name: "Status completeness", actual: statusPct, target: 90, mode: "gte" as const },
        { name: "Doc level fills", actual: Number(a.doc_levels_filled ?? 0), target: 1, mode: "gte" as const },
      ];
    },
  },
  "Pattern Synthesis": {
    systemPrompt: `You are evaluating a pattern synthesis step that identifies CROSS-CUTTING CONVENTIONS from repeated evidence packs plus supporting canonical entities. A convention is a recurring pattern, not necessarily a fixed number of pre-existing decision nodes.

IMPORTANT evaluation guidelines:
- A convention should have repeated evidence across multiple source units or documents.
- Quality over quantity: a small number of well-grounded conventions is acceptable.
- Evaluate the ACTUAL conventions provided: Are they real patterns? Are the constituent decisions genuine instances of the pattern?
- Do NOT penalize for low convention count alone if the conventions found are high-quality and well-evidenced.

Return sub_scores for "Pattern quality" (0-100), "Evidence grounding" (0-100), "Actionability" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const conventions = Array.isArray(a.phase3_conventions)
        ? a.phase3_conventions as Array<{
            convention_name: string;
            established_by: string;
            constituent_decisions: string[];
            confidence: string;
            documentation_level?: string;
            evidence_count?: number;
            evidence_sources?: string[];
          }>
        : Array.isArray(a.conventions)
          ? a.conventions as Array<{
              convention_name: string;
              established_by: string;
              constituent_decisions: string[];
              confidence: string;
              documentation_level?: string;
              evidence_count?: number;
              evidence_sources?: string[];
            }>
          : [];
      const convDetails = conventions.map((c, i) =>
        `${i + 1}. "${c.convention_name}" (by ${c.established_by}, ${c.confidence} confidence, doc level: ${c.documentation_level ?? "unknown"})\n   Backed by ${c.constituent_decisions.length} decisions and ${c.evidence_count ?? 0} evidence refs\n   Evidence sources: ${(c.evidence_sources ?? []).join(", ") || "(none listed)"}`
      ).join("\n\n");
      return `Analyzed ${a.total_decisions_analyzed ?? "?"} decisions and found ${a.conventions_found ?? "?"} cross-cutting conventions using ${a.llm_calls ?? "?"} LLM calls.

Conventions found:
${convDetails || "(none)"}`;
    },
    deterministicChecks: (a) => {
      const conventions = Array.isArray(a.phase3_conventions)
        ? a.phase3_conventions as Array<{ documentation_level?: string }>
        : Array.isArray(a.conventions)
          ? a.conventions as Array<{ documentation_level?: string }>
          : [];
      return [
        { name: "Conventions found", actual: Number(a.conventions_found ?? 0), target: 1, mode: "gte" as const },
        {
          name: "Documentation level set",
          actual: conventions.length > 0 && conventions.every((c) => c.documentation_level) ? 1 : 0,
          target: 1,
          mode: "eq" as const,
        },
      ];
    },
  },
  "Graph Re-enrichment": {
    systemPrompt: `You are evaluating final graph wiring and traversal QA. Assess path usefulness, convention wiring quality, and whether downstream traversal is actually possible.

Do not infer missing convention coverage from a truncated example alone. Use the grouped APPLIES_TO summary, the full match list, and traversal QA checks together before concluding that a convention is unwired.

Return sub_scores for "Path usefulness" (0-100), "Convention wiring" (0-100), "Traversal QA" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const appliesToResults = Array.isArray(a.applies_to_results)
        ? a.applies_to_results as Array<{ convention?: string; feature?: string; confidence?: string }>
        : [];
      const appliesByConvention = appliesToResults.reduce<Record<string, string[]>>((acc, item) => {
        const convention = typeof item.convention === "string" ? item.convention : "(unknown convention)";
        const feature = typeof item.feature === "string" ? item.feature : "(unknown feature)";
        (acc[convention] ??= []).push(`${feature}${item.confidence ? ` [${item.confidence}]` : ""}`);
        return acc;
      }, {});
      const appliesSummary = Object.entries(appliesByConvention)
        .map(([convention, features]) => `${convention}: ${features.join(", ")}`)
        .join(" | ");
      const traversalQa = (a.traversal_qa ?? {}) as { summary?: Record<string, unknown>; checks?: unknown[] };
      return `Added ${a.total_new_edges ?? "?"} new edges: ${a.discovery_edges_added ?? "?"} discovery, ${a.convention_edges_added ?? "?"} convention, ${a.applies_to_edges_added ?? "?"} applies-to.

Discovery wiring: ${JSON.stringify(a.discovery_wiring ?? []).slice(0, 1400)}
Convention wiring: ${JSON.stringify(a.convention_wiring ?? []).slice(0, 1400)}
APPLIES_TO by convention: ${appliesSummary.slice(0, 2600)}
Full APPLIES_TO results (${appliesToResults.length}): ${JSON.stringify(appliesToResults).slice(0, 2600)}
Traversal QA summary: ${JSON.stringify(traversalQa.summary ?? {}).slice(0, 800)}
Traversal QA checks: ${JSON.stringify(traversalQa.checks ?? []).slice(0, 2200)}`;
    },
  },
  "Page Plan": {
    systemPrompt: `You are evaluating a page planning step for final KB correctness, not just page volume. Prioritize repository coverage, project bucket fidelity, convention coverage, and whether the planned human pages are likely to produce a useful KB instead of placeholders or people-led project hubs.

Return sub_scores for "Final KB coverage" (0-100), "Repo/project planning" (0-100), "Downstream readiness" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const projectPages = (a.planned_project_pages_by_category as Record<string, unknown> | undefined) ?? {};
      return `Planned ${a.total_pages ?? "?"} pages: ${Array.isArray(a.entity_pages) ? (a.entity_pages as unknown[]).length : "?"} entity + ${Array.isArray(a.human_pages) ? (a.human_pages as unknown[]).length : "?"} human.

Human page categories: ${JSON.stringify(a.human_page_categories ?? []).slice(0, 500)}
Human page titles: ${JSON.stringify(a.human_page_titles ?? []).slice(0, 800)}
Entity pages by type: ${JSON.stringify(a.entity_pages_by_type ?? {}).slice(0, 500)}
Excluded entity pages by type: ${JSON.stringify(a.excluded_entity_pages_by_type ?? {}).slice(0, 500)}
Priority counts: ${JSON.stringify(a.priority_counts ?? {}).slice(0, 200)}
Repository nodes: ${a.repository_node_count ?? "?"}
Planned repository pages: ${JSON.stringify(a.planned_repository_pages ?? []).slice(0, 500)}
Convention pages: ${JSON.stringify(a.planned_convention_pages ?? []).slice(0, 600)}
Convention page details: ${JSON.stringify(a.planned_convention_page_details ?? []).slice(0, 900)}
Project nodes by category: ${JSON.stringify(a.project_node_count_by_category ?? {}).slice(0, 300)}
Proposed project pages: ${JSON.stringify(projectPages.proposed_projects ?? []).slice(0, 600)}
Past undocumented project pages: ${JSON.stringify(projectPages.past_undocumented ?? []).slice(0, 600)}
Past documented project pages: ${JSON.stringify(projectPages.past_documented ?? []).slice(0, 600)}
Ongoing documented project pages: ${JSON.stringify(projectPages.ongoing_documented ?? []).slice(0, 600)}
Ongoing undocumented project pages: ${JSON.stringify(projectPages.ongoing_undocumented ?? []).slice(0, 600)}`;
    },
  },
  "GraphRAG Retrieval": {
    systemPrompt: `You are evaluating GraphRAG retrieval packs for downstream page generation. Assess: coverage of the planned pages, retrieval relevance, and grounding quality.

Return sub_scores for "Coverage" (0-100), "Relevance" (0-100), "Grounding" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      return `Built ${a.total_packs ?? "?"} retrieval packs for ${a.expected_total_packs ?? "?"} planned pages (${a.entity_packs ?? "?"} entity, ${a.human_packs ?? "?"} human).

Critical pack samples: ${JSON.stringify(a.critical_pack_samples ?? []).slice(0, 3200)}`;
    },
  },
  "Generate Entity Pages": {
    systemPrompt: `You are evaluating generated entity pages for final KB correctness. Prefer coverage of planned repository pages and GT-critical project pages over prose smoothness alone. Convention and team-member pages should preserve ownership, applications, and evidence relationships.

Return sub_scores for "Final KB correctness" (0-100), "Coverage" (0-100), "Grounding" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      return `Generated ${a.total_pages ?? "?"} entity pages using ${a.llm_calls ?? "?"} LLM calls.

By type: ${JSON.stringify(a.by_type ?? {}).slice(0, 300)}
Planned repository page count: ${a.planned_repository_page_count ?? "?"}
Repository page titles: ${JSON.stringify(a.repository_page_titles ?? []).slice(0, 600)}
Generated project pages by category: ${JSON.stringify(a.generated_project_pages_by_category ?? {}).slice(0, 1200)}
Critical page titles: ${JSON.stringify(a.critical_page_titles ?? []).slice(0, 500)}
Critical page samples: ${JSON.stringify(a.critical_page_samples ?? a.page_samples ?? []).slice(0, 3200)}`;
    },
  },
  "Generate Human Pages": {
    systemPrompt: `You are evaluating generated human pages for final KB correctness. A non-placeholder Company Overview and project-led hub pages matter more than generic prose. Pay close attention to whether project category pages actually link project pages, and whether the generated pages stay grounded in real entity pages.

Return sub_scores for "Final KB correctness" (0-100), "Linkage quality" (0-100), "Narrative grounding" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      return `Generated ${a.total_pages ?? "?"} human pages using ${a.llm_calls ?? "?"} LLM calls.

By layer: ${JSON.stringify(a.by_layer ?? {}).slice(0, 200)}
Link stats: ${JSON.stringify(a.linked_entity_page_id_stats ?? {}).slice(0, 200)}
Page titles by category: ${JSON.stringify(a.page_titles_by_category ?? {}).slice(0, 1200)}
Company Overview status: ${JSON.stringify(a.company_overview ?? {}).slice(0, 300)}
Project hub link stats: ${JSON.stringify(a.project_hub_link_stats ?? []).slice(0, 2200)}
Page samples: ${JSON.stringify(a.page_samples ?? []).slice(0, 2000)}
Critical page titles: ${JSON.stringify(a.critical_page_titles ?? []).slice(0, 500)}
Critical page samples: ${JSON.stringify(a.critical_page_samples ?? a.page_samples ?? []).slice(0, 3200)}`;
    },
  },
  "Generate How-To Guides": {
    systemPrompt: `You are evaluating generated how-to guides. Assess: actionability, evidence grounding, convention application, and completeness of steps.

Return sub_scores for "Actionability" (0-100), "Evidence grounding" (0-100), "Convention application" (0-100), and "Step completeness" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      return `Generated ${a.total_howtos ?? a.total_pages ?? "?"} how-to guides using ${a.llm_calls ?? "?"} LLM calls.

Target nodes: ${JSON.stringify(a.target_nodes ?? []).slice(0, 400)}
Target count: ${a.target_node_count ?? "?"}
How-to titles: ${JSON.stringify(a.howto_titles ?? []).slice(0, 400)}
Direct technical source count: ${a.direct_technical_source_count ?? "?"}
Convention constraints total: ${a.convention_constraints_total ?? "?"}
Convention refs total: ${a.convention_refs_total ?? "?"}
Convention reference coverage pct: ${a.convention_reference_coverage_pct ?? "?"}
Implementation reference count: ${a.implementation_reference_count ?? "?"}
Implementation reference opportunities: ${a.implementation_reference_opportunities ?? "?"}
Implementation step count: ${a.implementation_step_count ?? "?"}
Steps with source refs: ${a.steps_with_source_refs ?? "?"}
Step evidence coverage pct: ${a.step_evidence_coverage_pct ?? "?"}
Source artifact titles used: ${JSON.stringify(a.source_artifact_titles_used ?? []).slice(0, 3000)}
How-to samples: ${JSON.stringify(a.howto_samples ?? []).slice(0, 24000)}
Convention compliance: ${JSON.stringify(a.compliance_results ?? []).slice(0, 4000)}`;
    },
  },
  "Extract Claims": {
    systemPrompt: `You are evaluating a claim extraction step. Assess: claim validity, coverage across entities and pages, and evidence quality.

Return sub_scores for "Claim validity" (0-100), "Coverage" (0-100), "Evidence quality" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      return `Extracted ${a.total_claims ?? "?"} claims using ${a.llm_calls ?? "?"} LLM calls.`;
    },
  },
  "Create Verify Cards": {
    systemPrompt: `You are evaluating verification card creation. Assess: card relevance, severity calibration, and noise filtering quality.

Convention attribution gaps, contradiction risks, and roadmap-critical project synthesis gaps are high-signal issues. Prefer sampled card content over raw counts when the two disagree.

Return sub_scores for "Relevance" (0-100), "Severity calibration" (0-100), "Noise filtering" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a) => {
      const byType = a.by_type as Record<string, number> | undefined;
      const bySev = a.by_severity as Record<string, number> | undefined;
      return `Created ${a.total_cards ?? "?"} verification cards from ${a.candidates_gathered ?? "?"} candidates (${a.filtered_out ?? "?"} filtered).

By type: ${JSON.stringify(byType ?? {})}
By severity: ${JSON.stringify(bySev ?? {})}
Critical card titles: ${JSON.stringify(a.critical_card_titles ?? []).slice(0, 700)}
Critical card samples: ${JSON.stringify(a.critical_card_samples ?? a.card_samples ?? []).slice(0, 5000)}
Filtered candidate samples: ${JSON.stringify(a.filtered_candidate_samples ?? []).slice(0, 2200)}
LLM calls: ${a.llm_calls ?? "?"}`;
    },
  },
};

function getGenericConfig(stepName: string): StepJudgeConfig {
  return {
    systemPrompt: `You are evaluating the quality of the "${stepName}" pipeline step output. Assess completeness, accuracy, and usefulness. Return sub_scores for "Completeness" (0-100), "Accuracy" (0-100), "Usefulness" (0-100). Report issues and recommendations.`,
    buildUserPrompt: (a: Record<string, unknown>) => {
      const summary = Object.entries(a).slice(0, 15).map(([k, v]) => {
        if (typeof v === "number" || typeof v === "string") return `${k}: ${v}`;
        if (Array.isArray(v)) return `${k}: ${v.length} items` + (v.length > 0 && typeof v[0] === "object" ? ` (sample: ${JSON.stringify(v[0]).slice(0, 150)})` : "");
        if (v && typeof v === "object") return `${k}: ${JSON.stringify(v).slice(0, 150)}`;
        return `${k}: ${String(v)}`;
      }).join("\n");
      return `Step "${stepName}" output:\n${summary}`;
    },
  };
}

export function getJudgeConfig(stepName: string): StepJudgeConfig {
  return STEP_JUDGE_CONFIGS[stepName] ?? getGenericConfig(stepName);
}

function extractMetricFromArtifact(artifact: Record<string, unknown>, key: string): number | null {
  if (key.startsWith("sampled_")) return null;

  if (artifact[key] !== undefined && typeof artifact[key] === "number") {
    return artifact[key] as number;
  }

  switch (key) {
    case "total_documents_positive":
      return Number(artifact.total_documents ?? 0) > 0 ? Number(artifact.total_documents) : 0;
    case "provider_diversity":
      return Object.keys(((artifact.by_provider ?? artifact.by_source) as Record<string, unknown>) ?? {}).length;
    case "total_chunks_positive":
      return Number(artifact.total_chunks ?? 0);
    case "chunks_cover_documents": {
      const totalChunks = Number(artifact.total_chunks ?? 0);
      const totalDocs = Number(artifact.total_documents ?? artifact.total_docs ?? 0);
      return totalDocs > 0 && totalChunks >= totalDocs ? 1 : 0;
    }
    case "source_units_positive":
      return Number(
        artifact.total_source_units ??
        Object.values((artifact.source_units_by_source as Record<string, number> | undefined) ?? {}).reduce(
          (sum, value) => sum + Number(value ?? 0),
          0,
        ),
      );
    case "evidence_spans_positive":
      return Number(artifact.total_evidence_spans ?? artifact.total_chunks ?? 0);
    case "observation_count_positive":
      return Number(artifact.total_observations ?? 0);
    case "candidate_type_diversity":
    case "type_diversity":
      return Object.keys(((artifact.candidate_entities_by_type ?? artifact.entities_by_type) as Record<string, unknown>) ?? {}).length;
    case "retyped_or_rejected_positive":
      return Number(artifact.retyped_count ?? 0) + Number(artifact.opus_rejected ?? 0);
    case "after_count_not_greater_than_before_count":
      return Number(artifact.total_entities_after ?? 0) <= Number(artifact.total_entities_before ?? 0) ? 1 : 0;
    case "zero_co_occurrence_semantic_edges":
      return artifact.zero_co_occurrence_semantic_edges ? 1 : 0;
    case "pattern_candidates_positive":
      return Array.isArray(artifact.pattern_candidates) ? artifact.pattern_candidates.length : 0;
    case "total_new_edges":
      return Number(artifact.total_new_edges ?? artifact.new_edges ?? 0);
    case "conventions_found_positive":
      return Number(artifact.conventions_found ?? 0);
    case "total_entities_positive":
      return Number(artifact.total_entities ?? 0);
    case "discovery_count_positive":
      return Number(artifact.total_discoveries ?? 0);
    case "category_diversity":
      return Object.keys((artifact.by_category as Record<string, unknown>) ?? {}).length;
    case "min_decisions_per_convention": {
      const conventions = Array.isArray(artifact.phase3_conventions)
        ? artifact.phase3_conventions as Record<string, unknown>[]
        : Array.isArray(artifact.conventions)
          ? artifact.conventions as Record<string, unknown>[]
          : [];
      if (conventions.length === 0) return 0;
      return Math.min(
        ...conventions.map((c) =>
          Array.isArray(c.constituent_decisions) ? c.constituent_decisions.length : 0,
        ),
      );
    }
    case "description_coverage_pct": {
      const total = Number(artifact.total_entities_processed ?? 0);
      const missing = Number(artifact.descriptions_missing_after ?? 0);
      return total > 0 ? Math.round(((total - missing) / total) * 100) : 100;
    }
    case "valid_status_pct": {
      const pp = Number(artifact.total_project_process_nodes ?? 0);
      const valid =
        Number(artifact.statuses_already_valid ?? 0) +
        Number(artifact.statuses_filled ?? 0) +
        Number(artifact.statuses_corrected ?? 0);
      return pp > 0 ? Math.round((valid / pp) * 100) : 100;
    }
    case "decided_by_corrections_count":
      return artifact.decided_by_corrected !== undefined ? Number(artifact.decided_by_corrected) : null;
    case "decisions_with_decided_by_pct": {
      const totalDecisions = Number(artifact.total_decisions ?? 0);
      const withDecidedBy =
        Number(artifact.decided_by_fixed ?? 0) +
        Number(artifact.decided_by_confirmed ?? 0) +
        Number(artifact.decided_by_corrected ?? 0);
      return totalDecisions > 0 ? Math.round((withDecidedBy / totalDecisions) * 100) : 100;
    }
    case "documentation_level_set": {
      const convs = Array.isArray(artifact.phase3_conventions)
        ? artifact.phase3_conventions as Record<string, unknown>[]
        : Array.isArray(artifact.conventions)
          ? artifact.conventions as Record<string, unknown>[]
          : [];
      if (convs.length === 0) return null;
      return convs.every(c => c.documentation_level) ? 1 : 0;
    }
    case "identity_based_merges_logged":
      return artifact.identity_merges !== undefined ? 1 : null;
    case "convention_edges_positive":
      return Number(artifact.convention_edges_added ?? 0) + Number(artifact.applies_to_edges_added ?? 0);
    case "traversal_checks_positive":
      return Number((artifact.traversal_qa as Record<string, any> | undefined)?.summary?.checked ?? 0);
    case "traversal_full_pass_positive":
      return Number((artifact.traversal_qa as Record<string, any> | undefined)?.summary?.full_pass ?? 0);
    case "hidden_conventions_page_present_when_needed": {
      const conventionCount = Number(artifact.convention_node_count ?? 0);
      if (conventionCount === 0) return 1;
      return asStringArray(artifact.human_page_categories).includes("hidden_conventions") ? 1 : 0;
    }
    case "company_overview_page_present":
      return asStringArray(artifact.human_page_categories).includes("company_overview") ? 1 : 0;
    case "planned_repo_pages_present_when_repo_nodes_exist": {
      const repositoryNodeCount = Number(artifact.repository_node_count ?? 0);
      if (repositoryNodeCount === 0) return 1;
      return asStringArray(artifact.planned_repository_pages).length >= repositoryNodeCount ? 1 : 0;
    }
    case "project_bucket_pages_planned_when_projects_exist": {
      const counts = (artifact.project_node_count_by_category as Record<string, unknown> | undefined) ?? {};
      const planned = (artifact.planned_project_pages_by_category as Record<string, unknown> | undefined) ?? {};
      const activeCategories = Object.entries(counts).filter(([, count]) => Number(count ?? 0) > 0);
      if (activeCategories.length === 0) return null;
      const allCovered = activeCategories.every(([category]) => asStringArray(planned[category]).length > 0);
      return allCovered ? 1 : 0;
    }
    case "convention_entity_pages_present_when_needed": {
      const conventionCount = Number(artifact.convention_node_count ?? 0);
      if (conventionCount === 0) return 1;
      return asStringArray(artifact.planned_convention_pages).length >= conventionCount ? 1 : 0;
    }
    case "retrieval_pack_count_matches_plan": {
      const totalPacks = Number(artifact.total_packs ?? 0);
      const expectedPacks = Number(artifact.expected_total_packs ?? 0);
      if (expectedPacks <= 0) return null;
      return totalPacks === expectedPacks ? 1 : 0;
    }
    case "sampled_packs_have_graph_and_source_context": {
      const samples = Array.isArray(artifact.critical_pack_samples)
        ? artifact.critical_pack_samples as Record<string, unknown>[]
        : [];
      if (samples.length === 0) return null;
      const hasContext = samples.every((sample) => {
        const graphContext = Array.isArray(sample.graph_context) ? sample.graph_context : [];
        const docSnippets = Array.isArray(sample.doc_snippets) ? sample.doc_snippets : [];
        const vectorSnippets = Array.isArray(sample.vector_snippets) ? sample.vector_snippets : [];
        return graphContext.length > 0 && (docSnippets.length > 0 || vectorSnippets.length > 0);
      });
      return hasContext ? 1 : 0;
    }
    case "howto_count_positive_when_proposed_work_exists": {
      const targetCount = Number(
        artifact.target_node_count ??
        (Array.isArray(artifact.target_nodes) ? artifact.target_nodes.length : 0),
      );
      if (targetCount <= 0) return null;
      return Number(artifact.total_howtos ?? artifact.total_pages ?? 0);
    }
    case "direct_technical_source_count_positive":
      return Number(artifact.direct_technical_source_count ?? 0);
    case "convention_reference_coverage_pct": {
      const total = Number(artifact.convention_constraints_total ?? 0);
      if (total <= 0) return null;
      return Number(artifact.convention_reference_coverage_pct ?? 0);
    }
    case "step_evidence_coverage_pct": {
      const totalSteps = Number(artifact.implementation_step_count ?? 0);
      if (totalSteps <= 0) return null;
      return Number(artifact.step_evidence_coverage_pct ?? 0);
    }
    case "implementation_reference_count_positive": {
      const opportunities = Number(artifact.implementation_reference_opportunities ?? 0);
      if (opportunities <= 0) return null;
      return Number(artifact.implementation_reference_count ?? 0);
    }
    case "repository_pages_generated_when_planned": {
      const plannedCount = Number(artifact.planned_repository_page_count ?? 0);
      if (plannedCount === 0) return 1;
      return asStringArray(artifact.repository_page_titles).length >= plannedCount ? 1 : 0;
    }
    case "company_overview_non_placeholder": {
      const companyOverview = (artifact.company_overview as Record<string, unknown> | undefined) ?? {};
      if (!companyOverview.exists) return 0;
      return companyOverview.placeholder === false ? 1 : 0;
    }
    case "project_hub_links_are_project_led": {
      const stats = Array.isArray(artifact.project_hub_link_stats)
        ? artifact.project_hub_link_stats as Record<string, unknown>[]
        : [];
      const nonEmptyStats = stats.filter((stat) => Number(stat.linked_total ?? 0) > 0);
      if (nonEmptyStats.length === 0) return null;
      const allProjectLed = nonEmptyStats.every((stat) =>
        Number(stat.linked_project_count ?? 0) > 0 &&
        Number(stat.linked_project_count ?? 0) > Number(stat.linked_team_member_count ?? 0)
      );
      return allProjectLed ? 1 : 0;
    }
    case "zero_jira_auto_project_promotions":
      return artifact.zero_jira_auto_project_promotions ? 1 : 0;
    case "applies_to_targets_are_features_or_projects": {
      const results = Array.isArray(artifact.applies_to_results)
        ? artifact.applies_to_results as Record<string, unknown>[]
        : [];
      if (results.length === 0) return 0;
      const looksClean = results.every((r) => {
        const feature = String(r.feature ?? "").trim();
        return feature.length > 0 && !/^PAW-\d+$/i.test(feature) && !/^PR\s*#?\d+$/i.test(feature);
      });
      return looksClean ? 1 : 0;
    }
    case "evidence_pack_convention_source_count": {
      const epSamples = Array.isArray(artifact.evidence_pack_samples)
        ? artifact.evidence_pack_samples as Record<string, unknown>[]
        : [];
      if (epSamples.length === 0) return Number(artifact.evidence_pack_convention_source_count ?? 0);
      return Math.max(...epSamples.map(s => Number(s.convention_source_count ?? 0)), 0);
    }
    case "evidence_pack_precedent_source_count": {
      const epSamples2 = Array.isArray(artifact.evidence_pack_samples)
        ? artifact.evidence_pack_samples as Record<string, unknown>[]
        : [];
      if (epSamples2.length === 0) return Number(artifact.evidence_pack_precedent_source_count ?? 0);
      return Math.max(...epSamples2.map(s => Number(s.precedent_source_count ?? 0)), 0);
    }
    case "evidence_pack_source_type_diversity": {
      const epSamples3 = Array.isArray(artifact.evidence_pack_samples)
        ? artifact.evidence_pack_samples as Record<string, unknown>[]
        : [];
      if (epSamples3.length === 0) return Number(artifact.evidence_pack_source_type_diversity ?? 0);
      return Math.max(...epSamples3.map(s => {
        const mix = s.source_type_mix as Record<string, unknown> | undefined;
        return mix ? Object.keys(mix).length : 0;
      }), 0);
    }
    case "evidence_pack_fallback_ratio_low": {
      const epSamples4 = Array.isArray(artifact.evidence_pack_samples)
        ? artifact.evidence_pack_samples as Record<string, unknown>[]
        : [];
      if (epSamples4.length === 0) return Number(artifact.evidence_pack_fallback_ratio_pct ?? 0);
      const ratios = epSamples4.map(s => Number(s.fallback_ratio_pct ?? 0));
      return ratios.length > 0 ? Math.round(ratios.reduce((a, b) => a + b, 0) / ratios.length) : 0;
    }
    case "total_cards_positive_when_candidates_exist": {
      const candidates = Number(artifact.candidates_gathered ?? 0);
      if (candidates <= 0) return 1;
      return Number(artifact.total_cards ?? 0) > 0 ? 1 : 0;
    }
    case "card_volume_reasonable": {
      const candidates = Number(artifact.candidates_gathered ?? 0);
      const totalCards = Number(artifact.total_cards ?? 0);
      if (candidates <= 0) return 1;
      return totalCards > 0 && totalCards <= Math.min(40, Math.ceil(candidates * 0.8)) ? 1 : 0;
    }
    case "sampled_cards_have_execution_id": {
      const samples = Array.isArray(artifact.critical_card_samples)
        ? artifact.critical_card_samples as Record<string, unknown>[]
        : Array.isArray(artifact.card_samples)
          ? artifact.card_samples as Record<string, unknown>[]
          : [];
      if (samples.length === 0) return 0;
      return samples.every((sample) => typeof sample.execution_id === "string" && sample.execution_id.length > 0)
        ? 1
        : 0;
    }
    default:
      return null;
  }
}

function deriveSampleKey(sampledKey: string, artifact: Record<string, unknown>): string | null {
  const preferredSamples: Record<string, string[]> = {
    sampled_docs_have_source_ids: ["sampled_documents"],
    sampled_chunks_have_parent_doc_id: ["chunk_samples"],
    sampled_entities_have_source_refs: ["entity_samples"],
    sampled_retyped_entities_have_reasons: ["retyped_entities"],
    sampled_merges_have_evidence: ["merges"],
    sampled_false_merge_rate_low: ["kept_separate"],
    sampled_conventions_have_owner_and_evidence: ["phase3_conventions", "conventions"],
    sampled_howtos_reference_real_entities: ["howto_samples"],
    sampled_howtos_name_ownered_conventions: ["howto_samples"],
    sampled_howtos_include_kb_specific_prescriptions: ["howto_samples"],
    sampled_howtos_cite_real_artifacts: ["howto_samples"],
  };
  for (const candidate of preferredSamples[sampledKey] ?? []) {
    if (Array.isArray(artifact[candidate])) return candidate;
  }
  const base = sampledKey.replace(/^sampled_/, "");
  const candidates = [base, `${base}_results`, `${base}_details`, `${base}_corrections`, `${base}_summary`];
  for (const c of candidates) {
    if (artifact[c] !== undefined && Array.isArray(artifact[c])) return c;
  }
  for (const [k, v] of Object.entries(artifact)) {
    if (Array.isArray(v) && k.includes(base.split("_")[0])) return k;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function normalizeBenchmarkSlug(companySlug: string): string {
  return companySlug.toLowerCase().replace(/\d+$/, "");
}

function loadGoalFiles(stepNumber: number): { goalText: string; stepGoal: Record<string, unknown> | null } {
  let goalText = "";
  let stepGoal: Record<string, unknown> | null = null;
  try {
    goalText = readFileSync(path.join(process.cwd(), "goals", "goal.txt"), "utf-8");
    const yamlPath = path.join(process.cwd(), "goals", "steps", `pass1-step-${String(stepNumber).padStart(2, "0")}.yaml`);
    stepGoal = parseYaml(readFileSync(yamlPath, "utf-8"));
  } catch { /* goal files not found — degrade gracefully */ }
  return { goalText, stepGoal };
}

function loadBenchmarkOverlay(
  companySlug: string,
  stepNumber: number,
): {
  globalText: string;
  stepOverlay: Record<string, unknown> | null;
  groundTruthContext: { file: string; text: string }[];
} {
  const benchmarkSlug = normalizeBenchmarkSlug(companySlug);
  const benchmarkRoot = path.join(process.cwd(), "benchmarks", benchmarkSlug);
  if (!existsSync(benchmarkRoot)) {
    return { globalText: "", stepOverlay: null, groundTruthContext: [] };
  }

  let globalText = "";
  let stepOverlay: Record<string, unknown> | null = null;
  const groundTruthContext: { file: string; text: string }[] = [];

  const globalPath = path.join(benchmarkRoot, "global.md");
  if (existsSync(globalPath)) {
    globalText = readFileSync(globalPath, "utf-8");
  }

  const stepPath = path.join(
    benchmarkRoot,
    "steps",
    `pass1-step-${String(stepNumber).padStart(2, "0")}.yaml`,
  );
  if (existsSync(stepPath)) {
    stepOverlay = parseYaml(readFileSync(stepPath, "utf-8"));
  }

  for (const file of asStringArray(stepOverlay?.ground_truth_files)) {
    const absPath = path.join(process.cwd(), file);
    if (!existsSync(absPath)) continue;
    groundTruthContext.push({
      file,
      text: readFileSync(absPath, "utf-8").slice(0, 3000),
    });
  }

  return { globalText, stepOverlay, groundTruthContext };
}

export async function evaluateStep(
  companySlug: string,
  executionId: string,
  logLLMCallFn?: (stepId: string, model: string, prompt: string, response: string, inputTokens: number, outputTokens: number, costUsd: number, durationMs: number) => Promise<void>,
): Promise<JudgeResult> {
  const tc = getTenantCollections(companySlug);
  const stepDoc = await tc.run_steps.findOne({ execution_id: executionId });

  if (!stepDoc) throw new Error("Step not found");
  if (!stepDoc.artifact) throw new Error("Step has no artifact");

  const config = await getCompanyConfig(companySlug);
  const models = config?.pipeline_settings?.models;
  const judgeModel = getFastModel(models);
  const judgeModelName = getFastModelName(models);
  const ccModel = getCrossCheckModel(models);
  const ccModelName = getCrossCheckModelName(models);

  const stepName = stepDoc.name as string;
  const artifact = stepDoc.artifact as Record<string, unknown>;
  const stepConfig = getJudgeConfig(stepName);

  const stepNumber = (stepDoc as Record<string, unknown>).step_number as number | undefined;
  const { goalText, stepGoal } = stepNumber ? loadGoalFiles(stepNumber) : { goalText: "", stepGoal: null };
  const { globalText: benchmarkGlobalText, stepOverlay, groundTruthContext } = stepNumber
    ? loadBenchmarkOverlay(companySlug, stepNumber)
    : { globalText: "", stepOverlay: null, groundTruthContext: [] };

  let enrichedSystemPrompt = stepConfig.systemPrompt;
  if (stepGoal) {
    const mustDo = (stepGoal.must_do as string[] ?? []).map((s: string) => `- ${s}`).join("\n");
    const mustNotDo = (stepGoal.must_not_do as string[] ?? []).map((s: string) => `- ${s}`).join("\n");
    const successSignals = (stepGoal.success_signals as string[] ?? []).map((s: string) => `- ${s}`).join("\n");
    const failureSignals = (stepGoal.failure_signals as string[] ?? []).map((s: string) => `- ${s}`).join("\n");
    const judgeShouldLookAt = (stepGoal.judge_should_look_at as string[] ?? []).map((s: string) => `- ${s}`).join("\n");

    const contract = `You are evaluating Step ${stepGoal.step_number}: ${stepGoal.step_name}.

OVERALL PIPELINE GOAL:
${goalText}

THIS STEP'S CONTRACT:
Purpose: ${stepGoal.purpose}
Must do:
${mustDo}
Must not do:
${mustNotDo}
Success signals:
${successSignals}
Failure signals:
${failureSignals}
What to inspect:
${judgeShouldLookAt}

Judge this step ONLY on its own responsibility. Do not blame it for missing upstream truth unless its contract says it owns that correction.

`;
    enrichedSystemPrompt = contract + enrichedSystemPrompt;

    const sampledChecks = ((stepGoal.deterministic_checks as Record<string, unknown>[] | undefined) ?? [])
      .filter((c) => (c.key as string).startsWith("sampled_"));
    if (sampledChecks.length > 0) {
      enrichedSystemPrompt += "\n\nSAMPLE INSPECTION GUIDANCE (evaluate qualitatively from artifact data):\n";
      for (const c of sampledChecks) {
        enrichedSystemPrompt += `- ${c.description}\n`;
        const sampleKey = deriveSampleKey(c.key as string, artifact);
        if (sampleKey && Array.isArray(artifact[sampleKey])) {
          const sampleData = (artifact[sampleKey] as any[]).slice(0, 5);
          enrichedSystemPrompt += `  Sample data (${sampleKey}, ${(artifact[sampleKey] as any[]).length} total):\n`;
          enrichedSystemPrompt += `  ${JSON.stringify(sampleData, null, 2).slice(0, 1000)}\n`;
        }
      }
    }
  }

  if (stepOverlay || benchmarkGlobalText) {
    const benchmarkFocus = asStringArray(stepOverlay?.benchmark_focus).map((s) => `- ${s}`).join("\n");
    const benchmarkMustFit = asStringArray(stepOverlay?.benchmark_must_fit).map((s) => `- ${s}`).join("\n");
    const benchmarkWatchouts = asStringArray(stepOverlay?.benchmark_watchouts).map((s) => `- ${s}`).join("\n");
    const benchmarkQuestions = asStringArray(stepOverlay?.benchmark_questions).map((s) => `- ${s}`).join("\n");
    const benchmarkFalsePositives = asStringArray(stepOverlay?.benchmark_false_positive_examples).map((s) => `- ${s}`).join("\n");
    const gtText = groundTruthContext
      .map((gt) => `FILE: ${gt.file}\n${gt.text}`)
      .join("\n\n---\n\n");

    enrichedSystemPrompt += `

BENCHMARK OVERLAY (evaluation only):
Use this only to judge benchmark fit for this dataset. Do NOT treat it as a generation answer key.

BENCHMARK GLOBAL CONTEXT:
${benchmarkGlobalText}

STEP-SPECIFIC BENCHMARK FOCUS:
${benchmarkFocus || "- None provided"}

WHAT MUST FIT THIS BENCHMARK:
${benchmarkMustFit || "- None provided"}

KNOWN WATCHOUTS:
${benchmarkWatchouts || "- None provided"}

FALSE-POSITIVE EXAMPLES:
${benchmarkFalsePositives || "- None provided"}

QUESTIONS TO ANSWER DURING JUDGING:
${benchmarkQuestions || "- None provided"}

RELEVANT GROUND-TRUTH CONTEXT:
${gtText || "(none provided)"}

When benchmark overlay and general contract disagree in granularity, keep the base step contract for ownership and use the benchmark overlay only for dataset-specific fit.
`;
  }

  enrichedSystemPrompt += `

FINAL RESPONSE REQUIREMENTS:
- Always set go_no_go to either "go" or "no-go".
- Always provide blockers as a flat list of the most important concrete blockers. Use an empty list if none.
- Set rerun_from_step to the earliest pass1 step number that should be rerun to fix the current blockers. Use null if no rerun is needed or if the issue is outside pass1.
- If the artifact is missing a benchmark-critical path or source-fidelity property, prefer "no-go".
`;

  const logLLMCall = logLLMCallFn ?? (async (
    stepId: string, model: string, prompt: string, response: string,
    inputTokens: number, outputTokens: number, costUsd: number, durationMs: number,
  ) => {
    await tc.llm_calls.insertOne({
      call_id: randomUUID(),
      run_id: stepDoc.run_id,
      step_id: stepDoc.step_id,
      execution_id: executionId,
      model,
      prompt: prompt.slice(0, 50000),
      response: response.slice(0, 50000),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
      judge_rerun: true,
    });
  });

  let deterministicResult: JudgeResult | undefined;
  const allChecks: DeterministicCheck[] = [];

  if (stepConfig.deterministicChecks) {
    allChecks.push(...stepConfig.deterministicChecks(artifact));
  }

  if (stepGoal?.deterministic_checks) {
    for (const check of stepGoal.deterministic_checks as Record<string, unknown>[]) {
      const actual = extractMetricFromArtifact(artifact, check.key as string);
      if (actual === null) continue;
      allChecks.push({
        name: check.description as string,
        actual,
        target: check.target as number,
        mode: check.mode as "gte" | "lte" | "eq",
      });
    }
  }

  if (allChecks.length > 0) {
    deterministicResult = buildDeterministicJudge(allChecks, 70);
  }

  let userPrompt = stepConfig.buildUserPrompt(artifact);

  if (stepNumber === 8) {
    const step5Doc = await tc.run_steps.findOne(
      { run_id: stepDoc.run_id, step_number: 5, status: "completed" },
      { sort: { execution_number: -1, completed_at: -1 }, projection: { execution_id: 1, artifact: 1 } },
    );
    const step5Artifact = (step5Doc?.artifact ?? {}) as Record<string, unknown>;
    const resolvedTitles = (step5Artifact.resolved_titles_by_type ?? {}) as Record<string, unknown>;
    const canonicalProjects = Array.isArray(resolvedTitles.project)
      ? resolvedTitles.project as string[]
      : [];
    const canonicalTickets = Array.isArray(resolvedTitles.ticket)
      ? resolvedTitles.ticket as string[]
      : [];
    if (canonicalProjects.length > 0 || canonicalTickets.length > 0) {
      userPrompt += `

UPSTREAM CANONICAL CONTEXT FROM STEP 5 (same run):
Latest Step 5 execution: ${step5Doc?.execution_id ?? "(unknown)"}
Canonical project titles (${canonicalProjects.length}): ${canonicalProjects.join("; ").slice(0, 3200)}
Canonical ticket titles (${canonicalTickets.length}): ${canonicalTickets.slice(0, 40).join("; ").slice(0, 2200)}

Evaluation rule for this run: if a Step 8 suppression entry is marked "already_canonical" and it matches one of the upstream same-type canonical titles above after normalizing superficial suffix variants, treat that as affirmative evidence of earlier capture rather than a missed discovery.

Do not treat raw Jira ticket IDs in the already_canonical list as missing project discoveries when the same run already has canonical ticket entities for them.`;
    }
  }

  const llmResult = await runLLMJudge({
    model: judgeModel,
    modelName: judgeModelName,
    systemPrompt: enrichedSystemPrompt,
    userPrompt,
    crossCheckModel: ccModel,
    crossCheckModelName: ccModelName,
    logLLMCall,
    stepId: stepDoc.step_id as string,
  });

  const judgeResult = deterministicResult
    ? mergeJudgeResults(deterministicResult, llmResult, 70)
    : llmResult;

  await tc.run_steps.updateOne(
    { execution_id: executionId },
    { $set: { judge_result: judgeResult } },
  );

  return judgeResult;
}
