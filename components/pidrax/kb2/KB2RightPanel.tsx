"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { normalizeForMatch } from "@/lib/utils";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  MessageSquare,
  FileText,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Send,
  X,
  Loader2,
  Search,
  AtSign,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceRef {
  source_type: string;
  doc_id: string;
  title: string;
  section_heading?: string;
  excerpt?: string;
}

interface RelatedEntityPage {
  page_id: string;
  title: string;
  node_type: string;
  highlighted_section_names?: string[];
  highlighted_item_texts?: string[];
  sections: {
    section_name: string;
    items: { text: string; confidence: string }[];
  }[];
}

interface AutoContext {
  type:
    | "entity_page"
    | "human_page"
    | "verify_card"
    | "ticket"
    | "howto"
    | "admin";
  id: string;
  title: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface KB2RightPanelProps {
  companySlug: string;
  autoContext: AutoContext | null;
  sourceRefs: SourceRef[];
  relatedEntityPages: RelatedEntityPage[];
  defaultTab?: "sources" | "kb" | "chat";
  runId?: string;
  emptySourceMessage?: string | null;
  emptyKbMessage?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  confluence: "Confluence",
  jira: "Jira",
  slack: "Slack",
  github: "GitHub",
  feedback: "Feedback",
  notion: "Notion",
  teams: "Teams",
  bitbucket: "Bitbucket",
  zendesk: "Zendesk",
  intercom: "Intercom",
};

function sourceLabel(sourceType: string): string {
  const normalized = (sourceType ?? "").trim().toLowerCase();
  if (!normalized) return "Source";
  return SOURCE_LABELS[normalized] ?? normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-green-600",
  medium: "text-yellow-600",
  low: "text-red-500",
};

// ---------------------------------------------------------------------------
// Tab 1 — Input Sources
// ---------------------------------------------------------------------------

function SourcesTab({
  companySlug,
  sourceRefs,
  runId,
  emptyMessage,
}: {
  companySlug: string;
  sourceRefs: SourceRef[];
  runId?: string;
  emptyMessage?: string | null;
}) {
  const [openSet, setOpenSet] = useState<Set<number>>(new Set());
  const [fullDocs, setFullDocs] = useState<Record<string, { title: string; content: string; provider?: string } | null>>({});
  const [loadingDocs, setLoadingDocs] = useState<Set<string>>(new Set());
  const fetchedRef = useRef<Set<string>>(new Set());

  const getCacheKey = (ref: SourceRef): string =>
    `${runId ?? "latest"}:${ref.source_type ?? ""}:${ref.doc_id}`;

  const toggle = (idx: number) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  useEffect(() => {
    for (const idx of openSet) {
      const ref = sourceRefs[idx];
      if (!ref?.doc_id) continue;
      const cacheKey = getCacheKey(ref);
      if (fullDocs[cacheKey] !== undefined || fetchedRef.current.has(cacheKey)) continue;
      fetchedRef.current.add(cacheKey);

      setLoadingDocs((prev) => new Set(prev).add(cacheKey));
      const params = new URLSearchParams({ type: "parsed_doc", doc_id: ref.doc_id });
      if (ref.source_type) params.set("source_type", ref.source_type);
      if (runId) params.set("run_id", runId);
      fetch(`/api/${companySlug}/kb2?${params}`)
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json();
            const doc = data.document;
            let content = doc?.content ?? "";
            if (!content && doc?.sections?.length) {
              content = doc.sections.map((s: any) => `## ${s.heading}\n${s.content}`).join("\n\n");
            }
            setFullDocs((prev) => ({ ...prev, [cacheKey]: { title: doc?.title ?? "", content, provider: doc?.provider } }));
          } else {
            setFullDocs((prev) => ({ ...prev, [cacheKey]: null }));
          }
        })
        .catch(() => {
          setFullDocs((prev) => ({ ...prev, [cacheKey]: null }));
        })
        .finally(() => {
          setLoadingDocs((prev) => {
            const next = new Set(prev);
            next.delete(cacheKey);
            return next;
          });
        });
    }
  }, [openSet, sourceRefs, companySlug, runId, fullDocs]);

  useEffect(() => {
    setOpenSet(new Set());
  }, [sourceRefs]);

  const highlightExcerpt = (content: string, excerpt?: string, sectionHeading?: string): React.ReactNode => {
    if (!excerpt || !content) return <span className="whitespace-pre-wrap">{content}</span>;

    const wrapMatch = (text: string, start: number, len: number) => (
      <span className="whitespace-pre-wrap">
        {text.slice(0, start)}
        <mark className="bg-yellow-200 dark:bg-yellow-900/60 rounded px-0.5">{text.slice(start, start + len)}</mark>
        {text.slice(start + len)}
      </span>
    );

    const cleanExcerpt = excerpt.slice(0, 300).trim();
    const contentLower = content.toLowerCase();
    const excerptLower = cleanExcerpt.toLowerCase();

    // 1. Exact substring match
    const fullIdx = contentLower.indexOf(excerptLower);
    if (fullIdx !== -1) return wrapMatch(content, fullIdx, cleanExcerpt.length);

    // 2. Whitespace-normalized match: collapse all whitespace to single spaces
    //    and find the excerpt, then map position back to the original string
    const normalize = (s: string) => s.replace(/\s+/g, " ");
    const normContent = normalize(contentLower);
    const normExcerpt = normalize(excerptLower);
    const normIdx = normContent.indexOf(normExcerpt);
    if (normIdx !== -1) {
      let normPos = 0;
      let origStart = 0;
      for (let ci = 0; ci < content.length && normPos < normIdx; ci++) {
        if (/\s/.test(content[ci])) {
          if (ci === 0 || !/\s/.test(content[ci - 1])) normPos++;
        } else {
          normPos++;
        }
        origStart = ci + 1;
      }
      let origEnd = origStart;
      let matchedNorm = 0;
      for (let ci = origStart; ci < content.length && matchedNorm < normExcerpt.length; ci++) {
        if (/\s/.test(content[ci])) {
          if (ci === origStart || !/\s/.test(content[ci - 1])) matchedNorm++;
        } else {
          matchedNorm++;
        }
        origEnd = ci + 1;
      }
      return wrapMatch(content, origStart, origEnd - origStart);
    }

    // 3. Format-stripped normalized match (handles heading underlines, quote markers, etc.)
    const normFull = normalizeForMatch(content);
    const normExcerptFull = normalizeForMatch(cleanExcerpt);
    if (normFull.includes(normExcerptFull)) {
      const paragraphs: { text: string; start: number; end: number }[] = [];
      const paraRe = /(?:\S[\s\S]*?)(?=\n\s*\n|$)/g;
      let pm: RegExpExecArray | null;
      while ((pm = paraRe.exec(content)) !== null) {
        paragraphs.push({ text: pm[0], start: pm.index, end: pm.index + pm[0].length });
      }
      if (paragraphs.length > 0) {
        let bestStart = -1;
        let bestEnd = -1;
        for (let i = 0; i < paragraphs.length; i++) {
          let combined = "";
          for (let j = i; j < paragraphs.length; j++) {
            combined += (j > i ? " " : "") + paragraphs[j].text;
            if (normalizeForMatch(combined).includes(normExcerptFull)) {
              bestStart = paragraphs[i].start;
              bestEnd = paragraphs[j].end;
              break;
            }
          }
          if (bestStart !== -1) break;
        }
        if (bestStart !== -1) {
          return wrapMatch(content, bestStart, bestEnd - bestStart);
        }
      }
    }

    // 4. Section-scoped normalized match
    if (sectionHeading) {
      const headingIdx = contentLower.indexOf(sectionHeading.toLowerCase());
      if (headingIdx !== -1) {
        const sectionEnd = Math.min(headingIdx + 800, content.length);
        const sectionSlice = content.slice(headingIdx, sectionEnd);
        const normSection = normalize(sectionSlice.toLowerCase());
        const normSectionIdx = normSection.indexOf(normExcerpt);
        if (normSectionIdx !== -1) {
          let normPos = 0;
          let secStart = 0;
          for (let ci = 0; ci < sectionSlice.length && normPos < normSectionIdx; ci++) {
            if (/\s/.test(sectionSlice[ci])) {
              if (ci === 0 || !/\s/.test(sectionSlice[ci - 1])) normPos++;
            } else {
              normPos++;
            }
            secStart = ci + 1;
          }
          let secEnd = secStart;
          let matchedNorm = 0;
          for (let ci = secStart; ci < sectionSlice.length && matchedNorm < normExcerpt.length; ci++) {
            if (/\s/.test(sectionSlice[ci])) {
              if (ci === secStart || !/\s/.test(sectionSlice[ci - 1])) matchedNorm++;
            } else {
              matchedNorm++;
            }
            secEnd = ci + 1;
          }
          return wrapMatch(content, headingIdx + secStart, secEnd - secStart);
        }
      }
    }

    // 5. Speaker-header-stripped match: remove leading "Name [date]:" from excerpt
    const speakerStripped = cleanExcerpt.replace(/^\s*\w[\w\s.]*\[[\d\-\/]+\]:\s*\n?/, "").trim();
    if (speakerStripped !== cleanExcerpt && speakerStripped.length > 20) {
      const normStripped = normalizeForMatch(speakerStripped);
      if (normFull.includes(normStripped)) {
        const paragraphs: { text: string; start: number; end: number }[] = [];
        const paraRe2 = /(?:\S[\s\S]*?)(?=\n\s*\n|$)/g;
        let pm2: RegExpExecArray | null;
        while ((pm2 = paraRe2.exec(content)) !== null) {
          paragraphs.push({ text: pm2[0], start: pm2.index, end: pm2.index + pm2[0].length });
        }
        for (let i = 0; i < paragraphs.length; i++) {
          let combined = "";
          for (let j = i; j < paragraphs.length; j++) {
            combined += (j > i ? " " : "") + paragraphs[j].text;
            if (normalizeForMatch(combined).includes(normStripped)) {
              return wrapMatch(content, paragraphs[i].start, paragraphs[j].end - paragraphs[i].start);
            }
          }
        }
      }
    }

    // 6. Sentence-level best match (high threshold to avoid wrong highlights)
    const excerptWords = new Set(excerptLower.split(/\s+/).filter((w) => w.length > 3));
    if (excerptWords.size >= 3) {
      const sentences = content.split(/(?<=[.!?\n])\s+/);
      let bestScore = 0;
      let bestStart = 0;
      let bestLen = 0;
      let pos = 0;
      for (const sent of sentences) {
        const sentWords = sent.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const overlap = sentWords.filter((w) => excerptWords.has(w)).length;
        const score = excerptWords.size > 0 ? overlap / excerptWords.size : 0;
        if (score > bestScore) {
          bestScore = score;
          bestStart = content.indexOf(sent, pos);
          bestLen = sent.length;
        }
        pos += sent.length + 1;
      }
      if (bestScore >= 0.5 && bestStart >= 0) {
        return wrapMatch(content, bestStart, bestLen);
      }
    }

    // 7. No confident match -- show content without highlight rather than highlight wrong spot
    return <span className="whitespace-pre-wrap">{content}</span>;
  };

  if (sourceRefs.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        {emptyMessage ?? "Select an item to see its sources."}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sourceRefs.map((ref, idx) => {
        const isOpen = openSet.has(idx);
        const cacheKey = getCacheKey(ref);
        const fullDoc = fullDocs[cacheKey];
        const isLoading = loadingDocs.has(cacheKey);
        return (
          <Collapsible
            key={`${ref.source_type ?? ""}-${ref.doc_id}-${idx}`}
            open={isOpen}
            onOpenChange={() => toggle(idx)}
          >
            <div className="rounded-md border border-border transition-colors">
              <CollapsibleTrigger asChild>
                <button className="flex items-start gap-2 w-full p-3 text-left hover:bg-muted/50 rounded-md">
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="text-xs font-semibold">
                      {sourceLabel(ref.source_type)}
                    </p>
                    <p className="text-sm font-medium truncate">{ref.title}</p>
                    {ref.section_heading && (
                      <p className="text-xs text-muted-foreground truncate">
                        {ref.section_heading}
                      </p>
                    )}
                  </div>
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                  )}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-3 pb-3">
                  {isLoading && (
                    <div className="flex items-center gap-2 py-4 justify-center">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">Loading full document...</span>
                    </div>
                  )}
                  {!isLoading && fullDoc?.content && (
                    <div className="rounded bg-muted/40 p-3 max-h-96 overflow-y-auto">
                      <p className="text-xs font-medium mb-2">{fullDoc.title}</p>
                      <div className="text-xs text-muted-foreground leading-relaxed">
                        {highlightExcerpt(fullDoc.content, ref.excerpt, ref.section_heading)}
                      </div>
                    </div>
                  )}
                  {!isLoading && (!fullDoc || !fullDoc.content) && ref.excerpt && (
                    <div className="rounded bg-muted/60 p-2">
                      <p className="text-xs italic text-muted-foreground whitespace-pre-wrap">
                        {ref.excerpt}
                      </p>
                    </div>
                  )}
                  {!isLoading && (!fullDoc || !fullDoc.content) && !ref.excerpt && (
                    <p className="text-xs text-muted-foreground py-2">Full document not available.</p>
                  )}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — AI KB Pages
// ---------------------------------------------------------------------------

function KBPagesTab({
  relatedEntityPages,
  emptyMessage,
}: {
  relatedEntityPages: RelatedEntityPage[];
  emptyMessage?: string | null;
}) {
  const [openSet, setOpenSet] = useState<Set<string>>(new Set());

  const toggle = (pageId: string) => {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  };

  useEffect(() => {
    setOpenSet(new Set());
  }, [relatedEntityPages]);

  const isItemHighlighted = (page: RelatedEntityPage, itemText: string): boolean => {
    const highlightedTexts = page.highlighted_item_texts ?? [];
    if (highlightedTexts.length === 0) return false;
    const normalizedItemText = normalizeForMatch(itemText);
    return highlightedTexts.some((highlightedText) => {
      const normalizedHighlight = normalizeForMatch(highlightedText);
      return (
        normalizedItemText.includes(normalizedHighlight) ||
        normalizedHighlight.includes(normalizedItemText)
      );
    });
  };

  if (relatedEntityPages.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        {emptyMessage ?? "Select an item to see its AI page."}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {relatedEntityPages.map((page) => (
        <Collapsible
          key={page.page_id}
          open={openSet.has(page.page_id)}
          onOpenChange={() => toggle(page.page_id)}
        >
          <div className="rounded-md border border-border">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-2 w-full p-3 text-left hover:bg-muted/50 rounded-md">
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {page.node_type}
                </Badge>
                <p className="text-sm font-medium truncate flex-1">
                  {page.title}
                </p>
                {openSet.has(page.page_id) ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-3 pb-3 space-y-3">
                {page.sections.map((sec) => {
                  const isSectionHighlighted = (page.highlighted_section_names ?? []).includes(
                    sec.section_name,
                  );
                  return (
                  <div
                    key={sec.section_name}
                    className={`rounded-md px-2 py-1.5 ${
                      isSectionHighlighted ? "bg-primary/5 ring-1 ring-primary/20" : ""
                    }`}
                  >
                    <p
                      className={`text-xs font-semibold mb-1 ${
                        isSectionHighlighted ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {sec.section_name}
                    </p>
                    <ul className="space-y-1">
                      {sec.items.map((item, i) => (
                        <li
                          key={i}
                          className={`text-xs flex items-start gap-1.5 rounded px-1 py-0.5 ${
                            isItemHighlighted(page, item.text)
                              ? "bg-primary/10 text-primary"
                              : ""
                          }`}
                        >
                          <span className="shrink-0 text-muted-foreground">•</span>
                          <span>{item.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )})}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3 — Chat
// ---------------------------------------------------------------------------

interface MentionSearchResult {
  type: AutoContext["type"];
  id: string;
  title: string;
}

function ChatTab({
  companySlug,
  autoContext,
  onSourcesReceived,
}: {
  companySlug: string;
  autoContext: AutoContext | null;
  onSourcesReceived?: (inputSources: SourceRef[], kbPages: RelatedEntityPage[]) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mentionedItems, setMentionedItems] = useState<AutoContext[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionResults, setMentionResults] = useState<MentionSearchResult[]>(
    [],
  );
  const [mentionLoading, setMentionLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ---- Mention search with debounce ----
  const fetchMentions = useCallback(
    async (query: string) => {
      mentionAbort.current?.abort();
      const controller = new AbortController();
      mentionAbort.current = controller;

      setMentionLoading(true);
      try {
        const types = ["entity_pages", "tickets", "verify_cards"];
        const results: MentionSearchResult[] = [];

        const fetches = types.map(async (t) => {
          const res = await fetch(
            `/api/${companySlug}/kb2?type=${t}&q=${encodeURIComponent(query)}`,
            { signal: controller.signal },
          );
          if (!res.ok) return [];
          const data = await res.json();
          const typeMap: Record<string, AutoContext["type"]> = {
            entity_pages: "entity_page",
            tickets: "ticket",
            verify_cards: "verify_card",
          };
          return (data.items ?? data ?? []).map(
            (item: { page_id?: string; card_id?: string; ticket_id?: string; title: string }) => ({
              type: typeMap[t] ?? "entity_page",
              id: item.page_id ?? item.card_id ?? item.ticket_id ?? "",
              title: item.title ?? "Untitled",
            }),
          );
        });

        const batches = await Promise.all(fetches);
        batches.forEach((b) => results.push(...b));

        if (!controller.signal.aborted) {
          setMentionResults(
            query
              ? results.filter((r) =>
                  r.title.toLowerCase().includes(query.toLowerCase()),
                )
              : results.slice(0, 20),
          );
        }
      } catch {
        if (!controller.signal.aborted) setMentionResults([]);
      } finally {
        if (!controller.signal.aborted) setMentionLoading(false);
      }
    },
    [companySlug],
  );

  useEffect(() => {
    if (!mentionOpen) return;
    const timer = setTimeout(() => fetchMentions(mentionQuery), 250);
    return () => clearTimeout(timer);
  }, [mentionQuery, mentionOpen, fetchMentions]);

  const openMentionPicker = () => {
    setMentionQuery("");
    setMentionResults([]);
    setMentionOpen(true);
  };

  const selectMention = (item: MentionSearchResult) => {
    if (!mentionedItems.some((m) => m.id === item.id)) {
      setMentionedItems((prev) => [...prev, item]);
    }
    setMentionOpen(false);

    const cleaned = input.replace(/@\S*$/, "").trimEnd();
    setInput(cleaned ? `${cleaned} ` : "");
    textareaRef.current?.focus();
  };

  const removeMention = (id: string) => {
    setMentionedItems((prev) => prev.filter((m) => m.id !== id));
  };

  // ---- Send message ----
  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const contextItems: AutoContext[] = [
      ...(autoContext ? [autoContext] : []),
      ...mentionedItems,
    ];

    const userMsg: ChatMessage = { role: "user", content: trimmed };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`/api/${companySlug}/kb2/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          context_items: contextItems.map((c) => ({
            type: c.type,
            id: c.id,
            title: c.title,
          })),
          conversation_history: nextMessages,
        }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer ?? "No response." },
      ]);

      const iSources: SourceRef[] = (data.input_sources ?? []).map((s: any) => ({
        source_type: s.source_type ?? "unknown",
        doc_id: s.doc_id ?? "",
        title: s.title ?? "Unknown",
        excerpt: s.excerpt,
      }));
      const kPages: RelatedEntityPage[] = (data.kb_sources ?? []).map((p: any) => ({
        page_id: p.page_id,
        title: p.title,
        node_type: p.node_type ?? "unknown",
        sections: (p.sections ?? []).map((s: any) => ({
          section_name: s.section_name,
          items: (s.items ?? []).map((i: any) => ({ text: i.text, confidence: i.confidence ?? "medium" })),
        })),
      }));
      onSourcesReceived?.(iSources, kPages);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Something went wrong. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
      return;
    }
    if (e.key === "Escape" && mentionOpen) {
      setMentionOpen(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    const cursorPos = e.target.selectionStart;
    const textBefore = val.slice(0, cursorPos);
    const atMatch = textBefore.match(/@(\S*)$/);

    if (atMatch) {
      if (!mentionOpen) openMentionPicker();
      setMentionQuery(atMatch[1]);
    } else if (mentionOpen) {
      setMentionOpen(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Context badges */}
      <div className="flex flex-wrap gap-1.5 p-2 border-b min-h-[36px]">
        {autoContext && (
          <Badge
            variant="default"
            className="text-[10px] bg-blue-600 hover:bg-blue-600"
          >
            {autoContext.title}
          </Badge>
        )}
        {mentionedItems.map((item) => (
          <Badge
            key={item.id}
            variant="secondary"
            className="text-[10px] gap-1 pr-1"
          >
            {item.title}
            <button
              onClick={() => removeMention(item.id)}
              className="ml-0.5 hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {!autoContext && mentionedItems.length === 0 && (
          <span className="text-[10px] text-muted-foreground leading-5">
            No context — use @ to mention items
          </span>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              Ask a question about the knowledge base…
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-muted text-foreground"
                }`}
              >
                {msg.role === "user" ? (
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                ) : (
                  <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:mb-2 [&_p]:last:mb-0 [&_ol]:mb-2 [&_ul]:mb-2 [&_li]:mb-0.5 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_code]:text-xs [&_code]:bg-muted-foreground/10 [&_code]:px-1 [&_code]:rounded">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="border-t p-2 relative">
        {/* Mention dropdown */}
        {mentionOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-1 rounded-md border bg-popover shadow-lg z-50 max-h-56 flex flex-col">
            <div className="flex items-center gap-2 p-2 border-b">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={mentionQuery}
                onChange={(e) => setMentionQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setMentionOpen(false);
                }}
                placeholder="Search pages, tickets, cards…"
                className="flex-1 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
              />
              <button
                onClick={() => setMentionOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <ScrollArea className="flex-1 max-h-44">
              {mentionLoading && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {!mentionLoading && mentionResults.length === 0 && (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  {mentionQuery ? "No results found." : "Type to search…"}
                </div>
              )}
              {!mentionLoading &&
                mentionResults.map((item) => (
                  <button
                    key={`${item.type}-${item.id}`}
                    onClick={() => selectMention(item)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/60 text-sm"
                  >
                    <Badge
                      variant="outline"
                      className="shrink-0 text-[9px] px-1"
                    >
                      {item.type.replace("_", " ")}
                    </Badge>
                    <span className="truncate">{item.title}</span>
                  </button>
                ))}
            </ScrollArea>
          </div>
        )}

        <div className="flex items-end gap-2">
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0 h-8 w-8"
            onClick={openMentionPicker}
            title="Mention an item"
          >
            <AtSign className="h-4 w-4" />
          </Button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question…"
            rows={1}
            className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[36px] max-h-[120px]"
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />
          <Button
            size="icon"
            className="shrink-0 h-8 w-8"
            onClick={sendMessage}
            disabled={loading || !input.trim()}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function KB2RightPanel({
  companySlug,
  autoContext,
  sourceRefs,
  relatedEntityPages,
  defaultTab = "sources",
  runId,
  emptySourceMessage,
  emptyKbMessage,
}: KB2RightPanelProps) {
  const [activeTab, setActiveTab] = useState(defaultTab);
  const activeSources = sourceRefs;
  const activeKbPages = relatedEntityPages;

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as typeof activeTab)}
      className="flex flex-col h-full"
    >
      <div className="border-b px-2">
        <TabsList className="w-full justify-start bg-transparent h-9">
          <TabsTrigger
            value="sources"
            className="text-xs gap-1 data-[state=active]:bg-muted"
          >
            <FileText className="h-3.5 w-3.5" />
            Sources
            {activeSources.length > 0 && (
              <Badge
                variant="secondary"
                className="ml-1 text-[10px] px-1 py-0"
              >
                {activeSources.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="kb"
            className="text-xs gap-1 data-[state=active]:bg-muted"
          >
            <BookOpen className="h-3.5 w-3.5" />
            AI Page
            {activeKbPages.length > 0 && (
              <Badge
                variant="secondary"
                className="ml-1 text-[10px] px-1 py-0"
              >
                {activeKbPages.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="chat"
            className="text-xs gap-1 data-[state=active]:bg-muted"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="sources" className="flex-1 mt-0 min-h-0">
        <ScrollArea className="h-full">
          <div className="p-3">
            <SourcesTab
              companySlug={companySlug}
              sourceRefs={activeSources}
              runId={runId}
              emptyMessage={emptySourceMessage}
            />
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="kb" className="flex-1 mt-0 min-h-0">
        <ScrollArea className="h-full">
          <div className="p-3">
            <KBPagesTab relatedEntityPages={activeKbPages} emptyMessage={emptyKbMessage} />
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="chat" className="flex-1 mt-0 min-h-0">
        <ChatTab companySlug={companySlug} autoContext={autoContext} />
      </TabsContent>
    </Tabs>
  );
}

export { KB2RightPanel };
export type { SourceRef, RelatedEntityPage, AutoContext };
