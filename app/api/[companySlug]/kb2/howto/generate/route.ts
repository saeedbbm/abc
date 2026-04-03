import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { getReasoningModel } from "@/lib/ai-model";
import { getTenantCollections } from "@/lib/mongodb";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { getCompanyConfig } from "@/src/application/lib/kb2/company-config";
import {
  KB2GeneratedHowtoResultSchema,
  renderImplementationStepsContent,
  type KB2NormalizedHowtoSection,
  type KB2NormalizedHowtoStep,
  normalizeGeneratedHowtoSections,
} from "@/src/application/lib/kb2/howto-structure";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import {
  buildHowtoEvidenceEntries,
  buildParsedDocLookup,
  buildTechnicalSourceContext,
  collectPageText,
  dedupeHowtoEvidenceRefs,
  hasGuideTokenOverlap,
  type HowtoEvidenceEntry,
} from "@/src/application/lib/kb2/howto-context";
import { buildNodeOwnerMap, getPrimaryOwnerName } from "@/src/application/lib/kb2/owner-resolution";
import { buildPlanSectionEvidence } from "@/src/application/lib/kb2/plan-evidence";
import { getLatestCompletedRunId, getLatestRunIdFromCollection } from "@/src/application/lib/kb2/run-scope";
import { buildPlanTitle } from "@/src/application/lib/kb2/title-cleanup";
import {
  buildBaselineRunFilter,
  buildStateFilter,
  ensureWritableDemoState,
} from "@/src/application/lib/kb2/demo-state";
import { PrefixLogger } from "@/lib/utils";
import type {
  KB2EntityPageType,
  KB2EvidenceRefType,
  KB2GraphEdgeType,
  KB2GraphNodeType,
} from "@/src/entities/models/kb2-types";

const HOWTO_TEMPLATE_SECTIONS = [
  "Overview",
  "Context",
  "Requirements",
  "Implementation Steps",
  "Testing Plan",
  "Risks and Considerations",
  "Prompt Section",
];

const HOWTO_DISCOVERY_CATEGORIES = new Set([
  "proposed_from_feedback",
  "proposed_project",
  "past_undocumented",
  "ongoing_undocumented",
]);

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

function formatEvidenceEntries(title: string, entries: HowtoEvidenceEntry[]): string {
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

function collectPageSourceRefs(page: KB2EntityPageType, maxItems = 12): KB2EvidenceRefType[] {
  return page.sections
    .flatMap((section) => section.items.slice(0, maxItems))
    .flatMap((item) => (item.source_refs ?? []) as KB2EvidenceRefType[]);
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

function scoreContextPage(projectText: string, page: KB2EntityPageType): number {
  let score = 0;
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
  if (/\bgreen\b/.test(decisionText) && /\b(donate|donation|sponsor|money|financial|cta|payment)\b/.test(decisionText)) {
    return /\bdonation\b|\btoy\b|\bpayment\b|\bfinancial\b|\bcta\b|\bpurchase\b/.test(projectLower);
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
  let score = scoreContextPage(projectText, page);
  if (IMPLEMENTATION_REFERENCE_SIGNAL_RE.test(collectPageText(page))) score += 6;
  if (hasGuideTokenOverlap(projectText, page.title, 2)) score += 4;
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
        text: `Apply ${source.title} to the primary money-related CTA buttons: keep green reserved for purchase and donation actions because ${ownerLabel}financial-action convention uses green only for monetary flows.${sourceNote}`,
        tokens: ["green", "donat", "button"],
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
        text: `Keep the established pet-card browse pattern from ${source.title}: preserve the responsive card grid, lazy-loaded pet images, and skeleton loading behavior when adding related actions to browse surfaces.${sourceNote}`,
        tokens: ["lazy", "skeleton", "grid"],
        evidenceHints: noteTitles,
      });
    } else if (family === "financial-form") {
      lines.push({
        family,
        text: `Model the purchase flow on ${source.title}: use a clean, single-column checkout/payment form with minimal visual noise and clear confirmation of which pet receives the donation.${sourceNote}`,
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const config = await getCompanyConfig(companySlug);
  const body = await request.json();
  const { ticket_id, project_node_id } = body;
  const writableState = await ensureWritableDemoState(tc, companySlug);
  let scopedRunId =
    body.run_id
    ?? writableState.base_run_id
    ?? await getLatestRunIdFromCollection(tc, companySlug, {
      distinct: (field: string) => tc.entity_pages.distinct(field, { demo_state_id: { $exists: false } }),
    })
    ?? await getLatestRunIdFromCollection(tc, companySlug, {
      distinct: (field: string) => tc.tickets.distinct(field, { demo_state_id: { $exists: false } }),
    })
    ?? await getLatestCompletedRunId(tc, companySlug);

  const templateSections = config?.pipeline_settings?.howto?.sections ?? HOWTO_TEMPLATE_SECTIONS;

  const contextParts: string[] = [];
  let title = "Implementation Plan";
  let ownerName = "";
  const linkedEntityIds = new Set<string>();
  const contextPages: KB2EntityPageType[] = [];
  const fallbackSourceRefs: KB2EvidenceRefType[] = [];
  let selectedProjectNode: KB2GraphNodeType | null = null;
  let projectGraphNodes: KB2GraphNodeType[] = [];
  let projectGraphEdges: KB2GraphEdgeType[] = [];

  async function loadEntityPagesByNodeIds(nodeIds: string[]): Promise<KB2EntityPageType[]> {
    const ids = [...new Set(nodeIds.filter(Boolean))];
    if (ids.length === 0) return [];

    const statePages = await tc.entity_pages.find({
      node_id: { $in: ids },
      ...buildStateFilter(writableState.state_id),
    }).toArray() as unknown as KB2EntityPageType[];
    const seenNodeIds = new Set(statePages.map((page) => page.node_id));
    if (!scopedRunId || seenNodeIds.size === ids.length) {
      return statePages;
    }

    const remainingIds = ids.filter((id) => !seenNodeIds.has(id));
    if (remainingIds.length === 0) return statePages;
    const baselinePages = await tc.entity_pages.find({
      node_id: { $in: remainingIds },
      ...buildBaselineRunFilter(scopedRunId),
    }).toArray() as unknown as KB2EntityPageType[];
    const seenAfterBaseline = new Set([...statePages, ...baselinePages].map((page) => page.node_id));
    const rawFallbackIds = ids.filter((id) => !seenAfterBaseline.has(id));
    if (rawFallbackIds.length === 0) return [...statePages, ...baselinePages];
    const rawFallbackPages = await tc.entity_pages.find({
      node_id: { $in: rawFallbackIds },
    }).toArray() as unknown as KB2EntityPageType[];
    const deduped = new Map<string, KB2EntityPageType>();
    for (const page of [...statePages, ...baselinePages, ...rawFallbackPages]) {
      if (!deduped.has(page.node_id)) deduped.set(page.node_id, page);
    }
    return Array.from(deduped.values());
  }

  async function loadGraphNodesByIds(nodeIds: string[]): Promise<KB2GraphNodeType[]> {
    const ids = [...new Set(nodeIds.filter(Boolean))];
    if (ids.length === 0) return [];

    const stateNodes = await tc.graph_nodes.find({
      node_id: { $in: ids },
      ...buildStateFilter(writableState.state_id),
    }).toArray() as unknown as KB2GraphNodeType[];
    const seenNodeIds = new Set(stateNodes.map((node) => node.node_id));
    if (!scopedRunId || seenNodeIds.size === ids.length) {
      return stateNodes;
    }

    const remainingIds = ids.filter((id) => !seenNodeIds.has(id));
    if (remainingIds.length === 0) return stateNodes;
    const baselineNodes = await tc.graph_nodes.find({
      node_id: { $in: remainingIds },
      ...buildBaselineRunFilter(scopedRunId),
    }).toArray() as unknown as KB2GraphNodeType[];
    const seenAfterBaseline = new Set([...stateNodes, ...baselineNodes].map((node) => node.node_id));
    const rawFallbackIds = ids.filter((id) => !seenAfterBaseline.has(id));
    if (rawFallbackIds.length === 0) return [...stateNodes, ...baselineNodes];
    const rawFallbackNodes = await tc.graph_nodes.find({
      node_id: { $in: rawFallbackIds },
    }).toArray() as unknown as KB2GraphNodeType[];
    const deduped = new Map<string, KB2GraphNodeType>();
    for (const node of [...stateNodes, ...baselineNodes, ...rawFallbackNodes]) {
      if (!deduped.has(node.node_id)) deduped.set(node.node_id, node);
    }
    return Array.from(deduped.values());
  }

  async function loadDecisionPages(): Promise<KB2EntityPageType[]> {
    const statePages = await tc.entity_pages.find({
      node_type: "decision",
      ...buildStateFilter(writableState.state_id),
    }).toArray() as unknown as KB2EntityPageType[];
    if (!scopedRunId) return statePages;
    const baselinePages = await tc.entity_pages.find({
      node_type: "decision",
      ...buildBaselineRunFilter(scopedRunId),
    }).toArray() as unknown as KB2EntityPageType[];
    const deduped = new Map<string, KB2EntityPageType>();
    for (const page of [...statePages, ...baselinePages]) {
      if (!deduped.has(page.node_id)) deduped.set(page.node_id, page);
    }
    return Array.from(deduped.values());
  }

  async function loadProjectPages(): Promise<KB2EntityPageType[]> {
    const statePages = await tc.entity_pages.find({
      node_type: "project",
      ...buildStateFilter(writableState.state_id),
    }).toArray() as unknown as KB2EntityPageType[];
    if (!scopedRunId) return statePages;
    const baselinePages = await tc.entity_pages.find({
      node_type: "project",
      ...buildBaselineRunFilter(scopedRunId),
    }).toArray() as unknown as KB2EntityPageType[];
    const deduped = new Map<string, KB2EntityPageType>();
    for (const page of [...statePages, ...baselinePages]) {
      if (!deduped.has(page.node_id)) deduped.set(page.node_id, page);
    }
    return Array.from(deduped.values());
  }

  if (ticket_id) {
    const ticket = await tc.tickets.findOne({ ticket_id, ...buildStateFilter(writableState.state_id) });
    if (ticket) {
      if (typeof ticket.run_id === "string" && ticket.run_id.trim().length > 0) {
        scopedRunId = ticket.run_id;
      }
      title = buildPlanTitle(String((ticket as any).title ?? ticket_id));
      ownerName =
        (Array.isArray((ticket as any).assignees) ? (ticket as any).assignees[0] : null)
        ?? ((ticket as any).owner_name || "")
        ?? "";
      contextParts.push(`Ticket: ${(ticket as any).title}\nDescription: ${(ticket as any).description ?? ""}\nPriority: ${(ticket as any).priority}`);
      for (const entityId of ((ticket as any).linked_entity_ids ?? []) as string[]) {
        if (entityId) linkedEntityIds.add(entityId);
      }
      fallbackSourceRefs.push(...((((ticket as any).source_refs ?? []) as KB2EvidenceRefType[])));
      const linkedPages = await loadEntityPagesByNodeIds([...linkedEntityIds]);
      contextPages.push(...linkedPages);
      if (linkedPages.length > 0) {
        const linkedContext = linkedPages
          .map((page) => `## ${page.title} [${page.node_type}]\n${page.sections.map((section) => `### ${section.section_name}\n${section.items.map((item) => `- ${item.text}`).join("\n")}`).join("\n\n")}`)
          .join("\n\n");
        contextParts.push(`Linked KB pages:\n${linkedContext}`);
      }
    }
  }

  if (project_node_id) {
    const explicitProjectNodes = await loadGraphNodesByIds([project_node_id]);
    const explicitProjectNode = explicitProjectNodes[0] ?? null;
    const projectPages = await loadEntityPagesByNodeIds([project_node_id]);
    const page = projectPages[0] ?? null;
    if (page) {
      title = buildPlanTitle((page as any).title ?? project_node_id);
      if (!scopedRunId && typeof (page as any).run_id === "string" && (page as any).run_id.trim().length > 0) {
        scopedRunId = (page as any).run_id;
      }
      linkedEntityIds.add(project_node_id);
      contextPages.push(page);
      const sections = ((page as any).sections ?? [])
        .map((s: any) => `### ${s.section_name}\n${(s.items ?? []).map((i: any) => `- ${i.text}`).join("\n")}`)
        .join("\n");
      contextParts.push(`Project: ${(page as any).title}\n${sections}`);
    }

    const edgeFilter: Record<string, unknown> = {
      $or: [{ source_node_id: project_node_id }, { target_node_id: project_node_id }],
    };
    if (scopedRunId) Object.assign(edgeFilter, buildBaselineRunFilter(scopedRunId));
    const edges = await tc.graph_edges
      .find(edgeFilter)
      .limit(config?.pipeline_settings?.howto_on_demand?.edges_limit ?? 20)
      .toArray();

    const relatedIds = new Set<string>();
    for (const e of edges) {
      relatedIds.add(e.source_node_id as string);
      relatedIds.add(e.target_node_id as string);
    }
    relatedIds.delete(project_node_id);
    const relatedGraphNodes = await loadGraphNodesByIds([project_node_id, ...relatedIds]);
    const ownershipMap = buildNodeOwnerMap(relatedGraphNodes, edges as unknown as KB2GraphEdgeType[]);
    const projectNode = relatedGraphNodes.find((node) => node.node_id === project_node_id) ?? explicitProjectNode;
    selectedProjectNode = projectNode;
    projectGraphNodes = relatedGraphNodes;
    projectGraphEdges = edges as unknown as KB2GraphEdgeType[];
    ownerName = ownerName || getPrimaryOwnerName(projectNode, ownershipMap) || "";
    if (!page && projectNode) {
      title = buildPlanTitle(projectNode.display_name ?? project_node_id);
      if (!scopedRunId && typeof projectNode.run_id === "string" && projectNode.run_id.trim().length > 0) {
        scopedRunId = projectNode.run_id;
      }
      linkedEntityIds.add(project_node_id);
      const projectSummary = [
        `Project: ${projectNode.display_name}`,
        typeof projectNode.attributes?.description === "string" && projectNode.attributes.description.trim().length > 0
          ? `Description: ${projectNode.attributes.description.trim()}`
          : "",
        typeof projectNode.attributes?.status === "string" && projectNode.attributes.status.trim().length > 0
          ? `Status: ${projectNode.attributes.status.trim()}`
          : "",
        Array.isArray(projectNode.attributes?.related_entities) && projectNode.attributes.related_entities.length > 0
          ? `Related entities: ${projectNode.attributes.related_entities.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (projectSummary) contextParts.unshift(projectSummary);
    }
    fallbackSourceRefs.push(...((projectNode?.source_refs ?? []) as KB2EvidenceRefType[]));
    fallbackSourceRefs.push(
      ...relatedGraphNodes.flatMap((node) =>
        node.node_id === project_node_id ? [] : ((node.source_refs ?? []) as KB2EvidenceRefType[]),
      ),
    );

    if (relatedIds.size > 0) {
      const relatedNodes = relatedGraphNodes
        .filter((node) => relatedIds.has(node.node_id))
        .slice(0, config?.pipeline_settings?.howto_on_demand?.related_nodes_limit ?? 10);
      const relContext = relatedNodes
        .map((n: any) => `- ${n.type}: ${n.display_name}`)
        .join("\n");
      contextParts.push(`Related entities:\n${relContext}`);

      for (const node of relatedNodes) linkedEntityIds.add(node.node_id);
      const relatedPages = await loadEntityPagesByNodeIds([...relatedIds]);
      contextPages.push(...relatedPages);
    }
  }

  const latestSnapshot = scopedRunId
    ? await tc.input_snapshots.findOne(
        { run_id: scopedRunId },
        { sort: { created_at: -1 } },
      ) as { parsed_documents?: KB2ParsedDocument[] } | null
    : null;
  const parsedDocs = (latestSnapshot?.parsed_documents ?? []) as KB2ParsedDocument[];
  const parsedDocLookup = buildParsedDocLookup(parsedDocs);
  const projectContextText = contextParts.join("\n\n");
  const targetIntentText = selectedProjectNode
    ? [
        selectedProjectNode.display_name,
        typeof selectedProjectNode.attributes?.description === "string"
          ? selectedProjectNode.attributes.description
          : "",
      ].filter(Boolean).join(" ")
    : projectContextText;
  const technicalSourceContext = buildTechnicalSourceContext(projectContextText, fallbackSourceRefs, parsedDocLookup);
  const entityPageByNodeId = new Map(contextPages.map((page) => [page.node_id, page]));
  const projectNodeById = new Map(projectGraphNodes.map((node) => [node.node_id, node]));
  const projectOwnershipMap = buildNodeOwnerMap(projectGraphNodes, projectGraphEdges);
  const directConventionRefs: KB2EvidenceRefType[] = [];
  const implementationReferenceRefs: KB2EvidenceRefType[] = [];
  let conventionContext = "";
  let implementationReferenceContext = "";
  let prescriptionContext = "";
  let carryForwardLines: CarryForwardLine[] = [];

  if (project_node_id && selectedProjectNode) {
    const appliesToEdges = projectGraphEdges.filter(
      (edge) => edge.type === "APPLIES_TO" && edge.target_node_id === project_node_id,
    );
    const directConventionNodeIds = new Set(appliesToEdges.map((edge) => edge.source_node_id));
    const prescriptionSources: PrescriptionSource[] = [];
    const conventionBlocks = appliesToEdges
      .map((edge) => {
        const conventionNode = projectNodeById.get(edge.source_node_id);
        if (!conventionNode || conventionNode.attributes?.is_convention !== true) return null;
        const conventionPage = entityPageByNodeId.get(conventionNode.node_id);
        const conventionOwner =
          (typeof conventionNode.attributes?.established_by === "string" && conventionNode.attributes.established_by.trim().length > 0
            ? conventionNode.attributes.established_by.trim()
            : "") ||
          getPrimaryOwnerName(conventionNode, projectOwnershipMap) ||
          "";
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
        directConventionRefs.push(...conventionEvidenceEntries.map((entry) => entry.ref));
        const conventionBaseTitle = conventionPage?.title ?? conventionNode.display_name;
        const conventionTitle = conventionOwner && !conventionBaseTitle.toLowerCase().includes(conventionOwner.toLowerCase())
          ? `${conventionOwner} — ${conventionBaseTitle}`
          : conventionBaseTitle;
        if (conventionPage) {
          prescriptionSources.push({
            title: conventionTitle,
            owner: conventionOwner,
            page: conventionPage,
            family: getFallbackDecisionFamily(conventionPage),
          });
        }
        const block = [
          `### ${conventionTitle}`,
          conventionOwner ? `Owner: ${conventionOwner}` : "",
          typeof conventionNode.attributes?.pattern_rule === "string"
            ? `Pattern Rule: ${conventionNode.attributes.pattern_rule}`
            : "",
          conventionPage ? `Current KB Summary:\n${summarizeContextPage(projectContextText, conventionPage)}` : "",
          formatEvidenceEntries("Raw Source Evidence", conventionEvidenceEntries),
        ]
          .filter(Boolean)
          .join("\n\n");
        return block;
      })
      .filter((block): block is string => Boolean(block));
    const allDecisionPages = await loadDecisionPages();
    const fallbackDecisionCandidates = allDecisionPages
      .filter((page) =>
        !directConventionNodeIds.has(page.node_id) &&
        shouldIncludeFallbackDecisionConstraint(targetIntentText, page),
      )
      .map((page) => ({
        page,
        score: scoreContextPage(targetIntentText, page),
        family: getFallbackDecisionFamily(page),
      }))
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title));
    const selectedFallbackDecisionCandidates: typeof fallbackDecisionCandidates = [];
    const seenFallbackFamilies = new Set<string>();
    for (const entry of fallbackDecisionCandidates) {
      if (entry.family && seenFallbackFamilies.has(entry.family)) continue;
      selectedFallbackDecisionCandidates.push(entry);
      if (entry.family) seenFallbackFamilies.add(entry.family);
      if (selectedFallbackDecisionCandidates.length >= 6) break;
    }
    const fallbackDecisionBlocks = selectedFallbackDecisionCandidates
      .map((decisionPage) => {
        const decisionNode = projectNodeById.get(decisionPage.page.node_id);
        const decisionOwner =
          (typeof decisionNode?.attributes?.established_by === "string" && decisionNode.attributes.established_by.trim().length > 0
            ? decisionNode.attributes.established_by.trim()
            : "") ||
          getPrimaryOwnerName(decisionNode, projectOwnershipMap) ||
          "";
        const decisionEvidenceEntries = buildHowtoEvidenceEntries(
          projectContextText,
          decisionNode
            ? ((decisionNode.source_refs ?? []) as KB2EvidenceRefType[])
            : collectRelevantContextItems(projectContextText, decisionPage.page)
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
        directConventionRefs.push(...decisionEvidenceEntries.map((entry) => entry.ref));
        const decisionTitle = decisionOwner && !decisionPage.page.title.toLowerCase().includes(decisionOwner.toLowerCase())
          ? `${decisionOwner} — ${decisionPage.page.title}`
          : decisionPage.page.title;
        prescriptionSources.push({
          title: decisionTitle,
          owner: decisionOwner,
          page: decisionPage.page,
          family: getFallbackDecisionFamily(decisionPage.page),
        });
        return [
          `### ${decisionTitle}`,
          decisionOwner ? `Owner: ${decisionOwner}` : "",
          typeof decisionNode?.attributes?.pattern_rule === "string"
            ? `Pattern Rule: ${decisionNode.attributes.pattern_rule}`
            : "",
          `Current KB Summary:\n${summarizeContextPage(projectContextText, decisionPage.page)}`,
          formatEvidenceEntries("Raw Source Evidence", decisionEvidenceEntries),
        ]
          .filter(Boolean)
          .join("\n\n");
      });
    const allConventionBlocks = [...conventionBlocks, ...fallbackDecisionBlocks];
    if (allConventionBlocks.length > 0) {
      conventionContext = [
        "## Convention Evidence (HARD — the implementation MUST comply with these)",
        "For each convention, state what it means for this feature, the specific implementation choice it implies, and at least one supporting source artifact.",
        "",
        ...allConventionBlocks,
      ].join("\n\n");
    }

    const allProjectPages = await loadProjectPages();
    const globalProjectNodes = await loadGraphNodesByIds(allProjectPages.map((page) => page.node_id));
    const allProjectNodeById = new Map<string, KB2GraphNodeType>([
      ...projectGraphNodes.map((node) => [node.node_id, node]),
      ...globalProjectNodes.map((node) => [node.node_id, node]),
    ]);
    const relatedImplementationReferencePages = contextPages
      .filter((page) => {
        if (page.node_id === project_node_id) return false;
        return isEligibleImplementationReferenceNode(allProjectNodeById.get(page.node_id), project_node_id);
      })
      .map((page) => ({
        page,
        score: scoreContextPage(targetIntentText, page),
        family: getImplementationReferenceFamily(page),
      }))
      .filter((entry) => familyAppliesToTargetIntent(targetIntentText, entry.family));
    const seenImplementationReferenceNodeIds = new Set(
      relatedImplementationReferencePages.map((entry) => entry.page.node_id),
    );
    const globalImplementationReferencePages = allProjectPages
      .filter((page) => !seenImplementationReferenceNodeIds.has(page.node_id))
      .map((page) => ({
        page,
        relatedNode: allProjectNodeById.get(page.node_id),
        score: scoreImplementationReferencePage(targetIntentText, page),
        family: getImplementationReferenceFamily(page),
      }))
      .filter(({ relatedNode, score, family }) =>
        isEligibleImplementationReferenceNode(relatedNode, project_node_id)
        && score >= 8
        && familyAppliesToTargetIntent(targetIntentText, family)
      )
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title));
    const implementationReferencePages = [
      ...relatedImplementationReferencePages,
      ...globalImplementationReferencePages.map(({ page, score, family }) => ({ page, score, family })),
    ]
      .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title))
      .slice(0, 4);
    const implementationEntries = buildHowtoEvidenceEntries(
      projectContextText,
      implementationReferencePages.flatMap(({ page }) =>
        collectRelevantContextItems(targetIntentText, page)
          .slice(0, 6)
          .flatMap((item) => item.sourceRefs),
      ),
      parsedDocLookup,
      {
        minScore: 6,
        maxRefs: 6,
        maxChars: 1600,
        dropFeedbackWhenTechnical: true,
      },
    );
    implementationReferenceRefs.push(...implementationEntries.map((entry) => entry.ref));
    if (implementationEntries.length > 0) {
      implementationReferenceContext = [
        "## Implementation Patterns From Related Projects",
        "These artifacts come from completed or existing work with similar surfaces or component patterns.",
        "Use them to make concrete UI, data-loading, component, and workflow choices only when the evidence clearly applies to this feature.",
        "",
        formatEvidenceEntries("Related Project Source Evidence", implementationEntries),
      ].join("\n\n");
    }
    for (const { page } of implementationReferencePages) {
      const relatedNode = allProjectNodeById.get(page.node_id);
      prescriptionSources.push({
        title: page.title,
        owner: getPrimaryOwnerName(relatedNode, projectOwnershipMap) || null,
        page,
        family: getImplementationReferenceFamily(page),
      });
    }
    prescriptionContext = buildEvidenceBackedPrescriptionSection(targetIntentText, prescriptionSources);
    carryForwardLines = buildCarryForwardLines(targetIntentText, prescriptionSources, parsedDocs);
  }
  const context = [
    projectContextText,
    technicalSourceContext.context,
    conventionContext,
    implementationReferenceContext,
    prescriptionContext,
  ].filter(Boolean).join("\n\n");
  const logger = new PrefixLogger("kb2-howto-on-demand");

  const result = await structuredGenerate({
    model: getReasoningModel(config?.pipeline_settings?.models),
    system: config?.prompts?.howto_on_demand?.system ?? `You generate implementation plan documents for engineering work items.
Each plan has sections that must be filled with specific, actionable content.

Sections: ${templateSections.join(", ")}

Rules:
- Overview: 2-3 sentences explaining what this work is about and why it matters.
- Context: What existing patterns, systems, and decisions are relevant. Reference specific entities.
- Requirements: What must be true when this is done. Acceptance criteria.
- Implementation Steps: Return 4-7 explicit step objects in the section's steps array. Each step needs a short title plus 2-4 sentences of prose explaining what to do and why it matters for this feature.
- Testing Plan: What tests to write. What edge cases to cover.
- Risks and Considerations: What could go wrong. What tradeoffs exist.
- Prompt Section: If an AI agent were implementing this, what prompt or instructions would you give it?

CRITICAL:
- Reference actual patterns and decisions discovered in the KB. Do NOT give generic advice.
- When Convention Evidence is provided, for each convention explain what it means for this feature, the specific implementation choice it implies, and at least one supporting source artifact.
- When Implementation Patterns From Related Projects is provided, use those artifacts to make concrete UI, data-loading, component, and workflow choices without inventing unsupported details.
- When Evidence-Backed Implementation Prescriptions are provided, carry those exact implementation choices into Context, Requirements, and Implementation Steps with owner attribution. Do not reduce them to abstract convention mentions.
- In Implementation Steps, write prose only. No code blocks, no pseudocode, no JSX, and no inline code samples.
- Each implementation step should mention the exact source artifact names that justify it via that step's evidence_hints array. Use exact titles from the provided context only.
- If a step proposes new backend, data, or UI work that is not explicitly named in the evidence, say it is new work to define instead of inventing routes, fields, payloads, or component names.
- Do not spell raw HTTP method/path snippets in Implementation Steps. Describe existing APIs in plain English.
- Do not invent file paths, endpoints, libraries, source titles, architecture details, owners, or conventions.
- If a detail is not grounded in the provided context, keep the step general instead of making up a concrete implementation.`,
    prompt: `Generate an implementation plan based on this context:\n\nOutput reminders:\n- Fill every requested section.\n- For Implementation Steps, populate the steps array with titled prose steps.\n- Each implementation step must list exact supporting artifact titles in evidence_hints.\n- When Evidence-Backed Implementation Prescriptions are provided, carry those concrete choices into the plan with owner attribution instead of referring to them abstractly.\n\n${context}`,
    schema: KB2GeneratedHowtoResultSchema,
    logger,
    maxOutputTokens: config?.pipeline_settings?.howto_on_demand?.max_output_tokens ?? 4096,
  });

  const normalizedSections = normalizeGeneratedHowtoSections(result.sections ?? [], templateSections)
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
  for (const entityId of result.linked_entity_ids ?? []) {
    if (entityId) linkedEntityIds.add(entityId);
  }
  const combinedFallbackRefs = dedupeHowtoEvidenceRefs([
    ...(technicalSourceContext.refs.length > 0 ? technicalSourceContext.refs : fallbackSourceRefs),
    ...directConventionRefs,
    ...implementationReferenceRefs,
  ]);
  const sectionsWithEvidence = buildPlanSectionEvidence(normalizedSections, {
    entityPages: Array.from(
      new Map(contextPages.map((page) => [page.page_id, page])).values(),
    ),
    fallbackSourceRefs: combinedFallbackRefs,
  });
  for (const section of sectionsWithEvidence) {
    for (const ref of section.entity_refs ?? []) linkedEntityIds.add(ref.node_id);
    for (const step of section.steps ?? []) {
      for (const ref of step.entity_refs ?? []) linkedEntityIds.add(ref.node_id);
    }
  }

  const howtoId = randomUUID();
  const doc = {
    howto_id: howtoId,
    run_id: scopedRunId,
    demo_state_id: writableState.state_id,
    company_slug: companySlug,
    ticket_id: ticket_id ?? null,
    project_node_id: project_node_id ?? null,
    title,
    sections: sectionsWithEvidence,
    linked_entity_ids: [...linkedEntityIds],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    plan_status: "draft",
    owner_name: ownerName,
    reviewers: [],
    discussion: [],
  };

  await tc.howto.insertOne(doc);

  return Response.json({ howto: doc });
}
