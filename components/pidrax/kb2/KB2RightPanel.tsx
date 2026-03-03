"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOURCE_ICONS: Record<string, string> = {
  confluence: "📄",
  jira: "🎫",
  slack: "💬",
  github: "🐙",
  feedback: "📣",
};

function sourceIcon(sourceType: string): string {
  return SOURCE_ICONS[sourceType] ?? "📎";
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
}: {
  companySlug: string;
  sourceRefs: SourceRef[];
}) {
  const [openSet, setOpenSet] = useState<Set<number>>(new Set());
  const [fullDocs, setFullDocs] = useState<Record<string, { title: string; content: string; provider?: string } | null>>({});
  const [loadingDocs, setLoadingDocs] = useState<Set<string>>(new Set());
  const fetchedRef = useRef<Set<string>>(new Set());

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
      if (!ref?.doc_id || fetchedRef.current.has(ref.doc_id)) continue;
      fetchedRef.current.add(ref.doc_id);
      const docId = ref.doc_id;

      setLoadingDocs((prev) => new Set(prev).add(docId));
      fetch(`/api/${companySlug}/kb2?type=parsed_doc&doc_id=${encodeURIComponent(docId)}`)
        .then(async (res) => {
          if (res.ok) {
            const data = await res.json();
            const doc = data.document;
            let content = doc?.content ?? "";
            if (!content && doc?.sections?.length) {
              content = doc.sections.map((s: any) => `## ${s.heading}\n${s.content}`).join("\n\n");
            }
            setFullDocs((prev) => ({ ...prev, [docId]: { title: doc?.title ?? "", content, provider: doc?.provider } }));
          } else {
            setFullDocs((prev) => ({ ...prev, [docId]: null }));
          }
        })
        .catch(() => {
          setFullDocs((prev) => ({ ...prev, [docId]: null }));
        })
        .finally(() => {
          setLoadingDocs((prev) => {
            const next = new Set(prev);
            next.delete(docId);
            return next;
          });
        });
    }
  }, [openSet, sourceRefs, companySlug]);

  useEffect(() => {
    fetchedRef.current.clear();
    setFullDocs({});
  }, [sourceRefs]);

  const highlightExcerpt = (content: string, excerpt?: string): React.ReactNode => {
    if (!excerpt || !content) return <span className="whitespace-pre-wrap">{content}</span>;
    const cleanExcerpt = excerpt.slice(0, 200).trim();
    const idx = content.toLowerCase().indexOf(cleanExcerpt.toLowerCase().slice(0, 60));
    if (idx === -1) return <span className="whitespace-pre-wrap">{content}</span>;
    const before = content.slice(0, idx);
    const match = content.slice(idx, idx + cleanExcerpt.length);
    const after = content.slice(idx + cleanExcerpt.length);
    return (
      <span className="whitespace-pre-wrap">
        {before}
        <mark className="bg-yellow-200 dark:bg-yellow-900/60 rounded px-0.5">{match}</mark>
        {after}
      </span>
    );
  };

  if (sourceRefs.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        Select an item to see its sources.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sourceRefs.map((ref, idx) => {
        const isOpen = openSet.has(idx);
        const fullDoc = fullDocs[ref.doc_id];
        const isLoading = loadingDocs.has(ref.doc_id);
        return (
          <Collapsible
            key={`${ref.doc_id}-${idx}`}
            open={isOpen}
            onOpenChange={() => toggle(idx)}
          >
            <div className="rounded-md border border-border transition-colors">
              <CollapsibleTrigger asChild>
                <button className="flex items-start gap-2 w-full p-3 text-left hover:bg-muted/50 rounded-md">
                  <span className="text-base leading-none mt-0.5">
                    {sourceIcon(ref.source_type)}
                  </span>
                  <div className="flex-1 min-w-0">
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
                        {highlightExcerpt(fullDoc.content, ref.excerpt)}
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
}: {
  relatedEntityPages: RelatedEntityPage[];
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

  if (relatedEntityPages.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        No related pages.
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
                {page.sections.map((sec) => (
                  <div key={sec.section_name}>
                    <p className="text-xs font-semibold text-muted-foreground mb-1">
                      {sec.section_name}
                    </p>
                    <ul className="space-y-1">
                      {sec.items.map((item, i) => (
                        <li
                          key={i}
                          className="text-xs flex items-start gap-1.5"
                        >
                          <span
                            className={`shrink-0 ${
                              CONFIDENCE_COLORS[item.confidence] ?? ""
                            }`}
                          >
                            •
                          </span>
                          <span>{item.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
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
}: {
  companySlug: string;
  autoContext: AutoContext | null;
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
                <p className="whitespace-pre-wrap">{msg.content}</p>
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
}: KB2RightPanelProps) {
  const [activeTab, setActiveTab] = useState(defaultTab);

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
            {sourceRefs.length > 0 && (
              <Badge
                variant="secondary"
                className="ml-1 text-[10px] px-1 py-0"
              >
                {sourceRefs.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="kb"
            className="text-xs gap-1 data-[state=active]:bg-muted"
          >
            <BookOpen className="h-3.5 w-3.5" />
            AI KB Pages
            {relatedEntityPages.length > 0 && (
              <Badge
                variant="secondary"
                className="ml-1 text-[10px] px-1 py-0"
              >
                {relatedEntityPages.length}
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
              sourceRefs={sourceRefs}
            />
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="kb" className="flex-1 mt-0 min-h-0">
        <ScrollArea className="h-full">
          <div className="p-3">
            <KBPagesTab relatedEntityPages={relatedEntityPages} />
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
