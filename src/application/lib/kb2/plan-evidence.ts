import { normalizeForMatch } from "@/lib/utils";
import { buildHowtoStepMatchText } from "@/src/application/lib/kb2/howto-structure";
import type {
  KB2EntityPageType,
  KB2EvidenceRefType,
} from "@/src/entities/models/kb2-types";

export interface KB2PlanEntityRef {
  node_id: string;
  page_id: string;
  page_title: string;
  node_type: string;
  section_name: string;
  item_text: string;
}

export interface KB2PlanSection {
  section_name: string;
  content: string;
  steps?: KB2PlanStep[];
  source_refs?: KB2EvidenceRefType[];
  entity_refs?: KB2PlanEntityRef[];
}

export interface KB2PlanStep {
  title: string;
  content: string;
  source_refs?: KB2EvidenceRefType[];
  entity_refs?: KB2PlanEntityRef[];
}

function dedupeSourceRefs(sourceRefs: KB2EvidenceRefType[]): KB2EvidenceRefType[] {
  const seen = new Set<string>();
  const out: KB2EvidenceRefType[] = [];
  for (const ref of sourceRefs) {
    const key = `${ref.source_type}:${ref.doc_id}:${ref.title}:${ref.excerpt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function dedupeEntityRefs(entityRefs: KB2PlanEntityRef[]): KB2PlanEntityRef[] {
  const seen = new Set<string>();
  const out: KB2PlanEntityRef[] = [];
  for (const ref of entityRefs) {
    const key = `${ref.page_id}:${ref.section_name}:${normalizeForMatch(ref.item_text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function hasStrongTextMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeForMatch(left);
  const normalizedRight = normalizeForMatch(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return true;
  }

  const leftWords = Array.from(
    new Set(normalizedLeft.split(/\s+/).filter((word) => word.length > 3)),
  );
  const rightWords = Array.from(
    new Set(normalizedRight.split(/\s+/).filter((word) => word.length > 3)),
  );
  if (leftWords.length < 3 || rightWords.length < 3) return false;

  const rightWordSet = new Set(rightWords);
  const overlap = leftWords.filter((word) => rightWordSet.has(word)).length;
  const minWordCount = Math.min(leftWords.length, rightWords.length);
  return overlap >= Math.min(4, minWordCount) && overlap / minWordCount >= 0.5;
}

function planTextChunks(content: string): string[] {
  return content
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function matchFallbackSources(searchText: string, sourceRefs: KB2EvidenceRefType[]): KB2EvidenceRefType[] {
  const matched = sourceRefs.filter((sourceRef) => {
    return (
      (sourceRef.excerpt ? hasStrongTextMatch(searchText, sourceRef.excerpt) : false) ||
      hasStrongTextMatch(searchText, sourceRef.title) ||
      (sourceRef.section_heading
        ? hasStrongTextMatch(searchText, sourceRef.section_heading)
        : false)
    );
  });
  return dedupeSourceRefs(matched);
}

function preferTechnicalSources(
  sourceRefs: KB2EvidenceRefType[],
  options: { dropFeedbackWhenTechnical?: boolean } = {},
): KB2EvidenceRefType[] {
  const deduped = dedupeSourceRefs(sourceRefs);
  if (!options.dropFeedbackWhenTechnical) return deduped;
  const hasTechnical = deduped.some((ref) => !["customer_feedback", "human_verification"].includes(ref.source_type));
  return hasTechnical
    ? deduped.filter((ref) => !["customer_feedback", "human_verification"].includes(ref.source_type))
    : deduped;
}

function collectEvidenceForText(
  sectionName: string,
  content: string,
  options: {
    entityPages: KB2EntityPageType[];
    fallbackSourceRefs?: KB2EvidenceRefType[];
  },
  extraSignals: string[] = [],
): { sourceRefs: KB2EvidenceRefType[]; entityRefs: KB2PlanEntityRef[] } {
  const searchText = [sectionName, content, ...extraSignals]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  if (!searchText.trim()) {
    return { sourceRefs: [], entityRefs: [] };
  }

  const chunks = planTextChunks(searchText);
  const matchedEntityRefs: KB2PlanEntityRef[] = [];
  const matchedSourceRefs: KB2EvidenceRefType[] = [];

  for (const page of options.entityPages) {
    for (const pageSection of page.sections) {
      for (const item of pageSection.items) {
        const itemText = item.text?.trim() ?? "";
        if (!itemText) continue;
        const itemMatched =
          hasStrongTextMatch(searchText, itemText) ||
          chunks.some((chunk) => hasStrongTextMatch(chunk, itemText));
        if (!itemMatched) continue;

        matchedEntityRefs.push({
          node_id: page.node_id,
          page_id: page.page_id,
          page_title: page.title,
          node_type: page.node_type,
          section_name: pageSection.section_name,
          item_text: itemText,
        });
        matchedSourceRefs.push(...((item.source_refs ?? []) as KB2EvidenceRefType[]));
      }
    }
  }

  let sourceRefs = dedupeSourceRefs(matchedSourceRefs);
  if (sourceRefs.length === 0 && options.fallbackSourceRefs?.length) {
    sourceRefs = matchFallbackSources(searchText, options.fallbackSourceRefs);
  }

  return {
    sourceRefs: sourceRefs.slice(0, 16),
    entityRefs: dedupeEntityRefs(matchedEntityRefs).slice(0, 16),
  };
}

export function buildPlanSectionEvidence(
  sections: Array<{
    section_name: string;
    content: string;
    steps?: Array<{ title: string; content: string; evidence_hints?: string[] }>;
  }>,
  options: {
    entityPages: KB2EntityPageType[];
    fallbackSourceRefs?: KB2EvidenceRefType[];
  },
): KB2PlanSection[] {
  return sections.map((section) => {
    const content = section.content?.trim() ?? "";
    const stepResults: KB2PlanStep[] = (section.steps ?? [])
      .map((step) => {
        const stepContent = step.content?.trim() ?? "";
        if (!stepContent) return null;
        const evidence = collectEvidenceForText(
          section.section_name,
          buildHowtoStepMatchText(step),
          options,
          step.evidence_hints ?? [],
        );
        const sourceRefs = preferTechnicalSources(evidence.sourceRefs, {
          dropFeedbackWhenTechnical: section.section_name === "Implementation Steps",
        });
        return {
          title: step.title.trim(),
          content: stepContent,
          ...(sourceRefs.length > 0 ? { source_refs: sourceRefs } : {}),
          ...(evidence.entityRefs.length > 0 ? { entity_refs: evidence.entityRefs } : {}),
        };
      })
      .filter((step): step is KB2PlanStep => Boolean(step));

    const sectionEvidence = content
      ? collectEvidenceForText(
          section.section_name,
          content,
          options,
          stepResults.map((step) => step.title),
        )
      : { sourceRefs: [], entityRefs: [] };
    const sourceRefs = preferTechnicalSources([
      ...sectionEvidence.sourceRefs,
      ...stepResults.flatMap((step) => step.source_refs ?? []),
    ], {
      dropFeedbackWhenTechnical: section.section_name === "Implementation Steps",
    }).slice(0, 16);
    const entityRefs = dedupeEntityRefs([
      ...sectionEvidence.entityRefs,
      ...stepResults.flatMap((step) => step.entity_refs ?? []),
    ]).slice(0, 16);

    return {
      section_name: section.section_name,
      content,
      ...(stepResults.length > 0 ? { steps: stepResults } : {}),
      ...(sourceRefs.length > 0 ? { source_refs: sourceRefs.slice(0, 16) } : {}),
      ...(entityRefs.length > 0 ? { entity_refs: entityRefs } : {}),
    };
  });
}
