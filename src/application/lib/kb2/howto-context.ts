import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { findBestMatchingUnit } from "@/src/application/lib/kb2/pass1-v2-artifacts";
import type { KB2EntityPageType, KB2EvidenceRefType } from "@/src/entities/models/kb2-types";

const GUIDE_TEXT_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under", "into",
  "using", "used", "page", "project", "decision", "feature", "should", "would", "could",
  "about", "their", "there", "then", "than", "when", "where", "what", "have", "will",
]);

const HOWTO_TECHNICAL_KEYWORDS_RE = /\b(api|endpoint|backend|frontend|schema|database|component|migration|payload|implementation|ticket|pr|payment|form|inventory|selector|pagination|color|layout|sidebar|vertical|horizontal|grid|responsive|mobile|button|accent|design|mockup|style|cta|image|lazy|skeleton|fallback|transition|memo|memoize|callback|toast|comparison|compare|overflow|scroll|round-trip|adoptable)\b/i;
const HOWTO_SECTION_HINT_RE = /\b(description|decision|scope|architecture|implementation|design|review|layout|ui|ux)\b/i;

export interface HowtoEvidenceEntry {
  ref: KB2EvidenceRefType;
  score: number;
  sourceTypeLabel: string;
  title: string;
  sectionHeading?: string;
  text: string;
}

export interface BuildHowtoEvidenceOptions {
  minScore?: number;
  maxRefs?: number;
  maxChars?: number;
  dropFeedbackWhenTechnical?: boolean;
}

export function normalizeNodeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function collectPageText(page: KB2EntityPageType): string {
  return [
    page.title,
    ...page.sections.flatMap((section) => [
      section.section_name,
      ...section.items.map((item) => item.text),
    ]),
  ].join(" ");
}

function tokenizeGuideText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 3 && !GUIDE_TEXT_STOPWORDS.has(token));
}

export function hasGuideTokenOverlap(left: string, right: string, minMatches = 2): boolean {
  const leftTokens = new Set(tokenizeGuideText(left));
  if (leftTokens.size === 0) return false;
  const rightTokens = tokenizeGuideText(right);
  let matches = 0;
  for (const token of rightTokens) {
    if (leftTokens.has(token)) matches += 1;
    if (matches >= minMatches) return true;
  }
  return false;
}

export function dedupeHowtoEvidenceRefs(sourceRefs: KB2EvidenceRefType[]): KB2EvidenceRefType[] {
  const seen = new Set<string>();
  const out: KB2EvidenceRefType[] = [];
  for (const ref of sourceRefs) {
    const key = [
      ref.source_type,
      ref.doc_id,
      ref.title,
      ref.section_heading ?? "",
      ref.excerpt,
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function buildParsedDocLookup(docs: KB2ParsedDocument[]): Map<string, KB2ParsedDocument> {
  const out = new Map<string, KB2ParsedDocument>();
  for (const doc of docs) {
    out.set(doc.sourceId, doc);
    out.set(doc.id, doc);
  }
  return out;
}

export function trimHowtoPromptText(value: string, maxChars = 520): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!Number.isFinite(maxChars) || maxChars <= 0) return normalized;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

export function formatHowtoSourceTypeLabel(sourceType: KB2EvidenceRefType["source_type"]): string {
  switch (sourceType) {
    case "jira":
      return "Jira";
    case "github":
      return "GitHub";
    case "confluence":
      return "Confluence";
    case "slack":
      return "Slack";
    case "customer_feedback":
      return "Customer Feedback";
    case "human_verification":
      return "Human Verification";
    default:
      return "Source";
  }
}

export function scoreHowtoSourceRef(projectText: string, ref: KB2EvidenceRefType): number {
  const refText = [ref.title, ref.section_heading ?? "", ref.excerpt ?? ""].join(" ");
  let score =
    ref.source_type === "jira" ? 12
      : ref.source_type === "github" ? 11
        : ref.source_type === "confluence" ? 9
          : ref.source_type === "slack" ? 5
            : ref.source_type === "customer_feedback" ? 2
              : 1;

  if (hasGuideTokenOverlap(projectText, refText, 2)) score += 6;
  if (HOWTO_TECHNICAL_KEYWORDS_RE.test(refText)) score += 3;
  if (HOWTO_SECTION_HINT_RE.test(ref.section_heading ?? "")) score += 2;
  return score;
}

function resolveHowtoEvidenceText(
  ref: KB2EvidenceRefType,
  docsById: Map<string, KB2ParsedDocument>,
  maxChars: number,
): string {
  const doc = docsById.get(ref.doc_id);
  const matchingUnit = doc
    ? findBestMatchingUnit(doc, [ref.section_heading ?? "", ref.excerpt ?? ""].filter(Boolean).join("\n"))
    : null;
  return trimHowtoPromptText(matchingUnit?.text || ref.excerpt || doc?.content || "", maxChars);
}

export function buildHowtoEvidenceEntries(
  projectText: string,
  sourceRefs: KB2EvidenceRefType[],
  docsById: Map<string, KB2ParsedDocument>,
  options: BuildHowtoEvidenceOptions = {},
): HowtoEvidenceEntry[] {
  const {
    minScore = 0,
    maxRefs = 8,
    maxChars = 520,
    dropFeedbackWhenTechnical = true,
  } = options;

  const scoredRefs = dedupeHowtoEvidenceRefs(sourceRefs)
    .map((ref) => ({
      ref,
      score: scoreHowtoSourceRef(projectText, ref),
    }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score || a.ref.title.localeCompare(b.ref.title));

  const filteredRefs = (
    dropFeedbackWhenTechnical && scoredRefs.some((entry) => !["customer_feedback", "human_verification"].includes(entry.ref.source_type))
      ? scoredRefs.filter((entry) => !["customer_feedback", "human_verification"].includes(entry.ref.source_type))
      : scoredRefs
  ).slice(0, maxRefs);

  return filteredRefs.map(({ ref, score }) => ({
    ref,
    score,
    sourceTypeLabel: formatHowtoSourceTypeLabel(ref.source_type),
    title: ref.title,
    ...(ref.section_heading ? { sectionHeading: ref.section_heading } : {}),
    text: resolveHowtoEvidenceText(ref, docsById, maxChars),
  }));
}

export function buildHowtoEvidenceSection(args: {
  title: string;
  introLines?: string[];
  entries: HowtoEvidenceEntry[];
}): string {
  const { title, introLines = [], entries } = args;
  if (entries.length === 0) return "";
  return [
    `## ${title}`,
    ...introLines,
    "",
    ...entries.map((entry) => [
      `### ${entry.sourceTypeLabel} — ${entry.title}`,
      entry.sectionHeading ? `Section: ${entry.sectionHeading}` : "",
      entry.text ? `Evidence: ${entry.text}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

export function buildTechnicalSourceContext(
  projectText: string,
  sourceRefs: KB2EvidenceRefType[],
  docsById: Map<string, KB2ParsedDocument>,
): { context: string; refs: KB2EvidenceRefType[]; entries: HowtoEvidenceEntry[] } {
  const entries = buildHowtoEvidenceEntries(projectText, sourceRefs, docsById, {
    minScore: 7,
    maxRefs: 8,
    maxChars: 520,
    dropFeedbackWhenTechnical: true,
  });

  return {
    context: buildHowtoEvidenceSection({
      title: "Direct Technical Source Evidence",
      introLines: [
        "Only use these artifacts when making concrete technical implementation claims.",
        "If an exact implementation detail is not supported here, say that it is not yet confirmed.",
      ],
      entries,
    }),
    refs: entries.map((entry) => entry.ref),
    entries,
  };
}
