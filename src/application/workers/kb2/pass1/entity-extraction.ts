import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { calculateCostUsd, getFastModel, getFastModelName } from "@/lib/ai-model";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import {
  appendUniqueSourceRefs,
  buildEvidenceRefFromDoc,
  getDocSourceUnits,
  normalizeEntityType,
  projectCandidateReview,
  type KB2CandidateEntity,
  type KB2Observation,
  type KB2SourceUnit,
} from "@/src/application/lib/kb2/pass1-v2-artifacts";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const ObservationSchema = z.object({
  observations: z.array(
    z.object({
      unit_id: z.string(),
      label: z.string(),
      observation_kind: z.enum([
        "candidate_entity",
        "decision_signal",
        "work_item_signal",
        "process_signal",
        "person_signal",
        "feedback_signal",
        "pattern_signal",
      ]),
      suggested_type: z.string(),
      reasoning: z.string(),
      evidence_excerpt: z.string(),
      aliases: z.array(z.string()).default([]),
      attributes: z.object({}).passthrough().default({}),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});

const UNIT_BATCH_SIZE = 10;
const UNIT_TEXT_CAP = 1200;
const TASK_SHAPED_RE = /\b(fix|bug|cleanup|refactor|investigate|copy|planning|roadmap|maintenance|postmortem|onboarding|meeting|1:1|review|mockups?|touch target|handoff)\b/i;
const PROJECT_SURFACE_RE = /\b(page|portal|browser|browse|tracking|calendar|chooser|navigation|profile|profiles|comparison|volunteer|feature|initiative|redesign|mvp|integration|rollout|launch|orders|responsiveness)\b/i;
const DIRECT_PROJECT_SURFACE_RE = /\b(page|portal|browser|browse|tracking|calendar|chooser|navigation|comparison|feature|orders|responsiveness|redesign|integration|pipeline|standardization|search|profile|profiles|form)\b/i;
const PROJECT_FRAGMENT_RE = /\b(button|buttons|card|cards|designs?|endpoint|tests?|e2e|mockups?|touch target)\b/i;
const CONFLUENCE_UMBRELLA_RE = /\b(phase\s+\d+|website redesign|roadmap)\b/i;
const INITIATIVE_RE = /\b(phase|initiative|priority|biggest new feature|goal of|ongoing effort|feature work|started this effort|distinct feature|living document)\b/i;
const DECISION_TRIGGER_RE = /\b(decided|decision|prefer|instead of|tradeoff|going with|makes more sense|standardize|suggested|opted)\b/i;
const PROCESS_TRIGGER_RE = /\b(process|workflow|runbook|playbook|checklist|triage|handoff|manual process|review flow|deployment pipeline|daily|weekly|every \d+)\b/i;
const PATTERN_TRIGGER_RE = /\b(convention|pattern|standard(?:ize|ized)?|rule|default|prefer|preferred|instead of|always|never)\b/i;
const WEAK_DECISION_FEEDBACK_RE = /\blooks so much better\b|\bwhere we started\b/i;
const IMPLEMENTATION_CONTEXT_RE = /\b(ui|ux|button|cta|card|layout|menu|navigation|sidebar|filter|pagination|page|modal|drawer|grid|tab|tabs|table|form|search|sort|cache|caching|load|loading|client side|server side|api|schema|color|accent|style|responsive|mobile)\b/i;
const IMPLEMENTATION_ACTION_RE = /\b(use|using|keep|put|place|load|store|filter|sort|paginate|render|show|hide|stack)\b/i;

const EXTRACTION_PROMPT = `You are extracting evidence-backed observations and candidate entities from already-structured enterprise source units.

CRITICAL:
- You are NOT creating final canonical truth.
- Output observations and candidate entities only.
- Prefer explicit source units and exact evidence over broad summarization.

ENTITY RULES:
- Jira issues are tickets unless the evidence clearly describes a larger multi-ticket initiative.
- GitHub PRs are pull_request entities, not projects.
- Customer feedback items are customer_feedback unless multiple units clearly support a feature hypothesis.
- A project must look like a feature initiative or body of work, not a one-off task, copy update, bug fix, roadmap note, or maintenance item.
- Decisions are choices, standards, tradeoffs, or conventions.
- Processes are repeatable human workflows. Pipelines are automated workflows.

OUTPUT RULES:
- Return one observation per distinct evidence-backed thing you notice in the provided units.
- Use the exact unit_id from the prompt.
- evidence_excerpt must be copied from the unit text, not paraphrased.
- suggested_type should be the best candidate type for later validation, even if uncertain.
- If evidence is weak, still return the observation with lower confidence instead of overcommitting to a project.
- Labels must be short (max 5 words), human-readable proper names. Good: "Shelter Search Page", "Stripe Integration". Bad: "Page for searching shelters in the application".
`;

interface DeterministicSeedBundle {
  observations: KB2Observation[];
  candidates: KB2CandidateEntity[];
}

function buildDeterministicObservation(args: {
  doc: KB2ParsedDocument;
  unitId: string;
  observation_kind: KB2Observation["observation_kind"];
  label: string;
  suggested_type: string;
  reasoning: string;
  confidence: KB2Observation["confidence"];
  source_ref: KB2Observation["source_ref"];
  aliases?: string[];
  attributes?: Record<string, unknown>;
}): KB2Observation {
  return {
    observation_id: randomUUID(),
    provider: args.doc.provider,
    doc_id: args.doc.sourceId,
    parent_doc_id: args.doc.id,
    unit_id: args.unitId,
    observation_kind: args.observation_kind,
    label: args.label,
    suggested_type: normalizeEntityType(args.suggested_type),
    reasoning: args.reasoning,
    confidence: args.confidence,
    evidence_excerpt: args.source_ref.excerpt,
    source_ref: args.source_ref,
    aliases: args.aliases ?? [],
    attributes: args.attributes ?? {},
  };
}

function buildCandidateFromObservation(
  observation: KB2Observation,
  origin: string,
): KB2CandidateEntity {
  return {
    candidate_id: randomUUID(),
    display_name: observation.label,
    type: normalizeEntityType(observation.suggested_type),
    confidence: observation.confidence,
    aliases: [...new Set(observation.aliases ?? [])],
    attributes: {
      ...(observation.attributes ?? {}),
      _candidate_stage: "step3",
      _candidate_origin: origin,
      _observation_kind: observation.observation_kind,
      _reasoning: observation.reasoning,
    },
    source_refs: [observation.source_ref],
    observation_ids: [observation.observation_id],
  };
}

function normalizeOwnerHint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s*\[[^\]]+\]\s*$/g, "").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function deriveOwnerHint(doc: KB2ParsedDocument, unit: KB2SourceUnit): string | undefined {
  const unitMeta = (unit.metadata ?? {}) as Record<string, unknown>;
  const docMeta = (doc.metadata ?? {}) as Record<string, unknown>;
  return normalizeOwnerHint(
    unitMeta.comment_author ??
    unitMeta.reviewer ??
    unitMeta.speaker ??
    unitMeta.author ??
    docMeta.author,
  );
}

function chooseSignalExcerpt(text: string, patterns: RegExp[]): string {
  const snippets = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((snippet) => snippet.trim())
    .filter((snippet) => snippet.length >= 18);
  for (const snippet of snippets) {
    if (patterns.some((pattern) => pattern.test(snippet))) {
      return snippet;
    }
  }
  return text.trim().slice(0, 280);
}

function compactSignalLabel(text: string, fallback: string): string {
  const cleaned = text
    .replace(/^[-*>#\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,\-]+$/g, "");
  if (!cleaned) return fallback;
  return cleaned.split(" ").slice(0, 8).join(" ").trim() || fallback;
}

function normalizeDecisionLabelText(text: string): string {
  return text
    .replace(/^[-*>#\s]+/, "")
    .replace(/^the user is choosing,\s*not comparing,\s*so\s+/i, "")
    .replace(/\bmakes more sense to me than\b/i, " over ")
    .replace(/\bmakes more sense than\b/i, " over ")
    .replace(/\s+across the top\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldSuppressDecisionExcerpt(text: string): boolean {
  const normalized = text
    .replace(/^[-*>#\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return true;
  if (WEAK_DECISION_FEEDBACK_RE.test(normalized)) return true;
  if (/^instead of\b/i.test(normalized) && normalized.split(/\s+/).length <= 5) {
    return true;
  }
  return false;
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatStructuredLabel(value: string): string {
  return toTitleCase(value)
    .replace(/\bCi Cd\b/g, "CI/CD")
    .replace(/\bApi\b/g, "API")
    .replace(/\bPr\b/g, "PR");
}

function normalizeStructuredProjectSurface(text: string): string {
  return text
    .replace(/^set up\s+(.+)$/i, (_match, body: string) => `${body} setup`)
    .replace(/^standardi[sz]e\s+(.+)$/i, (_match, body: string) => `${body} standardization`)
    .replace(/^(?:[a-z]+\s+)?api response format standardization$/i, "api response standardization")
    .replace(/^(?:[a-z]+\s+)?api response standardization$/i, "api response standardization")
    .replace(/^improv(?:e|ing)\s+(.+)$/i, (_match, body: string) => `${body} improvements`)
    .replace(/^(.+?)\s+to\s+(.+)$/i, (_match, left: string, right: string) => `${left} for ${right}`)
    .replace(/\s+browser page$/i, " browser")
    .replace(/\s+page designs?$/i, " page")
    .replace(/\s+\b(frontend|backend)\s+api\b$/i, "")
    .replace(/\s+[—-]\s+(backend|frontend|design|layout)\b.*$/i, "")
    .replace(/\s+\b(frontend|backend|design|layout|feature)\b$/i, "")
    .replace(/\s+(product spec|spec)$/i, "")
    .replace(/\s*[—-]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveRepositoryDisplayName(repo: unknown): string | null {
  if (typeof repo !== "string" || !repo.trim()) return null;
  const trimmed = repo.trim();
  const shortName = trimmed.split("/").pop()?.trim() ?? trimmed;
  return shortName.length > 0 ? shortName : null;
}

function deriveStructuredProjectLabelFromDoc(doc: KB2ParsedDocument): string | null {
  let text = doc.title
    .replace(/^[A-Z]+-\d+:\s*/i, "")
    .replace(/^[^:]*PR\s*#\d+:\s*/i, "")
    .replace(/^(build|add|implement|design|create)\s+/i, "")
    .trim();
  text = normalizeStructuredProjectSurface(text);
  if (!text) return null;
  if (TASK_SHAPED_RE.test(text)) return null;
  if (!DIRECT_PROJECT_SURFACE_RE.test(text)) return null;
  return formatStructuredLabel(text);
}

function extractJiraDescription(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/## Description\n([\s\S]*?)(?=\n## |\n# |$)/);
  return match?.[1]?.trim() ?? "";
}

function deriveStructuredProjectSeedFromConfluenceUnit(
  doc: KB2ParsedDocument,
  unit: KB2SourceUnit,
): { label: string; status?: "active" | "completed" | "proposed"; documentation_level: "documented" } | null {
  if (doc.provider !== "confluence") return null;

  const unitTitle = unit.title.trim();
  if (!unitTitle) return null;

  if (/^future considerations$/i.test(unitTitle)) {
    return {
      label: `${doc.title} — Future Considerations`,
      status: "proposed",
      documentation_level: "documented",
    };
  }

  const phaseMatch = unitTitle.match(/^Phase\s+\d+.*?[—-]\s*(.+)$/i);
  if (!phaseMatch?.[1]) return null;

  let label = normalizeStructuredProjectSurface(phaseMatch[1]);
  if (!label) return null;
  if (!DIRECT_PROJECT_SURFACE_RE.test(label) && label.split(/\s+/).length < 2) return null;
  if (TASK_SHAPED_RE.test(label)) return null;

  const normalizedText = unit.text.toLowerCase();
  const status =
    /\bstatus:\s*complete\b/i.test(unit.text)
      ? "completed"
      : /\bstatus:\s*in progress\b/i.test(unit.text)
        ? "active"
        : normalizedText.includes("future considerations")
          ? "proposed"
          : undefined;

  return {
    label: formatStructuredLabel(label),
    status,
    documentation_level: "documented",
  };
}

function buildStructuredProjectCandidateFromDoc(
  doc: KB2ParsedDocument,
): KB2CandidateEntity | null {
  if (!["jira", "github", "confluence"].includes(doc.provider)) {
    return null;
  }
  const label = deriveStructuredProjectLabelFromDoc(doc);
  if (!label) return null;
  const firstUnit = getDocSourceUnits(doc)[0] ?? null;
  const sourceRef = buildEvidenceRefFromDoc(
    doc,
    (firstUnit?.text ?? doc.content).slice(0, 280),
    firstUnit,
  );
  const attrs = (doc.metadata ?? {}) as Record<string, unknown>;
  return {
    candidate_id: randomUUID(),
    display_name: label,
    type: "project",
    confidence: "medium",
    aliases: [doc.title].filter((alias) => alias.trim().toLowerCase() !== label.toLowerCase()),
    attributes: {
      owner_hint:
        normalizeOwnerHint(attrs.assignee) ??
        normalizeOwnerHint(attrs.author) ??
        normalizeOwnerHint(attrs.source_author),
      linked_ticket: typeof attrs.key === "string" ? attrs.key : undefined,
      linked_pr: attrs.prNumber,
      repo: attrs.repo,
      _candidate_stage: "step3",
      _candidate_origin: `structured-${doc.provider}-project-surface`,
      _observation_kind: "work_item_signal",
      _reasoning: `Structured ${doc.provider} title describes a feature surface that should remain available as a project candidate before validation.`,
    },
    source_refs: [sourceRef],
    observation_ids: [],
  };
}

function buildDeterministicSignalSeedsForUnit(
  doc: KB2ParsedDocument,
  unit: KB2SourceUnit,
): DeterministicSeedBundle {
  const observations: KB2Observation[] = [];
  const candidates: KB2CandidateEntity[] = [];

  if (!["confluence", "slack", "github"].includes(doc.provider)) {
    return { observations, candidates };
  }

  const text = unit.text.trim();
  if (text.length < 40) {
    return { observations, candidates };
  }

  const ownerHint = deriveOwnerHint(doc, unit);
  const baseAttributes: Record<string, unknown> = ownerHint ? { owner_hint: ownerHint } : {};
  const pushSignal = (args: {
    observation_kind: KB2Observation["observation_kind"];
    label: string;
    suggested_type: string;
    reasoning: string;
    confidence: KB2Observation["confidence"];
    excerpt: string;
    origin: string;
    promote_candidate?: boolean;
    attributes?: Record<string, unknown>;
  }) => {
    const source_ref = buildEvidenceRefFromDoc(doc, args.excerpt, unit);
    const observation = buildDeterministicObservation({
      doc,
      unitId: unit.unit_id,
      observation_kind: args.observation_kind,
      label: args.label,
      suggested_type: args.suggested_type,
      reasoning: args.reasoning,
      confidence: args.confidence,
      source_ref,
      attributes: {
        ...baseAttributes,
        ...(args.attributes ?? {}),
      },
    });
    observations.push(observation);
    if (args.promote_candidate) {
      candidates.push(buildCandidateFromObservation(observation, args.origin));
    }
  };

  const confluenceProjectSeed = deriveStructuredProjectSeedFromConfluenceUnit(doc, unit);
  if (confluenceProjectSeed) {
    pushSignal({
      observation_kind: "work_item_signal",
      label: confluenceProjectSeed.label,
      suggested_type: "project",
      reasoning: "A structured Confluence section names a concrete body of work and records its lifecycle, so it should remain available as a documented project candidate.",
      confidence: confluenceProjectSeed.status ? "high" : "medium",
      excerpt: unit.text.slice(0, 320),
      origin: "deterministic-confluence-section-project",
      promote_candidate: true,
      attributes: {
        documentation_level: confluenceProjectSeed.documentation_level,
        ...(confluenceProjectSeed.status ? { status: confluenceProjectSeed.status } : {}),
      },
    });
  }

  const hasPatternSignal = IMPLEMENTATION_CONTEXT_RE.test(text) && (
    PATTERN_TRIGGER_RE.test(text) ||
    (IMPLEMENTATION_ACTION_RE.test(text) && DECISION_TRIGGER_RE.test(text))
  );
  if (hasPatternSignal) {
    pushSignal({
      observation_kind: "pattern_signal",
      label: compactSignalLabel(
        chooseSignalExcerpt(text, [PATTERN_TRIGGER_RE, IMPLEMENTATION_CONTEXT_RE]),
        unit.title,
      ),
      suggested_type: "decision",
      reasoning: "This excerpt describes a reusable implementation rule or team default, so it should survive as a pattern signal for later convention synthesis.",
      confidence: DECISION_TRIGGER_RE.test(text) ? "high" : "medium",
      excerpt: chooseSignalExcerpt(text, [PATTERN_TRIGGER_RE, IMPLEMENTATION_CONTEXT_RE]),
      origin: "deterministic-pattern",
      promote_candidate: false,
      attributes: { signal_family: "implementation_pattern" },
    });
  }

  if (DECISION_TRIGGER_RE.test(text)) {
    const excerpt = chooseSignalExcerpt(text, [DECISION_TRIGGER_RE]);
    if (!shouldSuppressDecisionExcerpt(excerpt)) {
      pushSignal({
        observation_kind: "decision_signal",
        label: compactSignalLabel(normalizeDecisionLabelText(excerpt), unit.title),
        suggested_type: "decision",
        reasoning: "This excerpt contains an explicit choice, tradeoff, or standard and should remain available as a decision signal before canonicalization.",
        confidence: hasPatternSignal ? "high" : "medium",
        excerpt,
        origin: "deterministic-decision",
        promote_candidate:
          doc.provider === "slack" ||
          (doc.provider === "github" && unit.kind === "review_comment") ||
          !hasPatternSignal,
      });
    }
  }

  const processText = `${unit.title}\n${text}`;
  const strongProcessTitle = /\b(process|workflow|runbook|playbook|checklist|onboarding|deployment|sync)\b/i.test(unit.title);
  if (PROCESS_TRIGGER_RE.test(processText)) {
    const excerpt = chooseSignalExcerpt(`${unit.title}\n${text}`, [PROCESS_TRIGGER_RE]);
    const processLabel = strongProcessTitle
      ? compactSignalLabel(unit.title, "Workflow")
      : compactSignalLabel(excerpt, compactSignalLabel(unit.title, "Workflow"));
    pushSignal({
      observation_kind: "process_signal",
      label: processLabel,
      suggested_type: "process",
      reasoning: "This excerpt describes a repeatable human or delivery workflow, so it should be preserved as a process signal.",
      confidence: "medium",
      excerpt,
      origin: "deterministic-process",
      promote_candidate: strongProcessTitle || doc.provider !== "confluence",
    });
  }

  return { observations, candidates };
}

function buildDeterministicSeeds(
  docs: KB2ParsedDocument[],
): DeterministicSeedBundle {
  const observations: KB2Observation[] = [];
  const candidates: KB2CandidateEntity[] = [];

  for (const doc of docs) {
    const attrs = (doc.metadata ?? {}) as Record<string, any>;
    const primaryUnit = getDocSourceUnits(doc)[0] ?? null;
    const primaryRef = buildEvidenceRefFromDoc(
      doc,
      (primaryUnit?.text ?? doc.content).slice(0, 240),
      primaryUnit,
    );
    const unitId = primaryUnit?.unit_id ?? `${doc.sourceId}:deterministic`;

    if (doc.provider === "jira" && attrs.key) {
      const jiraDescription = extractJiraDescription(doc.content);
      const jiraSummary = doc.title.replace(/^[A-Z]+-\d+:\s*/i, "").trim() || doc.title;
      const ticketObservation = buildDeterministicObservation({
        doc,
        unitId,
        observation_kind: "candidate_entity",
        label: String(attrs.key),
        suggested_type: "ticket",
        reasoning: `Structured Jira issue ${attrs.key} is a tracked work item and should remain traceable as a ticket candidate.`,
        confidence: "high",
        source_ref: primaryRef,
        aliases: [doc.title].filter((value) => value !== attrs.key),
        attributes: {
          ticket_key: String(attrs.key),
          summary: jiraSummary,
          description: jiraDescription,
          issue_type: attrs.issue_type ?? attrs.issueType ?? attrs.type,
          status: attrs.status,
          raw_status: attrs.status,
          assignee: attrs.assignee,
          reporter: attrs.reporter,
          created_at: attrs.created,
          resolved_at: attrs.resolved,
          sprint: attrs.sprint,
        },
      });
      observations.push(ticketObservation);
      candidates.push({
        candidate_id: randomUUID(),
        display_name: String(attrs.key),
        type: "ticket",
        confidence: "high",
        aliases: [doc.title].filter((value) => value !== attrs.key),
        attributes: {
          ticket_key: String(attrs.key),
          summary: jiraSummary,
          description: jiraDescription,
          status: attrs.status,
          raw_status: attrs.status,
          priority: attrs.priority,
          issue_type: attrs.issue_type ?? attrs.issueType ?? attrs.type,
          assignee: attrs.assignee,
          reporter: attrs.reporter,
          created_at: attrs.created,
          resolved_at: attrs.resolved,
          sprint: attrs.sprint,
          _candidate_stage: "step3",
          _candidate_origin: "deterministic-jira",
        },
        source_refs: [primaryRef],
        observation_ids: [ticketObservation.observation_id],
      });

      const projectLabel = deriveStructuredProjectLabelFromDoc(doc);
      if (projectLabel) {
        const projectObservation = buildDeterministicObservation({
          doc,
          unitId,
          observation_kind: "work_item_signal",
          label: projectLabel,
          suggested_type: "project",
          reasoning: `Structured Jira work item ${attrs.key} describes a clear feature surface, so it should remain available as a project candidate before later validation and discovery.`,
          confidence: "medium",
          source_ref: primaryRef,
          aliases: [doc.title],
          attributes: {
            owner_hint: attrs.assignee,
            linked_ticket: attrs.key,
          },
        });
        observations.push(projectObservation);
        candidates.push(buildCandidateFromObservation(projectObservation, "deterministic-feature-surface"));
      }
    }

    if (doc.provider === "github" && attrs.prNumber) {
      const repositoryName = deriveRepositoryDisplayName(attrs.repo);
      if (repositoryName) {
        const repoObservation = buildDeterministicObservation({
          doc,
          unitId,
          observation_kind: "candidate_entity",
          label: repositoryName,
          suggested_type: "repository",
          reasoning: `Structured GitHub metadata identifies ${repositoryName} as the repository for PR #${attrs.prNumber}, so it should remain available as a first-class repository entity.`,
          confidence: "high",
          source_ref: primaryRef,
          aliases: typeof attrs.repo === "string" && attrs.repo.trim().toLowerCase() !== repositoryName.toLowerCase()
            ? [attrs.repo]
            : [],
          attributes: {
            repo: attrs.repo,
            pr_number: attrs.prNumber,
            _candidate_stage: "step3",
            _candidate_origin: "deterministic-github-repository",
          },
        });
        observations.push(repoObservation);
        candidates.push({
          candidate_id: randomUUID(),
          display_name: repositoryName,
          type: "repository",
          confidence: "high",
          aliases: typeof attrs.repo === "string" && attrs.repo.trim().toLowerCase() !== repositoryName.toLowerCase()
            ? [attrs.repo]
            : [],
          attributes: {
            repo: attrs.repo,
            _candidate_stage: "step3",
            _candidate_origin: "deterministic-github-repository",
          },
          source_refs: [primaryRef],
          observation_ids: [repoObservation.observation_id],
        });
      }

      const prObservation = buildDeterministicObservation({
        doc,
        unitId,
        observation_kind: "candidate_entity",
        label: doc.title,
        suggested_type: "pull_request",
        reasoning: `Structured GitHub pull request #${attrs.prNumber} should remain available as a first-class pull_request candidate with author and review provenance.`,
        confidence: "high",
        source_ref: primaryRef,
        attributes: {
          repo: attrs.repo,
          pr_number: attrs.prNumber,
          author: attrs.author,
          reviewers: attrs.reviewers,
          state: attrs.state,
          branch: attrs.branch,
        },
      });
      observations.push(prObservation);
      candidates.push({
        candidate_id: randomUUID(),
        display_name: doc.title,
        type: "pull_request",
        confidence: "high",
        aliases: [],
        attributes: {
          repo: attrs.repo,
          pr_number: attrs.prNumber,
          author: attrs.author,
          state: attrs.state,
          branch: attrs.branch,
          _candidate_stage: "step3",
          _candidate_origin: "deterministic-github",
        },
        source_refs: [primaryRef],
        observation_ids: [prObservation.observation_id],
      });

      const projectLabel = deriveStructuredProjectLabelFromDoc(doc);
      if (projectLabel) {
        const projectObservation = buildDeterministicObservation({
          doc,
          unitId,
          observation_kind: "work_item_signal",
          label: projectLabel,
          suggested_type: "project",
          reasoning: `Structured pull request #${attrs.prNumber} references a clear feature surface, so it should remain available as a project candidate before validation.`,
          confidence: "medium",
          source_ref: primaryRef,
          aliases: [doc.title],
          attributes: {
            owner_hint: attrs.author,
            linked_pr: attrs.prNumber,
            repo: attrs.repo,
          },
        });
        observations.push(projectObservation);
        candidates.push(buildCandidateFromObservation(projectObservation, "deterministic-feature-surface"));
      }
    }

    if (doc.provider === "customerFeedback") {
      const feedbackEntityObservation = buildDeterministicObservation({
        doc,
        unitId,
        observation_kind: "candidate_entity",
        label: doc.title,
        suggested_type: "customer_feedback",
        reasoning: "Structured customer feedback submission should remain traceable as a customer_feedback entity.",
        confidence: "high",
        source_ref: primaryRef,
        attributes: {
          requester: attrs.name,
          subject: attrs.subject,
          date: attrs.date,
        },
      });
      const feedbackSignalObservation = buildDeterministicObservation({
        doc,
        unitId,
        observation_kind: "feedback_signal",
        label: String(attrs.subject ?? doc.title),
        suggested_type: "customer_feedback",
        reasoning: "Customer feedback describing a request, pain point, or desired capability that may contribute to feature discovery.",
        confidence: "high",
        source_ref: primaryRef,
        attributes: {
          requester: attrs.name,
          subject: attrs.subject,
          date: attrs.date,
          requested_capability_hint: String(attrs.subject ?? doc.title),
        },
      });
      observations.push(feedbackEntityObservation, feedbackSignalObservation);
      candidates.push({
        candidate_id: randomUUID(),
        display_name: doc.title,
        type: "customer_feedback",
        confidence: "high",
        aliases: [],
        attributes: {
          requester: attrs.name,
          subject: attrs.subject,
          date: attrs.date,
          _candidate_stage: "step3",
          _candidate_origin: "deterministic-feedback",
        },
        source_refs: [primaryRef],
        observation_ids: [
          feedbackEntityObservation.observation_id,
          feedbackSignalObservation.observation_id,
        ],
      });
    }

    for (const unit of getDocSourceUnits(doc)) {
      const signalSeeds = buildDeterministicSignalSeedsForUnit(doc, unit);
      observations.push(...signalSeeds.observations);
      candidates.push(...signalSeeds.candidates);
    }
  }

  return { observations, candidates };
}

function candidateKey(displayName: string, type: string): string {
  return `${type.toLowerCase()}::${displayName.toLowerCase().trim()}`;
}

function upsertCandidate(
  map: Map<string, KB2CandidateEntity>,
  candidate: KB2CandidateEntity,
): void {
  const key = candidateKey(candidate.display_name, candidate.type);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, candidate);
    return;
  }
  existing.aliases = [...new Set([...existing.aliases, ...candidate.aliases])];
  existing.observation_ids = [...new Set([...existing.observation_ids, ...candidate.observation_ids])];
  appendUniqueSourceRefs(existing.source_refs, candidate.source_refs);
  existing.attributes = {
    ...existing.attributes,
    ...candidate.attributes,
    _candidate_stage: "step3",
  };
  if (existing.confidence !== "high" && candidate.confidence === "high") {
    existing.confidence = "high";
  }
}

function getCandidatePromotionDecision(
  observation: KB2Observation,
): { promote: boolean; reason: string } {
  const normalizedType = normalizeEntityType(observation.suggested_type);
  const sourceType = observation.source_ref.source_type;
  const text = `${observation.label} ${observation.reasoning} ${observation.evidence_excerpt}`.toLowerCase();

  if (observation.observation_kind === "feedback_signal") {
    return {
      promote: false,
      reason: "Feedback signal kept as observation only; deterministic feedback entities already preserve the submission.",
    };
  }

  if (observation.observation_kind === "pattern_signal") {
    return {
      promote: false,
      reason: "Pattern signals stay at the observation layer for later convention synthesis.",
    };
  }

  if (normalizedType === "project") {
    if (
      sourceType === "confluence" &&
      CONFLUENCE_UMBRELLA_RE.test(observation.label.toLowerCase()) &&
      !/\bfuture considerations\b/i.test(observation.label)
    ) {
      return {
        promote: false,
        reason: "Confluence umbrella phases and redesign headings stay as observation-only context instead of canonical project candidates.",
      };
    }
    if (sourceType === "slack" && PROJECT_FRAGMENT_RE.test(text)) {
      return {
        promote: false,
        reason: "Slack-only fragment like a card, button, endpoint, or test should stay observation-only until broader project evidence appears.",
      };
    }
    if (!DIRECT_PROJECT_SURFACE_RE.test(text) && /\b(improvement|improvements|work)\b/i.test(text)) {
      return {
        promote: false,
        reason: "Generic improvement/work phrasing without a concrete feature surface stays observation-only.",
      };
    }
    if (TASK_SHAPED_RE.test(text)) {
      return {
        promote: false,
        reason: "Weak task-shaped or planning-style project signal kept as observation only until validation.",
      };
    }
    if (sourceType === "slack" || sourceType === "confluence") {
      const review = projectCandidateReview({
        node_id: observation.observation_id,
        run_id: "preview",
        execution_id: "preview",
        type: "project",
        display_name: observation.label,
        aliases: observation.aliases ?? [],
        attributes: observation.attributes ?? {},
        source_refs: [observation.source_ref],
        truth_status: "inferred",
        confidence: observation.confidence,
      });
      if (!review.keep_as_project) {
        return {
          promote: false,
          reason: `Observation kept below the project layer: ${review.reason}`,
        };
      }
    }
    if (observation.confidence === "low") {
      if (DIRECT_PROJECT_SURFACE_RE.test(text)) {
        return {
          promote: true,
          reason: "Low-confidence but clearly feature-shaped project signal promoted to preserve project recall.",
        };
      }
      return {
        promote: false,
        reason: "Low-confidence project signal kept as observation only to reduce early ontology inflation.",
      };
    }
    if (!PROJECT_SURFACE_RE.test(text) && !INITIATIVE_RE.test(text) && sourceType !== "confluence") {
      return {
        promote: false,
        reason: "Project signal lacks clear feature or initiative shape, so it stays as observation-only evidence.",
      };
    }
  }

  if (normalizedType === "decision") {
    if (
      observation.observation_kind === "decision_signal" ||
      DECISION_TRIGGER_RE.test(text) ||
      (PATTERN_TRIGGER_RE.test(text) && IMPLEMENTATION_CONTEXT_RE.test(text))
    ) {
      return {
        promote: true,
        reason: "Decision-pattern signal is strong enough to become a candidate entity.",
      };
    }
    if (observation.confidence === "low") {
      return {
        promote: false,
        reason: "Weak decision-like signal kept as observation only.",
      };
    }
  }

  if (normalizedType === "process") {
    if (observation.observation_kind === "process_signal" || PROCESS_TRIGGER_RE.test(text)) {
      return {
        promote: true,
        reason: "Repeatable workflow signal is strong enough to become a process candidate.",
      };
    }
    return {
      promote: false,
      reason: "Process-like signal lacked explicit workflow language and stayed observation-only.",
    };
  }

  if (observation.observation_kind === "work_item_signal" && normalizedType !== "ticket" && observation.confidence === "low") {
    return {
      promote: false,
      reason: "Low-confidence work-item signal stayed at the observation layer.",
    };
  }

  return {
    promote: true,
    reason: "Observation has enough shape to be promoted as a candidate entity.",
  };
}

export const entityExtractionStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-entity-extraction-v2");
  const stepId = "pass1-step-3";
  const tc = getTenantCollections(ctx.companySlug);
  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  if (!snapshot) throw new Error("No input snapshot found — run step 1 first");

  const docs = snapshot.parsed_documents as KB2ParsedDocument[];
  const allUnits = docs.flatMap((doc) => getDocSourceUnits(doc).map((unit) => ({ doc, unit })));
  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  const modelName = getFastModelName(ctx.config?.pipeline_settings?.models);

  const observationMap = new Map<string, KB2Observation>();
  const candidateMap = new Map<string, KB2CandidateEntity>();
  const suppressedCandidateSamples: Array<{
    label: string;
    suggested_type: string;
    observation_kind: KB2Observation["observation_kind"];
    reason: string;
    source_ref: KB2Observation["source_ref"];
  }> = [];
  const suppressedCountsByType: Record<string, number> = {};
  let totalLLMCalls = 0;

  const deterministicSeeds = buildDeterministicSeeds(docs);
  for (const observation of deterministicSeeds.observations) {
    observationMap.set(observation.observation_id, observation);
  }
  for (const candidate of deterministicSeeds.candidates) {
    upsertCandidate(candidateMap, candidate);
  }
  for (const doc of docs) {
    const structuredProjectCandidate = buildStructuredProjectCandidateFromDoc(doc);
    if (structuredProjectCandidate) {
      upsertCandidate(candidateMap, structuredProjectCandidate);
    }
  }

  const totalBatches = Math.ceil(allUnits.length / UNIT_BATCH_SIZE);
  await ctx.onProgress(`Extracting candidate observations from ${allUnits.length} source units...`, 5);

  for (let i = 0; i < allUnits.length; i += UNIT_BATCH_SIZE) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");

    const batch = allUnits.slice(i, i + UNIT_BATCH_SIZE);
    const unitText = batch.map(({ doc, unit }, index) =>
      `--- Unit ${index + 1} [unit_id="${unit.unit_id}" doc_id="${doc.sourceId}" provider="${doc.provider}" kind="${unit.kind}"] : ${unit.title} ---\n${unit.text.slice(0, UNIT_TEXT_CAP)}`,
    ).join("\n\n");

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: ctx.config?.prompts?.entity_extraction?.system ?? EXTRACTION_PROMPT,
      prompt: unitText,
      schema: ObservationSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;

    if (usageData) {
      const cost = calculateCostUsd(modelName, usageData.promptTokens, usageData.completionTokens);
      await ctx.logLLMCall(
        stepId,
        modelName,
        unitText.slice(0, 10000),
        JSON.stringify(result, null, 2).slice(0, 10000),
        usageData.promptTokens,
        usageData.completionTokens,
        cost,
        Date.now() - startMs,
      );
    }

    const unitMap = new Map(batch.map(({ doc, unit }) => [unit.unit_id, { doc, unit }]));
    for (const observation of result.observations ?? []) {
      const matched = unitMap.get(observation.unit_id);
      if (!matched) continue;
      const normalizedType = normalizeEntityType(observation.suggested_type);
      const sourceRef = buildEvidenceRefFromDoc(
        matched.doc,
        observation.evidence_excerpt || matched.unit.text,
        matched.unit,
      );
      const observationId = randomUUID();

      observationMap.set(observationId, {
        observation_id: observationId,
        provider: matched.doc.provider,
        doc_id: matched.doc.sourceId,
        parent_doc_id: matched.doc.id,
        unit_id: matched.unit.unit_id,
        observation_kind: observation.observation_kind,
        label: observation.label,
        suggested_type: normalizedType,
        reasoning: observation.reasoning,
        confidence: observation.confidence,
        evidence_excerpt: sourceRef.excerpt,
        source_ref: sourceRef,
        aliases: observation.aliases ?? [],
        attributes: observation.attributes ?? {},
      });

      const observationRecord = observationMap.get(observationId)!;
      const promotionDecision = getCandidatePromotionDecision(observationRecord);
      if (!promotionDecision.promote) {
        suppressedCountsByType[normalizedType] = (suppressedCountsByType[normalizedType] || 0) + 1;
        if (suppressedCandidateSamples.length < 20) {
          suppressedCandidateSamples.push({
            label: observationRecord.label,
            suggested_type: normalizedType,
            observation_kind: observationRecord.observation_kind,
            reason: promotionDecision.reason,
            source_ref: observationRecord.source_ref,
          });
        }
        continue;
      }

      upsertCandidate(
        candidateMap,
        buildCandidateFromObservation(observationRecord, "observation"),
      );
    }

    const pct = Math.round(5 + ((i + batch.length) / Math.max(allUnits.length, 1)) * 85);
    await ctx.onProgress(
      `Processed unit batch ${Math.floor(i / UNIT_BATCH_SIZE) + 1}/${totalBatches}`,
      pct,
    );
  }

  const candidateNodes: KB2GraphNodeType[] = Array.from(candidateMap.values()).map((candidate) => ({
    node_id: candidate.candidate_id,
    run_id: ctx.runId,
    execution_id: ctx.executionId,
    type: candidate.type,
    display_name: candidate.display_name,
    aliases: candidate.aliases,
    attributes: {
      ...candidate.attributes,
      _candidate_entity: true,
      _validation_status: "pending",
      _observation_ids: candidate.observation_ids,
      _evidence_count: candidate.source_refs.length,
    },
    source_refs: candidate.source_refs,
    truth_status: "inferred",
    confidence: candidate.confidence,
  }));

  if (candidateNodes.length > 0) {
    await tc.graph_nodes_pre_resolution.insertMany(candidateNodes as any[]);
  }

  const observations = Array.from(observationMap.values());
  const observationsByKind = observations.reduce<Record<string, number>>((acc, observation) => {
    acc[observation.observation_kind] = (acc[observation.observation_kind] || 0) + 1;
    return acc;
  }, {});
  const candidatesByType = candidateNodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.type] = (acc[node.type] || 0) + 1;
    return acc;
  }, {});

  await ctx.onProgress(`Extracted ${candidateNodes.length} candidate entities from ${observations.length} observations`, 100);

  const prioritizedEntitySamples = [
    ...candidateNodes.filter((node) => node.type === "project"),
    ...candidateNodes.filter((node) => node.type === "customer_feedback"),
    ...candidateNodes.filter((node) => node.type === "decision"),
    ...candidateNodes,
  ];
  const uniqueSampleNodeIds = new Set<string>();
  const entitySamples = prioritizedEntitySamples
    .filter((node) => {
      if (uniqueSampleNodeIds.has(node.node_id)) return false;
      uniqueSampleNodeIds.add(node.node_id);
      return true;
    })
    .slice(0, 15)
    .map((node) => ({
    display_name: node.display_name,
    type: node.type,
    confidence: node.confidence,
    aliases: node.aliases,
    source_refs: node.source_refs,
    attributes: node.attributes,
    }));
  const signalSamplesByKind = Object.fromEntries(
    (["decision_signal", "process_signal", "pattern_signal"] as const).map((kind) => [
      kind,
      observations
        .filter((observation) => observation.observation_kind === kind)
        .slice(0, 6)
        .map((observation) => ({
          label: observation.label,
          suggested_type: observation.suggested_type,
          confidence: observation.confidence,
          reasoning: observation.reasoning,
          source_ref: observation.source_ref,
        })),
    ]),
  );
  const signalOwnerCountsByKind = Object.fromEntries(
    (["decision_signal", "process_signal", "pattern_signal"] as const).map((kind) => {
      const counts = new Map<string, number>();
      for (const observation of observations.filter((item) => item.observation_kind === kind)) {
        const ref = observation.source_ref as Record<string, unknown>;
        const owner =
          ref.slack_speaker ??
          ref.comment_author ??
          ref.pr_author ??
          ref.source_author ??
          ref.author;
        if (typeof owner !== "string" || !owner.trim()) continue;
        const normalizedOwner = owner.trim();
        counts.set(normalizedOwner, (counts.get(normalizedOwner) ?? 0) + 1);
      }
      return [
        kind,
        [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 8)
          .map(([owner, count]) => ({ owner, count })),
      ];
    }),
  );

  return {
    total_observations: observations.length,
    total_entities: candidateNodes.length,
    llm_calls: totalLLMCalls,
    observations_by_kind: observationsByKind,
    candidate_entities_by_type: candidatesByType,
    observation_only_counts_by_type: suppressedCountsByType,
    suppressed_candidate_samples: suppressedCandidateSamples,
    signal_samples_by_kind: signalSamplesByKind,
    signal_owner_counts_by_kind: signalOwnerCountsByKind,
    observations: observations.map((observation) => ({
      observation_id: observation.observation_id,
      provider: observation.provider,
      doc_id: observation.doc_id,
      parent_doc_id: observation.parent_doc_id,
      unit_id: observation.unit_id,
      label: observation.label,
      suggested_type: observation.suggested_type,
      observation_kind: observation.observation_kind,
      confidence: observation.confidence,
      evidence_excerpt: observation.evidence_excerpt,
      source_ref: observation.source_ref,
      reasoning: observation.reasoning,
      aliases: observation.aliases,
      attributes: observation.attributes,
    })),
    entities_by_type: Object.fromEntries(
      Object.entries(candidatesByType).map(([type]) => [
        type,
        candidateNodes
          .filter((node) => node.type === type)
          .map((node) => ({
            display_name: node.display_name,
            aliases: node.aliases,
            confidence: node.confidence,
            source_count: node.source_refs.length,
            source_refs: node.source_refs,
            attributes: node.attributes,
          })),
      ]),
    ),
    entity_samples: entitySamples,
    artifact_version: "pass1_v2",
  };
};
