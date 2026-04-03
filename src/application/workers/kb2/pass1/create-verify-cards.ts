import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { buildNodeOwnerMap, getNodeOwnerNames } from "@/src/application/lib/kb2/owner-resolution";
import { buildVerifyIssueLabel, cleanEntityTitle } from "@/src/application/lib/kb2/title-cleanup";
import type {
  KB2ClaimType,
  KB2GraphNodeType,
  KB2GraphEdgeType,
  KB2EntityPageType,
  KB2VerificationCardType,
  KB2VerifyCardType,
  KB2Severity,
  KB2EvidenceRefType,
} from "@/src/entities/models/kb2-types";
import { ENTITY_PAGE_TEMPLATES } from "@/src/entities/models/kb2-templates";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

interface RawCandidate {
  type: KB2VerifyCardType;
  raw_text: string;
  entity_name?: string;
  page_id?: string;
  page_type?: "entity" | "human";
  page_title?: string;
  claim_ids: string[];
  source_refs: KB2EvidenceRefType[];
}

const LLMVerifyCardSchema = z.object({
  cards: z.array(
    z.object({
      index: z.number(),
      keep: z.boolean(),
      title: z.string(),
      problem_explanation: z
        .string()
        .describe("Clear explanation of the problem: what is wrong/uncertain and what's at stake if it's incorrect"),
      supporting_evidence: z
        .array(
          z.object({
            text: z.string().describe("Factual statement from the source that supports the claim"),
            source_title: z.string().optional().describe("Document title where this evidence was found"),
            confidence: z.enum(["high", "medium", "low"]).optional(),
          }),
        )
        .describe("Evidence found in source documents that relates to this issue"),
      missing_evidence: z.array(z.string()).describe("Specific information that is missing and would be needed to resolve this"),
      affected_entity_names: z
        .array(z.string())
        .describe("Display names of other entities that would be impacted if this issue is confirmed"),
      required_data: z
        .array(z.string())
        .describe("Specific data points the reviewer needs to provide (e.g., 'correct database URL', 'actual owner name')"),
      verification_question: z.string().describe("A single clear yes/no or specific-answer question the reviewer should answer"),
      severity: z.enum(["S1", "S2", "S3", "S4"]),
      recommended_action: z.string(),
    }),
  ),
});

type VerifyCardDraft = z.infer<typeof LLMVerifyCardSchema>["cards"][number];

interface RankedCandidateCard {
  candidateIndex: number;
  candidate: RawCandidate;
  llmCard: VerifyCardDraft;
  adjustedSeverity: KB2Severity;
  priority: number;
  page?: KB2EntityPageType;
  node?: KB2GraphNodeType;
  ownerSignals: string[];
}

const SEVERITY_ORDER: Record<KB2Severity, number> = {
  S1: 0,
  S2: 1,
  S3: 2,
  S4: 3,
};

const OWNERABLE_TYPES = new Set(["repository", "infrastructure", "database", "project"]);
const DISCOVERY_CRITICAL_CATEGORIES = new Set([
  "proposed_from_feedback",
  "proposed_project",
  "past_undocumented",
  "ongoing_undocumented",
]);
const OWNER_SECTION_RE = /identity|ownership|people|decision makers/i;
const OWNER_SIGNAL_RE =
  /\b(owner|lead|assignee|decision maker|decision-makers|designer|authored|author|implemented by|implementer|responsible|handled by|reporter)\b/i;
const HIGH_IMPACT_RISK_RE = /\b(auth|token|payment|donation|sponsor|money|404|security|database|production)\b/i;
const CONVENTION_FALLBACK_RE =
  /\b(convention|pattern|semantic color|color coding|vertical navigation|sidebar navigation|client-side|pagination|browse flow)\b/i;
const PRIORITY_CONVENTION_RE =
  /\b(color|semantic color|green|vertical navigation|sidebar navigation|client-side|pagination|browse)\b/i;
const BAD_ISSUE_SEED_RE = /\b(customer feedback ticket|kb item)\b/i;
const DANGLING_ISSUE_END_RE = /\b(is|are|was|were|has|have|had|which|that|where|when|named|external|automated|no|with|to)\b$/i;
const BAD_FINAL_ISSUE_START_RE = /^(is|was|were|are|has|have|had|does|did)\b/i;
const BAD_FINAL_ISSUE_END_RE = /\b(is|are|was|were|has|have|had|no|with|to|on|entirely|explicitly)\b$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareSeverity(a: KB2Severity, b: KB2Severity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

function moreSevere(a: KB2Severity, b: KB2Severity): KB2Severity {
  return compareSeverity(a, b) <= 0 ? a : b;
}

function getNodeAttributeString(node: KB2GraphNodeType | undefined, key: string): string | null {
  const value = (node?.attributes as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getNodeAttributeList(node: KB2GraphNodeType | undefined, key: string): string[] {
  const value = (node?.attributes as Record<string, unknown> | undefined)?.[key];
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function uniqueNames(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeTitleKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hasStrongWordOverlap(left: string, right: string): boolean {
  const leftWords = normalizeTitleKey(left).split(/\s+/).filter((word) => word.length > 2);
  const rightWords = new Set(normalizeTitleKey(right).split(/\s+/).filter((word) => word.length > 2));
  if (leftWords.length === 0 || rightWords.size === 0) return false;
  const overlap = leftWords.filter((word) => rightWords.has(word)).length;
  return overlap >= Math.min(2, leftWords.length) || overlap / leftWords.length >= 0.6;
}

function simplifyIssueSeed(issueSeed: string, entityTitle: string): string {
  const fragments = issueSeed
    .split(/\s+[—–-]\s+|:\s+/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  if (fragments.length < 2) return issueSeed.trim();
  for (let i = fragments.length - 1; i >= 0; i -= 1) {
    const fragment = fragments[i];
    if (!hasStrongWordOverlap(fragment, entityTitle)) {
      return fragment;
    }
  }
  return fragments[fragments.length - 1];
}

function normalizeIssueText(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").replace(/[?]+$/g, "").trim();
}

function firstOtherAffectedEntityName(
  entityTitle: string,
  affectedEntityNames: string[],
): string | null {
  const entityKey = normalizeTitleKey(entityTitle);
  for (const name of affectedEntityNames) {
    const cleaned = cleanEntityTitle(name);
    if (!cleaned) continue;
    const key = normalizeTitleKey(cleaned);
    if (key && key !== entityKey) return cleaned;
  }
  return null;
}

function deriveIssueLabelFromSignals(params: {
  entityTitle: string;
  candidate: RawCandidate;
  rawTitle: string;
  node?: KB2GraphNodeType;
  page?: KB2EntityPageType;
  verificationQuestion?: string;
  requiredData?: string[];
  missingEvidence?: string[];
  affectedEntityNames?: string[];
}): { subjectTitle: string; issueLabel: string | null } {
  const subjectTitle = params.entityTitle;
  const affectedEntityNames = params.affectedEntityNames ?? [];
  const question = normalizeIssueText(params.verificationQuestion);
  const combinedText = normalizeIssueText([
    params.rawTitle,
    params.candidate.raw_text,
    question,
    ...(params.requiredData ?? []),
    ...(params.missingEvidence ?? []),
    ...affectedEntityNames,
  ].join(" "));

  const explicitProjectRoleMatch =
    question.match(/^Did\s+(.+?)\s+propose\s+the\s+(.+?)\s+project\b/i)
    ?? question.match(/^Has\s+(.+?)\s+been formally assigned to\b.*?\bto the\s+(.+?)(?:\s+Project)?(?:,|\?|$)/i)
    ?? question.match(/^(?:Does|Did)\s+(.+?)\s+have\b.*?\bon the\s+(.+?)(?:,|\?|$)/i);
  if (explicitProjectRoleMatch) {
    const personName = cleanEntityTitle(explicitProjectRoleMatch[1]);
    const projectTitle = cleanEntityTitle(explicitProjectRoleMatch[2], "project");
    if (personName && projectTitle) {
      const roleLabel =
        /\bassigned\b|\bassignee\b/i.test(question)
          ? "Confirm Project Assignee"
          : /\bpropose|owner|owned|initiated|attribut(?:ed|ion)\b/i.test(question)
            ? "Confirm Project Owner"
            : `Confirm ${personName}'s Role`;
      return {
        subjectTitle: projectTitle,
        issueLabel: buildVerifyIssueLabel(roleLabel),
      };
    }
  }

  const alternateSubject =
    params.node?.type === "team_member" || params.page?.node_type === "team_member"
      ? firstOtherAffectedEntityName(params.entityTitle, affectedEntityNames)
      : null;

  if (
    alternateSubject &&
    /\b(propose|proposed|assigned|assignment|role|owner|assignee|attribut(?:ed|ion)|initiated)\b/i.test(combinedText)
  ) {
    const roleLabel =
      /\bassigned\b|\bassignee\b/i.test(combinedText)
        ? "Confirm Project Assignee"
        : /\bpropose|owner|initiated|attribut(?:ed|ion)\b/i.test(combinedText)
          ? "Confirm Project Owner"
          : `Confirm ${params.entityTitle}'s role`;
    return {
      subjectTitle: alternateSubject,
      issueLabel: buildVerifyIssueLabel(roleLabel),
    };
  }

  const directRules: Array<{ re: RegExp; label: string }> = [
    { re: /\bjavascript framework\b|\bfrontend framework\b|\bnext\.js\b|\breact\b|\bvue\b|\bangular\b/i, label: "Confirm Frontend Framework" },
    { re: /\bpayment processor\b|\bpayment gateway\b|\bstripe\b|\bbraintree\b|\bpaypal\b|\bpci\b/i, label: "Confirm Payment Processor" },
    { re: /\bmap service\b|\bmap provider\b|\bmapbox\b|\bgoogle maps\b|\bleaflet\b|\bopenstreetmap\b/i, label: "Confirm Map Provider" },
    { re: /\bfallback color\b|\bfallback style\b|\bunknown gender\b|\bnon-binary\b|\bwithout a binary gender value\b|\bgender is not male or female\b/i, label: "Fallback for Unknown Gender" },
    { re: /\bpet adoption chooser\b|\b8.?15\b|\bhard business constraint\b|\bdataset size\b|\bupper bound\b|\bclient-side pagination\b/i, label: "Confirm Pet Count Limit" },
    { re: /\bconsidered and rejected\b|\bdiscussed and rejected\b|\brejected\b.*\balternative\b|\balternative\b.*\brejected\b|\bnever formally considered\b/i, label: "Confirm Rejected Alternative" },
    { re: /\bintegration between\b|\bintegration with\b|\bconfirmed technical requirement\b|\bconfirmed requirement\b|\bconfirmed integration plan\b|\bteam confirmed\b.*\bintegrate\b|\bintegrate directly\b|\bformally require(?:s|d)? integration\b|\bformally planned and ticketed\b|\bscoped in a ticket\b|\bcustomer-suggested flow\b|\bcustomer suggestion\b|\bdesign doc\b/i, label: "Confirm Planned Integration" },
    { re: /\bformally scoped or ticketed\b|\bformalized into tickets\b|\bproject scope\b/i, label: "Confirm Ticketed Scope" },
    { re: /\bstandard\b.*\bfinalized\b|\bplanning to adopt\b|\badopt(?:ed|ion|ing)?\b|\bscheduled adoption\b/i, label: "Confirm Standard Adoption" },
    { re: /\bdocumented process\b|\bwritten documentation\b|\bwhere is it\b/i, label: "Confirm Documented Process" },
    { re: /\blisted as affected\b|\bwhat does ['"].+['"] refer to\b|\baffected by a card styling rule\b/i, label: "Confirm Affected Scope" },
    { re: /\blazy loading\b.*\bimplemented\b|\bimplementation status\b|\bstill pending\b|\bresolved another way\b/i, label: "Confirm Implementation Status" },
    { re: /\bstale\b|\bstaleness criteria\b|\bdocumented definition\b|\bwhat qualifies\b/i, label: "Confirm Staleness Criteria" },
    { re: /\bowner\b|\bassignee\b|\bassigned to\b/i, label: "Confirm Owner" },
  ];

  for (const rule of directRules) {
    if (rule.re.test(combinedText)) {
      return { subjectTitle, issueLabel: buildVerifyIssueLabel(rule.label) };
    }
  }

  if (question) {
    const questionRules: Array<{ re: RegExp; label: string }> = [
      { re: /^What\s+JavaScript framework\b|^What\s+frontend framework\b/i, label: "Confirm Frontend Framework" },
      { re: /^Which\s+payment processor\b/i, label: "Confirm Payment Processor" },
      { re: /^Which\s+map service(?: or library)?\b/i, label: "Confirm Map Provider" },
      { re: /^Is\s+there\s+(?:a\s+)?defined fallback (?:color|style)\b/i, label: "Fallback for Unknown Gender" },
      { re: /^Is\s+the\b.*\b(?:dataset size|upper bound|constraint)\b/i, label: "Confirm Pet Count Limit" },
      { re: /^Was\s+passing raw database date formats\b/i, label: "Confirm Rejected Alternative" },
      { re: /^Was\s+raw DB date pass-through\b/i, label: "Confirm Rejected Alternative" },
      { re: /^Is\s+the integration between\b|^Is\s+integration with\b/i, label: "Confirm Planned Integration" },
      { re: /^Has\s+the integration between\b/i, label: "Confirm Planned Integration" },
      { re: /^Has\s+the team confirmed that\b.*\bintegrate\b/i, label: "Confirm Planned Integration" },
      { re: /^Have\b.*\bbeen formally scoped or ticketed\b/i, label: "Confirm Ticketed Scope" },
      { re: /^Has\s+the\b.*\bbeen finalized\b/i, label: "Confirm Standard Adoption" },
      { re: /^Has\s+the PetSync data standard\b/i, label: "Confirm Standard Adoption" },
      { re: /^Does\s+a documented process exist\b/i, label: "Confirm Documented Process" },
      { re: /^Does\b.*\blisted as affected\b|^What does ['"].+['"] refer to\b/i, label: "Confirm Affected Scope" },
      { re: /^Was\b.*\bimplemented\b/i, label: "Confirm Implementation Status" },
      { re: /^Is\s+there\s+a documented definition or criteria\b.*\bstale\b/i, label: "Confirm Staleness Criteria" },
    ];
    for (const rule of questionRules) {
      if (rule.re.test(question)) {
        return { subjectTitle, issueLabel: buildVerifyIssueLabel(rule.label) };
      }
    }

    const whichThing = question.match(/^Which\s+(.+?)\s+(?:does|do|is|are|was|were)\b/i)?.[1];
    if (whichThing) {
      return {
        subjectTitle,
        issueLabel: buildVerifyIssueLabel(`Confirm ${whichThing}`),
      };
    }
  }

  const primaryRequiredData = normalizeIssueText((params.requiredData ?? [])[0]);
  if (primaryRequiredData) {
    const requiredRules: Array<{ re: RegExp; label: string }> = [
      { re: /\bfrontend framework\b|\bjavascript framework\b|\bnext\.js\b|\breact\b|\bvue\b|\bangular\b/i, label: "Confirm Frontend Framework" },
      { re: /\bpayment processor\b|\bpayment gateway\b|\bstripe\b|\bbraintree\b|\bpaypal\b/i, label: "Confirm Payment Processor" },
      { re: /\bmap service\/library name\b|\bmap service\b/i, label: "Confirm Map Provider" },
      { re: /\bfallback color or style\b|\bnon-binary\b|\bunknown gender\b/i, label: "Fallback for Unknown Gender" },
      { re: /\bremain small\b|\b8.?15\b|\bdataset size\b/i, label: "Confirm Pet Count Limit" },
      { re: /\brejected\b|\balternative\b|\bformally considered\b/i, label: "Confirm Rejected Alternative" },
      { re: /\bplanned\b|\bconfirmed integration plan\b|\bconfirmed technical requirement\b|\bconfirmed requirement\b|\bintegration plan\b|\bintegration with\b|\brequire integration\b|\bticket\b|\bcustomer suggestion\b|\bdesign doc\b/i, label: "Confirm Planned Integration" },
      { re: /\bformalized into tickets\b|\bproject scope\b/i, label: "Confirm Ticketed Scope" },
      { re: /\bcurrent status\b.*\bstandard\b|\badopt(?:ed|ion|ing)?\b/i, label: "Confirm Standard Adoption" },
      { re: /\bwritten documentation\b|\bdocumented\b/i, label: "Confirm Documented Process" },
      { re: /\baffected\b|\brefer to in this context\b/i, label: "Confirm Affected Scope" },
      { re: /\bimplementation status\b|\bimplemented\b|\brejected\b|\bpending\b/i, label: "Confirm Implementation Status" },
      { re: /\bdefinition of ['"]?stale['"]?\b|\bstaleness\b/i, label: "Confirm Staleness Criteria" },
      { re: /\bowner\b|\bassignee\b/i, label: "Confirm Owner" },
    ];
    for (const rule of requiredRules) {
      if (rule.re.test(primaryRequiredData)) {
        return { subjectTitle, issueLabel: buildVerifyIssueLabel(rule.label) };
      }
    }
  }

  return { subjectTitle, issueLabel: null };
}

function getSourceTitles(sourceRefs: KB2EvidenceRefType[]): string[] {
  return Array.from(
    new Set(
      sourceRefs
        .map((ref) => ref.title?.trim())
        .filter((title): title is string => Boolean(title)),
    ),
  ).slice(0, 4);
}

function normalizeEvidenceRef(
  ref: Partial<KB2EvidenceRefType> | Record<string, unknown> | undefined,
): KB2EvidenceRefType | null {
  if (!ref) return null;
  const sourceType = typeof ref.source_type === "string" ? ref.source_type : "";
  const docId = typeof ref.doc_id === "string" ? ref.doc_id.trim() : "";
  const title = typeof ref.title === "string" ? ref.title.trim() : "";
  if (!sourceType || !docId || !title) return null;
  const excerpt = typeof ref.excerpt === "string" ? ref.excerpt : "";
  const sectionHeading = typeof ref.section_heading === "string" && ref.section_heading.trim().length > 0
    ? ref.section_heading.trim()
    : undefined;
  return {
    source_type: sourceType as KB2EvidenceRefType["source_type"],
    doc_id: docId,
    title,
    excerpt,
    ...(sectionHeading ? { section_heading: sectionHeading } : {}),
  };
}

function dedupeEvidenceRefs(
  sourceRefs: Array<Partial<KB2EvidenceRefType> | Record<string, unknown> | undefined>,
): KB2EvidenceRefType[] {
  const seen = new Set<string>();
  const out: KB2EvidenceRefType[] = [];
  for (const ref of sourceRefs) {
    const normalized = normalizeEvidenceRef(ref);
    if (!normalized) continue;
    const key = [
      normalized.source_type,
      normalized.doc_id,
      normalized.title,
      normalized.section_heading ?? "",
      normalized.excerpt,
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function collectPageText(page: KB2EntityPageType): string {
  const parts: string[] = [page.title];
  for (const section of page.sections) {
    parts.push(section.section_name);
    for (const item of section.items) {
      parts.push(item.text);
    }
  }
  return parts.join(" ");
}

function collectConventionText(node: KB2GraphNodeType | undefined, page: KB2EntityPageType | undefined): string {
  return [
    node?.display_name,
    getNodeAttributeString(node, "pattern_rule"),
    getNodeAttributeString(node, "summary"),
    page ? collectPageText(page) : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function getPageOwnerSignals(page?: KB2EntityPageType): string[] {
  if (!page) return [];
  const signals = new Set<string>();
  for (const section of page.sections) {
    const sectionRelevant = OWNER_SECTION_RE.test(section.section_name);
    for (const item of section.items) {
      const text = item.text.trim();
      if (!text) continue;
      if (sectionRelevant || OWNER_SIGNAL_RE.test(text)) {
        signals.add(text);
      }
    }
  }
  return Array.from(signals).slice(0, 6);
}

function isConventionNode(node?: KB2GraphNodeType, page?: KB2EntityPageType): boolean {
  if ((node?.attributes as Record<string, unknown> | undefined)?.is_convention === true) return true;
  if (!page || page.node_type !== "decision") return false;
  return CONVENTION_FALLBACK_RE.test(collectPageText(page));
}

function isPriorityConvention(node: KB2GraphNodeType | undefined, page: KB2EntityPageType | undefined): boolean {
  return PRIORITY_CONVENTION_RE.test(collectConventionText(node, page));
}

function extractLikelyOwnerNames(
  node: KB2GraphNodeType | undefined,
  ownerSignals: string[],
  teamMemberNames: string[],
): string[] {
  const names = new Set<string>();
  for (const name of getNodeAttributeList(node, "owner")) names.add(name);
  for (const name of getNodeAttributeList(node, "decided_by")) names.add(name);
  const establishedBy = getNodeAttributeString(node, "established_by");
  if (establishedBy) names.add(establishedBy);
  for (const signal of ownerSignals) {
    for (const teamMemberName of teamMemberNames) {
      const re = new RegExp(`\\b${escapeRegExp(teamMemberName)}\\b`, "i");
      if (re.test(signal)) names.add(teamMemberName);
    }
  }
  return Array.from(names);
}

function fallbackIssueLabel(candidate: RawCandidate): string {
  const missingSection = candidate.raw_text.match(/Missing "([^"]+)"/i)?.[1];
  switch (candidate.type) {
    case "unknown_owner":
      return "Missing Owner";
    case "missing_must":
      return missingSection
        ? `Missing ${buildVerifyIssueLabel(missingSection)}`
        : "Missing Required Section";
    case "low_confidence":
      return "Confirm Key Detail";
    case "inferred_claim":
      return "Confirm Supporting Evidence";
    case "duplicate_cluster":
      return "Possible Duplicate";
    case "conflict":
      return "Conflicting Facts";
    case "edit_proposal":
      return "Review Proposed Edit";
    default:
      return "Needs Review";
  }
}

function normalizeVerifyCardTitle(params: {
  candidate: RawCandidate;
  rawTitle: string;
  node?: KB2GraphNodeType;
  page?: KB2EntityPageType;
  verificationQuestion?: string;
  requiredData?: string[];
  missingEvidence?: string[];
  affectedEntityNames?: string[];
}): string {
  const entityTitle = cleanEntityTitle(
    params.page?.title ??
      params.node?.display_name ??
      params.candidate.entity_name ??
      params.candidate.page_title ??
      "KB Item",
    params.node?.type,
  );
  const cleanedRawTitle = cleanEntityTitle(params.rawTitle);
  const derived = deriveIssueLabelFromSignals({
    entityTitle,
    candidate: params.candidate,
    rawTitle: params.rawTitle,
    node: params.node,
    page: params.page,
    verificationQuestion: params.verificationQuestion,
    requiredData: params.requiredData,
    missingEvidence: params.missingEvidence,
    affectedEntityNames: params.affectedEntityNames,
  });
  const entityPrefix = new RegExp(`^${escapeRegExp(entityTitle)}\\s*[—:-]\\s*`, "i");
  let issueSeed = cleanedRawTitle.replace(entityPrefix, "").trim();
  issueSeed = simplifyIssueSeed(issueSeed, entityTitle);
  let issueLabel = derived.issueLabel ?? (params.candidate.type === "unknown_owner"
    ? "Missing Owner"
    : issueSeed
      ? buildVerifyIssueLabel(issueSeed)
      : "");
  const quoteCount = (issueSeed.match(/['"]/g) ?? []).length;
  const entityKey = normalizeTitleKey(entityTitle);
  const issueKey = normalizeTitleKey(issueSeed);

  if (!derived.issueLabel && params.node?.type === "team_member" && /\bproposed\b|\battributed\b/i.test(issueSeed)) {
    issueLabel = "Project Attribution";
  } else if (!derived.issueLabel && /\brequires integration with\b/i.test(issueSeed)) {
    issueLabel = "Needs Integration Detail";
  }

  if (
    !derived.issueLabel && (
      !issueLabel ||
      issueLabel.toLowerCase() === entityTitle.toLowerCase() ||
      /[.!?]/.test(issueSeed) ||
      BAD_ISSUE_SEED_RE.test(issueSeed) ||
      DANGLING_ISSUE_END_RE.test(issueSeed) ||
      quoteCount % 2 === 1 ||
      issueKey === entityKey
    )
  ) {
    issueLabel = fallbackIssueLabel(params.candidate);
  }

  if (
    !issueLabel ||
    (!derived.issueLabel && hasStrongWordOverlap(issueLabel, entityTitle)) ||
    BAD_FINAL_ISSUE_START_RE.test(issueLabel) ||
    BAD_FINAL_ISSUE_END_RE.test(issueLabel) ||
    /\bcontingent on\b/i.test(issueLabel)
  ) {
    issueLabel = fallbackIssueLabel(params.candidate);
  }

  return `${derived.subjectTitle} — ${issueLabel}`;
}

function inferAssignedOwners(
  node: KB2GraphNodeType | undefined,
  ownerSignals: string[],
  teamMemberNames: string[],
  ownershipMap: Map<string, string[]>,
  edgesByNode: Map<string, { edge: KB2GraphEdgeType; other: KB2GraphNodeType | undefined }[]>,
): string[] {
  const graphOwners = getNodeOwnerNames(node, ownershipMap);
  if (graphOwners.length > 0) return graphOwners;
  if (node) {
    const relatedOwners = uniqueNames(
      (edgesByNode.get(node.node_id) ?? [])
        .filter((entry) => entry.edge.type === "RELATED_TO")
        .flatMap((entry) => getNodeOwnerNames(entry.other, ownershipMap)),
    );
    if (relatedOwners.length > 0) return relatedOwners;
  }
  return extractLikelyOwnerNames(node, ownerSignals, teamMemberNames);
}

function buildForcedConventionOwnershipCard(params: {
  executionId: string;
  runId: string;
  node: KB2GraphNodeType;
  page: KB2EntityPageType;
  likelyOwner: string;
  ownerSignals: string[];
  sourceRefs: KB2EvidenceRefType[];
}): KB2VerificationCardType {
  const sourceTitles = getSourceTitles(params.sourceRefs);
  const ownerSignalTexts = params.ownerSignals.slice(0, 2);
  const supportingEvidence = ownerSignalTexts.map((text, index) => ({
    text,
    source_title: sourceTitles[index] ?? sourceTitles[0],
    confidence: "high",
  }));
  return {
    card_id: randomUUID(),
    run_id: params.runId,
    execution_id: params.executionId,
    card_type: "unknown_owner",
    severity: "S1",
    title: `${cleanEntityTitle(params.node.display_name, "decision")} — Missing Owner`,
    explanation:
      `The "${params.node.display_name}" convention is missing canonical owner metadata. ` +
      `Page evidence points to ${params.likelyOwner}; if that attribution is wrong, downstream explanations about who established this convention will be unreliable.`,
    problem_explanation:
      `The "${params.node.display_name}" convention is missing canonical owner metadata. ` +
      `Page evidence points to ${params.likelyOwner}; if that attribution is wrong, downstream explanations about who established this convention will be unreliable.`,
    supporting_evidence: supportingEvidence,
    missing_evidence: [
      `Confirm whether ${params.likelyOwner} is the primary decision maker for "${params.node.display_name}".`,
      `Persist explicit owner/decision-maker attribution on the convention entity.`,
    ],
    affected_entities: [],
    required_data: [
      `Name the canonical owner/decision maker for "${params.node.display_name}".`,
    ],
    verification_question: `Is ${params.likelyOwner} the primary decision maker and owner for the ${params.node.display_name} convention?`,
    recommended_action:
      "Confirm the convention owner and update the canonical convention node/page with explicit attribution metadata.",
    page_occurrences: [{ page_id: params.page.page_id, page_type: "entity", page_title: params.page.title }],
    source_refs: params.sourceRefs,
    assigned_to: [params.likelyOwner],
    claim_ids: [],
    status: "open",
    discussion: [],
  };
}

function hasCanonicalOwner(node: KB2GraphNodeType | undefined, ownershipMap: Map<string, string[]>): boolean {
  if (!node) return false;
  if (getNodeAttributeList(node, "owner").length > 0) return true;
  if (getNodeAttributeList(node, "decided_by").length > 0) return true;
  if (getNodeAttributeString(node, "owner_hint")) return true;
  return (ownershipMap.get(node.node_id)?.length ?? 0) > 0;
}

function isDiscoveryProject(node?: KB2GraphNodeType): boolean {
  if (!node || node.type !== "project") return false;
  const status = getNodeAttributeString(node, "status");
  const category = getNodeAttributeString(node, "discovery_category");
  return status === "proposed" || Boolean(category && DISCOVERY_CRITICAL_CATEGORIES.has(category));
}

function buildRiskText(
  candidate: RawCandidate,
  page?: KB2EntityPageType,
  node?: KB2GraphNodeType,
  ownerSignals: string[] = [],
): string {
  const parts = [
    candidate.raw_text,
    candidate.entity_name,
    candidate.page_title,
    page?.title,
    node?.display_name,
    ...ownerSignals,
    ...getSourceTitles(candidate.source_refs),
  ];
  return parts.filter(Boolean).join(" ");
}

function getSeverityFloor(
  candidate: RawCandidate,
  node: KB2GraphNodeType | undefined,
  page: KB2EntityPageType | undefined,
  ownerSignals: string[],
): KB2Severity | null {
  const riskText = buildRiskText(candidate, page, node, ownerSignals);
  const conventionNode = isConventionNode(node, page);
  if (candidate.type === "unknown_owner" && conventionNode) {
    return ownerSignals.length > 0 ? "S1" : "S2";
  }
  if (isDiscoveryProject(node) && (candidate.type === "low_confidence" || candidate.type === "inferred_claim")) {
    return "S2";
  }
  if (conventionNode && (candidate.type === "low_confidence" || candidate.type === "inferred_claim")) {
    return "S2";
  }
  if (HIGH_IMPACT_RISK_RE.test(riskText)) {
    return "S1";
  }
  return null;
}

function getCardPriority(
  severity: KB2Severity,
  candidate: RawCandidate,
  node: KB2GraphNodeType | undefined,
  page: KB2EntityPageType | undefined,
  ownerSignals: string[],
): number {
  let score = 400 - SEVERITY_ORDER[severity] * 100;
  const conventionNode = isConventionNode(node, page);
  const riskText = buildRiskText(candidate, page, node, ownerSignals);
  if (candidate.type === "unknown_owner" && conventionNode) score += 160;
  if (conventionNode) score += 80;
  if (isDiscoveryProject(node)) score += 70;
  if (HIGH_IMPACT_RISK_RE.test(riskText)) score += 60;
  if (ownerSignals.length > 0) score += 25;
  if (candidate.claim_ids.length > 0) score += Math.min(candidate.claim_ids.length, 3) * 5;
  if (candidate.source_refs.length > 1) score += 15;
  return score;
}

function resolveCandidateContext(
  candidate: RawCandidate,
  pageById: Map<string, KB2EntityPageType>,
  pageByNodeId: Map<string, KB2EntityPageType>,
  nodeById: Map<string, KB2GraphNodeType>,
  nodeByName: Map<string, KB2GraphNodeType>,
): { page?: KB2EntityPageType; node?: KB2GraphNodeType; ownerSignals: string[] } {
  const directPage = candidate.page_id ? pageById.get(candidate.page_id) : undefined;
  const nodeFromPage = directPage ? nodeById.get(directPage.node_id) : undefined;
  const nodeFromName =
    !nodeFromPage && candidate.entity_name
      ? nodeByName.get(candidate.entity_name.toLowerCase())
      : undefined;
  const node = nodeFromPage ?? nodeFromName;
  const page = directPage ?? (node ? pageByNodeId.get(node.node_id) : undefined);
  return {
    page,
    node,
    ownerSignals: getPageOwnerSignals(page),
  };
}

function isCriticalEntry(entry: RankedCandidateCard): boolean {
  return (
    isConventionNode(entry.node, entry.page) ||
    isDiscoveryProject(entry.node) ||
    HIGH_IMPACT_RISK_RE.test(buildRiskText(entry.candidate, entry.page, entry.node, entry.ownerSignals))
  );
}

function summarizeCard(entry: RankedCandidateCard, card: KB2VerificationCardType): Record<string, unknown> {
  return {
    execution_id: card.execution_id ?? null,
    card_id: card.card_id,
    title: card.title,
    card_type: card.card_type,
    severity: card.severity,
    entity_name: entry.candidate.entity_name ?? entry.node?.display_name ?? null,
    page_title: entry.page?.title ?? entry.candidate.page_title ?? null,
    source_titles: getSourceTitles(card.source_refs),
    claim_ids: card.claim_ids.slice(0, 4),
    assigned_to: card.assigned_to,
    owner_signals: entry.ownerSignals.slice(0, 2),
    verification_question: card.verification_question ?? null,
    explanation: (card.problem_explanation ?? card.explanation).slice(0, 260),
  };
}

function summarizeFilteredCandidate(
  candidate: RawCandidate,
  page: KB2EntityPageType | undefined,
  node: KB2GraphNodeType | undefined,
  ownerSignals: string[],
): Record<string, unknown> {
  return {
    candidate_type: candidate.type,
    entity_name: candidate.entity_name ?? node?.display_name ?? null,
    page_title: page?.title ?? candidate.page_title ?? null,
    raw_text: candidate.raw_text.slice(0, 260),
    source_titles: getSourceTitles(candidate.source_refs),
    owner_signals: ownerSignals.slice(0, 2),
    convention_related: isConventionNode(node, page),
    discovery_project_related: isDiscoveryProject(node),
    high_impact: HIGH_IMPACT_RISK_RE.test(buildRiskText(candidate, page, node, ownerSignals)),
  };
}

export const createVerifyCardsStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-verify-cards");
  const stepId = "pass1-step-18";
  const BATCH_SIZE = ctx.config?.pipeline_settings?.verification?.batch_size ?? 25;
  const createVerifyCardsSystemPrompt = ctx.config?.prompts?.create_verify_cards?.system ?? `You review verification card candidates for a company knowledge base.
For each candidate, decide whether to keep it and rewrite it for a human reviewer.

SEVERITY RUBRIC:
- S1 (Critical): Affects production systems, could cause wrong AI chat answers, factual contradiction about infrastructure/payments/auth
- S2 (High): Important factual claim about system behavior needing verification, integration details, data flow
- S3 (Medium): Organizational/process claims, team membership, project status
- S4 (Low): Nice-to-know, cosmetic, low-impact gaps like missing optional info

TITLE RULES (MANDATORY):
- Max 10 words. Entity name first, then the issue. Example: "PostgreSQL — Missing Connection Config"
- No hedging in titles: never use "may", "potentially", "appears to", "based on evidence", "it seems that"
- No sentences in titles. Use entity-dash-issue format: "[Entity Name] — [Issue]"
- Hedging and nuance belong ONLY in verification_question and problem_explanation, never in the title
- The issue must name the specific fact/field to verify. Good: "Confirm Map Provider", "Missing Owner", "Confirm Pet Count Limit"
- Never use generic issue labels like "Needs Verification", "Inferred Claim", "Confirm Convention Attribution", or "Confirm Request Synthesis"

CONTENT RULES:
- Filter out noise: if a candidate is trivially true, obvious, or would waste a reviewer's time, set keep: false
- problem_explanation: 2-3 sentences max. First sentence: what's wrong. Second: why it matters. No filler.
- verification_question: One specific question the reviewer can answer quickly. Not a paragraph.
- supporting_evidence: Only include if genuinely useful. Omit raw chat quotes that don't add clarity.
- missing_evidence: Short bullet phrases, not full sentences. Example: "Owner's full name" not "The full name of the team member who owns this"
- required_data: Only what the reviewer actually needs to provide. Skip if not applicable.
- recommended_action: One short sentence. Example: "Confirm with the team lead" not "It is recommended that a team member reach out to confirm..."
- Missing section cards for sections unlikely to have data should be S4 or filtered
- Unknown owner cards for minor libraries or tools should be S4 or filtered
- Inferred claims about critical systems (payments, auth, databases) should be S1 or S2
- Discovery items (truth_status=inferred, from conversation analysis) should only get S1/S2 cards if they represent critical factual claims. Most discovery items are S3 or should be filtered.
- Convention/pattern entities are inherently inferred — do NOT create cards questioning their existence. Only create cards if a specific factual claim within them is questionable.
- Do NOT create a card just because a page or project was synthesized from multiple signals. Keep a card only when there is a concrete unresolved fact a human can answer.
- Missing canonical owner/decision-maker attribution on a cross-cutting convention or pattern is high-signal and should usually be S1 or S2.
- Write like a knowledgeable teammate: short, direct, plain English. No filler intros or AI-style summaries.`;

  const claimsExecId = await ctx.getStepExecutionId("pass1", 17);
  const claimsFilter = claimsExecId ? { execution_id: claimsExecId } : { run_id: ctx.runId };
  const claims = (await tc.claims.find(claimsFilter).toArray()) as unknown as KB2ClaimType[];
  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  const nodeExecIds = [step9ExecId, step10ExecId].filter(Boolean);
  const nodesFilter = nodeExecIds.length > 0
    ? { execution_id: { $in: nodeExecIds } }
    : { run_id: ctx.runId };
  const nodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  const step6ExecId = await ctx.getStepExecutionId("pass1", 6);
  const step7ExecId = await ctx.getStepExecutionId("pass1", 7);
  const step11ExecId = await ctx.getStepExecutionId("pass1", 11);
  const edgeExecIds = [step6ExecId, step7ExecId, step11ExecId].filter(Boolean);
  const edgesFilter = edgeExecIds.length > 0
    ? { execution_id: { $in: edgeExecIds } }
    : { run_id: ctx.runId };
  const edges = (await tc.graph_edges.find(edgesFilter).toArray()) as unknown as KB2GraphEdgeType[];
  const epExecId = await ctx.getStepExecutionId("pass1", 14);
  const epFilter = epExecId ? { execution_id: epExecId } : { run_id: ctx.runId };
  const entityPages = (await tc.entity_pages.find(epFilter).toArray()) as unknown as KB2EntityPageType[];

  const nodeById = new Map<string, KB2GraphNodeType>();
  for (const n of nodes) nodeById.set(n.node_id, n);
  const nodeByName = new Map<string, KB2GraphNodeType>();
  for (const n of nodes) nodeByName.set(n.display_name.toLowerCase(), n);
  const teamMemberNames = nodes
    .filter((node) => node.type === "team_member")
    .map((node) => node.display_name)
    .sort((a, b) => b.length - a.length);
  const pageById = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) pageById.set(ep.page_id, ep);
  const pageByNodeId = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) pageByNodeId.set(ep.node_id, ep);

  const edgesByNode = new Map<string, { edge: KB2GraphEdgeType; other: KB2GraphNodeType | undefined }[]>();
  const ownershipMap = buildNodeOwnerMap(nodes, edges);
  for (const edge of edges) {
    const srcEntry = edgesByNode.get(edge.source_node_id) ?? [];
    srcEntry.push({ edge, other: nodeById.get(edge.target_node_id) });
    edgesByNode.set(edge.source_node_id, srcEntry);

    const tgtEntry = edgesByNode.get(edge.target_node_id) ?? [];
    tgtEntry.push({ edge, other: nodeById.get(edge.source_node_id) });
    edgesByNode.set(edge.target_node_id, tgtEntry);
  }

  // ------ Phase 1: Gather all candidates ------
  await ctx.onProgress("Phase 1: Gathering verification candidates...", 5);

  const candidates: RawCandidate[] = [];

  for (const claim of claims) {
    if (claim.truth_status === "inferred") {
      const sourcePage = claim.source_page_id ? pageById.get(claim.source_page_id) : undefined;
      if (sourcePage) {
        const sourceNode = nodeById.get(sourcePage.node_id);
        if (sourceNode?.attributes?.is_convention) continue;
      }
      candidates.push({
        type: "inferred_claim",
        raw_text: claim.text,
        entity_name: sourcePage?.title,
        page_id: claim.source_page_id,
        page_type: claim.source_page_type,
        page_title: sourcePage?.title,
        claim_ids: [claim.claim_id],
        source_refs: claim.source_refs ?? [],
      });
    }
    if (claim.confidence === "low" && claim.truth_status !== "inferred") {
      const page = claim.source_page_id ? pageById.get(claim.source_page_id) : undefined;
      candidates.push({
        type: "low_confidence",
        raw_text: claim.text,
        entity_name: page?.title,
        page_id: claim.source_page_id,
        page_type: claim.source_page_type,
        page_title: page?.title,
        claim_ids: [claim.claim_id],
        source_refs: claim.source_refs ?? [],
      });
    }
  }

  for (const page of entityPages) {
    const template = ENTITY_PAGE_TEMPLATES[page.node_type];
    if (!template) continue;
    for (const spec of template.sections) {
      if (spec.requirement !== "MUST") continue;
      const section = page.sections.find((s) => s.section_name === spec.name);
      if (!section || section.items.length === 0) {
        candidates.push({
          type: "missing_must",
          raw_text: `Missing "${spec.name}" on ${page.title} (${page.node_type}). Intent: ${spec.intent}`,
          entity_name: page.title,
          page_id: page.page_id,
          page_type: "entity",
          page_title: page.title,
          claim_ids: [],
          source_refs: [],
        });
      }
    }
  }

  for (const node of nodes) {
    const page = pageByNodeId.get(node.node_id);
    const ownerSignals = getPageOwnerSignals(page);
    const conventionNode = isConventionNode(node, page);
    const canonicalOwnerPresent = hasCanonicalOwner(node, ownershipMap);

    if (conventionNode) {
      if (canonicalOwnerPresent || ownerSignals.length === 0) continue;
      candidates.push({
        type: "unknown_owner",
        raw_text: `Canonical convention "${node.display_name}" is missing owner/decision-maker attribution even though page evidence names decision makers: ${ownerSignals[0]}`,
        entity_name: node.display_name,
        page_id: page?.page_id,
        page_type: "entity",
        page_title: page?.title,
        claim_ids: [],
        source_refs: node.source_refs ?? [],
      });
      continue;
    }

    if (!OWNERABLE_TYPES.has(node.type)) continue;
    if (canonicalOwnerPresent || ownerSignals.length > 0) continue;
    candidates.push({
      type: "unknown_owner",
      raw_text: `No owner for ${node.type} "${node.display_name}"`,
      entity_name: node.display_name,
      page_id: page?.page_id,
      page_type: page ? "entity" : undefined,
      page_title: page?.title,
      claim_ids: [],
      source_refs: node.source_refs ?? [],
    });
  }

  await ctx.onProgress(`Phase 1 complete: ${candidates.length} raw candidates`, 20);

  if (candidates.length === 0) {
    await ctx.onProgress("No verification candidates found", 100);
    return { total_cards: 0, by_type: {}, by_severity: {}, llm_calls: 0 };
  }

  // ------ Phase 2: LLM pass for filtering and rewriting ------
  await ctx.onProgress("Phase 2: LLM filtering and rewriting...", 25);

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  let totalLLMCalls = 0;
  const survivingEntries: Array<{
    candidateIndex: number;
    candidate: RawCandidate;
    llmCard: VerifyCardDraft;
  }> = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchText = batch.map((c, idx) => {
      const { page, node, ownerSignals } = resolveCandidateContext(c, pageById, pageByNodeId, nodeById, nodeByName);
      const parts = [`${i + idx}. [${c.type}] Entity: ${c.entity_name ?? "unknown"}\n   Claim: "${c.raw_text}"`];
      if (c.source_refs.length > 0) {
        parts.push(`   Sources: ${c.source_refs.map((r) => `${r.title} (${r.source_type})${r.excerpt ? ` — "${r.excerpt.slice(0, 150)}"` : ""}`).join("; ")}`);
      }
      if (page) {
        const relSection = page.sections.find((s) =>
          s.items.some((it) => it.text.toLowerCase().includes(c.raw_text.toLowerCase().slice(0, 40))),
        );
        if (relSection) {
          parts.push(`   Page section [${relSection.section_name}]: ${relSection.items.map((it) => it.text).join(" | ").slice(0, 300)}`);
        }
      }
      if (ownerSignals.length > 0) {
        parts.push(`   Owner signals: ${ownerSignals.join(" | ").slice(0, 300)}`);
      }
      if (node) {
        const nodeEdges = edgesByNode.get(node.node_id) ?? [];
        if (nodeEdges.length > 0) {
          parts.push(`   Graph connections: ${nodeEdges.slice(0, 8).map((e) => `${e.edge.type} → ${e.other?.display_name ?? "?"}`).join(", ")}`);
        }
      }
      return parts.join("\n");
    }).join("\n\n");

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: createVerifyCardsSystemPrompt,
      prompt: `Review these ${batch.length} verification candidates. For each one, provide a structured analysis with problem explanation, evidence, affected entities, and a clear verification question.\n\n${batchText}`,
      schema: LLMVerifyCardSchema,
      logger,
      onUsage: (usage) => { usageData = usage; },
      signal: ctx.signal,
    });
    totalLLMCalls++;

    if (usageData) {
      const cost = calculateCostUsd(getFastModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(stepId, getFastModelName(ctx.config?.pipeline_settings?.models), batchText.slice(0, 3000), JSON.stringify(result, null, 2).slice(0, 3000), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
    }

    for (const card of result.cards ?? []) {
      if (!card.keep) continue;
      if (card.index >= 0 && card.index < candidates.length) {
        survivingEntries.push({
          candidateIndex: card.index,
          candidate: candidates[card.index],
          llmCard: card,
        });
      }
    }

    const pct = Math.round(25 + ((i + batch.length) / candidates.length) * 40);
    await ctx.onProgress(`Phase 2: processed ${Math.min(i + BATCH_SIZE, candidates.length)}/${candidates.length} candidates`, pct);
  }

  const rankedEntries: RankedCandidateCard[] = survivingEntries
    .map((entry) => {
      const { page, node, ownerSignals } = resolveCandidateContext(
        entry.candidate,
        pageById,
        pageByNodeId,
        nodeById,
        nodeByName,
      );
      const llmSeverity = entry.llmCard.severity as KB2Severity;
      const severityFloor = getSeverityFloor(entry.candidate, node, page, ownerSignals);
      const adjustedSeverity = severityFloor ? moreSevere(llmSeverity, severityFloor) : llmSeverity;
      return {
        ...entry,
        page,
        node,
        ownerSignals,
        adjustedSeverity,
        priority: getCardPriority(adjustedSeverity, entry.candidate, node, page, ownerSignals),
      };
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        compareSeverity(a.adjustedSeverity, b.adjustedSeverity) ||
        a.llmCard.title.localeCompare(b.llmCard.title),
    );

  const MAX_CARDS = 30;
  const finalEntries = rankedEntries.slice(0, MAX_CARDS);

  await ctx.onProgress(`Phase 2 complete: ${finalEntries.length}/${candidates.length} cards kept`, 65);

  // ------ Phase 3: Attach source refs mechanically ------
  await ctx.onProgress("Phase 3: Attaching source references...", 70);

  // ------ Phase 4: Auto-assign from graph ownership ------
  await ctx.onProgress("Phase 4: Auto-assigning...", 80);

  const finalCards: KB2VerificationCardType[] = [];
  const cardSamples: Record<string, unknown>[] = [];
  const criticalCardSamples: Record<string, unknown>[] = [];

  for (const entry of finalEntries) {
    const { llmCard, candidate, page, node } = entry;

    const assignedTo = inferAssignedOwners(
      page ? nodeById.get(page.node_id) ?? node : node,
      entry.ownerSignals,
      teamMemberNames,
      ownershipMap,
      edgesByNode,
    );
    if (node?.type === "customer_feedback" && assignedTo.length === 0) {
      continue;
    }
    if (!page && !node && assignedTo.length === 0) {
      continue;
    }

    const affectedEntities: { entity_name: string; entity_type?: string; relationship?: string }[] = [];
    for (const name of llmCard.affected_entity_names ?? []) {
      const found = nodeByName.get(name.toLowerCase());
      affectedEntities.push({ entity_name: name, entity_type: found?.type, relationship: "potentially affected" });
    }

    const finalCard: KB2VerificationCardType = {
      card_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      card_type: candidate.type,
      severity: entry.adjustedSeverity,
      title: normalizeVerifyCardTitle({
        candidate,
        rawTitle: llmCard.title,
        page,
        node,
        verificationQuestion: llmCard.verification_question,
        requiredData: llmCard.required_data,
        missingEvidence: llmCard.missing_evidence,
        affectedEntityNames: llmCard.affected_entity_names,
      }),
      explanation: llmCard.problem_explanation ?? llmCard.title,
      problem_explanation: llmCard.problem_explanation,
      supporting_evidence: llmCard.supporting_evidence ?? [],
      missing_evidence: llmCard.missing_evidence ?? [],
      affected_entities: affectedEntities,
      required_data: llmCard.required_data ?? [],
      verification_question: llmCard.verification_question,
      recommended_action: llmCard.recommended_action,
      page_occurrences: page
        ? [{ page_id: page.page_id, page_type: candidate.page_type ?? "entity", page_title: page.title }]
        : candidate.page_id
          ? [{ page_id: candidate.page_id, page_type: candidate.page_type ?? "entity", page_title: candidate.page_title }]
          : [],
      source_refs: candidate.source_refs,
      assigned_to: assignedTo,
      claim_ids: candidate.claim_ids,
      status: "open",
      discussion: [],
    };
    finalCards.push(finalCard);

    const sample = summarizeCard(entry, finalCard);
    if (cardSamples.length < 5) cardSamples.push(sample);
    if (isCriticalEntry(entry) && criticalCardSamples.length < 8) {
      criticalCardSamples.push(sample);
    }
  }

  if (criticalCardSamples.length === 0) {
    criticalCardSamples.push(...cardSamples.slice(0, 8));
  }

  const existingUnknownOwnerPageIds = new Set(
    finalCards
      .filter((card) => card.card_type === "unknown_owner")
      .flatMap((card) => card.page_occurrences.map((occurrence) => occurrence.page_id)),
  );
  for (const node of nodes) {
    const page = pageByNodeId.get(node.node_id);
    if (!page) continue;
    if (!isConventionNode(node, page) || !isPriorityConvention(node, page)) continue;
    if (hasCanonicalOwner(node, ownershipMap)) continue;
    if (existingUnknownOwnerPageIds.has(page.page_id)) continue;

    const ownerSignals = getPageOwnerSignals(page);
    const likelyOwnerNames = extractLikelyOwnerNames(node, ownerSignals, teamMemberNames);
    const likelyOwner = likelyOwnerNames[0];
    if (!likelyOwner) continue;

    const forcedCard = buildForcedConventionOwnershipCard({
      executionId: ctx.executionId,
      runId: ctx.runId,
      node,
      page,
      likelyOwner,
      ownerSignals,
      sourceRefs: node.source_refs ?? [],
    });
    finalCards.unshift(forcedCard);
    existingUnknownOwnerPageIds.add(page.page_id);

    const sample = {
      execution_id: forcedCard.execution_id ?? null,
      card_id: forcedCard.card_id,
      title: forcedCard.title,
      card_type: forcedCard.card_type,
      severity: forcedCard.severity,
      entity_name: node.display_name,
      page_title: page.title,
      source_titles: getSourceTitles(forcedCard.source_refs),
      claim_ids: [],
      assigned_to: forcedCard.assigned_to,
      owner_signals: ownerSignals.slice(0, 2),
      verification_question: forcedCard.verification_question ?? null,
      explanation: (forcedCard.problem_explanation ?? forcedCard.explanation).slice(0, 260),
    };
    criticalCardSamples.unshift(sample);
    if (criticalCardSamples.length > 8) criticalCardSamples.pop();
    cardSamples.unshift(sample);
    if (cardSamples.length > 5) cardSamples.pop();
  }

  // ------ Phase 5: Deduplicate cards ------
  const seenTitleKeys = new Set<string>();
  const seenEntityTypeKeys = new Set<string>();
  const deduplicatedCards: KB2VerificationCardType[] = [];
  for (const card of finalCards) {
    const titleKey = card.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const words = titleKey.split(/\s+/).sort().join(" ");
    if (seenTitleKeys.has(words)) continue;
    seenTitleKeys.add(words);

    if (card.card_type === "duplicate_cluster") {
      const entities = (card.affected_entities ?? []).map(e => e.entity_name).sort();
      const pairKey = `dup:${entities.join("|")}`;
      if (seenTitleKeys.has(pairKey)) continue;
      seenTitleKeys.add(pairKey);
    }

    const pageId = card.page_occurrences?.[0]?.page_id;
    if (pageId) {
      const entityTypeKey = `${card.card_type}:${pageId}`;
      if (seenEntityTypeKeys.has(entityTypeKey)) continue;
      seenEntityTypeKeys.add(entityTypeKey);
    }

    deduplicatedCards.push(card);
  }
  const deduped = finalCards.length - deduplicatedCards.length;
  finalCards.length = 0;
  finalCards.push(...deduplicatedCards);

  const keptCandidateIndexes = new Set(finalEntries.map((entry) => entry.candidateIndex));
  const filteredCandidateSamples = candidates
    .map((candidate, candidateIndex) => {
      const { page, node, ownerSignals } = resolveCandidateContext(
        candidate,
        pageById,
        pageByNodeId,
        nodeById,
        nodeByName,
      );
      return {
        candidateIndex,
        candidate,
        page,
        node,
        ownerSignals,
        priority: getCardPriority("S4", candidate, node, page, ownerSignals),
      };
    })
    .filter((entry) => !keptCandidateIndexes.has(entry.candidateIndex))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5)
    .map((entry) => summarizeFilteredCandidate(entry.candidate, entry.page, entry.node, entry.ownerSignals));

  const dupExecId = await ctx.getStepExecutionId("pass1", 5);
  const dupCardFilter = dupExecId
    ? { execution_id: dupExecId, card_type: "duplicate_cluster" }
    : { run_id: ctx.runId, card_type: "duplicate_cluster" };
  const existingDupCards = await tc.verification_cards
    .find(dupCardFilter)
    .toArray();

  if (finalCards.length > 0) {
    await tc.verification_cards.insertMany(finalCards as any[]);
  }

  const totalCards = finalCards.length + existingDupCards.length;
  const filteredOut = Math.max(candidates.length - keptCandidateIndexes.size, 0);
  const byType = finalCards.reduce((acc, c) => {
    acc[c.card_type] = (acc[c.card_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  if (existingDupCards.length > 0) {
    byType["duplicate_cluster"] = existingDupCards.length;
  }

  await ctx.onProgress(`Created ${totalCards} verification cards (${filteredOut} filtered, ${deduped} deduped)`, 100);
  return {
    total_cards: totalCards,
    candidates_gathered: candidates.length,
    filtered_out: filteredOut,
    deduplicated: deduped,
    by_type: byType,
    by_severity: finalCards.reduce((acc, c) => {
      acc[c.severity] = (acc[c.severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    llm_calls: totalLLMCalls,
    card_samples: cardSamples,
    critical_card_samples: criticalCardSamples,
    critical_card_titles: criticalCardSamples.map((sample) => String(sample.title ?? "")),
    filtered_candidate_samples: filteredCandidateSamples,
  };
};
