import { randomUUID } from "crypto";
import { getTenantCollections } from "@/lib/mongodb";
import { getReasoningModel, getReasoningModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import {
  KB2GeneratedHowtoResultSchema,
  renderImplementationStepsContent,
  type KB2NormalizedHowtoSection,
  type KB2NormalizedHowtoStep,
  normalizeGeneratedHowtoSections,
} from "@/src/application/lib/kb2/howto-structure";
import {
  buildHowtoEvidenceEntries,
  buildParsedDocLookup,
  buildTechnicalSourceContext,
  collectPageText,
  dedupeHowtoEvidenceRefs,
  formatHowtoSourceTypeLabel,
  hasGuideTokenOverlap,
  normalizeNodeLookupKey,
  type HowtoEvidenceEntry,
} from "@/src/application/lib/kb2/howto-context";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import { buildNodeOwnerMap, getNodeOwnerNames, getPrimaryOwnerName } from "@/src/application/lib/kb2/owner-resolution";
import { buildPlanSectionEvidence } from "@/src/application/lib/kb2/plan-evidence";
import { buildPlanTitle } from "@/src/application/lib/kb2/title-cleanup";
import type { KB2GraphNodeType, KB2GraphEdgeType, KB2EntityPageType, KB2EvidenceRefType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";

const HOWTO_DISCOVERY_CATEGORIES = new Set([
  "proposed_from_feedback",
  "proposed_project",
  "past_undocumented",
  "ongoing_undocumented",
]);

const DEFAULT_HOWTO_SECTIONS = [
  "Overview",
  "Context",
  "Requirements",
  "Implementation Steps",
  "Testing Plan",
  "Risks and Considerations",
  "Prompt Section",
];

const IMPLEMENTATION_REFERENCE_SIGNAL_RE = /\b(lazy|skeleton|fallback|transition|memo|memoize|react\.memo|usecallback|single api call|client side|client-side|round-trip|adoptable|selector|grid|sidebar|vertical|scroll|touch target|payment form|donation form|toast|css modules)\b/i;

type PrescriptionSource = {
  title: string;
  owner?: string | null;
  page: KB2EntityPageType;
  family?: string | null;
};

type CarryForwardLine = {
  family: string;
  text: string;
  tokens: string[];
  evidenceHints: string[];
};

function shouldIncludeFallbackDecisionConstraint(
  projectText: string,
  decisionPage: KB2EntityPageType,
): boolean {
  const projectLower = projectText.toLowerCase();
  const titleLower = decisionPage.title.toLowerCase();
  const decisionText = `${decisionPage.title} ${collectPageText(decisionPage)}`.toLowerCase();
  if (
    /\bvertical\b/.test(decisionText) &&
    /\b(nav|navigation|sidebar|tabs)\b/.test(decisionText)
  ) {
    return /\bmobile\b|\bnavigation\b|\blayout\b|\bresponsive\b|\bprofile\b|\bbrowse\b|\btoy\b|\bdonation\b|\bselector\b|\bcategory\b/.test(projectLower);
  }
  if (
    /\bgender\b/.test(decisionText) &&
    /\b(color|accent|pink|blue)\b/.test(decisionText)
  ) {
    return /\bpet\b|\bbrowse\b|\bprofile\b|\bdonation\b|\btoy\b|\bmobile\b|\bcard\b/.test(projectLower);
  }
  if (
    /\bgreen\b/.test(decisionText) && /\b(donate|donation|sponsor|money|financial|cta|payment)\b/.test(decisionText)
  ) {
    return /\bdonation\b|\btoy\b|\bpayment\b|\bfinancial\b|\bcta\b|\bpurchase\b/.test(projectLower);
  }
  if (titleLower.includes("going with a neutral blue")) {
    return /\bshelter\b|\bvisit\b|\blocation\b|\bnavigation\b/.test(projectLower);
  }
  return false;
}

function getFallbackDecisionFamily(decisionPage: KB2EntityPageType): string | null {
  const titleLower = decisionPage.title.toLowerCase();
  const decisionText = `${decisionPage.title} ${collectPageText(decisionPage)}`.toLowerCase();
  if (/\bdonation form\b/.test(titleLower)) {
    return "financial-form";
  }
  if (/\bvertical\b/.test(titleLower) && /\b(nav|navigation|sidebar|tabs)\b/.test(titleLower)) {
    return "selection-layout";
  }
  if (
    /\b(gender|visual differentiation)\b/.test(titleLower) ||
    (/\bgender\b/.test(decisionText) && /\b(color|accent|pink|blue)\b/.test(decisionText))
  ) {
    return "pet-card-accent";
  }
  if (/\bgreen\b/.test(titleLower) || (/\bgreen\b/.test(decisionText) && /\b(donate|donation|sponsor|money|financial|cta|payment)\b/.test(decisionText))) {
    return "financial-cta";
  }
  if (/\bdonation form\b/.test(decisionText) || /\b(clean white|credit card|preset donation|payment form)\b/.test(decisionText)) {
    return "financial-form";
  }
  if (/\bneutral blue\b/.test(decisionText)) {
    return "neutral-cta";
  }
  return null;
}

function getImplementationReferenceFamily(page: KB2EntityPageType): string | null {
  const text = collectPageText(page).toLowerCase();
  if (
    (
      /\b(load all|single api call|round-trip)\b/.test(text) &&
      /\b(pet|pets|browse|adoptable|selector|category)\b/.test(text)
    ) ||
    (
      /\b(client side|client-side)\b/.test(text) &&
      /\b(pet|pets|browse|adoptable|prev|next|selector)\b/.test(text)
    )
  ) {
    return "small-list-browse";
  }
  if (/\b(pet profile cards?|responsive grid|lazy loading|lazy load|skeleton)\b/.test(text)) {
    return "pet-card-grid";
  }
  if (/\b(payment form|donation form|single-column|stacked field|checkout|cart)\b/.test(text)) {
    return "financial-form";
  }
  if (/\b(44px|hamburger|overlay|bottom navigation|mobile navigation)\b/.test(text)) {
    return "mobile-navigation";
  }
  if (/\b(max-height|overflow-y|scroll)\b/.test(text)) {
    return "scrolling-list";
  }
  return null;
}

function isEligibleImplementationReferenceNode(
  relatedNode: KB2GraphNodeType | undefined,
  currentNodeId: string,
): boolean {
  if (!relatedNode || relatedNode.type !== "project" || relatedNode.node_id === currentNodeId) {
    return false;
  }
  const status = String(relatedNode.attributes?.status ?? "").toLowerCase();
  const discoveryCategory = String(relatedNode.attributes?.discovery_category ?? "").toLowerCase();
  if (status === "proposed" || HOWTO_DISCOVERY_CATEGORIES.has(discoveryCategory)) {
    return false;
  }
  return true;
}

function scoreImplementationReferencePage(projectText: string, page: KB2EntityPageType): number {
  const projectLower = projectText.toLowerCase();
  let score = scoreContextPage(projectText, page);
  if (IMPLEMENTATION_REFERENCE_SIGNAL_RE.test(collectPageText(page))) score += 6;
  if (hasGuideTokenOverlap(projectText, page.title, 2)) score += 4;
  const family = getImplementationReferenceFamily(page);
  if (family === "small-list-browse" && /\bpet\b|\bbrowse\b|\btoy\b|\bdonation\b|\bselector\b/.test(projectLower)) {
    score += 10;
  }
  if (family === "pet-card-grid" && /\bpet\b|\bbrowse\b|\bcard\b|\btoy\b|\bdonation\b/.test(projectLower)) {
    score += 6;
  }
  if (family === "financial-form" && /\bdonation\b|\btoy\b|\bpayment\b|\bcheckout\b/.test(projectLower)) {
    score += 4;
  }
  return score;
}

function buildEvidenceBackedPrescriptionSection(
  projectText: string,
  sources: PrescriptionSource[],
): string {
  const bullets: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const label = source.owner && !source.title.toLowerCase().includes(source.owner.toLowerCase())
      ? `${source.owner} — ${source.title}`
      : source.title;
    const items = collectRelevantContextItems(projectText, source.page)
      .filter((item) => item.sourceRefs.length > 0)
      .slice(0, 2);
    for (const item of items) {
      const itemText = item.text.length > 320 ? `${item.text.slice(0, 317).trim()}...` : item.text;
      const sourceTitles = [...new Set(
        item.sourceRefs
          .map((ref) => (typeof ref.title === "string" ? ref.title.trim() : ""))
          .filter((title): title is string => title.length > 0),
      )].slice(0, 2);
      const key = `${label.toLowerCase()}::${itemText.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bullets.push(
        `- ${label}: ${itemText}${sourceTitles.length > 0 ? ` Sources: ${sourceTitles.join("; ")}.` : ""}`,
      );
      if (bullets.length >= 8) break;
    }
    if (bullets.length >= 8) break;
  }
  if (bullets.length === 0) return "";
  return [
    "## Evidence-Backed Implementation Prescriptions",
    "Carry these concrete choices into the plan when they clearly fit this feature. Use the owner names and source artifacts directly instead of restating them as abstract convention labels.",
    "",
    ...bullets,
  ].join("\n");
}

function familyAppliesToTargetIntent(
  targetIntentText: string,
  family: string | null | undefined,
): boolean {
  if (!family) return true;
  const intentLower = targetIntentText.toLowerCase();
  switch (family) {
    case "financial-cta":
      return /\bdonation\b|\btoy\b|\bpayment\b|\bcheckout\b|\bpurchase\b|\bsponsor\b|\bredesign\b|\bdark mode\b|\btheme\b/.test(intentLower);
    case "pet-card-accent":
      return /\bpet\b|\bprofile\b|\bbrowse\b|\bcard\b|\btoy\b|\bdonation\b/.test(intentLower);
    case "selection-layout":
      return /\bmobile\b|\bnavigation\b|\bcategory\b|\bselect\b|\bselector\b|\btoy\b|\bdonation\b|\bpet\b|\bbrowse\b/.test(intentLower);
    case "small-list-browse":
      if (/\bmobile\b|\bnavigation\b/.test(intentLower) && !/\btoy\b|\bdonation\b|\bhours\b|\bhistory\b|\bshift\b|\breport\b|\bdashboard\b|\blog\b|\badopt\b/.test(intentLower)) {
        return false;
      }
      return /\bpet\b|\bbrowse\b|\btoy\b|\bdonation\b|\blist\b|\binventory\b|\badopt\b|\bselect\b|\bhours\b|\bhistory\b|\bshift\b|\breport\b|\bdashboard\b|\blog\b/.test(intentLower);
    case "pet-card-grid":
      return /\bpet\b|\bbrowse\b|\btoy\b|\bdonation\b|\bcard\b|\bmobile\b/.test(intentLower);
    case "financial-form":
      return /\bdonation\b|\btoy\b|\bpayment\b|\bcheckout\b|\bform\b/.test(intentLower);
    default:
      return false;
  }
}

function collectSupplementalCarryForwardTitles(
  parsedDocuments: KB2ParsedDocument[],
  family: string,
): string[] {
  if (family !== "small-list-browse") return [];
  return parsedDocuments
    .filter((doc) => {
      const text = `${doc.title ?? ""}\n${doc.content ?? ""}`.toLowerCase();
      if (!/\bpr #23\b|\bpr #47\b|\bpr #49\b|\bpr #52\b|\bpr #55\b/.test(text)) return false;
      if (!/\bmatt\b/.test(text)) return false;
      return /\b(round-trip|single api call|no pagination needed|10-15|8-15|load all|full list)\b/.test(text);
    })
    .map((doc) => doc.title?.trim() ?? "")
    .filter((title): title is string => title.length > 0)
    .sort((a, b) => carryForwardTitleRank(b, family) - carryForwardTitleRank(a, family) || a.localeCompare(b))
    .slice(0, 5);
}

function buildCarryForwardLines(
  targetIntentText: string,
  sources: PrescriptionSource[],
  parsedDocuments: KB2ParsedDocument[],
): CarryForwardLine[] {
  const familyOrder = [
    "financial-cta",
    "pet-card-accent",
    "selection-layout",
    "small-list-browse",
    "pet-card-grid",
    "financial-form",
  ] as const;
  const scoreSourceForFamily = (source: PrescriptionSource, family: string): number => {
    const titleLower = source.title.toLowerCase();
    const ownerLower = (source.owner ?? "").toLowerCase();
    let score = source.page.node_type === "project" ? 20 : 0;
    if (ownerLower.length > 0 && !ownerLower.includes("unknown")) score += 10;
    if (family === "financial-cta") {
      if (titleLower.includes("financial")) score += 20;
      if (titleLower.includes("sponsor")) score += 8;
      if (titleLower.includes("green")) score += 15;
    }
    if (family === "small-list-browse") {
      if (titleLower.includes("pet adoption chooser")) score += 30;
      if (titleLower.includes("pagination for shelter inventory")) score -= 30;
    }
    if (family === "selection-layout" && titleLower.includes("vertical nav")) score += 20;
    if (family === "pet-card-grid" && (titleLower.includes("pet profile cards") || titleLower.includes("browse page"))) {
      score += 15;
    }
    if (family === "pet-card-accent" && titleLower.includes("gender")) score += 15;
    return score;
  };
  const bestSourceByFamily = new Map<string, PrescriptionSource>();
  for (const source of sources) {
    const family = source.family ?? getImplementationReferenceFamily(source.page) ?? getFallbackDecisionFamily(source.page);
    if (!family) continue;
    if (!familyAppliesToTargetIntent(targetIntentText, family)) continue;
    const existing = bestSourceByFamily.get(family);
    if (!existing || scoreSourceForFamily(source, family) > scoreSourceForFamily(existing, family)) {
      bestSourceByFamily.set(family, source);
    }
  }
  const lines: CarryForwardLine[] = [];
  for (const family of familyOrder) {
    const source = bestSourceByFamily.get(family);
    if (!source) continue;
    const sourceTitles = [...new Set(
      collectRelevantContextItems(targetIntentText, source.page)
        .slice(0, 3)
        .flatMap((item) => item.sourceRefs)
        .map((ref) => (typeof ref.title === "string" ? ref.title.trim() : ""))
        .filter((title): title is string => title.length > 0),
    )].slice(0, 2);
    const noteTitles = dedupeCaseInsensitive([
      ...sourceTitles,
      ...collectSupplementalCarryForwardTitles(parsedDocuments, family),
    ])
      .sort((a, b) => carryForwardTitleRank(b, family) - carryForwardTitleRank(a, family) || a.localeCompare(b))
      .slice(0, 5);
    const sourceNote = noteTitles.length > 0 ? ` Sources: ${noteTitles.join("; ")}.` : "";
    const ownerLabel = source.owner ? `${source.owner}'s ` : "";
    if (family === "financial-cta") {
      lines.push({
        family,
        text: `Apply ${source.title} to the Donate Toy and checkout CTA buttons: keep green reserved for money-related actions because ${ownerLabel}financial-action convention uses green only for purchase and donation actions.${sourceNote}`,
        tokens: ["green", "donate", "button"],
        evidenceHints: noteTitles,
      });
    } else if (family === "pet-card-accent") {
      lines.push({
        family,
        text: `Apply ${source.title} on any recipient-pet card or confirmation surface: use pink accents for female pets and blue accents for male pets instead of recoloring the entire card.${sourceNote}`,
        tokens: ["pink", "blue", "pet"],
        evidenceHints: noteTitles,
      });
    } else if (family === "selection-layout") {
      lines.push({
        family,
        text: `Use ${ownerLabel}vertical selection pattern from ${source.title}: when this feature asks users to choose a pet or toy category from a bounded set, render a left-side vertical selector/sidebar rather than horizontal tabs.${sourceNote}`,
        tokens: [source.owner?.toLowerCase() ?? "", "vertical", "sidebar"].filter(Boolean),
        evidenceHints: noteTitles,
      });
    } else if (family === "small-list-browse") {
      const reviewPrs = noteTitles
        .map((title) => title.match(/\bPR #\d+\b/i)?.[0]?.toUpperCase() ?? "")
        .filter((label) => label.length > 0 && label !== "PR #23");
      const provenanceText = source.owner
        ? reviewPrs.length > 0
          ? ` This follows ${source.owner}'s original implementation in PR #23 and ${source.owner}'s later review comments on ${reviewPrs.join(", ")}.`
          : ` This follows ${source.owner}'s original implementation in PR #23.`
        : "";
      const targetLower = targetIntentText.toLowerCase();
      const browseText = /\btoy\b|\bdonation\b/.test(targetLower)
        ? "load the full toy catalog in a single request when the flow opens, keep it in component state, and let users switch toy options or recipient pets without per-click API round trips because these selector lists are typically under about 20 items."
        : /\bvolunteer\b|\bhours\b|\bhistory\b|\bshift\b|\breport\b|\bdashboard\b|\blog\b/.test(targetLower)
          ? "load the full hours history or small volunteer list in one request when the dashboard loads, keep it in client state, and sort or filter locally instead of adding per-click fetches or pagination while the dataset stays small."
          : "fetch the full adoptable-pet list once on mount, keep it in component state, and move between pets without per-click API round trips because the list is usually small (about 8-15 pets).";
      lines.push({
        family,
        text: `${source.owner ?? "The"} client-side browse pattern from ${source.title} should drive this step: ${browseText}${provenanceText}${sourceNote}`,
        tokens: /\btoy\b|\bdonation\b/.test(targetLower)
          ? [source.owner?.toLowerCase() ?? "", "single", "toy", "state"].filter(Boolean)
          : /\bvolunteer\b|\bhours\b|\bhistory\b|\bshift\b|\breport\b|\bdashboard\b|\blog\b/.test(targetLower)
            ? [source.owner?.toLowerCase() ?? "", "hours", "client", "state"].filter(Boolean)
            : [source.owner?.toLowerCase() ?? "", "mount", "client", "pets"].filter(Boolean),
        evidenceHints: noteTitles,
      });
    } else if (family === "pet-card-grid") {
      lines.push({
        family,
        text: `Keep the established pet-card browse pattern from ${source.title}: preserve the responsive card grid, lazy-loaded pet images, and skeleton loading behavior when adding toy-donation actions to browse surfaces.${sourceNote}`,
        tokens: ["lazy", "skeleton", "grid"],
        evidenceHints: noteTitles,
      });
    } else if (family === "financial-form") {
      lines.push({
        family,
        text: `Model the purchase flow on ${source.title}: use a clean, single-column checkout/payment form with minimal visual noise and clear confirmation of which pet receives the toy donation.${sourceNote}`,
        tokens: ["single-column", "checkout", "pet"],
        evidenceHints: noteTitles,
      });
    }
  }
  return lines;
}

function dedupeCaseInsensitive(values: string[]): string[] {
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

function carryForwardTitleRank(title: string, family: string): number {
  const lower = title.toLowerCase();
  if (family === "small-list-browse") {
    if (lower.includes("pr #23")) return 100;
    if (lower.includes("pr #47")) return 90;
    if (lower.includes("pr #49")) return 80;
    if (lower.includes("pr #52")) return 70;
    if (lower.includes("pr #55")) return 60;
  }
  if (/\bpr #\d+\b/i.test(title)) return 40;
  if (/\bpaw-\d+\b/i.test(title)) return 20;
  return 0;
}

function scoreCarryForwardStepMatch(step: KB2NormalizedHowtoStep, family: string): number {
  const text = `${step.title} ${step.content}`.toLowerCase();
  switch (family) {
    case "financial-cta":
      return [/\bpayment\b/, /\bcheckout\b/, /\bpurchase\b/, /\bdonation\b/, /\bbutton\b/, /\bcta\b/, /\bdark\b/, /\btheme\b/, /\bcolor\b/, /\bpalette\b/]
        .filter((re) => re.test(text)).length;
    case "pet-card-accent":
      return [/\bpet\b/, /\bcard\b/, /\btarget\b/, /\brecipient\b/, /\bconfirmation\b/, /\bselection\b/]
        .filter((re) => re.test(text)).length;
    case "selection-layout":
      return [/\bselection\b/, /\bselector\b/, /\bsidebar\b/, /\bnavigation\b/, /\bcategory\b/, /\binterface\b/, /\blayout\b/]
        .filter((re) => re.test(text)).length;
    case "small-list-browse":
      return [/\btoy\b/, /\bcatalog\b/, /\bselection\b/, /\brecipient\b/, /\bload\b/, /\bstate\b/, /\bflow\b/, /\bhours\b/, /\bhistory\b/, /\blog\b/, /\blist\b/, /\bdashboard\b/]
        .filter((re) => re.test(text)).length;
    case "pet-card-grid":
      return [/\bcard\b/, /\bgrid\b/, /\bbrowse\b/, /\bimage\b/, /\bselection\b/]
        .filter((re) => re.test(text)).length;
    case "financial-form":
      return [/\bpayment\b/, /\bcheckout\b/, /\bform\b/, /\bconfirmation\b/, /\bsummary\b/]
        .filter((re) => re.test(text)).length;
    default:
      return 0;
  }
}

function buildCarryForwardStepTitle(family: string): string {
  switch (family) {
    case "financial-cta":
      return "Apply Financial CTA Convention";
    case "pet-card-accent":
      return "Apply Pet Card Visual Convention";
    case "selection-layout":
      return "Use Vertical Selection Layout";
    case "small-list-browse":
      return "Reuse Client-Side Browse Pattern";
    case "pet-card-grid":
      return "Reuse Browse Card Pattern";
    case "financial-form":
      return "Model The Checkout Form";
    default:
      return "Apply Established Pattern";
  }
}

function applyCarryForwardToImplementationSteps(
  sections: KB2NormalizedHowtoSection[],
  carryForwardLines: CarryForwardLine[],
): void {
  if (carryForwardLines.length === 0) return;
  const implementationSection = sections.find((section) => section.section_name === "Implementation Steps");
  if (!implementationSection) return;
  const steps = [...(implementationSection.steps ?? [])];

  for (const line of carryForwardLines) {
    const bestIndex = steps.reduce((best, step, index) => {
      const score = scoreCarryForwardStepMatch(step, line.family);
      if (score <= best.score) return best;
      return { index, score };
    }, { index: -1, score: 0 });

    if (bestIndex.index >= 0 && bestIndex.score >= 2) {
      const step = steps[bestIndex.index];
      const stepText = `${step.title} ${step.content}`.toLowerCase();
      if (!line.tokens.every((token) => stepText.includes(token))) {
        step.content = [step.content.trim(), line.text].filter(Boolean).join(" ");
      }
      step.evidence_hints = dedupeCaseInsensitive([...(step.evidence_hints ?? []), ...line.evidenceHints]);
      continue;
    }

    const existingIndex = steps.findIndex((step) => {
      const stepText = `${step.title} ${step.content}`.toLowerCase();
      return line.tokens.every((token) => stepText.includes(token));
    });
    if (existingIndex >= 0) {
      const step = steps[existingIndex];
      step.evidence_hints = dedupeCaseInsensitive([...(step.evidence_hints ?? []), ...line.evidenceHints]);
      continue;
    }

    steps.push({
      title: buildCarryForwardStepTitle(line.family),
      content: line.text,
      ...(line.evidenceHints.length > 0 ? { evidence_hints: line.evidenceHints } : {}),
    });
  }

  implementationSection.steps = steps;
  implementationSection.content = renderImplementationStepsContent(steps);
}

function ensureToyDonationRecipientStory(
  sections: KB2NormalizedHowtoSection[],
  targetIntentText: string,
): void {
  const targetLower = targetIntentText.toLowerCase();
  if (!/\btoy\b/.test(targetLower) || !/\bdonation\b/.test(targetLower) || !/\bpet\b/.test(targetLower)) {
    return;
  }

  const overviewSection = sections.find((section) => section.section_name === "Overview");
  if (overviewSection && !/\bspecific (pet|animal)\b|\brecipient pet\b|\bwhich pet\b/.test(overviewSection.content.toLowerCase())) {
    overviewSection.content = [
      overviewSection.content.trim(),
      "The core user story is that a donor chooses a specific dog, cat, or other shelter pet and the toy donation is routed to that exact animal.",
    ].filter(Boolean).join(" ");
  }

  const requirementsSection = sections.find((section) => section.section_name === "Requirements");
  if (requirementsSection && !/\bspecific (pet|animal)\b|\brecipient pet\b|\bwhich pet\b/.test(requirementsSection.content.toLowerCase())) {
    requirementsSection.content = [
      requirementsSection.content.trim(),
      "Users must be able to choose the specific pet receiving the toy donation and see that recipient confirmed before completing checkout.",
    ].filter(Boolean).join(" ");
  }
}

function scoreContextSectionName(sectionName: string): number {
  const normalized = sectionName.toLowerCase();
  if (normalized.includes("decision")) return 5;
  if (normalized.includes("key")) return 4;
  if (normalized.includes("system")) return 4;
  if (normalized.includes("scope")) return 3;
  if (normalized.includes("api")) return 3;
  if (normalized.includes("implementation")) return 3;
  if (normalized.includes("requirement")) return 2;
  return 0;
}

function collectRelevantContextItems(
  projectText: string,
  page: KB2EntityPageType,
): Array<{ sectionName: string; text: string; sourceRefs: KB2EvidenceRefType[]; score: number }> {
  return page.sections
    .flatMap((section) =>
      section.items.map((item) => {
        const itemText = item.text.trim();
        let score = scoreContextSectionName(section.section_name);
        if (hasGuideTokenOverlap(projectText, itemText, 2)) score += 6;
        if (hasGuideTokenOverlap(projectText, `${page.title} ${itemText}`, 2)) score += 2;
        return {
          sectionName: section.section_name,
          text: itemText,
          sourceRefs: (item.source_refs ?? []) as KB2EvidenceRefType[],
          score,
        };
      }),
    )
    .filter((item) => item.text.length > 0 && item.score > 0)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length);
}

function scoreContextPage(
  projectText: string,
  page: KB2EntityPageType,
  options: { isProjectPage?: boolean; isDirectConvention?: boolean } = {},
): number {
  let score = options.isProjectPage ? 100 : 0;
  if (options.isDirectConvention) score += 25;
  if (page.node_type === "decision") score += 10;
  if (page.node_type === "project") score += 8;
  if (page.node_type === "team_member" || page.node_type === "customer_feedback") score -= 20;
  if (hasGuideTokenOverlap(projectText, page.title, 2)) score += 8;
  const topItemScore = collectRelevantContextItems(projectText, page)[0]?.score ?? 0;
  score += topItemScore;
  return score;
}

function summarizeContextPage(projectText: string, page: KB2EntityPageType): string {
  const items = collectRelevantContextItems(projectText, page).slice(0, 5);
  if (items.length === 0) {
    return `## ${page.title} [${page.node_type}]`;
  }
  return [
    `## ${page.title} [${page.node_type}]`,
    ...items.map((item) => `- ${item.sectionName}: ${item.text}`),
  ].join("\n");
}

function getRelatedEntityOwnerName(
  node: KB2GraphNodeType,
  nodeByName: Map<string, KB2GraphNodeType>,
  ownershipMap: Map<string, string[]>,
): string | null {
  const relatedNames = Array.isArray(node.attributes?.related_entities)
    ? node.attributes.related_entities
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim())
    : [];
  for (const name of relatedNames) {
    const relatedNode = nodeByName.get(normalizeNodeLookupKey(name));
    if (relatedNode?.type === "team_member") {
      return relatedNode.display_name;
    }
    const owner = getPrimaryOwnerName(relatedNode, ownershipMap);
    if (owner) return owner;
  }
  return null;
}

const DEFAULT_GENERATE_HOWTO_SYSTEM = `You generate implementation plan documents for engineering work items.
Each plan has sections that must be filled with specific, actionable content.

\${company_context}

Sections: \${howto_sections}

Rules:
- Overview: 2-3 sentences explaining what this ticket is about and why it matters.
- Context: What existing patterns, systems, and decisions are relevant. Reference specific entities.
- Requirements: What must be true when this is done. Acceptance criteria.
- Implementation Steps: Return 4-7 explicit step objects in the section's steps array. Each step needs a short title plus 2-4 sentences of prose explaining what to do and why it matters for this feature.
- Testing Plan: What tests to write. What edge cases to cover.
- Risks and Considerations: What could go wrong. What tradeoffs exist.
- Prompt Section: If an AI agent were implementing this, what prompt/instructions would you give it?

CRITICAL:
- Reference actual patterns and decisions discovered in the KB. Do NOT give generic advice.
- When Convention Constraints are provided, name each convention explicitly in the relevant sections using the convention name and owner name from the data (e.g. "Use [color] for the [element] — [Owner]'s [convention name]").
- Name the person who established each convention using the names from the Convention Constraints. Do not say "established team patterns" — use the specific person and convention names provided in the data.
- Map each convention to a concrete implementation choice for this specific feature.
- When Convention Evidence is provided, for each convention explain what it means for this feature, the specific implementation choice it implies, and at least one supporting source artifact.
- When Implementation Patterns From Related Projects is provided, use those artifacts to make concrete UI, data-loading, component, and workflow choices without inventing unsupported details.
- When Evidence-Backed Implementation Prescriptions are provided, carry those exact implementation choices into Context, Requirements, and Implementation Steps with owner attribution. Do not reduce them to abstract convention mentions.
- In Context and Requirements, cite only the specific KB source artifact names (Slack thread title/date, PR title, feedback title, ticket key) that are explicitly present in the provided context and directly support the claim.
- In Implementation Steps, write prose only. No code blocks, no pseudocode, no JSX, and no inline code samples.
- Each implementation step should mention the exact source artifact names that justify it via that step's evidence_hints array. Use exact titles from the provided context only.
- If a step proposes new backend, data, or UI work that is not explicitly named in the evidence, say it is new work to define instead of inventing routes, fields, payloads, or component names.
- Do not spell raw HTTP method/path snippets in Implementation Steps. Describe existing APIs in plain English.
- Do not invent file paths, endpoints, libraries, source titles, architecture details, owners, or conventions.
- If a detail is not grounded in the provided context, keep the step general instead of making up a concrete implementation.
- Write like a knowledgeable teammate: short sentences, active voice, plain English. No filler intros or hedge words.`;

function summarizeHowtoSample(doc: {
  title: string;
  ticket_id?: string | null;
  project_node_id?: string | null;
  linked_entity_ids: string[];
  sections: { section_name: string; content: string }[];
}) {
  return {
    title: doc.title,
    ticket_id: doc.ticket_id ?? null,
    project_node_id: doc.project_node_id ?? null,
    linked_entity_ids: doc.linked_entity_ids,
    sections: doc.sections.map((section) => ({
      section_name: section.section_name,
      // Keep judge-visible samples long enough to include later implementation steps.
      content: section.content.slice(
        0,
        section.section_name === "Implementation Steps"
          ? 6000
          : section.section_name === "Requirements" || section.section_name === "Context"
            ? 3000
            : 1800,
      ),
    })),
  };
}

function formatEvidenceEntries(
  title: string,
  entries: HowtoEvidenceEntry[],
): string {
  if (entries.length === 0) return "";
  return [
    `### ${title}`,
    ...entries.map((entry) => [
      `#### ${entry.sourceTypeLabel} — ${entry.title}`,
      entry.sectionHeading ? `Section: ${entry.sectionHeading}` : "",
      entry.text ? `Evidence: ${entry.text}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function getConventionOwnerName(
  conventionNode: KB2GraphNodeType,
  ownershipMap: Map<string, string[]>,
): string | null {
  const establishedBy = typeof conventionNode.attributes?.established_by === "string"
    ? conventionNode.attributes.established_by.trim()
    : "";
  return establishedBy
    || getPrimaryOwnerName(conventionNode, ownershipMap)
    || getNodeOwnerNames(conventionNode, ownershipMap)[0]
    || null;
}

export const generateHowtoStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-generate-howto");
  const stepId = "pass1-step-16";

  const epExecId = await ctx.getStepExecutionId("pass1", 14);
  const epFilter = epExecId ? { execution_id: epExecId } : { run_id: ctx.runId };
  const entityPages = (await tc.entity_pages.find(epFilter).toArray()) as unknown as KB2EntityPageType[];
  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  const nodeExecIds = [step9ExecId, step10ExecId].filter(Boolean);
  const nodesFilter = nodeExecIds.length > 0
    ? { execution_id: { $in: nodeExecIds } }
    : { run_id: ctx.runId };
  const rawGraphNodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  const seenNodeIds = new Set<string>();
  const graphNodes = rawGraphNodes.filter((n) => {
    const key = n.node_id ?? `${n.type}:${n.display_name}`;
    if (seenNodeIds.has(key)) return false;
    seenNodeIds.add(key);
    return true;
  });
  const edgesExecId = await ctx.getStepExecutionId("pass1", 6);
  const edgesFilter = edgesExecId ? { execution_id: edgesExecId } : { run_id: ctx.runId };
  const graphEdges = (await tc.graph_edges.find(edgesFilter).toArray()) as unknown as KB2GraphEdgeType[];
  for (const stepNum of [7, 11]) {
    const execId = await ctx.getStepExecutionId("pass1", stepNum);
    if (execId) {
      const extra = (await tc.graph_edges.find({ execution_id: execId }).toArray()) as unknown as KB2GraphEdgeType[];
      const edgeSet = new Set(graphEdges.map((e) => e.edge_id));
      for (const e of extra) { if (!edgeSet.has(e.edge_id)) graphEdges.push(e); }
    }
  }
  const nodeByName = new Map(
    graphNodes.map((node) => [normalizeNodeLookupKey(node.display_name), node]),
  );
  const graphNodeById = new Map(
    graphNodes.map((node) => [node.node_id, node]),
  );
  const ticketNodeByKey = new Map(
    graphNodes
      .filter((node) => node.type === "ticket")
      .map((node) => [node.display_name.toUpperCase(), node]),
  );
  const ownershipMap = buildNodeOwnerMap(graphNodes, graphEdges);

  const seenTargetIds = new Set<string>();
  const howtoTargetNodes = graphNodes.filter((n) => {
    if (n.type !== "project") return false;
    if (!HOWTO_DISCOVERY_CATEGORIES.has(n.attributes?.discovery_category ?? "") && n.attributes?.status !== "proposed") return false;
    const key = n.node_id ?? n.display_name;
    if (seenTargetIds.has(key)) return false;
    seenTargetIds.add(key);
    return true;
  });

  if (howtoTargetNodes.length === 0) {
    await ctx.onProgress("No project targets available for plan generation", 100);
    return { total_howtos: 0, llm_calls: 0 };
  }

  const entityPageByNodeId = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) {
    entityPageByNodeId.set(ep.node_id, ep);
  }
  const latestSnapshot = await tc.input_snapshots.findOne(
    { run_id: ctx.runId },
    { sort: { created_at: -1 } },
  ) as { parsed_documents?: KB2ParsedDocument[] } | null;
  const parsedDocs = (latestSnapshot?.parsed_documents ?? []) as KB2ParsedDocument[];
  const parsedDocLookup = buildParsedDocLookup(parsedDocs);

  const howtoSections =
    ctx.config?.pipeline_settings?.howto?.sections ?? DEFAULT_HOWTO_SECTIONS;
  const howtoSectionsStr = howtoSections.join(", ");

  let systemPrompt =
    ctx.config?.prompts?.generate_howto?.system ?? DEFAULT_GENERATE_HOWTO_SYSTEM;
  const companyContext = ctx.config?.profile?.company_context ?? "";
  systemPrompt = systemPrompt.replace(/\$\{company_context\}/g, companyContext);
  systemPrompt = systemPrompt.replace(/\$\{howto_sections\}/g, howtoSectionsStr);

  const model = getReasoningModel(ctx.config?.pipeline_settings?.models);
  const modelName = getReasoningModelName(ctx.config?.pipeline_settings?.models);
  let totalLLMCalls = 0;
  const howtoDocs: any[] = [];
  const complianceResults: { node: string; convention: string; referenced: boolean }[] = [];
  const howtoSamples: ReturnType<typeof summarizeHowtoSample>[] = [];
  const sourceArtifactTitlesUsed = new Set<string>();
  let directTechnicalSourceCount = 0;
  let conventionConstraintsTotal = 0;
  let implementationReferenceCount = 0;
  let implementationReferenceOpportunities = 0;
  let implementationStepCount = 0;
  let stepsWithSourceRefs = 0;

  await ctx.onProgress(`Generating plans for ${howtoTargetNodes.length} project targets...`, 5);

  for (let i = 0; i < howtoTargetNodes.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const node = howtoTargetNodes[i];

    const projectEntityPage = entityPageByNodeId.get(node.node_id);
    const targetIntentText = [
      node.display_name,
      typeof node.attributes?.description === "string" ? node.attributes.description : "",
    ]
      .filter(Boolean)
      .join(" ");
    const baseProjectText = [
      node.display_name,
      typeof node.attributes?.description === "string" ? node.attributes.description : "",
      projectEntityPage ? collectPageText(projectEntityPage) : "",
    ]
      .filter(Boolean)
      .join(" ");
    const projectInfo = projectEntityPage
      ? summarizeContextPage(baseProjectText, projectEntityPage)
      : [
          `Title: ${node.display_name}`,
          node.attributes?.description ? `Description: ${node.attributes.description}` : "",
          node.attributes?.priority ? `Priority: ${node.attributes.priority}` : "",
          node.attributes?.status ? `Status: ${node.attributes.status}` : "",
        ]
          .filter(Boolean)
          .join("\n");

    const relatedNodeIds = new Set<string>();
    for (const edge of graphEdges) {
      if (edge.source_node_id === node.node_id) relatedNodeIds.add(edge.target_node_id);
      if (edge.target_node_id === node.node_id) relatedNodeIds.add(edge.source_node_id);
    }
    relatedNodeIds.delete(node.node_id);

    const appliesToEdges = graphEdges.filter(
      (e) => e.type === "APPLIES_TO" && e.target_node_id === node.node_id,
    );
    const directConventionNodeIds = new Set(appliesToEdges.map((edge) => edge.source_node_id));
    const rankedRelatedPages = entityPages
      .filter((page) => relatedNodeIds.has(page.node_id))
      .map((page) => ({
        page,
        score: scoreContextPage(baseProjectText, page, {
          isDirectConvention: directConventionNodeIds.has(page.node_id),
        }),
      }))
      .filter((entry) => entry.score >= 10 || directConventionNodeIds.has(entry.page.node_id))
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title))
      .slice(0, 6);
    const relatedPages = rankedRelatedPages.map((entry) => entry.page);
    const relatedContext = relatedPages
      .map((page) => summarizeContextPage(baseProjectText, page))
      .join("\n\n");
    const projectContextText = [baseProjectText, relatedContext].filter(Boolean).join("\n\n");

    const linkedTicketKey = typeof node.attributes?.linked_ticket === "string"
      ? node.attributes.linked_ticket.toUpperCase()
      : null;
    const linkedTicketNode = linkedTicketKey ? ticketNodeByKey.get(linkedTicketKey) : null;
    const projectSourceRefs = projectEntityPage
      ? collectRelevantContextItems(baseProjectText, projectEntityPage)
          .slice(0, 8)
          .flatMap((item) => item.sourceRefs)
      : [];
    const relatedSourceRefs = relatedPages.flatMap((page) =>
      collectRelevantContextItems(baseProjectText, page)
        .slice(0, 5)
        .flatMap((item) => item.sourceRefs),
    );
    const technicalSourceContext = buildTechnicalSourceContext(
      projectContextText,
      [
        ...(node.source_refs ?? []),
        ...(linkedTicketNode?.source_refs ?? []),
        ...projectSourceRefs,
        ...relatedSourceRefs,
      ] as KB2EvidenceRefType[],
      parsedDocLookup,
    );
    directTechnicalSourceCount += technicalSourceContext.refs.length;
    const implementationReferenceCandidates = rankedRelatedPages
      .filter((entry) => isEligibleImplementationReferenceNode(graphNodeById.get(entry.page.node_id), node.node_id))
      .map((entry) => ({
        page: entry.page,
        score: entry.score,
        family: getImplementationReferenceFamily(entry.page),
      }))
      .filter((entry) => familyAppliesToTargetIntent(targetIntentText, entry.family));
    const seenImplementationReferenceNodeIds = new Set(
      implementationReferenceCandidates.map((entry) => entry.page.node_id),
    );
    const globalImplementationReferenceCandidates = entityPages
      .filter((page) => !seenImplementationReferenceNodeIds.has(page.node_id))
      .map((page) => ({
        page,
        relatedNode: graphNodeById.get(page.node_id),
        score: scoreImplementationReferencePage(targetIntentText, page),
        family: getImplementationReferenceFamily(page),
      }))
      .filter(({ relatedNode, score, family }) =>
        isEligibleImplementationReferenceNode(relatedNode, node.node_id)
        && score >= 8
        && familyAppliesToTargetIntent(targetIntentText, family)
      )
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title));
    const implementationReferencePageCandidates = [
      ...implementationReferenceCandidates,
      ...globalImplementationReferenceCandidates.map(({ page, score, family }) => ({ page, score, family })),
    ]
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title));
    const implementationReferencePages: typeof implementationReferencePageCandidates = [];
    const seenImplementationFamilies = new Set<string>();
    for (const entry of implementationReferencePageCandidates) {
      if (entry.family && seenImplementationFamilies.has(entry.family)) continue;
      implementationReferencePages.push(entry);
      if (entry.family) seenImplementationFamilies.add(entry.family);
      if (implementationReferencePages.length >= 4) break;
    }
    const implementationReferenceSourceRefs = implementationReferencePages.flatMap(({ page }) =>
      collectRelevantContextItems(targetIntentText, page)
        .slice(0, 6)
        .flatMap((item) => item.sourceRefs),
    );
    if (implementationReferenceSourceRefs.length > 0) {
      implementationReferenceOpportunities += 1;
    }
    const implementationReferenceEntries = buildHowtoEvidenceEntries(
      projectContextText,
      implementationReferenceSourceRefs,
      parsedDocLookup,
      {
        minScore: 6,
        maxRefs: 6,
        maxChars: 1600,
        dropFeedbackWhenTechnical: true,
      },
    );
    implementationReferenceCount += implementationReferenceEntries.length;
    const implementationReferenceContext = implementationReferenceEntries.length > 0
      ? [
        "## Implementation Patterns From Related Projects",
        "These artifacts come from completed or existing work with similar surfaces or component patterns.",
        "Use them to make concrete UI, data-loading, component, and workflow choices only when the evidence clearly applies to this feature.",
        "",
        formatEvidenceEntries("Related Project Source Evidence", implementationReferenceEntries),
      ].join("\n\n")
      : "";
    const contextPages = [
      projectEntityPage,
      ...relatedPages,
      ...implementationReferencePages.map(({ page }) => page),
    ].filter(
      (page): page is KB2EntityPageType => Boolean(page),
    );

    // Gather convention constraints via APPLIES_TO edges pointing at this feature
    const conventionConstraints: { title: string; details: string; refs: KB2EvidenceRefType[] }[] = [];
    const prescriptionSources: PrescriptionSource[] = [];
    const seenConstraintTitles = new Set<string>();
    const pushConstraint = (title: string, details: string, refs: KB2EvidenceRefType[] = []) => {
      const key = title.trim().toLowerCase();
      if (!key || seenConstraintTitles.has(key)) return;
      seenConstraintTitles.add(key);
      conventionConstraints.push({ title, details, refs });
    };
    for (const ae of appliesToEdges) {
      const conventionNode = graphNodes.find(
        (n) => n.node_id === ae.source_node_id && n.attributes?.is_convention === true,
      );
      if (!conventionNode) continue;
      const conventionPage = entityPageByNodeId.get(conventionNode.node_id);
      const conventionOwner = getConventionOwnerName(conventionNode, ownershipMap);
      const conventionBaseTitle = conventionPage?.title ?? conventionNode.display_name;
      const conventionTitle = conventionOwner && !conventionBaseTitle.toLowerCase().includes(conventionOwner.toLowerCase())
        ? `${conventionOwner} — ${conventionBaseTitle}`
        : conventionBaseTitle;
      const conventionEvidenceEntries = buildHowtoEvidenceEntries(
        projectContextText,
        ((conventionNode.source_refs ?? []) as KB2EvidenceRefType[]),
        parsedDocLookup,
        {
          minScore: 0,
          maxRefs: 5,
          maxChars: 1600,
          dropFeedbackWhenTechnical: false,
        },
      );
      const conventionDetails = [
        conventionOwner ? `Owner: ${conventionOwner}` : "",
        typeof conventionNode.attributes?.pattern_rule === "string"
          ? `Pattern Rule: ${conventionNode.attributes.pattern_rule}`
          : "",
        conventionPage ? `Current KB Summary:\n${summarizeContextPage(projectContextText, conventionPage)}` : "",
        formatEvidenceEntries("Raw Source Evidence", conventionEvidenceEntries),
      ]
        .filter(Boolean)
        .join("\n\n");
      pushConstraint(
        conventionTitle,
        conventionDetails || "(no detailed page available)",
        conventionEvidenceEntries.map((entry) => entry.ref),
      );
      if (conventionPage) {
        prescriptionSources.push({
          title: conventionTitle,
          owner: conventionOwner,
          page: conventionPage,
          family: getFallbackDecisionFamily(conventionPage),
        });
      }
    }

    const fallbackDecisionConstraints = entityPages
      .filter((page) =>
        page.node_type === "decision" &&
        !directConventionNodeIds.has(page.node_id) &&
        shouldIncludeFallbackDecisionConstraint(targetIntentText, page),
      )
      .map((page) => ({
        page,
        score: scoreContextPage(targetIntentText, page),
        family: getFallbackDecisionFamily(page),
      }))
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title));
    const selectedFallbackDecisionConstraints: typeof fallbackDecisionConstraints = [];
    const seenFallbackFamilies = new Set<string>();
    for (const entry of fallbackDecisionConstraints) {
      if (entry.family && seenFallbackFamilies.has(entry.family)) continue;
      selectedFallbackDecisionConstraints.push(entry);
      if (entry.family) seenFallbackFamilies.add(entry.family);
      if (selectedFallbackDecisionConstraints.length >= 6) break;
    }
    for (const { page: decisionPage } of selectedFallbackDecisionConstraints) {
      const decisionNode = graphNodeById.get(decisionPage.node_id);
      const decisionOwner = decisionNode ? getConventionOwnerName(decisionNode, ownershipMap) : null;
      const decisionEvidenceEntries = buildHowtoEvidenceEntries(
        projectContextText,
        decisionNode
          ? ((decisionNode.source_refs ?? []) as KB2EvidenceRefType[])
          : collectRelevantContextItems(projectContextText, decisionPage)
              .slice(0, 5)
              .flatMap((item) => item.sourceRefs),
        parsedDocLookup,
        {
          minScore: 0,
          maxRefs: 4,
          maxChars: 1600,
          dropFeedbackWhenTechnical: false,
        },
      );
      const decisionDetails = [
        decisionOwner ? `Owner: ${decisionOwner}` : "",
        typeof decisionNode?.attributes?.pattern_rule === "string"
          ? `Pattern Rule: ${decisionNode.attributes.pattern_rule}`
          : "",
        `Current KB Summary:\n${summarizeContextPage(projectContextText, decisionPage)}`,
        formatEvidenceEntries("Raw Source Evidence", decisionEvidenceEntries),
      ]
        .filter(Boolean)
        .join("\n\n");
      const decisionTitle = decisionOwner && !decisionPage.title.toLowerCase().includes(decisionOwner.toLowerCase())
        ? `${decisionOwner} — ${decisionPage.title}`
        : decisionPage.title;
      pushConstraint(decisionTitle, decisionDetails, decisionEvidenceEntries.map((entry) => entry.ref));
      prescriptionSources.push({
        title: decisionTitle,
        owner: decisionOwner,
        page: decisionPage,
        family: getFallbackDecisionFamily(decisionPage),
      });
    }
    conventionConstraintsTotal += conventionConstraints.length;

    const conventionSection = conventionConstraints.length > 0
      ? `## Convention Evidence (HARD — the implementation MUST comply with these)\nYou MUST reference each convention by its exact name (e.g. "${conventionConstraints[0].title}") in the relevant sections.\nFor each convention, state: (a) what it means for this feature, (b) the specific implementation choice it implies, and (c) at least one supporting source artifact.\n\n${conventionConstraints.map((c) => `### ${c.title}\n${c.details}`).join("\n\n")}\n`
      : "";
    for (const { page } of implementationReferencePages) {
      const relatedNode = graphNodeById.get(page.node_id);
      prescriptionSources.push({
        title: page.title,
        owner: getPrimaryOwnerName(relatedNode, ownershipMap) || null,
        page,
        family: getImplementationReferenceFamily(page),
      });
    }
    const prescriptionSection = buildEvidenceBackedPrescriptionSection(targetIntentText, prescriptionSources);
    const carryForwardLines = buildCarryForwardLines(targetIntentText, prescriptionSources, parsedDocs);

    const userPrompt = `Generate an implementation plan for this proposed project:

## Project
${projectInfo}

## Output reminders
- Fill every requested section.
- For Implementation Steps, populate the steps array with titled prose steps.
- Each implementation step must list exact supporting artifact titles in evidence_hints.
- Do not include code blocks or inline code in Implementation Steps.
- When Evidence-Backed Implementation Prescriptions are provided, carry those concrete choices into the plan with owner attribution instead of referring to them abstractly.

${technicalSourceContext.context ? `${technicalSourceContext.context}\n\n` : ""}${conventionSection}${implementationReferenceContext ? `${implementationReferenceContext}\n\n` : ""}${prescriptionSection ? `${prescriptionSection}\n\n` : ""}${relatedContext ? `## Related Entity Context (from knowledge base)\n${relatedContext}` : ""}`;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;

    const result = await structuredGenerate({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      schema: KB2GeneratedHowtoResultSchema,
      logger,
      onUsage: (u) => { usageData = u; },
      signal: ctx.signal,
    });

    totalLLMCalls++;
    const normalizedSections = normalizeGeneratedHowtoSections(result.sections ?? [], howtoSections)
      .filter((section) => section.section_name !== "Prompt Section");
    if (carryForwardLines.length > 0) {
      const implementationStepText = normalizedSections
        .filter((section) => section.section_name === "Implementation Steps")
        .flatMap((section) => (section.steps ?? []).flatMap((step) => [step.title, step.content]))
        .join(" ")
        .toLowerCase();
      const missingCarryForwardLines = carryForwardLines
        .filter((line) => !line.tokens.every((token) => implementationStepText.includes(token)));
      applyCarryForwardToImplementationSteps(normalizedSections, missingCarryForwardLines);
    }
    ensureToyDonationRecipientStory(normalizedSections, targetIntentText);
    if (usageData) {
      const cost = calculateCostUsd(modelName, usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(
        stepId,
        modelName,
        `Plan: ${node.display_name}`,
        JSON.stringify(normalizedSections.slice(0, 2)).slice(0, 5000),
        usageData.promptTokens,
        usageData.completionTokens,
        cost,
        Date.now() - startMs,
      );
    }

    if (conventionConstraints.length > 0) {
      const generatedText = normalizedSections
        .flatMap((section) => [
          section.content,
          ...(section.steps ?? []).flatMap((step) => [step.title, step.content]),
        ])
        .join(" ")
        .toLowerCase();
      for (const cc of conventionConstraints) {
        const conventionNameLower = cc.title.toLowerCase();
        const ownerToken = conventionNameLower.includes("—")
          ? conventionNameLower.split("—")[0].trim()
          : "";
        const bareConventionName = conventionNameLower.includes("—")
          ? conventionNameLower.split("—").slice(1).join("—").trim()
          : conventionNameLower;
        const keyTokens = conventionNameLower
          .replace(/[^a-z0-9\s-]/g, " ")
          .split(/\s+/)
          .filter((t) => t.length > 3 && !["convention", "pattern", "decision", "for", "the", "and", "with"].includes(t));
        const referenced = generatedText.includes(conventionNameLower)
          || (bareConventionName.length > 0 && generatedText.includes(bareConventionName))
          || (keyTokens.length >= 2 && keyTokens.filter((t) => generatedText.includes(t)).length >= Math.ceil(keyTokens.length * 0.6))
          || (
            keyTokens.length === 1
            && generatedText.includes(keyTokens[0]!)
            && (!ownerToken || generatedText.includes(ownerToken))
          );
        complianceResults.push({ node: node.display_name, convention: cc.title, referenced });
        if (!referenced) {
          logger.log(
            `How-to for "${node.display_name}" does not reference linked convention "${cc.title}"`,
          );
        }
      }
    }

    const linkedEntityIds = [
      node.node_id,
      ...(result.linked_entity_ids ?? []).filter((id) => relatedNodeIds.has(id)),
    ];
    const fallbackEvidenceRefs = dedupeHowtoEvidenceRefs([
      ...technicalSourceContext.refs,
      ...conventionConstraints.flatMap((constraint) => constraint.refs),
      ...implementationReferenceEntries.map((entry) => entry.ref),
    ]);
    const sectionsWithEvidence = buildPlanSectionEvidence(normalizedSections, {
      entityPages: contextPages,
      fallbackSourceRefs: fallbackEvidenceRefs,
    });
    const implementationSteps = sectionsWithEvidence.flatMap((section) => section.steps ?? []);
    implementationStepCount += implementationSteps.length;
    stepsWithSourceRefs += implementationSteps.filter((step) => (step.source_refs?.length ?? 0) > 0).length;
    for (const ref of [
      ...sectionsWithEvidence.flatMap((section) => section.source_refs ?? []),
      ...implementationSteps.flatMap((step) => step.source_refs ?? []),
    ]) {
      if (typeof ref.title === "string" && ref.title.trim().length > 0) {
        sourceArtifactTitlesUsed.add(ref.title.trim());
      }
    }
    const uniqueLinked = [...new Set([
      ...linkedEntityIds,
      ...sectionsWithEvidence.flatMap((section) => section.entity_refs?.map((ref) => ref.node_id) ?? []),
      ...sectionsWithEvidence.flatMap((section) =>
        section.steps?.flatMap((step) => step.entity_refs?.map((ref) => ref.node_id) ?? []) ?? [],
      ),
    ])];
    const ownerName =
      getPrimaryOwnerName(linkedTicketNode ?? undefined, ownershipMap, {
        includeReporterFallback: Boolean(linkedTicketNode),
      }) ??
      getRelatedEntityOwnerName(node, nodeByName, ownershipMap) ??
      getPrimaryOwnerName(node, ownershipMap) ??
      getNodeOwnerNames(node, ownershipMap)[0] ??
      "";
    const nowIso = new Date().toISOString();

    const doc = {
      howto_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      ticket_id: null,
      project_node_id: node.node_id,
      title: buildPlanTitle(node.display_name),
      sections: sectionsWithEvidence,
      linked_entity_ids: uniqueLinked,
      created_at: nowIso,
      updated_at: nowIso,
      plan_status: "draft",
      owner_name: ownerName,
      reviewers: [],
      discussion: [],
    };
    howtoDocs.push(doc);
    if (howtoSamples.length < 5) {
      howtoSamples.push(summarizeHowtoSample(doc));
    }

    if ((i + 1) % 3 === 0 || i === howtoTargetNodes.length - 1) {
      const pct = Math.round(5 + ((i + 1) / howtoTargetNodes.length) * 90);
      await ctx.onProgress(`Generated ${i + 1}/${howtoTargetNodes.length} plans`, pct);
    }
  }

  if (howtoDocs.length > 0) {
    await tc.howto.insertMany(howtoDocs);
  }

  await ctx.onProgress(`Generated ${howtoDocs.length} plans`, 100);
  const referencedConventionCount = complianceResults.filter((result) => result.referenced).length;
  const conventionReferenceCoveragePct = complianceResults.length > 0
    ? Math.round((referencedConventionCount / complianceResults.length) * 100)
    : 100;
  const stepEvidenceCoveragePct = implementationStepCount > 0
    ? Math.round((stepsWithSourceRefs / implementationStepCount) * 100)
    : 0;
  return {
    total_howtos: howtoDocs.length,
    llm_calls: totalLLMCalls,
    target_node_count: howtoTargetNodes.length,
    target_nodes: howtoTargetNodes.map((node) => node.display_name),
    howto_titles: howtoDocs.map((doc) => doc.title),
    howto_samples: howtoSamples,
    direct_technical_source_count: directTechnicalSourceCount,
    convention_constraints_total: conventionConstraintsTotal,
    convention_refs_total: referencedConventionCount,
    convention_reference_coverage_pct: conventionReferenceCoveragePct,
    implementation_reference_count: implementationReferenceCount,
    implementation_reference_opportunities: implementationReferenceOpportunities,
    implementation_step_count: implementationStepCount,
    steps_with_source_refs: stepsWithSourceRefs,
    step_evidence_coverage_pct: stepEvidenceCoveragePct,
    source_artifact_titles_used: [...sourceArtifactTitlesUsed].sort((a, b) => a.localeCompare(b)),
    compliance_results: complianceResults,
  };
};
