const TITLE_WORD_CAP = 10;
const VERIFY_ISSUE_WORD_CAP = 6;
const TICKET_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const TITLE_SPLIT_RE = /\s*-{3,}\s*|\s+[—–-]\s+|:\s+|;\s+|\.\s+|\n+/;

const KNOWN_ACRONYMS: Record<string, string> = {
  api: "API",
  ci: "CI",
  cd: "CD",
  "ci/cd": "CI/CD",
  pr: "PR",
  ui: "UI",
  ux: "UX",
  kb: "KB",
  jira: "Jira",
  github: "GitHub",
  confluence: "Confluence",
  oauth: "OAuth",
  sso: "SSO",
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "—");
}

function normalizeTitleSeparators(value: string): string {
  return value
    .replace(/-{3,}/g, " — ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseWord(word: string): string {
  const normalized = word.toLowerCase();
  if (KNOWN_ACRONYMS[normalized]) return KNOWN_ACRONYMS[normalized];
  if (/^[A-Z0-9-]+$/.test(word) && word.length <= 5) return word;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function smartTitleCase(value: string): string {
  const letters = value.replace(/[^A-Za-z]/g, "");
  if (!letters) return value;
  const isAllLower = letters === letters.toLowerCase();
  const isAllUpper = letters === letters.toUpperCase();
  if (!isAllLower && !isAllUpper) return value;
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => titleCaseWord(word))
    .join(" ");
}

function trimTitleLeadIns(value: string, nodeType?: string): string {
  let cleaned = value;
  cleaned = cleaned.replace(/^(?:how[- ]?to|plan)\s*:\s*/i, "");
  if (nodeType && nodeType !== "ticket") {
    cleaned = cleaned.replace(/^[A-Z][A-Z0-9]+-\d+[:\s-]+/i, "");
  }

  if (nodeType === "decision") {
    cleaned = cleaned
      .replace(/^(?:decision|we decided to|decided to|decide to|we chose to|chose to|choose to|we opted to|opted to|prefer to|use|using)\s+/i, "")
      .replace(/^(?:so\s+for\s+the\s+)(.+?)(?:\s+itself)?[, ]+\s*i['’]?m\s+going\b.*$/i, "$1")
      .replace(/^(?:we(?:'re| are)?|i['’]?m|im)\s+going with\s+/i, "")
      .replace(/^going with\s+/i, "")
      .replace(/^(?:the team )?(?:standard|convention|pattern)\s+(?:is|for)\s+/i, "")
      .replace(/^the user is choosing,\s*not comparing,\s*so\s+/i, "")
      .replace(/\bmakes more sense to me than\b/i, " over ")
      .replace(/\bmakes more sense than\b/i, " over ")
      .replace(/\bfor that(?: one)?\b/gi, "")
      .replace(/\bsince it'?s money-related\b/gi, "")
      .replace(/\s+across the top\b/i, "");
    if (/\binstead of\b/i.test(cleaned)) {
      const [left, right] = cleaned.split(/\binstead of\b/i);
      const rightWords = right?.trim().split(/\s+/).filter(Boolean) ?? [];
      if (left?.trim() && (rightWords.length === 0 || rightWords.length > 5 || looksWeakDecisionTitle(right ?? ""))) {
        cleaned = left.trim();
      }
    }
    cleaned = cleaned.replace(/^(?:a|an)\s+/i, "");
  }
  if (nodeType === "process") {
    cleaned = cleaned.replace(/^(?:process|workflow|runbook|playbook|checklist)\s+(?:for|to)\s+/i, "");
  }
  if (nodeType === "project") {
    cleaned = cleaned.replace(/^(?:project|feature|initiative)\s*:\s*/i, "");
  }

  return cleaned;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[\s:;,.!/?-]+$/g, "").trim();
}

function collapseRepeatedLeadingPhrase(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  const maxPhraseSize = Math.min(4, Math.floor(words.length / 2));
  for (let size = maxPhraseSize; size >= 1; size -= 1) {
    const first = words.slice(0, size).join(" ").toLowerCase();
    const second = words.slice(size, size * 2).join(" ").toLowerCase();
    if (!first || first !== second) continue;
    return [...words.slice(0, size), ...words.slice(size * 2)].join(" ");
  }
  return value;
}

function looksWeakDecisionTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith("going with ")) return true;
  if (/\binstead of\b/.test(normalized) && /\b(the|a|an|of|for|to|with|on|in)$/.test(normalized)) {
    return true;
  }
  return /\b(the|a|an|of|for|to|with|on|in)$/.test(normalized);
}

function truncateWords(value: string, maxWords: number): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return value;
  return words.slice(0, maxWords).join(" ");
}

function pickConciseFragment(value: string): string {
  const fragments = value
    .split(TITLE_SPLIT_RE)
    .map((fragment) => trimTrailingPunctuation(normalizeWhitespace(fragment)))
    .filter(Boolean);
  return (
    fragments.find((fragment) => {
      const wordCount = fragment.split(/\s+/).length;
      return wordCount >= 2 && wordCount <= TITLE_WORD_CAP;
    })
    ?? fragments[0]
    ?? value
  );
}

function extractTicketKey(value: string): string | null {
  return value.match(TICKET_KEY_RE)?.[1] ?? null;
}

export function cleanEntityTitle(raw: string, nodeType?: string): string {
  const original = normalizeWhitespace(stripMarkdown(raw));
  if (!original) return raw.trim();

  let cleaned = trimTitleLeadIns(original, nodeType);
  cleaned = normalizeTitleSeparators(cleaned);
  cleaned = collapseRepeatedLeadingPhrase(cleaned);
  cleaned = normalizeWhitespace(cleaned);
  cleaned = trimTrailingPunctuation(cleaned);

  if (cleaned.length > 86 || cleaned.split(/\s+/).length > TITLE_WORD_CAP) {
    cleaned = pickConciseFragment(cleaned);
  }

  cleaned = truncateWords(cleaned, TITLE_WORD_CAP);
  cleaned = trimTrailingPunctuation(cleaned);
  if (nodeType === "decision" && looksWeakDecisionTitle(cleaned)) {
    cleaned = cleaned.replace(/\b(the|a|an|of|for|to|with|on|in)$/i, "").trim();
  }
  cleaned = smartTitleCase(cleaned);

  return cleaned || original;
}

export function cleanTicketTitle(raw: string): string {
  const original = normalizeWhitespace(stripMarkdown(raw));
  if (!original) return raw.trim();

  const key = extractTicketKey(original);
  const body = cleanEntityTitle(
    key ? original.replace(new RegExp(`^${key}[:\\s-]*`, "i"), "") : original,
    "ticket",
  );
  if (key && body && body.toUpperCase() !== key.toUpperCase()) {
    return `${key}: ${body}`;
  }
  return body || key || original;
}

export function buildPlanTitle(raw: string): string {
  const key = extractTicketKey(raw);
  const cleanedTicket = cleanTicketTitle(raw);
  const cleanedBody = cleanEntityTitle(
    cleanedTicket.replace(/^[A-Z][A-Z0-9]+-\d+:\s*/i, ""),
    "project",
  );

  if (key && cleanedBody && `${key} ${cleanedBody}`.length <= 64) {
    return `Plan: ${key} ${cleanedBody}`;
  }
  return `Plan: ${cleanedBody || cleanEntityTitle(raw, "project") || "Implementation Plan"}`;
}

export function buildVerifyIssueLabel(raw: string): string {
  const cleaned = cleanEntityTitle(raw);
  return truncateWords(cleaned, VERIFY_ISSUE_WORD_CAP);
}
