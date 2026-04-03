import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import type {
  KB2Confidence,
  KB2EdgeType,
  KB2EvidenceRefType,
  KB2GraphEdgeType,
  KB2GraphNodeType,
  KB2NodeType,
} from "@/src/entities/models/kb2-types";

export type KB2SourceUnitKind =
  | "document"
  | "section"
  | "conversation"
  | "message"
  | "issue_description"
  | "comment"
  | "pr_description"
  | "review_comment"
  | "commit"
  | "submission";

export interface KB2SourceUnit {
  unit_id: string;
  parent_doc_id: string;
  provider: string;
  kind: KB2SourceUnitKind;
  anchor: string;
  title: string;
  text: string;
  order: number;
  metadata: Record<string, unknown>;
}

export interface KB2EvidenceSpan {
  span_id: string;
  doc_id: string;
  parent_doc_id: string;
  provider: string;
  unit_id: string;
  unit_kind: KB2SourceUnitKind;
  anchor: string;
  title: string;
  text: string;
  start_offset: number;
  end_offset: number;
  metadata: Record<string, unknown>;
}

export interface KB2Observation {
  observation_id: string;
  provider: string;
  doc_id: string;
  parent_doc_id: string;
  unit_id: string;
  observation_kind:
    | "candidate_entity"
    | "decision_signal"
    | "work_item_signal"
    | "process_signal"
    | "person_signal"
    | "feedback_signal"
    | "pattern_signal";
  label: string;
  suggested_type: string;
  reasoning: string;
  confidence: KB2Confidence;
  evidence_excerpt: string;
  source_ref: KB2EvidenceRefType & Record<string, unknown>;
  aliases: string[];
  attributes: Record<string, unknown>;
}

export interface KB2CandidateEntity {
  candidate_id: string;
  display_name: string;
  type: KB2NodeType;
  confidence: KB2Confidence;
  aliases: string[];
  attributes: Record<string, unknown>;
  source_refs: (KB2EvidenceRefType & Record<string, unknown>)[];
  observation_ids: string[];
}

export interface KB2PatternCandidate {
  pattern_id: string;
  owner_hint: string;
  title: string;
  pattern_rule: string;
  evidence_refs: (KB2EvidenceRefType & Record<string, unknown>)[];
  observation_ids: string[];
  source_unit_ids: string[];
  confidence: KB2Confidence;
}

export interface KB2DiscoveryHypothesis {
  hypothesis_id: string;
  display_name: string;
  suggested_type: "project" | "ticket" | "customer_feedback";
  category:
    | "past_undocumented"
    | "ongoing_undocumented"
    | "proposed_project"
    | "proposed_ticket"
    | "proposed_from_feedback";
  description: string;
  confidence: KB2Confidence;
  evidence_refs: (KB2EvidenceRefType & Record<string, unknown>)[];
  related_entities: string[];
}

export interface KB2TraversalQaCheck {
  node_name: string;
  node_type: string;
  has_owner_path: boolean;
  has_convention_path: boolean;
  has_evidence: boolean;
  blockers: string[];
}

const VALID_NODE_TYPES = new Set<KB2NodeType>([
  "team_member",
  "team",
  "client_company",
  "client_person",
  "repository",
  "integration",
  "infrastructure",
  "cloud_resource",
  "library",
  "database",
  "environment",
  "project",
  "decision",
  "process",
  "ticket",
  "pull_request",
  "pipeline",
  "customer_feedback",
]);

const TYPE_ALIASES: Record<string, KB2NodeType> = {
  service: "repository",
  app: "repository",
  application: "repository",
  repo: "repository",
  codebase: "repository",
  module: "repository",
  system: "infrastructure",
  component: "infrastructure",
  framework: "library",
  package: "library",
  dependency: "library",
  tool: "integration",
  platform: "integration",
  saas: "integration",
  aws: "cloud_resource",
  gcp: "cloud_resource",
  azure: "cloud_resource",
  user: "team_member",
  member: "team_member",
  employee: "team_member",
  person: "team_member",
  staff: "team_member",
  engineer: "team_member",
  customer: "client_person",
  organization: "client_company",
  company: "client_company",
  partner: "client_company",
  client: "client_company",
  feature: "project",
  initiative: "project",
  epic: "project",
  bug: "ticket",
  issue: "ticket",
  task: "ticket",
  story: "ticket",
  feedback: "customer_feedback",
  support_ticket: "customer_feedback",
  zendesk: "customer_feedback",
  pr: "pull_request",
  merge_request: "pull_request",
  ci: "pipeline",
  cd: "pipeline",
  decision_record: "decision",
  tradeoff: "decision",
  workflow: "process",
  procedure: "process",
  runbook: "process",
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value: string): string {
  return normalizeWhitespace(value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " "));
}

function truncateExcerpt(text: string, max = 800): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3).trim()}...`;
}

function makeFallbackUnit(doc: KB2ParsedDocument): KB2SourceUnit {
  return {
    unit_id: `${doc.id}:document`,
    parent_doc_id: doc.id,
    provider: doc.provider,
    kind: "document",
    anchor: doc.sourceId,
    title: doc.title,
    text: doc.content,
    order: 0,
    metadata: {},
  };
}

export function normalizeEntityType(raw: string): KB2NodeType {
  const lower = raw.toLowerCase().replace(/\s+/g, "_");
  if (VALID_NODE_TYPES.has(lower as KB2NodeType)) return lower as KB2NodeType;
  return TYPE_ALIASES[lower] ?? "infrastructure";
}

export function normalizeEvidenceSourceType(source: string): KB2EvidenceRefType["source_type"] {
  switch (source) {
    case "customerFeedback":
    case "customer_feedback":
    case "feedback":
    case "webform":
      return "customer_feedback";
    default:
      return source as KB2EvidenceRefType["source_type"];
  }
}

export function getDocSourceUnits(doc: KB2ParsedDocument): KB2SourceUnit[] {
  const rawUnits = (doc.metadata?.source_units ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(rawUnits) || rawUnits.length === 0) {
    return [makeFallbackUnit(doc)];
  }

  const normalized = rawUnits
    .map((unit, index) => ({
      unit_id: String(unit.unit_id ?? `${doc.id}:unit:${index + 1}`),
      parent_doc_id: doc.id,
      provider: doc.provider,
      kind: (String(unit.kind ?? "document") as KB2SourceUnitKind),
      anchor: String(unit.anchor ?? unit.unit_id ?? `${doc.sourceId}#unit-${index + 1}`),
      title: String(unit.title ?? doc.title),
      text: String(unit.text ?? "").trim(),
      order: Number(unit.order ?? index),
      metadata: (unit.metadata && typeof unit.metadata === "object") ? unit.metadata as Record<string, unknown> : {},
    }))
    .filter((unit) => unit.text.length > 0);

  return normalized.length > 0 ? normalized : [makeFallbackUnit(doc)];
}

export function buildEvidenceSpansForDoc(
  doc: KB2ParsedDocument,
  size: number,
  overlap: number,
): KB2EvidenceSpan[] {
  const spans: KB2EvidenceSpan[] = [];
  const units = getDocSourceUnits(doc);

  for (const unit of units) {
    if (unit.text.length <= size) {
      spans.push({
        span_id: `${unit.unit_id}:0`,
        doc_id: doc.sourceId,
        parent_doc_id: doc.id,
        provider: doc.provider,
        unit_id: unit.unit_id,
        unit_kind: unit.kind,
        anchor: unit.anchor,
        title: unit.title,
        text: unit.text,
        start_offset: 0,
        end_offset: unit.text.length,
        metadata: unit.metadata,
      });
      continue;
    }

    let start = 0;
    let index = 0;
    while (start < unit.text.length) {
      const end = Math.min(unit.text.length, start + size);
      spans.push({
        span_id: `${unit.unit_id}:${index}`,
        doc_id: doc.sourceId,
        parent_doc_id: doc.id,
        provider: doc.provider,
        unit_id: unit.unit_id,
        unit_kind: unit.kind,
        anchor: `${unit.anchor}#${index}`,
        title: unit.title,
        text: unit.text.slice(start, end).trim(),
        start_offset: start,
        end_offset: end,
        metadata: unit.metadata,
      });
      if (end >= unit.text.length) break;
      start += Math.max(1, size - overlap);
      index++;
    }
  }

  return spans;
}

export function deriveUnitAuthorshipMeta(
  unit: KB2SourceUnit,
): Record<string, unknown> {
  const meta = { ...unit.metadata };
  const derived: Record<string, unknown> = {};
  const speaker = meta.speaker ?? meta.author ?? meta.reviewer;
  if (typeof speaker === "string" && speaker.trim()) {
    if (unit.provider === "slack") derived.slack_speaker = speaker.trim();
    if (unit.provider === "github") derived.pr_author = speaker.trim();
  }
  if (Array.isArray(meta.reviewers) && meta.reviewers.length > 0) {
    derived.pr_reviewers = meta.reviewers;
  }
  if (typeof meta.comment_author === "string" && meta.comment_author.trim()) {
    derived.comment_author = meta.comment_author.trim();
  }
  if (typeof meta.author === "string" && meta.author.trim()) {
    derived.source_author = meta.author.trim();
  }
  if (typeof meta.timestamp === "string" && meta.timestamp.trim()) {
    derived.source_timestamp = meta.timestamp.trim();
  }
  return derived;
}

export function buildEvidenceRefFromDoc(
  doc: KB2ParsedDocument,
  excerpt: string,
  preferredUnit?: KB2SourceUnit | null,
): KB2EvidenceRefType & Record<string, unknown> {
  const unit = preferredUnit ?? findBestMatchingUnit(doc, excerpt);
  return {
    source_type: normalizeEvidenceSourceType(doc.provider),
    doc_id: doc.sourceId,
    title: doc.title,
    excerpt: truncateExcerpt(excerpt || unit?.text || doc.content),
    ...(unit?.title && unit.title !== doc.title ? { section_heading: unit.title } : {}),
    ...(unit ? deriveUnitAuthorshipMeta(unit) : {}),
  };
}

export function findBestMatchingUnit(
  doc: KB2ParsedDocument,
  excerpt: string,
): KB2SourceUnit | null {
  const units = getDocSourceUnits(doc);
  if (!excerpt.trim()) return units[0] ?? null;

  const needle = normalizeForMatch(excerpt);
  let best: KB2SourceUnit | null = null;
  let bestScore = 0;

  for (const unit of units) {
    const hay = normalizeForMatch(unit.text);
    if (hay.includes(needle) || needle.includes(hay)) {
      return unit;
    }
    const hayTokens = new Set(hay.split(" ").filter(Boolean));
    const needleTokens = new Set(needle.split(" ").filter(Boolean));
    let overlap = 0;
    for (const token of needleTokens) {
      if (hayTokens.has(token)) overlap++;
    }
    const score = needleTokens.size > 0 ? overlap / needleTokens.size : 0;
    if (score > bestScore) {
      bestScore = score;
      best = unit;
    }
  }

  return bestScore >= 0.4 ? best : (units[0] ?? null);
}

export function appendUniqueSourceRefs(
  target: (KB2EvidenceRefType & Record<string, unknown>)[],
  refs: Array<KB2EvidenceRefType & Record<string, unknown>>,
): (KB2EvidenceRefType & Record<string, unknown>)[] {
  const seen = new Set(target.map((ref) => `${ref.doc_id}|${ref.title}|${ref.excerpt}`));
  for (const ref of refs) {
    const key = `${ref.doc_id}|${ref.title}|${ref.excerpt}`;
    if (!seen.has(key)) {
      seen.add(key);
      target.push(ref);
    }
  }
  return target;
}

export function projectCandidateReview(
  node: KB2GraphNodeType,
): {
  keep_as_project: boolean;
  suggested_type: KB2NodeType;
  score: number;
  reason: string;
} {
  const name = node.display_name.trim();
  const lower = name.toLowerCase();
  const refs = node.source_refs ?? [];
  const attrs = (node.attributes ?? {}) as Record<string, unknown>;
  const sourceTypes = new Set(refs.map((ref) => ref.source_type));
  const hasConfluence = sourceTypes.has("confluence");
  const jiraOnly = sourceTypes.size === 1 && sourceTypes.has("jira");
  const githubOnly = sourceTypes.size === 1 && sourceTypes.has("github");
  const reasoningText = String(attrs._reasoning ?? "").toLowerCase();
  const evidenceText = refs
    .map((ref) => `${ref.title ?? ""} ${ref.excerpt ?? ""}`)
    .join(" ")
    .toLowerCase();
  const taskLike =
    /^([A-Z]+-\d+|pr\s*#\d+)/i.test(name) ||
    /^(fix|update|cleanup|refactor|investigate|bug|hotfix)\b/i.test(lower) ||
    /\b(copy|roadmap|planning|postmortem|onboarding|maintenance)\b/i.test(lower);
  const processLike = /\b(checklist|runbook|workflow|process|guide|playbook)\b/i.test(lower);
  const projectLike = /\b(project|feature|initiative|migration|redesign|rollout|launch|integration|dashboard|pipeline|standardization)\b/i.test(lower);
  const featureSurfaceLike = /\b(page|pages|portal|browser|dashboard|tracking|calendar|chooser|profiles|search|navigation|library|api|integration|pipeline|responsiveness|standardization)\b/i.test(lower);
  const initiativeSignal = /\b(q[1-4]\b|priority|priorities|body of work|initiative|workstream|confluence docs|docs up by|actively designed and built|distinct feature)\b/i
    .test(`${reasoningText} ${evidenceText}`);

  let score = 0;
  if (hasConfluence) score += 2;
  if (refs.length >= 2) score += 1;
  if (sourceTypes.size >= 2) score += 1;
  if (projectLike) score += 1;
  if (featureSurfaceLike) score += 1;
  if (initiativeSignal) score += 2;
  if (taskLike) score -= 3;
  if (jiraOnly && refs.length <= 1) score -= 2;
  if (githubOnly && refs.length <= 1) score -= 2;

  if (processLike) {
    return {
      keep_as_project: false,
      suggested_type: "process",
      score,
      reason: "Name and evidence look like a process or documentation workflow, not a project.",
    };
  }
  if (/^PR\s*#\d+/i.test(name) || githubOnly) {
    return {
      keep_as_project: false,
      suggested_type: "pull_request",
      score,
      reason: "Evidence is centered on a pull request rather than a multi-work-item initiative.",
    };
  }
  if (/^[A-Z]+-\d+/.test(name) || jiraOnly || taskLike) {
    return {
      keep_as_project: false,
      suggested_type: "ticket",
      score,
      reason: "Evidence looks like a single tracked work item rather than a project.",
    };
  }

  return {
    keep_as_project: score >= 2,
    suggested_type: score >= 2 ? "project" : "ticket",
    score,
    reason: score >= 2
      ? "Multiple sources or project-shaped evidence support keeping this as a project."
      : "Not enough multi-source or project-shaped evidence to treat this as a canonical project.",
  };
}

export function buildTraversalQa(
  nodes: KB2GraphNodeType[],
  edges: KB2GraphEdgeType[],
): { summary: Record<string, number>; checks: KB2TraversalQaCheck[] } {
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const outgoing = new Map<string, KB2GraphEdgeType[]>();
  const incoming = new Map<string, KB2GraphEdgeType[]>();
  for (const edge of edges) {
    const outList = outgoing.get(edge.source_node_id) ?? [];
    outList.push(edge);
    outgoing.set(edge.source_node_id, outList);

    const inList = incoming.get(edge.target_node_id) ?? [];
    inList.push(edge);
    incoming.set(edge.target_node_id, inList);
  }

  const ownerEdgeTypes = new Set<KB2EdgeType>(["OWNED_BY", "PROPOSED_BY", "LEADS", "MEMBER_OF"]);
  const conventionEdgeTypes = new Set<KB2EdgeType>(["APPLIES_TO", "CONTAINS", "RELATED_TO"]);
  const checks: KB2TraversalQaCheck[] = [];

  const focusNodeMap = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) {
    const attrs = (node.attributes ?? {}) as Record<string, unknown>;
    const discoveryCategory = typeof attrs.discovery_category === "string"
      ? attrs.discovery_category.trim()
      : "";
    const isDiscoveryFocus = (
      (node.type === "project" || node.type === "ticket") &&
      (discoveryCategory.length > 0 || attrs._hypothesis === true)
    );
    if (isDiscoveryFocus) {
      focusNodeMap.set(node.node_id, node);
    }
  }

  const conventionLinkedTargets = edges
    .filter((edge) => edge.type === "APPLIES_TO")
    .map((edge) => byId.get(edge.target_node_id))
    .filter((node): node is KB2GraphNodeType => Boolean(node && (node.type === "project" || node.type === "ticket")))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  for (const node of conventionLinkedTargets) {
    if (focusNodeMap.has(node.node_id)) continue;
    focusNodeMap.set(node.node_id, node);
    if (focusNodeMap.size >= 6) break;
  }

  const focusNodes = Array.from(focusNodeMap.values());

  for (const node of focusNodes) {
    const firstHop = outgoing.get(node.node_id) ?? [];
    const incomingHop = incoming.get(node.node_id) ?? [];
    const firstHopTargets = firstHop.map((edge) => byId.get(edge.target_node_id)).filter(Boolean) as KB2GraphNodeType[];

    const conventionTargetMap = new Map<string, KB2GraphNodeType>();
    const outgoingConventionTargets = firstHop
      .filter((edge) => conventionEdgeTypes.has(edge.type))
      .map((edge) => byId.get(edge.target_node_id))
      .filter((target) => Boolean(target && ((target.type === "decision" && (target.attributes as Record<string, unknown>)?.is_convention) || target.type === "process"))) as KB2GraphNodeType[];
    for (const target of outgoingConventionTargets) {
      conventionTargetMap.set(target.node_id, target);
    }
    const incomingConventionSources = incomingHop
      .filter((edge) => edge.type === "APPLIES_TO" || edge.type === "RELATED_TO")
      .map((edge) => byId.get(edge.source_node_id))
      .filter((target) => Boolean(target && ((target.type === "decision" && (target.attributes as Record<string, unknown>)?.is_convention) || target.type === "process"))) as KB2GraphNodeType[];
    for (const source of incomingConventionSources) {
      conventionTargetMap.set(source.node_id, source);
    }
    const conventionTargets = Array.from(conventionTargetMap.values());

    const ownerTargets = firstHop
      .filter((edge) => ownerEdgeTypes.has(edge.type))
      .map((edge) => byId.get(edge.target_node_id))
      .filter(Boolean) as KB2GraphNodeType[];

    let hasOwnerPath = ownerTargets.length > 0;
    const reachableEvidenceNodes = new Map<string, KB2GraphNodeType>();
    reachableEvidenceNodes.set(node.node_id, node);
    for (const target of firstHopTargets) reachableEvidenceNodes.set(target.node_id, target);
    for (const target of conventionTargets) reachableEvidenceNodes.set(target.node_id, target);
    for (const target of ownerTargets) reachableEvidenceNodes.set(target.node_id, target);
    if (!hasOwnerPath) {
      for (const convention of conventionTargets) {
        const conventionEdges = outgoing.get(convention.node_id) ?? [];
        const conventionOwners = conventionEdges
          .filter((edge) => ownerEdgeTypes.has(edge.type))
          .map((edge) => byId.get(edge.target_node_id))
          .filter(Boolean) as KB2GraphNodeType[];
        for (const owner of conventionOwners) {
          reachableEvidenceNodes.set(owner.node_id, owner);
        }
        if (conventionOwners.length > 0) {
          hasOwnerPath = true;
          break;
        }
      }
    }

    const blockers: string[] = [];
    const hasConventionPath = conventionTargets.length > 0;
    const hasEvidence = Array.from(reachableEvidenceNodes.values()).some((target) => (target.source_refs?.length ?? 0) > 0);
    if (!hasConventionPath) blockers.push("missing convention path");
    if (!hasOwnerPath) blockers.push("missing owner path");
    if (!hasEvidence) blockers.push("missing reachable evidence");

    checks.push({
      node_name: node.display_name,
      node_type: node.type,
      has_owner_path: hasOwnerPath,
      has_convention_path: hasConventionPath,
      has_evidence: hasEvidence,
      blockers,
    });
  }

  return {
    summary: {
      checked: checks.length,
      pass_owner_path: checks.filter((check) => check.has_owner_path).length,
      pass_convention_path: checks.filter((check) => check.has_convention_path).length,
      pass_evidence: checks.filter((check) => check.has_evidence).length,
      full_pass: checks.filter((check) => check.blockers.length === 0).length,
    },
    checks,
  };
}
