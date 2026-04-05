import { z } from "zod";

const STEP_TITLE_WORD_CAP = 8;

export const KB2GeneratedHowtoStepSchema = z.object({
  title: z.string().default(""),
  content: z.string().default(""),
  evidence_hints: z.array(z.string()).default([]).optional(),
});
export type KB2GeneratedHowtoStepType = z.infer<typeof KB2GeneratedHowtoStepSchema>;

export const KB2GeneratedHowtoSectionSchema = z.object({
  section_name: z.string(),
  content: z.string().default(""),
  steps: z.array(KB2GeneratedHowtoStepSchema).default([]).optional(),
});
export type KB2GeneratedHowtoSectionType = z.infer<typeof KB2GeneratedHowtoSectionSchema>;

export const KB2GeneratedHowtoResultSchema = z.object({
  sections: z.array(KB2GeneratedHowtoSectionSchema),
  linked_entity_ids: z.array(z.string()).default([]),
});
export type KB2GeneratedHowtoResultType = z.infer<typeof KB2GeneratedHowtoResultSchema>;

export interface KB2NormalizedHowtoStep {
  title: string;
  content: string;
  evidence_hints?: string[];
}

export interface KB2NormalizedHowtoSection {
  section_name: string;
  content: string;
  steps?: KB2NormalizedHowtoStep[];
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function stripFencedCodeBlocks(value: string): string {
  return value.replace(/```[\s\S]*?```/g, (match) => {
    const lineCount = match.split("\n").length;
    if (lineCount <= 10) return match;
    return " ";
  });
}

function stripInlineCode(value: string): string {
  return value.replace(/`([^`]+)`/g, "$1");
}

function humanizeApiPath(path: string): string {
  const label = path
    .replace(/^\/api\/v\d+\//i, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) return "detail";
      return segment.replace(/[-_]/g, " ");
    })
    .join(" ")
    .replace(/\b([a-z]+)s detail\b/gi, "$1 detail")
    .trim();
  return label || "API";
}

function replaceHttpRouteSnippets(value: string): string {
  return value.replace(
    /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9/_:.-]+)/g,
    (_, method: string, path: string) => {
      const label = humanizeApiPath(path);
      const prefix = method.toUpperCase() === "GET"
        ? "the existing"
        : method.toUpperCase() === "POST"
          ? "a new"
          : "the";
      return `${prefix} ${label} API`;
    },
  );
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeImplementationText(value: string): string {
  return normalizeWhitespace(
    stripInlineCode(
      stripFencedCodeBlocks(normalizeLineBreaks(value)),
    ),
  );
}

function normalizeStepTitle(value: string, index: number): string {
  const cleaned = normalizeWhitespace(
    stripInlineCode(
      value
        .replace(/^\d+\.\s*/, "")
        .replace(/^\*\*(.+?)\*\*$/, "$1")
        .replace(/[:;,.!?-]+$/g, ""),
    ),
  );
  if (!cleaned) return `Step ${index + 1}`;
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.slice(0, STEP_TITLE_WORD_CAP).join(" ");
}

function normalizeEvidenceHints(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const cleaned = normalizeWhitespace(stripInlineCode(value));
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function splitNumberedListItems(content: string): string[] {
  const normalized = normalizeLineBreaks(content).trim();
  if (!normalized || !/\d+\.\s+/.test(normalized)) return [];
  const matches = Array.from(
    normalized.matchAll(/(?:^|\n|\s)(\d+\.\s+[\s\S]*?)(?=(?:\n|\s)\d+\.\s+|$)/g),
  ).map((match) => match[1]?.trim() ?? "").filter(Boolean);
  if (matches.length > 0) return matches;
  return normalized
    .split(/\n(?=\d+\.\s+)/)
    .map((part) => part.trim())
    .filter((part) => /^\d+\.\s+/.test(part));
}

function parseLegacyImplementationSteps(content: string): KB2NormalizedHowtoStep[] {
  return splitNumberedListItems(content)
    .map((item, index) => {
      const body = item.replace(/^\d+\.\s+/, "").trim();
      if (!body) return null;

      const boldTitleMatch = body.match(/^\*\*(.+?)\*\*\s*[:.-]?\s*([\s\S]*)$/);
      if (boldTitleMatch) {
        const title = normalizeStepTitle(boldTitleMatch[1], index);
        const contentText = normalizeImplementationText(boldTitleMatch[2] || body);
        return contentText ? { title, content: contentText } : null;
      }

      const colonTitleMatch = body.match(/^([^:\n]{3,80})[:.-]\s+([\s\S]+)$/);
      if (colonTitleMatch && colonTitleMatch[1].split(/\s+/).filter(Boolean).length <= STEP_TITLE_WORD_CAP) {
        const title = normalizeStepTitle(colonTitleMatch[1], index);
        const contentText = normalizeImplementationText(colonTitleMatch[2]);
        return contentText ? { title, content: contentText } : null;
      }

      const firstSentenceMatch = body.match(/^(.+?[.!?])(?:\s+|$)([\s\S]*)$/);
      if (firstSentenceMatch) {
        const title = normalizeStepTitle(firstSentenceMatch[1].replace(/[.!?]+$/g, ""), index);
        const contentText = normalizeImplementationText(firstSentenceMatch[2] || firstSentenceMatch[1]);
        return contentText ? { title, content: contentText } : null;
      }

      return {
        title: `Step ${index + 1}`,
        content: normalizeImplementationText(body),
      };
    })
    .filter((step): step is KB2NormalizedHowtoStep => Boolean(step && step.content));
}

export function buildHowtoStepMatchText(step: { title: string; content: string }): string {
  return [step.title, step.content].filter(Boolean).join("\n").trim();
}

export function renderImplementationStepsContent(steps: Array<{ title: string; content: string }>): string {
  return steps
    .map((step, index) => `${index + 1}. ${step.title}\n${step.content}`)
    .join("\n\n")
    .trim();
}

function normalizeGeneratedSteps(steps: KB2GeneratedHowtoStepType[]): KB2NormalizedHowtoStep[] {
  return steps
    .map((step, index) => {
      const title = normalizeStepTitle(step.title, index);
      const content = normalizeImplementationText(step.content);
      if (!content) return null;
      const evidenceHints = normalizeEvidenceHints(step.evidence_hints);
      return {
        title,
        content,
        ...(evidenceHints.length > 0 ? { evidence_hints: evidenceHints } : {}),
      };
    })
    .filter((step): step is KB2NormalizedHowtoStep => Boolean(step));
}

function normalizeSectionText(sectionName: string, content: string): string {
  if (sectionName === "Implementation Steps") {
    return normalizeImplementationText(content);
  }
  return normalizeWhitespace(normalizeLineBreaks(content));
}

export function normalizeGeneratedHowtoSections(
  rawSections: KB2GeneratedHowtoSectionType[],
  orderedSectionNames: string[],
): KB2NormalizedHowtoSection[] {
  const bySectionName = new Map(
    rawSections.map((section) => [section.section_name.trim().toLowerCase(), section]),
  );

  return orderedSectionNames.map((sectionName) => {
    const rawSection = bySectionName.get(sectionName.trim().toLowerCase());
    const normalizedContent = normalizeSectionText(sectionName, rawSection?.content ?? "");

    if (sectionName !== "Implementation Steps") {
      return {
        section_name: sectionName,
        content: normalizedContent,
      };
    }

    const generatedSteps = normalizeGeneratedSteps(rawSection?.steps ?? []);
    const steps = generatedSteps.length > 0
      ? generatedSteps
      : parseLegacyImplementationSteps(normalizedContent);

    return {
      section_name: sectionName,
      content: steps.length > 0 ? renderImplementationStepsContent(steps) : normalizedContent,
      ...(steps.length > 0 ? { steps } : {}),
    };
  });
}
