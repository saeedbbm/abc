"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import { normalizeForMatch } from "@/lib/utils";
import { cleanEntityTitle } from "@/src/application/lib/kb2/title-cleanup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  MessageSquare,
  Send,
  Loader2,
  Sparkles,
  Search,
  FileText,
  Link2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  TicketCheck,
} from "lucide-react";
import { KB2RightPanel, SourceRef, RelatedEntityPage } from "./KB2RightPanel";
import { SplitLayout } from "./SplitLayout";
import { LeftSidebarLayout } from "./LeftSidebarLayout";

interface HowtoEntityRef {
  node_id: string;
  page_id: string;
  page_title: string;
  node_type: string;
  section_name: string;
  item_text: string;
}

interface HowtoSection {
  section_name: string;
  content: string;
  steps?: HowtoStep[];
  source_refs?: SourceRef[];
  entity_refs?: HowtoEntityRef[];
}

interface HowtoStep {
  title: string;
  content: string;
  source_refs?: SourceRef[];
  entity_refs?: HowtoEntityRef[];
}

interface Howto {
  howto_id: string;
  ticket_id?: string | null;
  project_node_id?: string | null;
  title: string;
  sections: HowtoSection[];
  linked_entity_ids: string[];
  created_at: string;
  updated_at?: string;
  plan_status?: PlanStatus;
  owner_name?: string;
  reviewers?: string[];
  discussion?: { author: string; text: string; timestamp: string }[];
}

interface Ticket {
  ticket_id: string;
  title: string;
  description: string;
  assignees: string[];
  priority: string;
  workflow_state: string;
  source: string;
  status?: string;
  linked_entity_ids?: string[];
  linked_entity_names: string[];
  labels: string[];
  created_at: string;
  source_refs?: SourceRef[];
}

interface ProjectNode {
  node_id: string;
  display_name: string;
  type: string;
  attributes?: Record<string, any>;
  source_refs?: {
    source_type: string;
    doc_id: string;
    title: string;
    excerpt?: string;
    section_heading?: string;
  }[];
}

interface EntityPage {
  page_id: string;
  node_id: string;
  title: string;
  node_type: string;
  sections: {
    section_name: string;
    requirement: string;
    items: {
      text: string;
      confidence: string;
      source_refs?: SourceRef[];
    }[];
  }[];
}

type SourceTab = "tickets" | "projects";

type TicketStatusKey = "past" | "ongoing" | "proposed";
type ProjectStatusKey =
  | "past_documented"
  | "past_undocumented"
  | "ongoing_documented"
  | "ongoing_undocumented"
  | "proposed";
type PlanStatus = "draft" | "in_review" | "approved" | "archived";

interface GeneratingPlan {
  temp_id: string;
  title: string;
  created_at: string;
}

type LeftSidebarTab = "plans" | "create";

const PRIORITY_COLORS: Record<string, string> = {
  critical: "bg-red-500 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-yellow-500 text-black",
  low: "bg-blue-500 text-white",
};

const TICKET_STATUS_LABELS: Record<TicketStatusKey, string> = {
  past: "Past Tickets",
  ongoing: "Ongoing Tickets",
  proposed: "Proposed Tickets",
};

const PROJECT_STATUS_LABELS: Record<ProjectStatusKey, string> = {
  past_documented: "Past Documented",
  past_undocumented: "Past Undocumented",
  ongoing_documented: "Ongoing Documented",
  ongoing_undocumented: "Ongoing Undocumented",
  proposed: "Proposed",
};

const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  draft: "Draft",
  in_review: "In Review",
  approved: "Approved",
  archived: "Archived",
};

type KBDerivedHighlightVariant = "company" | "pattern";

interface KBDerivedHighlight {
  phrase: string;
  variant: KBDerivedHighlightVariant;
}

const HIGHLIGHT_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under",
  "about", "their", "there", "then", "than", "when", "where", "what", "have",
  "will", "must", "should", "could", "would", "page", "project", "feature",
  "system", "current", "existing", "users", "user", "build", "create", "update",
  "flow", "work", "data", "details", "allows", "allow", "using", "used",
]);

const HIGHLIGHT_SIGNAL_TOKENS = new Set([
  "api", "browse", "button", "buttons", "cards", "catalog", "checkout", "cta",
  "ctas", "database", "donation", "donations", "filter", "filters", "grid",
  "inventory", "modal", "partner", "profile", "profiles", "responsive", "selector",
  "shelter", "sort", "species", "sponsor", "wishlist", "wishlists",
]);

function stripMarkdownFormatting(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>]/g, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHighlightPhrase(value: string): string {
  return stripMarkdownFormatting(value)
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeHighlightPhrase(value: string): string[] {
  return normalizeHighlightPhrase(value)
    .split(/\s+/)
    .map((word) => word.replace(/^[^A-Za-z0-9/:-]+|[^A-Za-z0-9/:-]+$/g, ""))
    .filter(Boolean);
}

function isSpecificHighlightPhrase(value: string): boolean {
  const phrase = normalizeHighlightPhrase(value);
  if (!phrase || phrase.length < 4 || phrase.length > 96) return false;

  const words = tokenizeHighlightPhrase(phrase);
  if (words.length === 0 || words.length > 10) return false;

  const meaningfulWords = words
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 2 && !HIGHLIGHT_STOPWORDS.has(word));
  if (meaningfulWords.length === 0) return false;

  if (words.length === 1) {
    return /^[A-Z][A-Z0-9]+-\d+$/.test(phrase)
      || phrase.includes("/")
      || /^[A-Z][a-z]{2,}$/.test(phrase);
  }

  const hasStrongSignal =
    /[A-Z0-9/:'"-]/.test(phrase) ||
    meaningfulWords.some((word) => HIGHLIGHT_SIGNAL_TOKENS.has(word));
  return hasStrongSignal || words.length >= 3;
}

function extractQuotedPhrases(value: string): string[] {
  return Array.from(value.matchAll(/["']([^"']{3,80})["']/g))
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function extractApiPhrases(value: string): string[] {
  const phrases = [
    ...Array.from(value.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9/_:.-]+/g)).map((match) => match[0]),
    ...Array.from(value.matchAll(/\/api\/v\d+\/[A-Za-z0-9/_:.-]+/g)).map((match) => match[0]),
  ];
  return phrases.filter(Boolean);
}

function extractIssueKeys(value: string): string[] {
  return Array.from(value.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g))
    .map((match) => match[0])
    .filter(Boolean);
}

function extractCapitalizedPhrases(value: string): string[] {
  return Array.from(
    stripMarkdownFormatting(value).matchAll(
      /\b(?:[A-Z][A-Za-z0-9'/-]*|[A-Z]{2,}|CTAs?|API|UI|UX)(?:\s+(?:[A-Z][A-Za-z0-9'/-]*|[A-Z]{2,}|CTAs?|API|UI|UX|for|and|to|of|the|&)){1,7}/g,
    ),
  )
    .map((match) => match[0]?.trim() ?? "")
    .filter(Boolean);
}

function extractPossessiveNames(value: string): string[] {
  return Array.from(stripMarkdownFormatting(value).matchAll(/\b([A-Z][a-z]{2,})(?='s\b)/g))
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function extractSourceTitleTerms(title: string): string[] {
  const normalized = normalizeHighlightPhrase(title);
  if (!normalized) return [];

  const out = new Set<string>([
    ...extractQuotedPhrases(normalized),
    ...extractApiPhrases(normalized),
    ...extractIssueKeys(normalized),
  ]);

  const ticketMatch = normalized.match(/^([A-Z][A-Z0-9]+-\d+)[:\s-]+(.+)$/);
  if (ticketMatch) {
    out.add(ticketMatch[1]);
    out.add(ticketMatch[2]);
  }

  if (!normalized.startsWith("#") && !normalized.includes("|")) {
    out.add(normalized);
    out.add(cleanEntityTitle(normalized));
    for (const phrase of extractCapitalizedPhrases(normalized)) out.add(phrase);
  }

  return Array.from(out);
}

function extractSharedEvidencePhrases(content: string, evidenceText: string): string[] {
  const normalizedContent = normalizeHighlightPhrase(content).toLowerCase();
  const words = tokenizeHighlightPhrase(evidenceText);
  const out = new Set<string>();
  if (!normalizedContent || words.length < 2) return [];

  const maxWindow = Math.min(6, words.length);
  for (let size = maxWindow; size >= 2; size -= 1) {
    for (let index = 0; index <= words.length - size; index += 1) {
      const phrase = words.slice(index, index + size).join(" ");
      if (!isSpecificHighlightPhrase(phrase)) continue;
      if (normalizedContent.includes(phrase.toLowerCase())) out.add(phrase);
    }
  }
  return Array.from(out);
}

function addDerivedHighlightTerms(
  bucket: Map<string, KBDerivedHighlight>,
  phrases: string[],
  variant: KBDerivedHighlightVariant,
) {
  for (const rawPhrase of phrases) {
    const phrase = normalizeHighlightPhrase(rawPhrase);
    if (!isSpecificHighlightPhrase(phrase)) continue;

    const key = phrase.toLowerCase();
    const existing = bucket.get(key);
    if (!existing) {
      bucket.set(key, { phrase, variant });
      continue;
    }

    const nextVariant = existing.variant === "pattern" || variant === "pattern"
      ? "pattern"
      : "company";
    const nextPhrase = phrase.length > existing.phrase.length ? phrase : existing.phrase;
    bucket.set(key, { phrase: nextPhrase, variant: nextVariant });
  }
}

function pruneDerivedHighlights(highlights: KBDerivedHighlight[]): KBDerivedHighlight[] {
  const sorted = [...highlights].sort((left, right) =>
    right.phrase.length - left.phrase.length
    || (left.variant === "pattern" ? -1 : 1),
  );
  const kept: KBDerivedHighlight[] = [];

  for (const highlight of sorted) {
    const lowerPhrase = highlight.phrase.toLowerCase();
    const overshadowed = kept.some((existing) => {
      const lowerExisting = existing.phrase.toLowerCase();
      return lowerExisting === lowerPhrase || lowerExisting.includes(lowerPhrase);
    });
    if (!overshadowed) kept.push(highlight);
    if (kept.length >= 24) break;
  }

  return kept.sort((left, right) => right.phrase.length - left.phrase.length);
}

function getHighlightClassName(variant: KBDerivedHighlightVariant): string {
  return variant === "pattern"
    ? "rounded-sm bg-violet-500/15 px-0.5 ring-1 ring-violet-500/20"
    : "rounded-sm bg-amber-500/15 px-0.5 ring-1 ring-amber-500/20";
}

function getHighlightTitle(variant: KBDerivedHighlightVariant): string {
  return variant === "pattern"
    ? "Derived from a company-specific pattern or convention"
    : "Derived from company-specific KB evidence";
}

function renderHighlightedText(
  text: string,
  highlights: KBDerivedHighlight[],
): ReactNode {
  if (!text || highlights.length === 0) return text;

  const matches: Array<{ start: number; end: number; text: string; variant: KBDerivedHighlightVariant }> = [];
  const orderedHighlights = [...highlights].sort((left, right) =>
    right.phrase.length - left.phrase.length
    || (left.variant === "pattern" ? -1 : 1),
  );

  for (const highlight of orderedHighlights) {
    const matcher = new RegExp(escapeRegExp(highlight.phrase), "gi");
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const overlapsExisting = matches.some((existing) =>
        Math.max(existing.start, start) < Math.min(existing.end, end),
      );
      if (!overlapsExisting) {
        matches.push({
          start,
          end,
          text: match[0],
          variant: highlight.variant,
        });
      }
      if (matcher.lastIndex === match.index) matcher.lastIndex += 1;
    }
  }

  if (matches.length === 0) return text;
  matches.sort((left, right) => left.start - right.start);

  const out: ReactNode[] = [];
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (cursor < match.start) out.push(text.slice(cursor, match.start));
    out.push(
      <span
        key={`${match.start}-${match.end}-${index}`}
        className={getHighlightClassName(match.variant)}
        title={getHighlightTitle(match.variant)}
      >
        {match.text}
      </span>,
    );
    cursor = match.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function highlightReactChildren(
  children: ReactNode,
  highlights: KBDerivedHighlight[],
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return renderHighlightedText(child, highlights);
    }
    if (typeof child === "number" || child == null || typeof child === "boolean") {
      return child;
    }
    if (isValidElement(child)) {
      const element = child as ReactElement<{ children?: ReactNode }>;
      return cloneElement(element, {
        ...element.props,
        children: highlightReactChildren(element.props.children, highlights),
      });
    }
    return child;
  });
}

function buildHighlightedMarkdownComponents(highlights: KBDerivedHighlight[]) {
  return {
    p: ({ children }: { children?: ReactNode }) => <p>{highlightReactChildren(children, highlights)}</p>,
    li: ({ children }: { children?: ReactNode }) => <li>{highlightReactChildren(children, highlights)}</li>,
    strong: ({ children }: { children?: ReactNode }) => <strong>{highlightReactChildren(children, highlights)}</strong>,
    em: ({ children }: { children?: ReactNode }) => <em>{highlightReactChildren(children, highlights)}</em>,
    code: ({ children, className }: { children?: ReactNode; className?: string }) => (
      <code className={className}>{highlightReactChildren(children, highlights)}</code>
    ),
    a: ({ children, href }: { children?: ReactNode; href?: string }) => (
      <a href={href}>{highlightReactChildren(children, highlights)}</a>
    ),
    h1: ({ children }: { children?: ReactNode }) => <h1>{highlightReactChildren(children, highlights)}</h1>,
    h2: ({ children }: { children?: ReactNode }) => <h2>{highlightReactChildren(children, highlights)}</h2>,
    h3: ({ children }: { children?: ReactNode }) => <h3>{highlightReactChildren(children, highlights)}</h3>,
    h4: ({ children }: { children?: ReactNode }) => <h4>{highlightReactChildren(children, highlights)}</h4>,
    blockquote: ({ children }: { children?: ReactNode }) => <blockquote>{highlightReactChildren(children, highlights)}</blockquote>,
  };
}

function normalizePriorityLevel(priority?: string): "critical" | "high" | "medium" | "low" | null {
  const value = (priority ?? "").trim().toLowerCase();
  if (value === "p0" || value === "critical") return "critical";
  if (value === "p1" || value === "high") return "high";
  if (value === "p2" || value === "medium") return "medium";
  if (value === "p3" || value === "low") return "low";
  return null;
}

function formatPriorityLabel(priority?: string): string {
  const normalized = normalizePriorityLevel(priority);
  if (normalized === "critical") return "Critical";
  if (normalized === "high") return "High";
  if (normalized === "medium") return "Medium";
  if (normalized === "low") return "Low";
  return priority?.trim() || "Unspecified";
}

function getPriorityBadgeClass(priority?: string): string {
  const normalized = normalizePriorityLevel(priority);
  return normalized ? PRIORITY_COLORS[normalized] : "bg-muted text-muted-foreground";
}

function getPlanStatus(howto?: Howto | null): PlanStatus {
  return howto?.plan_status ?? "draft";
}

function getPlanStatusBadgeClass(status: PlanStatus): string {
  switch (status) {
    case "draft":
      return "bg-blue-500/10 text-blue-700 border border-blue-200";
    case "in_review":
      return "bg-amber-500/10 text-amber-700 border border-amber-200";
    case "approved":
      return "bg-emerald-500/10 text-emerald-700 border border-emerald-200";
    case "archived":
      return "bg-muted text-muted-foreground border border-border";
    default:
      return "bg-muted text-muted-foreground border border-border";
  }
}

function formatPlanTimestamp(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function dedupeSourceRefs(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const ref of sourceRefs) {
    const key = `${ref.source_type}::${ref.doc_id}::${ref.title}::${ref.excerpt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function getTicketKey(ticket: Ticket): string | null {
  const directMatch = ticket.ticket_id?.match(/^[A-Z]+-\d+/);
  if (directMatch) return directMatch[0];
  const titleMatch = ticket.title?.match(/^([A-Z]+-\d+)/);
  return titleMatch ? titleMatch[1] : null;
}

function getTicketDisplayTitle(ticket: Ticket): string {
  const rawTitle = ticket.title.trim();
  const jiraSourceTitle = ticket.source_refs?.find((ref) =>
    ref.source_type === "jira" &&
    typeof ref.title === "string" &&
    ref.title.trim().length > 0,
  )?.title?.trim();
  const key = getTicketKey(ticket);
  if (jiraSourceTitle && key && rawTitle.toUpperCase() === key.toUpperCase()) {
    return jiraSourceTitle;
  }
  if (key) {
    const remainder = rawTitle.replace(/^[A-Z]+-\d+[:\s-]*/, "").trim();
    return remainder ? `${key}: ${remainder}` : key;
  }
  return rawTitle;
}

function classifyTicketStatus(ticket: Ticket): TicketStatusKey {
  const workflow = (ticket.workflow_state ?? "").toLowerCase();
  const status = (ticket.status ?? "").toLowerCase();
  if (workflow === "done" || status === "closed") return "past";
  if (ticket.source === "conversation" || ticket.source === "feedback") return "proposed";
  return "ongoing";
}

function classifyProjectStatus(project: ProjectNode): ProjectStatusKey {
  const disc = typeof project.attributes?.discovery_category === "string"
    ? project.attributes.discovery_category
    : "";
  const status = typeof project.attributes?.status === "string"
    ? project.attributes.status.toLowerCase()
    : "";
  const docLevel = typeof project.attributes?.documentation_level === "string"
    ? project.attributes.documentation_level.toLowerCase()
    : "";
  const hasConfluenceSource = (project.source_refs ?? []).some((ref) => ref.source_type === "confluence");
  const isDone = ["done", "completed", "closed", "past"].some((token) => status.includes(token));
  const isProposed = status === "proposed" || status === "planned";
  const effectiveDocLevel = docLevel || (hasConfluenceSource ? "documented" : "");
  const isDocumented = effectiveDocLevel === "documented";
  const isUndocumented = effectiveDocLevel === "undocumented";

  if (disc === "proposed_project" || disc === "proposed_from_feedback" || isProposed) {
    return "proposed";
  }
  if (disc === "past_undocumented") return "past_undocumented";
  if (disc === "ongoing_undocumented") return "ongoing_undocumented";
  if (disc === "past_documented") return "past_documented";
  if (disc === "ongoing_documented") return "ongoing_documented";

  if (isDone) return isDocumented ? "past_documented" : "past_undocumented";
  if (isUndocumented) return "ongoing_undocumented";
  if (isDocumented || project.attributes?.truth_status === "direct") return "ongoing_documented";
  return "ongoing_undocumented";
}

function getTicketSources(ticket: Ticket): SourceRef[] {
  if (ticket.source_refs && ticket.source_refs.length > 0) {
    return dedupeSourceRefs(ticket.source_refs);
  }
  return dedupeSourceRefs([
    {
      source_type: ticket.source || "unknown",
      doc_id: ticket.ticket_id,
      title: getTicketDisplayTitle(ticket),
      excerpt: ticket.description || undefined,
    },
  ]);
}

function SidebarSection({
  label,
  count,
  children,
  defaultOpen = false,
}: {
  label: string;
  count: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="mb-3">
      <CollapsibleTrigger className="w-full px-2 pb-1 flex items-center gap-2 hover:bg-accent/30 rounded transition-colors cursor-pointer group">
        <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex-1 text-left">
          {label}
        </p>
        <Badge variant="secondary" className="text-[8px] h-4 px-1.5">
          {count}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function isSourceGroupDefaultOpen(
  status: TicketStatusKey | ProjectStatusKey,
): boolean {
  return status === "proposed";
}

function isPlanGroupDefaultOpen(status: PlanStatus): boolean {
  return status === "draft" || status === "in_review";
}

export function KB2HowtoPage({ companySlug }: { companySlug: string }) {
  const [howtos, setHowtos] = useState<Howto[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [projects, setProjects] = useState<ProjectNode[]>([]);
  const [entityPages, setEntityPages] = useState<EntityPage[]>([]);
  const [leftSidebarTab, setLeftSidebarTab] = useState<LeftSidebarTab>("plans");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [commentText, setCommentText] = useState("");
  const [sourceTab, setSourceTab] = useState<SourceTab>("tickets");
  const [viewMode, setViewMode] = useState<"plan" | "prompt">("plan");
  const [generating, setGenerating] = useState(false);
  const [planSearchQuery, setPlanSearchQuery] = useState("");
  const [sourceSearchQuery, setSourceSearchQuery] = useState("");

  const [pendingTicketId, setPendingTicketId] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  const [activeSectionName, setActiveSectionName] = useState<string | null>(null);
  const [rightPanelSources, setRightPanelSources] = useState<SourceRef[]>([]);
  const [rightPanelRelated, setRightPanelRelated] = useState<RelatedEntityPage[]>([]);
  const [rightPanelSourceEmptyMessage, setRightPanelSourceEmptyMessage] = useState<string | null>(null);
  const [rightPanelRelatedEmptyMessage, setRightPanelRelatedEmptyMessage] = useState<string | null>(null);
  const [generatingPlan, setGeneratingPlan] = useState<GeneratingPlan | null>(null);
  const [planStatusDraft, setPlanStatusDraft] = useState<PlanStatus>("draft");
  const [ownerDraft, setOwnerDraft] = useState("");
  const [reviewersDraft, setReviewersDraft] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);

  const selected = howtos.find((h) => h.howto_id === selectedId) ?? null;
  const selectedGeneratingPlan =
    generatingPlan && generatingPlan.temp_id === selectedId ? generatingPlan : null;

  const fetchData = useCallback(async () => {
    const [hRes, tRes, nRes, epRes] = await Promise.all([
      fetch(`/api/${companySlug}/kb2?type=howto`),
      fetch(`/api/${companySlug}/kb2/tickets`),
      fetch(`/api/${companySlug}/kb2?type=graph_nodes`),
      fetch(`/api/${companySlug}/kb2?type=entity_pages`),
    ]);
    const hData = await hRes.json();
    const tData = await tRes.json();
    const nData = await nRes.json();
    const epData = await epRes.json();
    setHowtos(hData.howtos ?? []);
    setTickets(tData.tickets ?? []);
    setEntityPages(epData.pages ?? []);
    const nodes = nData.nodes ?? [];
    setProjects(nodes.filter((n: any) => n.type === "project"));
  }, [companySlug]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!selected) {
      setPlanStatusDraft("draft");
      setOwnerDraft("");
      setReviewersDraft("");
      return;
    }
    setPlanStatusDraft(getPlanStatus(selected));
    setOwnerDraft(selected.owner_name ?? "");
    setReviewersDraft((selected.reviewers ?? []).join(", "));
  }, [selected]);

  const handleSectionSave = async (sectionName: string, content: string) => {
    if (!selected) return;
    await fetch(`/api/${companySlug}/kb2?type=howto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "howto",
        howto_id: selected.howto_id,
        section_name: sectionName,
        content,
      }),
    });
    setEditingSection(null);
    setEditContent("");
    await fetchData();
  };

  const handleAddComment = async () => {
    if (!selected || !commentText.trim()) return;
    await fetch(`/api/${companySlug}/kb2?type=howto_comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "howto_comment",
        howto_id: selected.howto_id,
        comment: commentText,
      }),
    });
    setCommentText("");
    await fetchData();
  };

  const handleMetaSave = async () => {
    if (!selected) return;
    setSavingMeta(true);
    try {
      await fetch(`/api/${companySlug}/kb2?type=howto_meta`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "howto_meta",
          howto_id: selected.howto_id,
          plan_status: planStatusDraft,
          owner_name: ownerDraft.trim(),
          reviewers: reviewersDraft
            .split(",")
            .map((reviewer) => reviewer.trim())
            .filter(Boolean),
        }),
      });
      await fetchData();
    } finally {
      setSavingMeta(false);
    }
  };

  const handleOpenNewPlan = () => {
    setLeftSidebarTab("create");
    clearRightPanelSelection();
    setSelectedId(null);
    setPendingTicketId(null);
    setPendingProjectId(null);
    setSourceSearchQuery("");
    setViewMode("plan");
  };

  const handleGenerate = async (ticketId?: string, projectNodeId?: string) => {
    setGenerating(true);
    setLeftSidebarTab("plans");
    const sourceTitle = ticketId
      ? getTicketDisplayTitle(ticketById.get(ticketId) ?? ({
          ticket_id: ticketId,
          title: ticketId,
          description: "",
          assignees: [],
          priority: "",
          workflow_state: "",
          source: "jira",
          linked_entity_names: [],
          labels: [],
          created_at: "",
        } as Ticket))
      : projectNodeId
        ? projectById.get(projectNodeId)?.display_name ?? projectNodeId
        : "Untitled source";
    const tempId = `generating-${Date.now()}`;
    setGeneratingPlan({
      temp_id: tempId,
      title: `Plan: ${sourceTitle}`,
      created_at: new Date().toISOString(),
    });
    setSelectedId(tempId);
    try {
      const res = await fetch(`/api/${companySlug}/kb2/howto/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket_id: ticketId, project_node_id: projectNodeId }),
      });
      const data = await res.json();
      if (data.howto) {
        clearRightPanelSelection();
        setHowtos((prev) => [data.howto, ...prev.filter((howto) => howto.howto_id !== data.howto.howto_id)]);
        setPendingTicketId(null);
        setPendingProjectId(null);
        setSelectedId(data.howto.howto_id);
        setGeneratingPlan(null);
        await fetchData();
      }
    } catch (error) {
      setSelectedId(null);
      throw error;
    } finally {
      setGenerating(false);
      setGeneratingPlan(null);
    }
  };

  // Lookup maps
  const { howtoByTicket, howtoByProject } = useMemo(() => {
    const byTicket = new Map<string, Howto>();
    const byProject = new Map<string, Howto>();
    for (const h of howtos) {
      if (h.ticket_id && !byTicket.has(h.ticket_id)) byTicket.set(h.ticket_id, h);
      if (h.project_node_id && !byProject.has(h.project_node_id)) byProject.set(h.project_node_id, h);
    }
    return { howtoByTicket: byTicket, howtoByProject: byProject };
  }, [howtos]);

  const ticketById = useMemo(() => new Map(tickets.map((t) => [t.ticket_id, t])), [tickets]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.node_id, p])), [projects]);
  const entityPageByNodeId = useMemo(() => new Map(entityPages.map((ep) => [ep.node_id, ep])), [entityPages]);
  const entityPageById = useMemo(() => new Map(entityPages.map((ep) => [ep.page_id, ep])), [entityPages]);

  const buildRelatedEntityPage = (
    page: EntityPage,
    options?: {
      highlightedSectionNames?: string[];
      highlightedItemTexts?: string[];
    },
  ): RelatedEntityPage => ({
    page_id: page.page_id,
    title: cleanEntityTitle(page.title, page.node_type),
    node_type: page.node_type,
    highlighted_section_names: options?.highlightedSectionNames,
    highlighted_item_texts: options?.highlightedItemTexts,
    sections: page.sections.map((section) => ({
      section_name: section.section_name,
      items: section.items.map((item) => ({
        text: item.text,
        confidence: item.confidence,
      })),
    })),
  });

  const mergeRelatedEntityPages = (pages: RelatedEntityPage[]): RelatedEntityPage[] => {
    const merged = new Map<string, RelatedEntityPage>();
    for (const page of pages) {
      const existing = merged.get(page.page_id);
      if (!existing) {
        merged.set(page.page_id, {
          ...page,
          highlighted_section_names: [...(page.highlighted_section_names ?? [])],
          highlighted_item_texts: [...(page.highlighted_item_texts ?? [])],
        });
        continue;
      }
      merged.set(page.page_id, {
        ...existing,
        highlighted_section_names: [
          ...new Set([
            ...(existing.highlighted_section_names ?? []),
            ...(page.highlighted_section_names ?? []),
          ]),
        ],
        highlighted_item_texts: [
          ...new Set([
            ...(existing.highlighted_item_texts ?? []),
            ...(page.highlighted_item_texts ?? []),
          ]),
        ],
      });
    }
    return Array.from(merged.values());
  };

  const clearRightPanelSelection = () => {
    setActiveSectionName(null);
    setRightPanelSources([]);
    setRightPanelRelated([]);
    setRightPanelSourceEmptyMessage(null);
    setRightPanelRelatedEmptyMessage(null);
  };

  const filteredTickets = useMemo(() => tickets.filter((t) => {
    if (sourceSearchQuery && !getTicketDisplayTitle(t).toLowerCase().includes(sourceSearchQuery.toLowerCase())) return false;
    return true;
  }), [tickets, sourceSearchQuery]);

  const filteredProjects = useMemo(() => projects.filter((p) => {
    if (sourceSearchQuery && !p.display_name.toLowerCase().includes(sourceSearchQuery.toLowerCase())) return false;
    return true;
  }), [projects, sourceSearchQuery]);

  const filteredHowtos = useMemo(() => howtos.filter((h) => {
    if (planSearchQuery && !h.title.toLowerCase().includes(planSearchQuery.toLowerCase())) return false;
    return true;
  }), [howtos, planSearchQuery]);
  const promptSections = ["Prompt Section", "Implementation Steps", "Requirements", "Testing Plan"];

  const ticketGroups = useMemo(() => (["past", "ongoing", "proposed"] as TicketStatusKey[])
    .map((status) => ({
      status,
      label: TICKET_STATUS_LABELS[status],
      items: filteredTickets.filter((ticket) => classifyTicketStatus(ticket) === status),
    }))
    .filter((group) => group.items.length > 0), [filteredTickets]);

  const projectGroups = useMemo(() => ([
    "past_documented",
    "past_undocumented",
    "ongoing_documented",
    "ongoing_undocumented",
    "proposed",
  ] as ProjectStatusKey[])
    .map((status) => ({
      status,
      label: PROJECT_STATUS_LABELS[status],
      items: filteredProjects.filter((project) => classifyProjectStatus(project) === status),
    }))
    .filter((group) => group.items.length > 0), [filteredProjects]);

  const planGroups = useMemo(() => ([
    "draft",
    "in_review",
    "approved",
    "archived",
  ] as PlanStatus[])
    .map((status) => ({
      status,
      label: PLAN_STATUS_LABELS[status],
      items: filteredHowtos.filter((howto) => getPlanStatus(howto) === status),
    }))
    .filter((group) => group.items.length > 0), [filteredHowtos]);

  const selectedProject = selected?.project_node_id
    ? projects.find((p) => p.node_id === selected.project_node_id)
    : null;
  const selectedTicket = selected?.ticket_id ? ticketById.get(selected.ticket_id) ?? null : null;
  const projectSourceRefs: SourceRef[] = (selectedProject?.source_refs ?? []).map((ref) => ({
    source_type: ref.source_type,
    doc_id: ref.doc_id,
    title: ref.title,
    excerpt: ref.excerpt,
    section_heading: ref.section_heading,
  }));
  const allSources: SourceRef[] = dedupeSourceRefs(
    selected
      ? [...(selectedTicket ? getTicketSources(selectedTicket) : []), ...projectSourceRefs]
      : pendingTicketId && ticketById.get(pendingTicketId)
        ? getTicketSources(ticketById.get(pendingTicketId)!)
        : pendingProjectId && projectById.get(pendingProjectId)
          ? ((projectById.get(pendingProjectId)?.source_refs ?? []).map((ref) => ({
              source_type: ref.source_type,
              doc_id: ref.doc_id,
              title: ref.title,
              excerpt: ref.excerpt,
              section_heading: ref.section_heading,
            })))
          : [],
  );

  // For the "no howto yet" middle view
  const pendingTicket = pendingTicketId ? ticketById.get(pendingTicketId) : null;
  const pendingProject = pendingProjectId ? projectById.get(pendingProjectId) : null;
  const pendingExistingPlan = pendingTicket
    ? howtoByTicket.get(pendingTicket.ticket_id) ?? null
    : pendingProject
      ? howtoByProject.get(pendingProject.node_id) ?? null
      : null;

  const entityPagesForTicket = (ticket: Ticket | null | undefined): EntityPage[] => {
    if (!ticket) return [];
    const deduped = new Map<string, EntityPage>();
    for (const entityId of ticket.linked_entity_ids ?? []) {
      const page = entityPageByNodeId.get(entityId);
      if (page) deduped.set(page.page_id, page);
    }
    return Array.from(deduped.values());
  };

  const entityPagesForCurrentContext = (): EntityPage[] => {
    const pages: EntityPage[] = [];
    if (selectedTicket) pages.push(...entityPagesForTicket(selectedTicket));
    if (pendingTicket) pages.push(...entityPagesForTicket(pendingTicket));
    const selectedProjectPage = selectedProject?.node_id
      ? entityPageByNodeId.get(selectedProject.node_id)
      : null;
    if (selectedProjectPage) pages.push(selectedProjectPage);
    const pendingProjectPage = pendingProject?.node_id
      ? entityPageByNodeId.get(pendingProject.node_id)
      : null;
    if (pendingProjectPage) pages.push(pendingProjectPage);
    const deduped = new Map<string, EntityPage>();
    for (const page of pages) deduped.set(page.page_id, page);
    return Array.from(deduped.values());
  };

  const hasStrongTextMatch = (left: string, right: string): boolean => {
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
  };

  const howtoTextChunks = (content: string): string[] =>
    content
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?])\s+/))
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);

  const parseLegacyHowtoStep = (rawStep: string, index: number): HowtoStep | null => {
    const body = rawStep.replace(/^\d+\.\s+/, "").trim();
    if (!body) return null;

    const boldTitleMatch = body.match(/^\*\*(.+?)\*\*\s*[:.-]?\s*([\s\S]*)$/);
    if (boldTitleMatch) {
      return {
        title: boldTitleMatch[1].trim(),
        content: (boldTitleMatch[2] || body).trim(),
      };
    }

    const colonTitleMatch = body.match(/^([^:\n]{3,80})[:.-]\s+([\s\S]+)$/);
    if (colonTitleMatch && colonTitleMatch[1].split(/\s+/).filter(Boolean).length <= 8) {
      return {
        title: colonTitleMatch[1].trim(),
        content: colonTitleMatch[2].trim(),
      };
    }

    return {
      title: `Step ${index + 1}`,
      content: body,
    };
  };

  const splitNumberedMarkdownItems = (content: string): HowtoStep[] => {
    const normalized = content.replace(/\r\n/g, "\n").trim();
    if (!normalized || !/\d+\.\s+/.test(normalized)) return [];
    const numberedParts = Array.from(
      normalized.matchAll(/(?:^|\n|\s)(\d+\.\s+[\s\S]*?)(?=(?:\n|\s)\d+\.\s+|$)/g),
    )
      .map((match) => match[1]?.trim() ?? "")
      .filter(Boolean);
    const fallbackParts = numberedParts.length > 0
      ? numberedParts
      : normalized
          .split(/\n(?=\d+\.\s+)/)
          .map((part) => part.trim())
          .filter((part) => /^\d+\.\s+/.test(part));
    return fallbackParts
      .map((part, index) => parseLegacyHowtoStep(part, index))
      .filter((step): step is HowtoStep => Boolean(step && step.content));
  };

  const getHowtoSectionSteps = (section: HowtoSection): HowtoStep[] => {
    if (Array.isArray(section.steps) && section.steps.length > 0) {
      return section.steps.filter((step) => step.content?.trim());
    }
    return splitNumberedMarkdownItems(section.content);
  };

  const sectionHasVisibleContent = (section: HowtoSection): boolean =>
    Boolean(section.content?.trim() || getHowtoSectionSteps(section).length > 0);

  const normalizeStoredSourceRefs = (sourceRefs: SourceRef[] | undefined): SourceRef[] =>
    dedupeSourceRefs(
      (sourceRefs ?? []).map((sourceRef) => ({
        source_type: sourceRef.source_type,
        doc_id: sourceRef.doc_id,
        title: sourceRef.title,
        excerpt: sourceRef.excerpt,
        section_heading: sourceRef.section_heading,
      })),
    );

  const mapItemSourceRefs = (sourceRefs: SourceRef[] | undefined): SourceRef[] =>
    normalizeStoredSourceRefs(sourceRefs);

  const matchSourcesToContent = (
    content: string,
    sourceRefs: SourceRef[],
  ): SourceRef[] => {
    const matched = sourceRefs.filter((sourceRef) => {
      return (
        (sourceRef.excerpt ? hasStrongTextMatch(content, sourceRef.excerpt) : false) ||
        hasStrongTextMatch(content, sourceRef.title) ||
        (sourceRef.section_heading
          ? hasStrongTextMatch(content, sourceRef.section_heading)
          : false)
      );
    });
    return matched.length > 0 ? dedupeSourceRefs(matched) : [];
  };

  const candidateEntityPagesForHowtoContent = (content: string): EntityPage[] => {
    const deduped = new Map<string, EntityPage>();
    for (const page of entityPagesForCurrentContext()) {
      deduped.set(page.page_id, page);
    }

    for (const page of entityPages) {
      if (
        hasStrongTextMatch(content, page.title) ||
        hasStrongTextMatch(content, cleanEntityTitle(page.title, page.node_type))
      ) {
        deduped.set(page.page_id, page);
      }
    }

    return Array.from(deduped.values());
  };

  const matchedEntityItemsForHowtoContent = (
    content: string,
  ): Array<{
    page: EntityPage;
    sectionName: string;
    itemText: string;
    sourceRefs: SourceRef[];
  }> => {
    const chunks = howtoTextChunks(content);
    const matches: Array<{
      page: EntityPage;
      sectionName: string;
      itemText: string;
      sourceRefs: SourceRef[];
    }> = [];

    for (const page of candidateEntityPagesForHowtoContent(content)) {
      for (const section of page.sections) {
        for (const item of section.items) {
          const sourceRefs = mapItemSourceRefs(item.source_refs);
          const matchedChunk = chunks.some((chunk) => hasStrongTextMatch(chunk, item.text));
          const matchedWholeContent = hasStrongTextMatch(content, item.text);
          if (!matchedChunk && !matchedWholeContent) continue;
          matches.push({
            page,
            sectionName: section.section_name,
            itemText: item.text,
            sourceRefs,
          });
        }
      }
    }

    return matches;
  };

  const buildRelatedPagesFromStoredRefs = (
    entityRefs: HowtoSection["entity_refs"],
  ): RelatedEntityPage[] => {
    if (!entityRefs || entityRefs.length === 0) return [];

    const byPage = new Map<string, {
      page: EntityPage;
      highlightedSectionNames: Set<string>;
      highlightedItemTexts: Set<string>;
    }>();

    for (const entityRef of entityRefs) {
      const page =
        (entityRef.page_id ? entityPageById.get(entityRef.page_id) : null) ??
        entityPageByNodeId.get(entityRef.node_id);
      if (!page) continue;

      const existing = byPage.get(page.page_id) ?? {
        page,
        highlightedSectionNames: new Set<string>(),
        highlightedItemTexts: new Set<string>(),
      };
      if (entityRef.section_name) existing.highlightedSectionNames.add(entityRef.section_name);
      if (entityRef.item_text) existing.highlightedItemTexts.add(entityRef.item_text);
      byPage.set(page.page_id, existing);
    }

    return Array.from(byPage.values()).map(({ page, highlightedSectionNames, highlightedItemTexts }) =>
      buildRelatedEntityPage(page, {
        highlightedSectionNames: [...highlightedSectionNames],
        highlightedItemTexts: [...highlightedItemTexts],
      }),
    );
  };

  const collectDerivedHighlights = (
    content: string,
    sourceRefs: SourceRef[] | undefined,
    entityRefs: HowtoEntityRef[] | undefined,
  ): KBDerivedHighlight[] => {
    const bucket = new Map<string, KBDerivedHighlight>();
    const plainContent = stripMarkdownFormatting(content);

    for (const entityRef of entityRefs ?? []) {
      const variant: KBDerivedHighlightVariant = entityRef.node_type === "decision" ? "pattern" : "company";
      addDerivedHighlightTerms(
        bucket,
        [
          entityRef.page_title,
          cleanEntityTitle(entityRef.page_title, entityRef.node_type),
          ...extractCapitalizedPhrases(entityRef.item_text),
          ...extractPossessiveNames(entityRef.item_text),
          ...extractApiPhrases(entityRef.item_text),
          ...extractSharedEvidencePhrases(plainContent, entityRef.item_text),
        ],
        variant,
      );
    }

    for (const sourceRef of sourceRefs ?? []) {
      addDerivedHighlightTerms(
        bucket,
        [
          ...extractSourceTitleTerms(sourceRef.title),
          ...extractCapitalizedPhrases(sourceRef.section_heading ?? ""),
          ...extractQuotedPhrases(sourceRef.excerpt ?? ""),
          ...extractPossessiveNames(sourceRef.excerpt ?? ""),
          ...extractApiPhrases(sourceRef.excerpt ?? ""),
          ...extractSharedEvidencePhrases(plainContent, sourceRef.excerpt ?? ""),
        ],
        "company",
      );
    }

    return pruneDerivedHighlights(Array.from(bucket.values()));
  };

  const getSectionDerivedHighlights = (section: HowtoSection): KBDerivedHighlight[] =>
    collectDerivedHighlights(section.content, section.source_refs, section.entity_refs);

  const getStepDerivedHighlights = (
    section: HowtoSection,
    step: HowtoStep,
  ): KBDerivedHighlight[] => {
    const stepContent = [step.title, step.content].filter(Boolean).join("\n");
    return collectDerivedHighlights(
      stepContent,
      step.source_refs?.length ? step.source_refs : section.source_refs,
      step.entity_refs?.length ? step.entity_refs : section.entity_refs,
    );
  };

  const selectContextItem = ({
    itemKey,
    sources,
    relatedPages,
    emptySourceMessage,
    emptyRelatedMessage,
  }: {
    itemKey: string;
    sources: SourceRef[];
    relatedPages: RelatedEntityPage[];
    emptySourceMessage?: string | null;
    emptyRelatedMessage?: string | null;
  }) => {
    if (activeSectionName === itemKey) {
      clearRightPanelSelection();
      return;
    }
    setActiveSectionName(itemKey);
    setRightPanelSources(dedupeSourceRefs(sources));
    setRightPanelRelated(mergeRelatedEntityPages(relatedPages));
    setRightPanelSourceEmptyMessage(emptySourceMessage ?? null);
    setRightPanelRelatedEmptyMessage(emptyRelatedMessage ?? null);
  };

  const selectHowtoSection = (section: HowtoSection) => {
    const storedSources = normalizeStoredSourceRefs(section.source_refs);
    const storedRelatedPages = buildRelatedPagesFromStoredRefs(section.entity_refs);
    const hasStoredEvidence = storedSources.length > 0 || storedRelatedPages.length > 0;
    const matchedItems =
      !hasStoredEvidence
        ? matchedEntityItemsForHowtoContent(section.content)
        : [];
    const matchedSources = dedupeSourceRefs(
      matchedItems.flatMap((matchedItem) => matchedItem.sourceRefs),
    );
    const matchedRelatedPages = mergeRelatedEntityPages(
      matchedItems.map((matchedItem) =>
        buildRelatedEntityPage(matchedItem.page, {
          highlightedSectionNames: [matchedItem.sectionName],
          highlightedItemTexts: [matchedItem.itemText],
        }),
      ),
    );

    selectContextItem({
      itemKey: `howto:${section.section_name}`,
      sources:
        hasStoredEvidence
          ? storedSources
          : matchedSources.length > 0
            ? matchedSources
            : [],
      relatedPages:
        hasStoredEvidence
          ? storedRelatedPages
          : matchedRelatedPages.length > 0
            ? matchedRelatedPages
            : [],
      emptySourceMessage:
        hasStoredEvidence || matchedSources.length > 0
          ? null
          : "No matched source evidence for this section.",
      emptyRelatedMessage:
        hasStoredEvidence || matchedRelatedPages.length > 0
          ? null
          : "No matched KB page evidence for this section.",
    });
  };

  const selectHowtoStep = (section: HowtoSection, step: HowtoStep, index: number) => {
    const stepContent = [step.title, step.content].filter(Boolean).join("\n");
    const storedStepSources = normalizeStoredSourceRefs(step.source_refs);
    const storedStepRelatedPages = buildRelatedPagesFromStoredRefs(step.entity_refs);
    const hasStoredStepEvidence = storedStepSources.length > 0 || storedStepRelatedPages.length > 0;
    const storedSources = normalizeStoredSourceRefs(section.source_refs);
    const matchedStoredSources = hasStoredStepEvidence ? [] : matchSourcesToContent(stepContent, storedSources);
    const storedStepEntityRefs = (section.entity_refs ?? []).filter((entityRef) =>
      hasStrongTextMatch(stepContent, entityRef.item_text) ||
      hasStrongTextMatch(stepContent, entityRef.section_name) ||
      hasStrongTextMatch(stepContent, entityRef.page_title) ||
      hasStrongTextMatch(stepContent, cleanEntityTitle(entityRef.page_title, entityRef.node_type)),
    );
    const matchedItems = hasStoredStepEvidence ? [] : matchedEntityItemsForHowtoContent(stepContent);
    const matchedSources = dedupeSourceRefs([
      ...storedStepSources,
      ...matchedStoredSources,
      ...matchedItems.flatMap((matchedItem) => matchedItem.sourceRefs),
    ]);
    const relatedPages = mergeRelatedEntityPages([
      ...storedStepRelatedPages,
      ...buildRelatedPagesFromStoredRefs(hasStoredStepEvidence ? [] : storedStepEntityRefs),
      ...matchedItems.map((matchedItem) =>
        buildRelatedEntityPage(matchedItem.page, {
          highlightedSectionNames: [matchedItem.sectionName],
          highlightedItemTexts: [matchedItem.itemText],
        }),
      ),
    ]);

    selectContextItem({
      itemKey: `howto:${section.section_name}:${index}`,
      sources: matchedSources,
      relatedPages,
      emptySourceMessage:
        matchedSources.length > 0
          ? null
          : "No matched source evidence for this step.",
      emptyRelatedMessage:
        relatedPages.length > 0
          ? null
          : "No matched KB page evidence for this step.",
    });
  };

  const selectPendingTicketDescription = (ticket: Ticket) => {
    selectContextItem({
      itemKey: `ticket:${ticket.ticket_id}:description`,
      sources: getTicketSources(ticket),
      relatedPages: entityPagesForTicket(ticket).map((page) =>
        buildRelatedEntityPage(page, {
          highlightedItemTexts: ticket.description ? [ticket.description] : [],
        }),
      ),
    });
  };

  const selectPendingProjectItem = (
    project: ProjectNode,
    entityPage: EntityPage | null | undefined,
    sectionName: string,
    item: EntityPage["sections"][number]["items"][number],
    index: number,
  ) => {
    const projectSources = dedupeSourceRefs(
      (project.source_refs ?? []).map((ref) => ({
        source_type: ref.source_type,
        doc_id: ref.doc_id,
        title: ref.title,
        excerpt: ref.excerpt,
        section_heading: ref.section_heading,
      })),
    );
    const itemLevelSources = mapItemSourceRefs(item.source_refs);
    const contentMatchedSources = matchSourcesToContent(item.text, projectSources);
    selectContextItem({
      itemKey: `project:${project.node_id}:${sectionName}:${index}`,
      sources:
        itemLevelSources.length > 0
          ? itemLevelSources
          : contentMatchedSources.length > 0
            ? contentMatchedSources
            : [],
      relatedPages: entityPage
        ? [
            buildRelatedEntityPage(entityPage, {
              highlightedSectionNames: [sectionName],
              highlightedItemTexts: [item.text],
            }),
          ]
        : [],
    });
  };

  // ---------------------------------------------------------------------------
  // Linked items section for the howto detail view
  // ---------------------------------------------------------------------------
  const linkedItemsSection = (howto: Howto) => {
    const linkedTicket = howto.ticket_id ? ticketById.get(howto.ticket_id) : null;
    const linkedProject = howto.project_node_id ? projectById.get(howto.project_node_id) : null;

    if (!linkedTicket && !linkedProject) return null;

    return (
      <Card className="mb-4">
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Link2 className="h-3.5 w-3.5" /> Built From
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3 space-y-2">
          {linkedTicket && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/50 text-sm">
              <TicketCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Badge className={`text-[8px] px-1 shrink-0 ${getPriorityBadgeClass(linkedTicket.priority)}`}>
                {formatPriorityLabel(linkedTicket.priority)}
              </Badge>
              <span className="truncate flex-1">{getTicketDisplayTitle(linkedTicket)}</span>
              <button
                onClick={() => {
                  handleOpenNewPlan();
                  setSourceTab("tickets");
                  setPendingTicketId(linkedTicket.ticket_id);
                }}
                className="text-primary hover:underline text-xs shrink-0"
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          )}
          {linkedProject && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/50 text-sm">
              <FolderKanban className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Badge variant="outline" className="text-[8px] shrink-0">project</Badge>
              <span className="truncate flex-1">{linkedProject.display_name}</span>
              <button
                onClick={() => {
                  handleOpenNewPlan();
                  setSourceTab("projects");
                  setPendingProjectId(linkedProject.node_id);
                }}
                className="text-primary hover:underline text-xs shrink-0"
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  // ---------------------------------------------------------------------------
  // Sidebar list content
  // ---------------------------------------------------------------------------
  const sidebarList = (
    <>
      {generatingPlan && (!planSearchQuery || generatingPlan.title.toLowerCase().includes(planSearchQuery.toLowerCase())) && (
        <SidebarSection label="Generating" count={1} defaultOpen>
          <button
            onClick={() => setSelectedId(generatingPlan.temp_id)}
            className={`w-full rounded-md px-2 py-2 text-left text-xs transition-colors ${
              selectedId === generatingPlan.temp_id ? "bg-accent" : "hover:bg-accent/50"
            }`}
          >
            <div className="flex items-center gap-2">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{generatingPlan.title}</span>
            </div>
            <div className="mt-1 pl-5 text-[10px] text-muted-foreground">
              Generating now
            </div>
          </button>
        </SidebarSection>
      )}

      {planGroups.length === 0 ? (
        <p className="p-2 text-xs text-muted-foreground">No plans yet. Create one to get started.</p>
      ) : (
        planGroups.map((group) => (
          <SidebarSection
            key={group.status}
            label={group.label}
            count={group.items.length}
            defaultOpen={isPlanGroupDefaultOpen(group.status)}
          >
            {group.items.map((howto) => {
              const linkedTicket = howto.ticket_id ? ticketById.get(howto.ticket_id) : null;
              const linkedProject = howto.project_node_id ? projectById.get(howto.project_node_id) : null;
              const status = getPlanStatus(howto);
              return (
                <button
                  key={howto.howto_id}
                  onClick={() => {
                    clearRightPanelSelection();
                    setLeftSidebarTab("plans");
                    setSelectedId(howto.howto_id);
                    setPendingTicketId(null);
                    setPendingProjectId(null);
                    setViewMode("plan");
                  }}
                  className={`w-full rounded-md px-2 py-2 text-left text-xs transition-colors ${
                    selectedId === howto.howto_id ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Badge className={`text-[8px] px-1 ${getPlanStatusBadgeClass(status)}`}>
                      {PLAN_STATUS_LABELS[status]}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-medium">{howto.title}</span>
                  </div>
                  <div className="mt-1 pl-5 text-[10px] text-muted-foreground">
                    {linkedTicket
                      ? getTicketDisplayTitle(linkedTicket)
                      : linkedProject?.display_name ?? "Standalone plan"}
                  </div>
                </button>
              );
            })}
          </SidebarSection>
        ))
      )}
    </>
  );

  const sourcePickerList = sourceTab === "tickets"
    ? ticketGroups.length === 0
      ? <p className="p-2 text-xs text-muted-foreground">No tickets found.</p>
      : ticketGroups.map((group) => (
          <SidebarSection
            key={group.status}
            label={group.label}
            count={group.items.length}
            defaultOpen={isSourceGroupDefaultOpen(group.status)}
          >
            {group.items.map((ticket) => {
              const existingPlan = howtoByTicket.get(ticket.ticket_id);
              return (
                <button
                  key={ticket.ticket_id}
                  onClick={() => {
                    clearRightPanelSelection();
                    setSelectedId(null);
                    setPendingTicketId(ticket.ticket_id);
                    setPendingProjectId(null);
                  }}
                  className={`w-full rounded-md px-2 py-2 text-left text-xs transition-colors ${
                    pendingTicketId === ticket.ticket_id ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Badge className={`text-[8px] px-1 ${getPriorityBadgeClass(ticket.priority)}`}>
                      {formatPriorityLabel(ticket.priority)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">{getTicketDisplayTitle(ticket)}</span>
                    {existingPlan && (
                      <Badge variant="secondary" className="text-[8px] shrink-0">
                        Plan
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 pl-7 text-[10px] text-muted-foreground">
                    {ticket.assignees.length > 0 ? ticket.assignees.join(", ") : "Unassigned"} · {ticket.source}
                  </div>
                </button>
              );
            })}
          </SidebarSection>
        ))
    : projectGroups.length === 0
      ? <p className="p-2 text-xs text-muted-foreground">No projects found.</p>
      : projectGroups.map((group) => (
          <SidebarSection
            key={group.status}
            label={group.label}
            count={group.items.length}
            defaultOpen={isSourceGroupDefaultOpen(group.status)}
          >
            {group.items.map((project) => {
              const existingPlan = howtoByProject.get(project.node_id);
              return (
                <button
                  key={project.node_id}
                  onClick={() => {
                    clearRightPanelSelection();
                    setSelectedId(null);
                    setPendingTicketId(null);
                    setPendingProjectId(project.node_id);
                  }}
                  className={`w-full rounded-md px-2 py-2 text-left text-xs transition-colors ${
                    pendingProjectId === project.node_id ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[8px]">Project</Badge>
                    <span className="min-w-0 flex-1 truncate">{project.display_name}</span>
                    {existingPlan && (
                      <Badge variant="secondary" className="text-[8px] shrink-0">
                        Plan
                      </Badge>
                    )}
                  </div>
                </button>
              );
            })}
          </SidebarSection>
        ));

  // ---------------------------------------------------------------------------
  // Middle content
  // ---------------------------------------------------------------------------
  const middleContent = (() => {
    const WORKFLOW_LABELS: Record<string, string> = {
      backlog: "Backlog",
      todo: "To Do",
      in_progress: "In Progress",
      review: "Review",
      done: "Done",
    };

    if (leftSidebarTab === "plans") {
      if (selectedGeneratingPlan) {
        return (
          <ScrollArea className="h-full">
            <div className="mx-auto max-w-3xl p-6">
              <Card>
                <CardHeader className="py-4">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    Generating Plan
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pb-4 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">{selectedGeneratingPlan.title}</p>
                  <p>
                    We are turning the selected ticket or project into an editable plan. When it is ready,
                    this draft will replace the loading state automatically.
                  </p>
                  {(pendingTicket || pendingProject) && (
                    <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
                      Built from: {pendingTicket ? getTicketDisplayTitle(pendingTicket) : pendingProject?.display_name}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </ScrollArea>
        );
      }

      if (selected) {
        const planStatus = getPlanStatus(selected);
        return (
          <ScrollArea className="h-full">
            <div className="p-6">
              <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">Plan</Badge>
                    <Badge className={`text-[10px] ${getPlanStatusBadgeClass(planStatus)}`}>
                      {PLAN_STATUS_LABELS[planStatus]}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      Created {formatPlanTimestamp(selected.created_at)}
                    </Badge>
                    {selected.updated_at && selected.updated_at !== selected.created_at && (
                      <Badge variant="secondary" className="text-[10px]">
                        Updated {formatPlanTimestamp(selected.updated_at)}
                      </Badge>
                    )}
                  </div>
                  <h1 className="text-lg font-semibold">{selected.title}</h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Source-backed implementation plan that can be reviewed, edited, and handed off.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                    <span className={`${getHighlightClassName("company")} text-foreground`}>
                      Company KB detail
                    </span>
                    <span className={`${getHighlightClassName("pattern")} text-foreground`}>
                      Hidden pattern / convention
                    </span>
                    <span>Highlighted text is company-specific, not generic AI filler.</span>
                  </div>
                </div>
                <div className="flex rounded border text-[9px] overflow-hidden opacity-70 transition-opacity hover:opacity-100">
                  <button
                    onClick={() => setViewMode("plan")}
                    className={`px-1.5 py-0.5 transition-colors ${
                      viewMode === "plan" ? "bg-muted font-medium" : "hover:bg-accent/50"
                    }`}
                  >
                    Plan
                  </button>
                  <button
                    onClick={() => setViewMode("prompt")}
                    className={`px-1.5 py-0.5 transition-colors border-l ${
                      viewMode === "prompt" ? "bg-muted font-medium" : "hover:bg-accent/50"
                    }`}
                  >
                    Prompt
                  </button>
                </div>
              </div>

              <Card className="mb-4">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Plan Workflow</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 pb-4">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Status</p>
                      <Select
                        value={planStatusDraft}
                        onValueChange={(value) => setPlanStatusDraft(value as PlanStatus)}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="draft">Draft</SelectItem>
                          <SelectItem value="in_review">In Review</SelectItem>
                          <SelectItem value="approved">Approved</SelectItem>
                          <SelectItem value="archived">Archived</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Owner</p>
                      <Input
                        value={ownerDraft}
                        onChange={(e) => setOwnerDraft(e.target.value)}
                        placeholder="Who owns this plan?"
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Reviewers</p>
                      <Input
                        value={reviewersDraft}
                        onChange={(e) => setReviewersDraft(e.target.value)}
                        placeholder="Alice, Bob"
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                    <p>Use comments below for review rounds and requested changes.</p>
                    <Button size="sm" className="h-7 text-xs" onClick={handleMetaSave} disabled={savingMeta}>
                      {savingMeta ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                      Save Details
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {linkedItemsSection(selected)}

              {(viewMode === "plan"
                ? selected.sections.filter((s) => sectionHasVisibleContent(s) && s.section_name !== "Prompt Section")
                : selected.sections
                    .filter((s) => sectionHasVisibleContent(s) && promptSections.includes(s.section_name))
                    .sort((a, b) => promptSections.indexOf(a.section_name) - promptSections.indexOf(b.section_name))
              ).map((sec) => {
                const sectionHighlights = getSectionDerivedHighlights(sec);
                return (
                  <Card
                    key={sec.section_name}
                    className={`mb-4 transition-colors ${
                      activeSectionName === `howto:${sec.section_name}` ? "ring-1 ring-primary/40" : ""
                    }`}
                    onClick={() => selectHowtoSection(sec)}
                  >
                    <CardHeader className="py-3">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <span>{sec.section_name}</span>
                        {sectionHighlights.length > 0 && (
                          <Badge variant="outline" className="text-[9px] font-medium">
                            KB-derived
                          </Badge>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pb-3">
                      {editingSection === sec.section_name ? (
                        <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                          <Textarea
                            autoFocus
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            className="text-sm min-h-[100px] font-mono"
                          />
                          <div className="flex gap-2">
                            <Button size="sm" className="h-7 text-xs" onClick={() => handleSectionSave(sec.section_name, editContent)}>
                              Save
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditingSection(null); setEditContent(""); }}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            selectHowtoSection(sec);
                            setEditingSection(sec.section_name);
                            setEditContent(sec.content);
                          }}
                          className="cursor-pointer rounded p-2 hover:bg-accent/50 transition-colors"
                        >
                          {sectionHasVisibleContent(sec) ? (
                            sec.section_name === "Implementation Steps" && getHowtoSectionSteps(sec).length > 0 ? (
                              <div className="space-y-2">
                                {getHowtoSectionSteps(sec).map((step, stepIndex) => {
                                  const stepHighlights = getStepDerivedHighlights(sec, step);
                                  return (
                                    <button
                                      key={`${sec.section_name}:${stepIndex}`}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        selectHowtoStep(sec, step, stepIndex);
                                      }}
                                      className={`w-full rounded-md border p-3 text-left transition-colors ${
                                        activeSectionName === `howto:${sec.section_name}:${stepIndex}`
                                          ? "border-primary/40 bg-accent"
                                          : "border-border/60 hover:bg-accent/50"
                                      }`}
                                    >
                                      <div className="space-y-1.5">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <p className="text-sm font-medium">
                                            {renderHighlightedText(step.title, stepHighlights)}
                                          </p>
                                          {stepHighlights.length > 0 && (
                                            <Badge variant="outline" className="text-[9px] font-medium">
                                              KB-derived
                                            </Badge>
                                          )}
                                        </div>
                                        <div className="prose prose-sm max-w-none dark:prose-invert [&_ol]:mb-3 [&_ol]:pl-5 [&_p]:mb-2 [&_p]:last:mb-0 [&_ul]:mb-3 [&_ul]:pl-5">
                                          <ReactMarkdown components={buildHighlightedMarkdownComponents(stepHighlights)}>
                                            {step.content}
                                          </ReactMarkdown>
                                        </div>
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <div
                                className={`max-w-none text-sm dark:prose-invert [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_ol]:mb-3 [&_ol]:pl-5 [&_p]:mb-3 [&_p]:last:mb-0 [&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:mb-3 [&_ul]:pl-5 ${
                                  viewMode === "prompt"
                                    ? "font-mono text-xs [&_p]:text-xs [&_li]:text-xs"
                                    : "prose prose-sm [&_h1]:text-base [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-medium"
                                }`}
                              >
                                <ReactMarkdown components={buildHighlightedMarkdownComponents(sectionHighlights)}>
                                  {sec.content}
                                </ReactMarkdown>
                              </div>
                            )
                          ) : (
                            <span className="text-muted-foreground italic">Click to edit...</span>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              <Collapsible defaultOpen={false}>
                <Card className="mb-4">
                  <CollapsibleTrigger asChild>
                    <CardHeader className="py-3 cursor-pointer hover:bg-muted/30 transition-colors">
                      <CardTitle className="text-sm flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" /> Review & Discussion
                        {(selected.discussion?.length ?? 0) > 0 && (
                          <Badge variant="secondary" className="text-[9px] ml-1 px-1">{selected.discussion!.length}</Badge>
                        )}
                        <ChevronDown className="h-3 w-3 ml-auto text-muted-foreground" />
                      </CardTitle>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="pb-3">
                      {selected.discussion?.map((msg, i) => (
                        <div key={i} className="text-xs mb-2 pb-2 border-b last:border-0">
                          <span className="font-medium">{msg.author}</span>{" "}
                          <span className="text-muted-foreground">{new Date(msg.timestamp).toLocaleString()}</span>
                          <p className="mt-1">{msg.text}</p>
                        </div>
                      ))}
                      <div className="mt-2 space-y-2">
                        <Textarea
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                          placeholder="Leave a review note or comment..."
                          className="text-xs h-16"
                        />
                        <Button size="sm" onClick={handleAddComment} disabled={!commentText.trim()}>
                          <Send className="h-3 w-3 mr-1" /> Add Comment
                        </Button>
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            </div>
          </ScrollArea>
        );
      }

      return (
        <div className="flex h-full items-center justify-center">
          <div className="space-y-2 text-center">
            <FileText className="mx-auto h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              Select a plan from the left, or open `Create Plan` to make a new one.
            </p>
          </div>
        </div>
      );
    }

    return (
      <ScrollArea className="h-full">
        <div className="mx-auto max-w-3xl p-6">
          {!pendingTicket && !pendingProject ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <div className="space-y-2 text-center">
                <FileText className="mx-auto h-10 w-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  Pick a ticket or project from the left to load it here.
                </p>
              </div>
            </div>
          ) : pendingTicket ? (
            <>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Badge className={`text-xs ${getPriorityBadgeClass(pendingTicket.priority)}`}>
                  {formatPriorityLabel(pendingTicket.priority)}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {WORKFLOW_LABELS[pendingTicket.workflow_state] ?? pendingTicket.workflow_state}
                </Badge>
                {pendingTicket.source && (
                  <Badge variant="secondary" className="text-[10px]">{pendingTicket.source}</Badge>
                )}
              </div>
              <h1 className="mt-3 text-xl font-semibold">{getTicketDisplayTitle(pendingTicket)}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Generate a source-backed implementation plan from this ticket, then review and edit it with teammates.
              </p>

              {pendingTicket.description && (
                <div
                  className={`mt-5 cursor-pointer rounded-md px-2 py-2 transition-colors ${
                    activeSectionName === `ticket:${pendingTicket.ticket_id}:description`
                      ? "bg-primary/5 ring-1 ring-primary/20"
                      : "hover:bg-accent/30"
                  }`}
                  onClick={() => selectPendingTicketDescription(pendingTicket)}
                >
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {getTicketSources(pendingTicket).some((source) => source.excerpt?.trim()) ? "Summary" : "Description"}
                  </h3>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{pendingTicket.description}</p>
                </div>
              )}

              {pendingTicket.assignees.length > 0 && (
                <div className="mt-4">
                  <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Assignees</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {pendingTicket.assignees.map((assignee, index) => (
                      <Badge key={index} variant="secondary" className="text-xs">{assignee}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {pendingTicket.labels?.length > 0 && (
                <div className="mt-4">
                  <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Labels</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {pendingTicket.labels.map((label, index) => (
                      <Badge key={index} variant="secondary" className="text-[10px]">{label}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-[10px]">Project</Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {PROJECT_STATUS_LABELS[classifyProjectStatus(pendingProject)]}
                </Badge>
              </div>
              <h1 className="mt-3 text-xl font-semibold">{pendingProject.display_name}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Generate a plan from this project context and keep the result editable for review and handoff.
              </p>

              {(() => {
                const entityPage = entityPageByNodeId.get(pendingProject.node_id);
                if (!entityPage) {
                  return <p className="mt-6 text-sm text-muted-foreground">No entity page data available for this project.</p>;
                }
                return (
                  <div className="mt-6 space-y-4">
                    {entityPage.sections.filter((section) => section.items.length > 0).map((section) => (
                      <div key={section.section_name}>
                        <div className="mb-2 flex items-center gap-2 border-b pb-1">
                          <h3 className="text-sm font-semibold">{section.section_name}</h3>
                          <Badge
                            variant={section.requirement === "MUST" ? "default" : "secondary"}
                            className="text-[9px]"
                          >
                            {section.requirement}
                          </Badge>
                        </div>
                        <ul className="space-y-1">
                          {section.items.map((item, index) => (
                            <li
                              key={index}
                              className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                                activeSectionName === `project:${pendingProject.node_id}:${section.section_name}:${index}`
                                  ? "bg-primary/5 ring-1 ring-primary/20"
                                  : "hover:bg-accent/30"
                              }`}
                              onClick={() =>
                                selectPendingProjectItem(
                                  pendingProject,
                                  entityPage,
                                  section.section_name,
                                  item,
                                  index,
                                )
                              }
                            >
                              <span className="mt-1 shrink-0 text-muted-foreground">•</span>
                              <span className="flex-1">{item.text}</span>
                              <Badge
                                variant={item.confidence === "low" ? "destructive" : item.confidence === "medium" ? "secondary" : "default"}
                                className="shrink-0 text-[9px]"
                              >
                                {item.confidence}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </>
          )}

          {(pendingTicket || pendingProject) && (
            <div className="mt-6 border-t pt-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => handleGenerate(pendingTicket?.ticket_id, pendingProject?.node_id)}
                  disabled={generating}
                >
                  {generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  Generate Plan
                </Button>
                {pendingExistingPlan && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      clearRightPanelSelection();
                      setLeftSidebarTab("plans");
                      setSelectedId(pendingExistingPlan.howto_id);
                      setPendingTicketId(null);
                      setPendingProjectId(null);
                    }}
                  >
                    Open Latest Plan
                  </Button>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {pendingExistingPlan
                  ? "A plan already exists for this source. Open the latest version or generate a new draft."
                  : "This will create a new editable draft plan in the left sidebar."}
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    );
  })();

  return (
    <LeftSidebarLayout
      autoSaveId="plans-left"
      leftSidebar={
        <div className="flex h-full flex-col border-r">
          <div className="space-y-3 border-b p-3">
            <div className="min-w-0">
              <h2 className="text-sm font-medium">Plans</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Generate, review, and hand off implementation plans.
              </p>
            </div>
            <Tabs
              value={leftSidebarTab}
              onValueChange={(value) => {
                clearRightPanelSelection();
                setLeftSidebarTab(value as LeftSidebarTab);
              }}
            >
              <TabsList className="h-8 w-full">
                <TabsTrigger value="plans" className="flex-1 text-[10px]">Plans</TabsTrigger>
                <TabsTrigger value="create" className="flex-1 text-[10px]">Create Plan</TabsTrigger>
              </TabsList>
            </Tabs>
            {leftSidebarTab === "plans" ? (
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={planSearchQuery}
                  onChange={(e) => setPlanSearchQuery(e.target.value)}
                  placeholder="Search plans..."
                  className="h-8 pl-7 text-xs"
                />
              </div>
            ) : (
              <>
                <Tabs
                  value={sourceTab}
                  onValueChange={(value) => {
                    clearRightPanelSelection();
                    setSourceTab(value as SourceTab);
                    setPendingTicketId(null);
                    setPendingProjectId(null);
                  }}
                >
                  <TabsList className="h-8 w-full">
                    <TabsTrigger value="tickets" className="flex-1 text-[10px]">Tickets</TabsTrigger>
                    <TabsTrigger value="projects" className="flex-1 text-[10px]">Projects</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={sourceSearchQuery}
                    onChange={(e) => setSourceSearchQuery(e.target.value)}
                    placeholder={sourceTab === "tickets" ? "Search tickets..." : "Search projects..."}
                    className="h-8 pl-7 text-xs"
                  />
                </div>
              </>
            )}
          </div>

          <ScrollArea className="flex-1 p-2">
            {leftSidebarTab === "plans" ? sidebarList : sourcePickerList}
          </ScrollArea>
        </div>
      }
      mainContent={
        <SplitLayout
          autoSaveId="plans-v2"
          mainContent={<div className="h-full overflow-hidden">{middleContent}</div>}
          rightPanel={
            <KB2RightPanel
              companySlug={companySlug}
              autoContext={
                leftSidebarTab === "plans" && selected
                  ? { type: "howto" as const, id: selected.howto_id, title: selected.title }
                  : leftSidebarTab === "create" && pendingTicket
                    ? { type: "ticket" as const, id: pendingTicket.ticket_id, title: getTicketDisplayTitle(pendingTicket) }
                    : leftSidebarTab === "create" && pendingProject
                      ? {
                          type: "entity_page" as const,
                          id: entityPageByNodeId.get(pendingProject.node_id)?.page_id ?? pendingProject.node_id,
                          title: pendingProject.display_name,
                        }
                    : null
              }
              sourceRefs={rightPanelSources}
              relatedEntityPages={rightPanelRelated}
              emptySourceMessage={rightPanelSourceEmptyMessage}
              emptyKbMessage={rightPanelRelatedEmptyMessage}
              defaultTab="sources"
            />
          }
        />
      }
    />
  );
}
