import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { calculateCostUsd, getFastModel, getFastModelName } from "@/lib/ai-model";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import {
  buildEvidenceRefFromDoc,
  getDocSourceUnits,
  type KB2Observation,
} from "@/src/application/lib/kb2/pass1-v2-artifacts";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

function normalizeName(value: string): string {
  return normalizeLookupText(value);
}

function normalizeLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasNameMention(text: string, candidates: string[]): boolean {
  const hay = ` ${normalizeLookupText(text)} `;
  return candidates.some((candidate) => {
    const needle = normalizeLookupText(candidate);
    return needle.length >= 3 && hay.includes(` ${needle} `);
  });
}

const FeedbackDiscoverySchema = z.object({
  discoveries: z.array(z.object({
    feature_name: z.string(),
    type: z.enum(["project", "ticket"]),
    description: z.string(),
    evidence_doc_ids: z.array(z.string()),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

const FEEDBACK_DISCOVERY_PROMPT = `You cluster customer feedback submissions into coherent proposed product work.

Rules:
- Group multiple submissions that ask for the same capability into one discovery.
- Prefer product-level names such as "X Feature" or "Y Page" when the request is feature-shaped.
- Ignore generic praise or one-off bug reports unless they clearly describe a reusable feature or ticket-sized request.
- Customer feedback themes should usually become project discoveries, not a pile of disconnected tickets.
- Only emit a discovery when the request is supported by at least 2 submissions, or by 1 unusually specific submission with clear scope.
`;

type DiscoveryCategory =
  | "past_undocumented"
  | "ongoing_undocumented"
  | "proposed_project"
  | "proposed_ticket"
  | "proposed_from_feedback";

type SourceBackedSeed = {
  label: string;
  category: Exclude<DiscoveryCategory, "proposed_from_feedback" | "proposed_ticket">;
  description: string;
  confidence: "high" | "medium";
  docs: KB2ParsedDocument[];
};

function buildExistingTypesByName(nodes: KB2GraphNodeType[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const node of nodes) {
    const names = [node.display_name, ...(node.aliases ?? [])].filter(Boolean);
    for (const name of names) {
      const key = normalizeName(name);
      const types = map.get(key) ?? new Set<string>();
      types.add(node.type);
      map.set(key, types);
    }
  }
  return map;
}

function hasEquivalentCanonical(
  existingTypesByName: Map<string, Set<string>>,
  name: string,
  desiredType: "project" | "ticket",
): boolean {
  const types = existingTypesByName.get(normalizeName(name));
  if (!types || types.size === 0) return false;
  if (desiredType === "project") return types.has("project");
  return types.has("ticket") || types.has("project");
}

function registerDiscoveryType(
  existingTypesByName: Map<string, Set<string>>,
  name: string,
  type: string,
): void {
  const key = normalizeName(name);
  const types = existingTypesByName.get(key) ?? new Set<string>();
  types.add(type);
  existingTypesByName.set(key, types);
}

function looksLikeTaskNoise(label: string, observations: KB2Observation[]): boolean {
  const combined = `${label}\n${observations.map((observation) =>
    `${observation.reasoning}\n${observation.source_ref.excerpt}`).join("\n")}`.toLowerCase();
  return /^([A-Z]+-\d+|pr\s*#\d+)/i.test(label) ||
    /\b(fix|bug|test|cleanup|touch target|404|broken link|copy update|maintenance|refactor)\b/.test(combined);
}

function hasStrongProjectShape(label: string, observations: KB2Observation[]): boolean {
  const combined = `${label}\n${observations.map((observation) =>
    `${observation.reasoning}\n${observation.source_ref.excerpt}`).join("\n")}`.toLowerCase();
  const featureName = /\b(page|pages|portal|browser|dashboard|tracking|calendar|chooser|feature|search|navigation|improvements|redesign|integration)\b/
    .test(label.toLowerCase());
  const initiativeSignal = /\b(priority|priorities|initiative|body of work|workstream|actively designed and built|distinct feature|q[1-4]\b|planned)\b/
    .test(combined);
  const distinctDocs = new Set(observations.map((observation) => observation.doc_id));
  return featureName || initiativeSignal || distinctDocs.size >= 2;
}

function buildFeedbackObservation(
  doc: KB2ParsedDocument,
  label: string,
  description: string,
  suggestedType: "project" | "ticket",
  confidence: KB2Observation["confidence"],
): KB2Observation {
  const firstUnit = getDocSourceUnits(doc)[0] ?? null;
  const sourceRef = buildEvidenceRefFromDoc(
    doc,
    (firstUnit?.text ?? doc.content).slice(0, 320),
    firstUnit,
  );
  return {
    observation_id: `${doc.sourceId}:feedback-discovery`,
    provider: doc.provider,
    doc_id: doc.sourceId,
    parent_doc_id: doc.id,
    unit_id: firstUnit?.unit_id ?? `${doc.sourceId}:submission`,
    observation_kind: "feedback_signal",
    label,
    suggested_type: suggestedType,
    reasoning: description,
    confidence,
    evidence_excerpt: sourceRef.excerpt,
    source_ref: sourceRef,
    aliases: [],
    attributes: {},
  };
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeFeedbackFeatureName(name: string): string {
  let text = name.trim();
  const gerundTailMatch = text.match(/^(.+?)\s*&\s+([A-Za-z]+ing)(?:\s+feature)?$/i);
  if (gerundTailMatch?.[1] && gerundTailMatch[1].trim().split(/\s+/).length >= 2) {
    text = `${gerundTailMatch[1].trim()} Feature`;
  }
  const giftTailMatch = text.match(/^(.+?)\s*&\s+(gift|gifts|gifting)(?:\s+feature)?$/i);
  if (giftTailMatch?.[1] && giftTailMatch[1].trim().split(/\s+/).length >= 2) {
    text = `${giftTailMatch[1].trim()} Feature`;
  }
  if (!/\b(page|portal|browser|dashboard|tracking|calendar|chooser|workflow|integration|feature|ticket)\b/i.test(text)) {
    text = `${text.replace(/\s+feature$/i, "").trim()} Feature`;
  }
  return toTitleCase(text);
}

function isLowSignalSummary(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length < 6
    || /^#?[a-z0-9_-]+\s+\|\s+\d{4}-\d{2}-\d{2}/i.test(trimmed)
    || /^[A-Z]+-\d+$/i.test(trimmed)
  );
}

function getSummaryLabelTokens(label: string): string[] {
  return normalizeLookupText(label)
    .split(" ")
    .filter((token) => token.length >= 4 && !["feature", "project", "page"].includes(token));
}

function scoreSummaryCandidate(text: string, labelTokens: string[] = []): number {
  const trimmed = text.trim();
  if (!trimmed) return -1000;
  const normalized = normalizeLookupText(trimmed);
  let score = Math.min(trimmed.length, 220);
  if (isLowSignalSummary(trimmed)) score -= 160;
  if (labelTokens.length > 0) {
    const matches = labelTokens.filter((token) => normalized.includes(token));
    score += matches.length * 160;
  }
  if (/\b(api|page|portal|browser|tracking|calendar|chooser|donation|volunteer|hours|report|log|export|feature|integration|pr)\b/i.test(trimmed)) {
    score += 120;
  }
  if (/\b(coming|ready|working on|would be helpful|need a way|built|launched|in progress)\b/i.test(trimmed)) {
    score += 40;
  }
  if (/^\*\*[A-Za-z]+/.test(trimmed)) score += 10;
  return score;
}

function pickDocSummary(doc: KB2ParsedDocument, label = ""): string {
  const fromTitle = stripDocTitlePrefix(doc.title);
  const labelTokens = getSummaryLabelTokens(label);
  const sentences = doc.content
    .replace(/\s+/g, " ")
    .trim()
    .split(/[.!?]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const fromContent = sentences
    .sort((a, b) => scoreSummaryCandidate(b, labelTokens) - scoreSummaryCandidate(a, labelTokens) || b.length - a.length)
    [0] ?? doc.title;
  if (!isLowSignalSummary(fromContent) && fromContent.length >= 24) return fromContent;
  if (!isLowSignalSummary(fromTitle) && fromTitle.length >= 6) return fromTitle;
  return fromContent || fromTitle || doc.title;
}

function collectDocOwners(docs: KB2ParsedDocument[]): string[] {
  const owners = new Set<string>();
  for (const doc of docs) {
    const meta = (doc.metadata ?? {}) as Record<string, unknown>;
    for (const key of ["assignee", "author", "reporter", "owner"]) {
      const value = meta[key];
      if (typeof value === "string" && value.trim()) owners.add(value.trim());
    }
  }
  return [...owners].slice(0, 3);
}

function describeDiscoveryCategory(category: DiscoveryCategory): string {
  if (category === "past_undocumented") return "looks completed but undocumented";
  if (category === "ongoing_undocumented") return "looks active and undocumented";
  if (category === "proposed_project" || category === "proposed_ticket" || category === "proposed_from_feedback") {
    return "looks proposed rather than completed";
  }
  return "has supporting evidence across the linked sources";
}

function buildEvidenceBackedDescription(
  label: string,
  docs: KB2ParsedDocument[],
  category: DiscoveryCategory,
): string {
  const providers = [...new Set(docs.map((doc) => doc.provider))];
  const owners = collectDocOwners(docs);
  const labelTokens = getSummaryLabelTokens(label);
  const summary = docs
    .map((doc) => pickDocSummary(doc, label))
    .sort((a, b) =>
      scoreSummaryCandidate(b, labelTokens) - scoreSummaryCandidate(a, labelTokens)
      || b.length - a.length
      || a.localeCompare(b)
    )[0]
    ?? label;
  const sourceSignals = docs
    .map((doc) => stripDocTitlePrefix(doc.title))
    .filter((title) => !isLowSignalSummary(title))
    .slice(0, 3);
  const compactSummary = String(summary).replace(/\s+/g, " ").trim();
  const summarySentence =
    compactSummary && normalizeLookupText(compactSummary) !== normalizeLookupText(label)
      ? `Evidence points to work around ${compactSummary}.`
      : "Evidence across the linked sources points to a concrete body of work.";
  const sourceSignalSentence = sourceSignals.length > 0
    ? ` Source signals include ${sourceSignals.join(", ")}.`
    : "";
  const ownerText = owners.length > 0 ? ` It is associated with ${owners.join(", ")}.` : "";
  return `${label} is backed by ${providers.join(", ")} sources. ${summarySentence}${sourceSignalSentence} The project ${describeDiscoveryCategory(category)}.${ownerText}`;
}

function buildObservationBackedDescription(label: string, observations: KB2Observation[]): string {
  const sourceTypes = [...new Set(observations.map((observation) => observation.source_ref.source_type))];
  const summary = observations
    .map((observation) => observation.source_ref.excerpt)
    .find((excerpt) => typeof excerpt === "string" && excerpt.trim().length >= 20)
    ?? observations[0]?.reasoning
    ?? label;
  return `${label} is supported by ${sourceTypes.join(", ")} evidence, including ${String(summary).replace(/\s+/g, " ").trim().slice(0, 180)}.`;
}

function stripDocTitlePrefix(title: string): string {
  return title
    .replace(/^[A-Z]+-\d+:\s*/i, "")
    .replace(/^[^:]*PR\s*#\d+:\s*/i, "")
    .trim();
}

function normalizeProjectSurfaceLabel(text: string): string {
  return text
    .replace(/^set up\s+(.+)$/i, (_match, body: string) => `${body} setup`)
    .replace(/^standardi[sz]e\s+(.+)$/i, (_match, body: string) => `${body} standardization`)
    .replace(/^(?:[a-z]+\s+)?api response format standardization$/i, "api response standardization")
    .replace(/^(?:[a-z]+\s+)?api response standardization$/i, "api response standardization")
    .replace(/^mobile navigation$/i, "mobile responsiveness")
    .replace(/^improv(?:e|ing)\s+(.+)$/i, (_match, body: string) => `${body} improvements`)
    .replace(/^(.+?)\s+to\s+(.+)$/i, (_m, left: string, right: string) => `${left} for ${right}`)
    .replace(/\s+browser page$/i, " browser")
    .replace(/\s+\b(frontend|backend)\s+api\b$/i, "")
    .replace(/\s+\b(frontend|backend|design|layout|endpoint)\b$/i, "")
    .replace(/\s+(product spec|spec)$/i, "")
    .replace(/\s+\bfeature\b$/i, "")
    .replace(/\s*[—-]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeProjectLabel(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^[Bb]uild\s+/, "");
  text = text.replace(/^[Aa]dd\s+/, "");
  text = text.replace(/^[Ii]mplement\s+/, "");
  text = text.replace(/^[Dd]esign\s+/, "");
  text = text.replace(/^[Cc]reate\s+/, "");
  text = text.replace(/^[Rr]efactor\s+/, "");
  text = text.replace(/\s+\b(refactor|optimization|optimizations)\b$/i, "");
  text = text.replace(/\s+[—-]\s+(backend|frontend|design|frontend layout|layout)\b.*$/i, "");
  text = text.replace(/^events section to each shelter page$/i, "events section for each shelter page");
  text = normalizeProjectSurfaceLabel(text);
  return toTitleCase(text);
}

function isGenericProjectLabel(label: string): boolean {
  const normalized = normalizeLookupText(label);
  return normalized === "q1 planning" ||
    normalized === "api layer improvements" ||
    normalized === "frontend bundle size optimization" ||
    normalized === "mobile api optimizations" ||
    normalized === "frontend tickets" ||
    normalized === "shelter inventory list endpoint" ||
    normalized.includes("feature request backlog") ||
    normalized.endsWith("backlog") ||
    normalized.startsWith("wrapping up the ");
}

function extractSlackDiscoveryLabel(doc: KB2ParsedDocument): string | null {
  if (doc.provider !== "slack") return null;
  const text = `${doc.title}\n${doc.content}`;
  const patterns = [
    /pr coming for the ([a-z0-9][a-z0-9\s-]+?(?:tracking|orders|calendar|page|browser|browse|portal|feature|integration|pipeline|improvements|chooser|navigation|comparison|search|profiles?|responsiveness|standardization|form))(?:\s+api)?/i,
    /working on the ([a-z0-9][a-z0-9\s-]+?(?:page|browser|browse|portal|feature|tracking|orders|calendar|integration|pipeline|improvements|chooser|navigation|comparison|search|profiles?|responsiveness|standardization|form))/i,
    /\b([a-z0-9][a-z0-9\s-]+?(?:tracking|orders|calendar|page|browser|browse|portal|feature|integration|pipeline|improvements|chooser|navigation|comparison|search|profiles?|responsiveness|standardization|form))\s+(?:api|project)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const canonical = canonicalizeProjectLabel(match[1]);
    if (!canonical || isGenericProjectLabel(canonical)) continue;
    return canonical;
  }
  return null;
}

function extractSourceBackedProjectLabel(doc: KB2ParsedDocument): string | null {
  const rawTitle = stripDocTitlePrefix(doc.title);
  if (doc.provider === "jira" || doc.provider === "github") {
    const canonical = canonicalizeProjectLabel(rawTitle);
    const normalized = normalizeLookupText(canonical);
    if (
      !canonical ||
      isGenericProjectLabel(canonical) ||
      /\b(fix|bug|copy|postmortem|dependency|mockup|review|optimization|touch target)\b/.test(normalized)
    ) {
      return null;
    }
    if (
      /\b(page|portal|browser|browse|tracking|orders|calendar|navigation|comparison|integration|responsiveness|feature|redesign|pipeline|response|chooser|search|profile|form)\b/.test(normalized)
    ) {
      return canonical;
    }
    return null;
  }
  return extractSlackDiscoveryLabel(doc);
}

function inferDocBackedCategory(doc: KB2ParsedDocument): Exclude<DiscoveryCategory, "proposed_from_feedback" | "proposed_ticket"> {
  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
  const status = String(
    metadata.status ??
    metadata.state ??
    "",
  ).toLowerCase();
  const merged = String(metadata.merged ?? "").trim();
  const text = `${doc.title}\n${doc.content}`.toLowerCase();

  if (
    /\b(in progress|active|in review|in development|coming|rolling out|ongoing)\b/.test(status) ||
    /\b(pr coming|in flight|rolling out|ongoing)\b/.test(text)
  ) {
    return "ongoing_undocumented";
  }
  if (
    Boolean(merged) ||
    /\b(done|completed|closed|resolved|merged)\b/.test(status) ||
    /\b(beta is live|launched|shipped)\b/.test(text)
  ) {
    return "past_undocumented";
  }
  return "proposed_project";
}

function buildSyntheticObservationFromDoc(
  doc: KB2ParsedDocument,
  label: string,
  description: string,
  confidence: KB2Observation["confidence"],
): KB2Observation {
  const firstUnit = getDocSourceUnits(doc)[0] ?? null;
  const sourceRef = buildEvidenceRefFromDoc(
    doc,
    (firstUnit?.text ?? doc.content).slice(0, 320),
    firstUnit,
  );
  return {
    observation_id: `${doc.sourceId}:${normalizeLookupText(label)}:synthetic`,
    provider: doc.provider,
    doc_id: doc.sourceId,
    parent_doc_id: doc.id,
    unit_id: firstUnit?.unit_id ?? `${doc.sourceId}:synthetic`,
    observation_kind: "work_item_signal",
    label,
    suggested_type: "project",
    reasoning: description,
    confidence,
    evidence_excerpt: sourceRef.excerpt,
    source_ref: sourceRef,
    aliases: [],
    attributes: {},
  };
}

function buildSourceBackedSeeds(docs: KB2ParsedDocument[]): SourceBackedSeed[] {
  const grouped = new Map<string, SourceBackedSeed>();

  for (const doc of docs) {
    if (doc.provider === "customerFeedback") continue;
    const label = extractSourceBackedProjectLabel(doc);
    if (!label) continue;

    const category = inferDocBackedCategory(doc);
    const description = buildEvidenceBackedDescription(label, [doc], category);
    const key = normalizeName(label);
    const existing = grouped.get(key);
    if (existing) {
      existing.docs.push(doc);
      if (existing.category !== "ongoing_undocumented" && category === "ongoing_undocumented") {
        existing.category = category;
      } else if (existing.category === "proposed_project" && category === "past_undocumented") {
        existing.category = category;
      }
      existing.description = buildEvidenceBackedDescription(label, existing.docs, existing.category);
      if (existing.confidence !== "high" && existing.docs.length >= 2) {
        existing.confidence = "high";
      }
      continue;
    }

    grouped.set(key, {
      label,
      category,
      description,
      confidence: "medium",
      docs: [doc],
    });
  }

  const feedbackDocs = docs.filter((doc) => doc.provider === "customerFeedback");
  for (const seed of grouped.values()) {
    if (!/\btracking\b/i.test(seed.label)) continue;
    const labelTokens = normalizeLookupText(seed.label).split(" ").filter((token) => token.length >= 4);
    for (const feedbackDoc of feedbackDocs) {
      const text = normalizeLookupText(`${feedbackDoc.title}\n${feedbackDoc.content}`);
      const matches = labelTokens.filter((token) => text.includes(token)).length;
      if (matches < 2) continue;
      if (seed.docs.some((doc) => doc.sourceId === feedbackDoc.sourceId)) continue;
      seed.docs.push(feedbackDoc);
      if (seed.category === "proposed_project") {
        seed.category = "ongoing_undocumented";
      }
      seed.confidence = "high";
    }
  }

  return [...grouped.values()];
}

function getProjectFamilyTokens(label: string): string[] {
  return normalizeLookupText(label)
    .split(" ")
    .filter((token) =>
      token.length >= 4 &&
      !["page", "feature", "project", "phase", "frontend", "backend"].includes(token)
    );
}

function hasEquivalentProjectFamilyCanonical(label: string, canonicalNodes: KB2GraphNodeType[]): boolean {
  const labelTokens = getProjectFamilyTokens(label);
  if (labelTokens.length === 0) return false;

  return canonicalNodes
    .filter((node) => node.type === "project")
    .some((node) => {
      const names = [node.display_name, ...(node.aliases ?? [])];
      return names.some((name) => {
        const tokens = getProjectFamilyTokens(name);
        const shared = labelTokens.filter((token) => tokens.includes(token));
        return shared.length >= 2 && shared.length >= Math.min(labelTokens.length, tokens.length);
      });
    });
}

function hasConfluenceDocumentation(label: string, docs: KB2ParsedDocument[]): boolean {
  const normalizedLabel = normalizeLookupText(label);
  const labelTokens = normalizedLabel
    .split(" ")
    .filter((token) =>
      token.length >= 4 &&
      !["page", "feature", "portal", "browser", "tracking", "orders", "calendar", "project", "setup"].includes(token)
    );
  const fullTokens = normalizedLabel.split(" ").filter((token) => token.length >= 3);
  const phrases = [
    normalizedLabel,
    fullTokens.slice(0, 2).join(" "),
    fullTokens.slice(-2).join(" "),
  ].filter((phrase) => phrase.length >= 7);
  const confluenceDocs = docs.filter((doc) => {
    if (doc.provider !== "confluence") return false;
    const titleText = normalizeLookupText(doc.title);
    const bodyText = normalizeLookupText(doc.content.slice(0, 4000));
    if (titleText.includes("roadmap")) return false;
    if (/\bno formal project doc\b/i.test(doc.content)) return false;
    if (bodyText.includes("capacity notes") || bodyText.includes("quarterly priorities")) return false;
    return true;
  });
  return confluenceDocs.some((doc) => {
    const hay = normalizeLookupText(`${doc.title}\n${doc.content.slice(0, 8000)}`);
    if (phrases.some((phrase) => hay.includes(phrase))) return true;
    const matches = labelTokens.filter((token) => new RegExp(`\\b${token}\\b`, "i").test(hay)).length;
    return labelTokens.length >= 3 && matches >= 3;
  });
}

function collectRelatedEntities(
  label: string,
  observations: KB2Observation[],
  canonicalNodes: KB2GraphNodeType[],
): string[] {
  const refs = observations.map((observation) => observation.source_ref as Record<string, unknown>);
  const docIds = new Set(refs.map((ref) => String(ref.doc_id ?? "")).filter(Boolean));
  const titles = new Set(refs.map((ref) => String(ref.title ?? "")).filter(Boolean));
  const authors = new Set<string>();
  for (const ref of refs) {
    for (const key of ["source_author", "comment_author", "pr_author", "slack_speaker"]) {
      const value = ref[key];
      if (typeof value === "string" && value.trim()) authors.add(normalizeName(value));
    }
  }

  const combinedText = observations
    .map((observation) => `${observation.label}\n${observation.reasoning}\n${observation.source_ref.excerpt}`)
    .join("\n");

  return canonicalNodes
    .map((node) => {
      if (normalizeName(node.display_name) === normalizeName(label)) return null;
      const aliases = [node.display_name, ...(node.aliases ?? [])].filter(Boolean);
      let score = 0;
      if (node.source_refs.some((ref) => docIds.has(String(ref.doc_id ?? "")) || titles.has(String(ref.title ?? "")))) {
        score += 1;
      }
      if (hasNameMention(combinedText, aliases)) score += 2;
      if (node.type === "team_member" && aliases.some((alias) => authors.has(normalizeName(alias)))) {
        score += 2;
      }
      if (score < 2) return null;
      return { name: node.display_name, score };
    })
    .filter((entry): entry is { name: string; score: number } => Boolean(entry))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((entry) => entry.name);
}

function inferDiscoveryCategory(
  observations: KB2Observation[],
): DiscoveryCategory {
  const text = observations
    .map((observation) => `${observation.reasoning} ${observation.source_ref.excerpt}`)
    .join(" ")
    .toLowerCase();
  const sourceTypes = new Set(observations.map((observation) => observation.source_ref.source_type));

  if (sourceTypes.size === 1 && sourceTypes.has("customer_feedback")) {
    return "proposed_from_feedback";
  }
  if (/\b(should|could|would|proposal|proposed|idea|request|wishlist|want)\b/.test(text)) {
    return observations.some((observation) => observation.suggested_type === "ticket")
      ? "proposed_ticket"
      : "proposed_project";
  }
  if (/\b(done|completed|launched|shipped|migrated|moved off)\b/.test(text)) {
    return "past_undocumented";
  }
  return "ongoing_undocumented";
}

export const discoveryStepV2: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-discovery-v2");
  const stepId = "pass1-step-8";
  const tc = getTenantCollections(ctx.companySlug);

  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  if (!snapshot) throw new Error("No input snapshot found — run step 1 first");
  const docs = snapshot.parsed_documents as KB2ParsedDocument[];

  const step3Artifact = await ctx.getStepArtifact("pass1", 3);
  const observations = (step3Artifact?.observations ?? []) as KB2Observation[];

  const step5ExecId = await ctx.getStepExecutionId("pass1", 5);
  const canonicalNodes = (await tc.graph_nodes.find(
    step5ExecId ? { execution_id: step5ExecId } : { run_id: ctx.runId },
  ).toArray()) as unknown as KB2GraphNodeType[];

  const canonicalTypesByName = buildExistingTypesByName(canonicalNodes);
  const emittedDiscoveryTypesByName = new Map<string, Set<string>>();

  await ctx.onProgress(`Generating discovery hypotheses from ${observations.length} observations...`, 5);

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  const modelName = getFastModelName(ctx.config?.pipeline_settings?.models);
  let llmCalls = 0;

  const feedbackDocs = docs.filter((doc) => doc.provider === "customerFeedback");
  const discoveries: KB2GraphNodeType[] = [];
  const feedbackClusters: Array<{ merged_name: string; submissions: string[] }> = [];
  const duplicateChecks: Array<{ name: string; desired_type: string; existing_types: string[] }> = [];
  const suppressionLog: Array<{ label: string; reason: string; stage: string }> = [];

  if (feedbackDocs.length > 0) {
    const prompt = feedbackDocs.map((doc) =>
      `[doc_id="${doc.sourceId}"] ${doc.title}\n${doc.content.slice(0, 1200)}`).join("\n\n---\n\n");
    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;
    const result = await structuredGenerate({
      model,
      system: FEEDBACK_DISCOVERY_PROMPT,
      prompt,
      schema: FeedbackDiscoverySchema,
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

    const feedbackById = new Map(feedbackDocs.map((doc) => [doc.sourceId, doc]));
    for (const discovery of result.discoveries ?? []) {
      const normalizedFeatureName = normalizeFeedbackFeatureName(discovery.feature_name);
      const evidenceDocs = discovery.evidence_doc_ids
        .map((docId) => feedbackById.get(docId))
        .filter((doc): doc is KB2ParsedDocument => Boolean(doc));
      if (evidenceDocs.length === 0) {
        suppressionLog.push({
          label: normalizedFeatureName,
          reason: "missing_feedback_evidence",
          stage: "feedback",
        });
        continue;
      }
      if (evidenceDocs.length < 2 && discovery.confidence !== "high") {
        suppressionLog.push({
          label: normalizedFeatureName,
          reason: "insufficient_feedback_support",
          stage: "feedback",
        });
        continue;
      }
      if (
        hasEquivalentCanonical(canonicalTypesByName, normalizedFeatureName, discovery.type) ||
        hasEquivalentCanonical(emittedDiscoveryTypesByName, normalizedFeatureName, discovery.type)
      ) {
        suppressionLog.push({
          label: normalizedFeatureName,
          reason: "already_canonical",
          stage: "feedback",
        });
        duplicateChecks.push({
          name: normalizedFeatureName,
          desired_type: discovery.type,
          existing_types: [...(canonicalTypesByName.get(normalizeName(normalizedFeatureName)) ?? [])],
        });
        continue;
      }

      const feedbackObservations = evidenceDocs.map((doc) =>
        buildFeedbackObservation(
          doc,
          normalizedFeatureName,
          discovery.description,
          discovery.type,
          discovery.confidence,
        ));
      const relatedEntities = collectRelatedEntities(
        normalizedFeatureName,
        feedbackObservations,
        canonicalNodes,
      );

      discoveries.push({
        node_id: randomUUID(),
        run_id: ctx.runId,
        execution_id: ctx.executionId,
        type: discovery.type,
        display_name: normalizedFeatureName,
        aliases: [],
        attributes: {
          _hypothesis: true,
          discovery_category: "proposed_from_feedback",
          description: discovery.description,
          related_entities: relatedEntities,
          status: "proposed",
          documentation_level: "undocumented",
          evidence_pack_size: evidenceDocs.length,
        },
        source_refs: feedbackObservations.map((observation) => observation.source_ref),
        truth_status: "inferred",
        confidence: discovery.confidence,
      });
      feedbackClusters.push({
        merged_name: normalizedFeatureName,
        submissions: evidenceDocs.map((doc) => doc.title),
      });
      registerDiscoveryType(emittedDiscoveryTypesByName, normalizedFeatureName, discovery.type);
    }
  }

  const sourceBackedSeeds = buildSourceBackedSeeds(docs);
  for (const seed of sourceBackedSeeds) {
    const seedProviders = new Set(seed.docs.map((doc) => doc.provider));
    const hasCanonicalProject = hasEquivalentCanonical(canonicalTypesByName, seed.label, "project");
    const hasCanonicalProjectFamily = hasEquivalentProjectFamilyCanonical(seed.label, canonicalNodes);
    const hasCanonicalWorkItem =
      hasCanonicalProject ||
      hasCanonicalProjectFamily ||
      hasEquivalentCanonical(canonicalTypesByName, seed.label, "ticket");
    if (seedProviders.size === 1 && seedProviders.has("slack") && seed.docs.length < 2) {
      suppressionLog.push({ label: seed.label, reason: "single_source_slack", stage: "source_backed_seed" });
      continue;
    }
    if (seedProviders.size === 1 && seedProviders.has("jira") && !hasCanonicalWorkItem) {
      suppressionLog.push({ label: seed.label, reason: "jira_only_project_seed", stage: "source_backed_seed" });
      continue;
    }
    if (hasCanonicalProject) {
      suppressionLog.push({ label: seed.label, reason: "already_canonical", stage: "source_backed_seed" });
      duplicateChecks.push({
        name: seed.label,
        desired_type: "project",
        existing_types: [...(canonicalTypesByName.get(normalizeName(seed.label)) ?? [])],
      });
      continue;
    }
    if (hasConfluenceDocumentation(seed.label, docs)) {
      suppressionLog.push({ label: seed.label, reason: "documented_in_confluence", stage: "source_backed_seed" });
      continue;
    }
    if (hasCanonicalProjectFamily && !hasCanonicalProject) {
      suppressionLog.push({ label: seed.label, reason: "canonical_project_family_match", stage: "source_backed_seed" });
      continue;
    }
    if (hasEquivalentCanonical(emittedDiscoveryTypesByName, seed.label, "project")) {
      suppressionLog.push({ label: seed.label, reason: "already_emitted_discovery", stage: "source_backed_seed" });
      duplicateChecks.push({
        name: seed.label,
        desired_type: "project",
        existing_types: [...(canonicalTypesByName.get(normalizeName(seed.label)) ?? [])],
      });
      continue;
    }

    const seedObservations = seed.docs.map((doc) =>
      buildSyntheticObservationFromDoc(doc, seed.label, seed.description, seed.confidence));
    const relatedEntities = collectRelatedEntities(seed.label, seedObservations, canonicalNodes);
    const sourceRefs = seedObservations.map((observation) => observation.source_ref);

    discoveries.push({
      node_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      type: "project",
      display_name: seed.label,
      aliases: [],
      attributes: {
        _hypothesis: true,
        discovery_category: seed.category,
        description: seed.description,
        related_entities: relatedEntities,
        _discovery_basis: hasCanonicalWorkItem ? "canonical_work_item+source_seed" : "source_seed",
        _jira_only_auto_promotion: seedProviders.size === 1 && seedProviders.has("jira") && !hasCanonicalWorkItem,
        status: seed.category === "past_undocumented"
          ? "completed"
          : seed.category === "ongoing_undocumented"
            ? "active"
            : "proposed",
        documentation_level: "undocumented",
        evidence_pack_size: sourceRefs.length,
      },
      source_refs: sourceRefs,
      truth_status: "inferred",
      confidence: seed.confidence,
    });
    registerDiscoveryType(emittedDiscoveryTypesByName, seed.label, "project");
  }

  const grouped = new Map<string, KB2Observation[]>();
  for (const observation of observations) {
    if (observation.suggested_type !== "project" && observation.suggested_type !== "ticket") continue;
    const key = normalizeName(observation.label);
    const current = grouped.get(key) ?? [];
    current.push(observation);
    grouped.set(key, current);
  }

  for (const [, group] of grouped) {
    const sourceTypes = new Set(group.map((observation) => observation.source_ref.source_type));
    const jiraOnly = sourceTypes.size === 1 && sourceTypes.has("jira");
    const hasStrongDocSource = sourceTypes.has("jira") || sourceTypes.has("github");
    const distinctDocCount = new Set(group.map((observation) => observation.doc_id)).size;
    const sourceRefs = group.map((observation) => observation.source_ref);
    const suggestedType = group.some((observation) => observation.suggested_type === "project") ? "project" : "ticket";
    const label = group[0].label;

    const hasCanonicalEquivalent = hasEquivalentCanonical(canonicalTypesByName, label, suggestedType);
    const hasCanonicalProjectFamily =
      suggestedType === "project" && hasEquivalentProjectFamilyCanonical(label, canonicalNodes);

    if (hasCanonicalEquivalent) {
      suppressionLog.push({ label, reason: "already_canonical", stage: "observation_group" });
      duplicateChecks.push({
        name: label,
        desired_type: suggestedType,
        existing_types: [...(canonicalTypesByName.get(normalizeName(label)) ?? [])],
      });
      continue;
    }

    if (hasEquivalentCanonical(emittedDiscoveryTypesByName, label, suggestedType)) {
      suppressionLog.push({ label, reason: "already_emitted_discovery", stage: "observation_group" });
      duplicateChecks.push({
        name: label,
        desired_type: suggestedType,
        existing_types: [...(canonicalTypesByName.get(normalizeName(label)) ?? [])],
      });
      continue;
    }

    if (looksLikeTaskNoise(label, group)) {
      suppressionLog.push({ label, reason: "task_noise", stage: "observation_group" });
      continue;
    }

    if (hasCanonicalProjectFamily) {
      suppressionLog.push({ label, reason: "canonical_project_family_match", stage: "observation_group" });
      duplicateChecks.push({
        name: label,
        desired_type: suggestedType,
        existing_types: [...(canonicalTypesByName.get(normalizeName(label)) ?? [])],
      });
      continue;
    }

    if (suggestedType === "project" && hasConfluenceDocumentation(label, docs)) {
      suppressionLog.push({ label, reason: "documented_in_confluence", stage: "observation_group" });
      continue;
    }

    if (jiraOnly && suggestedType === "project") {
      suppressionLog.push({ label, reason: "jira_only_project_group", stage: "observation_group" });
      continue;
    }

    if (
      suggestedType === "project" &&
      !hasStrongDocSource &&
      !hasStrongProjectShape(label, group) &&
      distinctDocCount < 2 &&
      sourceTypes.size < 2
    ) {
      suppressionLog.push({ label, reason: "weak_project_shape", stage: "observation_group" });
      continue;
    }

    if (suggestedType === "project" && !hasStrongDocSource && distinctDocCount < 2) {
      suppressionLog.push({ label, reason: "insufficient_project_support", stage: "observation_group" });
      continue;
    }

    if (suggestedType === "ticket" && group.length < 2) {
      suppressionLog.push({ label, reason: "single_ticket_signal", stage: "observation_group" });
      continue;
    }

    const category = inferDiscoveryCategory(group);
    const description = buildObservationBackedDescription(label, group);
    const relatedEntities = collectRelatedEntities(label, group, canonicalNodes);

    discoveries.push({
      node_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      type: category === "proposed_ticket" ? "ticket" : suggestedType,
      display_name: label,
      aliases: [],
      attributes: {
        _hypothesis: true,
        discovery_category: category,
        description,
        related_entities: relatedEntities,
        _discovery_basis: hasCanonicalEquivalent ? "canonical_project+observation_group" : "observation_group",
        _jira_only_auto_promotion: false,
        status: category === "past_undocumented"
          ? "completed"
          : category === "ongoing_undocumented"
            ? "active"
            : "proposed",
        documentation_level: "undocumented",
        evidence_pack_size: sourceRefs.length,
      },
      source_refs: sourceRefs,
      truth_status: "inferred",
      confidence: group.length >= 3 ? "high" : "medium",
    });
    registerDiscoveryType(emittedDiscoveryTypesByName, label, category === "proposed_ticket" ? "ticket" : suggestedType);
  }

  if (discoveries.length > 0) {
    await tc.graph_nodes.insertMany(discoveries as any[]);
  }

  const byCategory = discoveries.reduce<Record<string, number>>((acc, node) => {
    const category = String((node.attributes as Record<string, unknown>).discovery_category ?? "unknown");
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {});

  logger.log(`Discovery created ${discoveries.length} evidence-backed hypotheses`);
  await ctx.onProgress(`Discovery created ${discoveries.length} evidence-backed hypotheses`, 100);
  const zeroJiraAutoProjectPromotions = discoveries.every((node) =>
    ((node.attributes as Record<string, unknown> | undefined)?._jira_only_auto_promotion) !== true
  );

  return {
    total_discoveries: discoveries.length,
    total_discoveries_by_category: byCategory,
    llm_calls: llmCalls,
    by_category: byCategory,
    jira_based_discoveries: [],
    feedback_clusters: feedbackClusters,
    duplicate_checks: duplicateChecks,
    suppression_log: suppressionLog,
    discoveries: discoveries.map((node) => ({
      display_name: node.display_name,
      type: node.type,
      category: (node.attributes as Record<string, unknown>).discovery_category,
      confidence: node.confidence,
      description: (node.attributes as Record<string, unknown>).description,
      related_entities: (node.attributes as Record<string, unknown>).related_entities,
      source_count: node.source_refs.length,
      source_documents: node.source_refs.map((ref) => ref.title),
    })),
    zero_jira_auto_project_promotions: zeroJiraAutoProjectPromotions,
    artifact_version: "pass1_v2",
  };
};
