"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ChevronDown,
  ChevronRight,
  BookOpen,
  Cpu,
  FileText,
  ExternalLink,
  X,
  Loader2,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HumanPage {
  page_id: string;
  title: string;
  layer: string;
  category: string;
  paragraphs: {
    heading: string;
    body: string;
    entity_refs: string[];
  }[];
  linked_entity_page_ids: string[];
}

interface ItemSourceRef {
  source_type: string;
  doc_id: string;
  title: string;
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
      claim_id?: string;
      source_refs?: ItemSourceRef[];
    }[];
  }[];
  source_refs?: { source_type: string; doc_id: string; title: string; excerpt: string }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYER_ORDER = ["company", "engineering", "marketing", "legal"];
const LAYER_LABELS: Record<string, string> = {
  company: "Company",
  engineering: "Engineering",
  marketing: "Marketing",
  legal: "Legal",
};

const ENTITY_TYPE_ORDER = [
  "person", "team", "client", "repository", "integration", "infrastructure",
  "cloud_resource", "library", "database", "environment", "project",
  "ticket", "pull_request", "pipeline", "customer_feedback",
];
const ENTITY_TYPE_LABELS: Record<string, string> = {
  person: "People",
  team: "Teams",
  client: "Clients",
  repository: "Repositories",
  integration: "Integrations",
  infrastructure: "Infrastructure",
  cloud_resource: "Cloud Resources",
  library: "Libraries",
  database: "Databases",
  environment: "Environments",
  project: "Projects",
  ticket: "Tickets",
  pull_request: "Pull Requests",
  pipeline: "Pipelines",
  customer_feedback: "Customer Feedback",
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function KB2KBPage({ companySlug }: { companySlug: string }) {
  const [humanPages, setHumanPages] = useState<HumanPage[]>([]);
  const [entityPages, setEntityPages] = useState<EntityPage[]>([]);
  const [selectedPage, setSelectedPage] = useState<HumanPage | null>(null);
  const [selectedEntityPage, setSelectedEntityPage] =
    useState<EntityPage | null>(null);
  const [expandedLayers, setExpandedLayers] = useState<Set<string>>(
    new Set(LAYER_ORDER)
  );
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const [viewTab, setViewTab] = useState("human");
  const [sidebarMode, setSidebarMode] = useState<"human" | "ai">("human");

  const [graphNodes, setGraphNodes] = useState<Record<string, { display_name: string; type: string; source_refs: { source_type: string; doc_id: string; title: string; excerpt: string }[] }>>({});

  const fetchPages = useCallback(async () => {
    const [hRes, eRes, nRes] = await Promise.all([
      fetch(`/api/${companySlug}/kb2?type=human_pages`),
      fetch(`/api/${companySlug}/kb2?type=entity_pages`),
      fetch(`/api/${companySlug}/kb2?type=graph_nodes`),
    ]);
    const hData = await hRes.json();
    const eData = await eRes.json();
    const nData = await nRes.json();
    setHumanPages(hData.pages ?? []);
    setEntityPages(eData.pages ?? []);
    const nodeMap: typeof graphNodes = {};
    for (const n of nData.nodes ?? []) {
      nodeMap[n.node_id] = { display_name: n.display_name, type: n.type, source_refs: n.source_refs ?? [] };
    }
    setGraphNodes(nodeMap);
    if (hData.pages?.length > 0) setSelectedPage(hData.pages[0]);
  }, [companySlug]);

  useEffect(() => {
    fetchPages();
  }, [fetchPages]);

  const toggleLayer = (layer: string) => {
    setExpandedLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  };

  const toggleType = (t: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const entityPagesByType = ENTITY_TYPE_ORDER.reduce((acc, t) => {
    acc[t] = entityPages.filter((ep) => ep.node_type === t);
    return acc;
  }, {} as Record<string, EntityPage[]>);

  const pagesByLayer = LAYER_ORDER.reduce(
    (acc, layer) => {
      acc[layer] = humanPages.filter((p) => p.layer === layer);
      return acc;
    },
    {} as Record<string, HumanPage[]>
  );

  const linkedEntityPages = selectedPage
    ? entityPages.filter((ep) =>
        selectedPage.linked_entity_page_ids.includes(ep.page_id) ||
        selectedPage.linked_entity_page_ids.includes(ep.node_id)
      )
    : [];

  const navigateToEntity = (refText: string) => {
    const ep = entityPages.find((e) =>
      e.title.toLowerCase().includes(refText.toLowerCase()),
    ) ?? entityPages.find((e) =>
      e.page_id === refText || e.node_id === refText,
    );
    if (ep) {
      setSelectedEntityPage(ep);
      setViewTab("ai");
    }
  };

  const resolveEntityRef = (ref: string): string => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(ref)) {
      const ep = entityPages.find((e) => e.page_id === ref || e.node_id === ref);
      return ep?.title ?? ref;
    }
    return ref;
  };

  const highlightEntityRefs = (body: string, entityRefs: string[]) => {
    if (entityRefs.length === 0) return <span>{body}</span>;
    const resolvedRefs = entityRefs.map(resolveEntityRef).filter((r) => r.length > 1);
    if (resolvedRefs.length === 0) return <span>{body}</span>;
    const escaped = resolvedRefs.map((r) =>
      r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    );
    const regex = new RegExp(`(${escaped.join("|")})`, "gi");
    const parts = body.split(regex);
    return (
      <>
        {parts.map((part, i) => {
          const isEntity = resolvedRefs.some(
            (ref) => ref.toLowerCase() === part.toLowerCase()
          );
          if (isEntity) {
            return (
              <span
                key={i}
                className="bg-primary/10 text-primary font-medium px-0.5 rounded cursor-pointer hover:bg-primary/20 transition-colors"
                onClick={() => navigateToEntity(part)}
              >
                {part}
              </span>
            );
          }
          return <span key={i}>{part}</span>;
        })}
      </>
    );
  };

  return (
    <div className="flex h-full">
      {/* Left nav tree */}
      <div className="w-64 border-r flex flex-col">
        <div className="p-4 border-b">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Knowledge Base</h2>
            <div className="ml-auto flex rounded-md border text-[10px] overflow-hidden">
              <button
                onClick={() => setSidebarMode("human")}
                className={`px-2 py-0.5 transition-colors ${sidebarMode === "human" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              >
                <BookOpen className="h-3 w-3 inline mr-0.5" />Human
              </button>
              <button
                onClick={() => setSidebarMode("ai")}
                className={`px-2 py-0.5 transition-colors border-l ${sidebarMode === "ai" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              >
                <Cpu className="h-3 w-3 inline mr-0.5" />AI
              </button>
            </div>
          </div>
        </div>
        <ScrollArea className="flex-1 p-2">
          {sidebarMode === "human" ? (
            <>
              {LAYER_ORDER.map((layer) => {
                const pages = pagesByLayer[layer] ?? [];
                const isExpanded = expandedLayers.has(layer);
                return (
                  <div key={layer} className="mb-1">
                    <button
                      onClick={() => toggleLayer(layer)}
                      className="flex items-center gap-1 w-full px-2 py-1.5 text-xs font-medium rounded hover:bg-accent"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      {LAYER_LABELS[layer] ?? layer}
                      {pages.length > 0 && (
                        <Badge variant="secondary" className="ml-auto text-[10px]">
                          {pages.length}
                        </Badge>
                      )}
                    </button>
                    {isExpanded && (
                      <div className="ml-4 space-y-0.5">
                        {pages.length === 0 ? (
                          <div className="text-[10px] text-muted-foreground px-2 py-1">
                            No pages yet
                          </div>
                        ) : (
                          pages.map((p) => (
                            <button
                              key={p.page_id}
                              onClick={() => {
                                setSelectedPage(p);
                                setSelectedEntityPage(null);
                                setViewTab("human");
                              }}
                              className={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
                                selectedPage?.page_id === p.page_id
                                  ? "bg-accent font-medium"
                                  : "hover:bg-accent/50"
                              }`}
                            >
                              {p.title}
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          ) : (
            <>
              {ENTITY_TYPE_ORDER.map((t) => {
                const pages = entityPagesByType[t] ?? [];
                if (pages.length === 0) return null;
                const isExpanded = expandedTypes.has(t);
                return (
                  <div key={t} className="mb-1">
                    <button
                      onClick={() => toggleType(t)}
                      className="flex items-center gap-1 w-full px-2 py-1.5 text-xs font-medium rounded hover:bg-accent"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      {ENTITY_TYPE_LABELS[t] ?? t}
                      <Badge variant="secondary" className="ml-auto text-[10px]">
                        {pages.length}
                      </Badge>
                    </button>
                    {isExpanded && (
                      <div className="ml-4 space-y-0.5">
                        {pages.map((ep) => (
                          <button
                            key={ep.page_id}
                            onClick={() => {
                              setSelectedEntityPage(ep);
                              setSelectedPage(null);
                            }}
                            className={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
                              selectedEntityPage?.page_id === ep.page_id
                                ? "bg-accent font-medium"
                                : "hover:bg-accent/50"
                            }`}
                          >
                            {ep.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </ScrollArea>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedPage || selectedEntityPage ? (
          selectedEntityPage ? (
            <div className="flex-1 min-h-0">
              <EntityPageView
                companySlug={companySlug}
                page={selectedEntityPage}
                sourceRefs={graphNodes[selectedEntityPage.node_id]?.source_refs ?? []}
                onBack={sidebarMode === "ai" ? undefined : () => {
                  setSelectedEntityPage(null);
                  setViewTab("human");
                }}
              />
            </div>
          ) : (
          <ScrollArea className="flex-1 p-6">
              <Tabs value={viewTab} onValueChange={setViewTab}>
                <div className="flex items-center gap-4 mb-4">
                  <h1 className="text-lg font-semibold">
                    {selectedPage?.title}
                  </h1>
                  <TabsList className="ml-auto">
                    <TabsTrigger value="human" className="text-xs">
                      <BookOpen className="h-3 w-3 mr-1" /> Human View
                    </TabsTrigger>
                    <TabsTrigger value="ai" className="text-xs">
                      <Cpu className="h-3 w-3 mr-1" /> AI View
                    </TabsTrigger>
                    <TabsTrigger value="sources" className="text-xs">
                      <FileText className="h-3 w-3 mr-1" /> Sources
                    </TabsTrigger>
                  </TabsList>
                </div>

                {/* Human View */}
                <TabsContent value="human">
                  {!selectedPage?.paragraphs.length ? (
                    <p className="text-xs text-muted-foreground italic">
                      No content yet
                    </p>
                  ) : (
                    selectedPage.paragraphs.map((para, pi) => (
                      <div key={pi} className="mb-6">
                        {para.heading && (
                          <h2 className="text-sm font-semibold mb-2 border-b pb-1">
                            {para.heading}
                          </h2>
                        )}
                        <p className="text-sm leading-relaxed">
                          {highlightEntityRefs(para.body, para.entity_refs)}
                        </p>
                        {para.entity_refs.length > 0 && (
                          <div className="flex gap-1 mt-2 flex-wrap">
                            {para.entity_refs.map((ref, ri) => {
                              const displayName = resolveEntityRef(ref);
                              return (
                              <Badge
                                key={ri}
                                variant="outline"
                                className="text-[10px] cursor-pointer hover:bg-accent"
                                onClick={() => navigateToEntity(ref)}
                              >
                                {displayName}
                              </Badge>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </TabsContent>

                {/* AI View */}
                <TabsContent value="ai">
                  <p className="text-sm text-muted-foreground mb-4">
                    Linked entity pages for this human page:
                  </p>
                  {linkedEntityPages.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No linked entity pages found.
                    </p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {linkedEntityPages.map((ep) => (
                        <Card
                          key={ep.page_id}
                          className="cursor-pointer hover:bg-accent/50 transition-colors"
                          onClick={() => setSelectedEntityPage(ep)}
                        >
                          <CardHeader className="py-3">
                            <div className="flex items-center gap-2">
                              <Badge
                                variant="outline"
                                className="text-[10px]"
                              >
                                {ep.node_type}
                              </Badge>
                              <CardTitle className="text-sm">
                                {ep.title}
                              </CardTitle>
                            </div>
                          </CardHeader>
                          <CardContent className="pb-3">
                            <p className="text-xs text-muted-foreground">
                              {ep.sections.length} section
                              {ep.sections.length !== 1 ? "s" : ""}
                            </p>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </TabsContent>

                {/* Sources */}
                <TabsContent value="sources">
                  {(() => {
                    const sourceMap = new Map<string, { title: string; source_type: string; entities: string[] }>();
                    for (const ep of linkedEntityPages) {
                      const node = graphNodes[ep.node_id];
                      if (!node?.source_refs) continue;
                      for (const ref of node.source_refs) {
                        const key = `${ref.source_type}:${ref.title}`;
                        if (!sourceMap.has(key)) {
                          sourceMap.set(key, { title: ref.title, source_type: ref.source_type, entities: [] });
                        }
                        const entry = sourceMap.get(key)!;
                        if (!entry.entities.includes(node.display_name)) {
                          entry.entities.push(node.display_name);
                        }
                      }
                    }
                    const sources = Array.from(sourceMap.values());
                    const byProvider = sources.reduce((acc, s) => {
                      if (!acc[s.source_type]) acc[s.source_type] = [];
                      acc[s.source_type].push(s);
                      return acc;
                    }, {} as Record<string, typeof sources>);
                    const PROVIDER_ICONS: Record<string, string> = {
                      confluence: "📄", jira: "🎫", slack: "💬", github: "🔧", customerFeedback: "📣",
                    };
                    if (sources.length === 0) {
                      return <p className="text-xs text-muted-foreground">No source documents linked to this page.</p>;
                    }
                    return (
                      <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                          {sources.length} source document{sources.length !== 1 ? "s" : ""} contributed to this page.
                        </p>
                        {Object.entries(byProvider).map(([provider, docs]) => (
                          <div key={provider}>
                            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1">
                              <span>{PROVIDER_ICONS[provider] ?? "📎"}</span> {provider} ({docs.length})
                            </h3>
                            <div className="space-y-1">
                              {docs.map((doc, i) => (
                                <div key={i} className="text-xs bg-muted/30 rounded px-3 py-2 border border-border/30">
                                  <div className="font-medium">{doc.title}</div>
                                  <div className="text-[10px] text-muted-foreground mt-0.5">
                                    Used by: {doc.entities.slice(0, 5).join(", ")}{doc.entities.length > 5 ? ` +${doc.entities.length - 5} more` : ""}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </TabsContent>
              </Tabs>
          </ScrollArea>
          )
        ) : (
          <div className="flex items-center justify-center flex-1">
            <p className="text-muted-foreground">
              {sidebarMode === "human"
                ? humanPages.length === 0
                  ? "No KB pages yet. Run the pipeline from KB Admin."
                  : "Select a page from the left panel."
                : entityPages.length === 0
                  ? "No entity pages yet. Run the pipeline from KB Admin."
                  : "Select an entity from the left panel."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source document panel (right side of split)
// ---------------------------------------------------------------------------

interface SourcePanelState {
  docId: string;
  title: string;
  sourceType: string;
  highlightText: string;
}

function SourcePanel({
  companySlug,
  source,
  onClose,
}: {
  companySlug: string;
  source: SourcePanelState;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const highlightRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent(null);
    fetch(`/api/${companySlug}/kb2?type=parsed_doc&doc_id=${encodeURIComponent(source.docId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setContent(data.doc?.content ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) { setContent(null); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [companySlug, source.docId]);

  useEffect(() => {
    if (content && highlightRef.current) {
      setTimeout(() => highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    }
  }, [content]);

  const PROVIDER_ICONS: Record<string, string> = {
    confluence: "📄", jira: "🎫", slack: "💬", github: "🔧", customerFeedback: "📣", human_verification: "✅",
  };

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading source document...
        </div>
      );
    }
    if (!content) {
      return <p className="text-xs text-muted-foreground p-4">Source document not found.</p>;
    }

    if (!source.highlightText || source.highlightText.length < 8) {
      return (
        <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono p-4">{content}</pre>
      );
    }

    const searchText = source.highlightText.slice(0, 150);
    const idx = content.toLowerCase().indexOf(searchText.toLowerCase());
    if (idx === -1) {
      const words = searchText.split(/\s+/).filter((w) => w.length > 4);
      const fuzzyWord = words[0];
      const fuzzyIdx = fuzzyWord ? content.toLowerCase().indexOf(fuzzyWord.toLowerCase()) : -1;
      if (fuzzyIdx === -1) {
        return (
          <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono p-4">{content}</pre>
        );
      }
      const start = Math.max(0, fuzzyIdx - 50);
      const end = Math.min(content.length, fuzzyIdx + fuzzyWord.length + 50);
      return (
        <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono p-4">
          {content.slice(0, start)}
          <span ref={highlightRef} className="bg-yellow-200 dark:bg-yellow-800/60 px-0.5 rounded">{content.slice(start, end)}</span>
          {content.slice(end)}
        </pre>
      );
    }

    return (
      <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono p-4">
        {content.slice(0, idx)}
        <span ref={highlightRef} className="bg-yellow-200 dark:bg-yellow-800/60 px-0.5 rounded">{content.slice(idx, idx + searchText.length)}</span>
        {content.slice(idx + searchText.length)}
      </pre>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30 shrink-0">
        <span className="text-sm">{PROVIDER_ICONS[source.sourceType] ?? "📎"}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold truncate">{source.title}</div>
          <div className="text-[10px] text-muted-foreground">{source.sourceType}</div>
        </div>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        {renderContent()}
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entity page detail view (with split-pane source viewer)
// ---------------------------------------------------------------------------

function EntityPageView({
  companySlug,
  page,
  sourceRefs,
  onBack,
}: {
  companySlug: string;
  page: EntityPage;
  sourceRefs: { source_type: string; doc_id: string; title: string; excerpt: string }[];
  onBack?: () => void;
}) {
  const [activeSource, setActiveSource] = useState<SourcePanelState | null>(null);
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);

  const openSource = (ref: ItemSourceRef, itemText: string, itemKey: string) => {
    setActiveSource({
      docId: ref.doc_id,
      title: ref.title,
      sourceType: ref.source_type,
      highlightText: itemText,
    });
    setSelectedItemKey(itemKey);
  };

  const closeSource = () => {
    setActiveSource(null);
    setSelectedItemKey(null);
  };

  const visibleSections = page.sections.filter(
    (s) => s.requirement === "MUST" || s.items.length > 0
  );

  const PROVIDER_ICONS: Record<string, string> = {
    confluence: "📄", jira: "🎫", slack: "💬", github: "🔧", customerFeedback: "📣", human_verification: "✅",
  };

  const uniqueSources = sourceRefs.reduce((acc, ref) => {
    const key = `${ref.source_type}:${ref.title}`;
    if (!acc.has(key)) acc.set(key, ref);
    return acc;
  }, new Map<string, typeof sourceRefs[number]>());

  const entityContent = (
    <div className="p-6">
      {onBack && (
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-4">
          &larr; Back to human view
        </Button>
      )}
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold">{page.title}</h2>
        <Badge variant="outline">{page.node_type}</Badge>
      </div>
      {visibleSections.map((section) => (
        <div key={section.section_name} className="mb-5">
          <div className="flex items-center gap-2 mb-2 border-b pb-1">
            <h3 className="text-sm font-semibold">{section.section_name}</h3>
            <Badge
              variant={section.requirement === "MUST" ? "default" : "secondary"}
              className="text-[9px]"
            >
              {section.requirement}
            </Badge>
          </div>
          {section.items.length === 0 ? (
            <p className="text-xs text-red-400 italic">Unknown</p>
          ) : (
            <ul className="space-y-0.5">
              {section.items.map((item, idx) => {
                const itemKey = `${section.section_name}-${idx}`;
                const hasItemSources = (item.source_refs ?? []).length > 0;
                const isSelected = selectedItemKey === itemKey;
                return (
                  <li key={idx} className="text-sm">
                    <div
                      className={`flex items-start gap-2 px-2 py-1.5 rounded transition-colors ${
                        isSelected
                          ? "bg-primary/10 ring-1 ring-primary/30"
                          : hasItemSources
                            ? "cursor-pointer hover:bg-accent/40"
                            : ""
                      }`}
                      onClick={() => {
                        if (hasItemSources && item.source_refs?.[0]) {
                          openSource(item.source_refs[0], item.text, itemKey);
                        }
                      }}
                    >
                      {hasItemSources && (
                        <FileText className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                      )}
                      <span className="flex-1">{item.text}</span>
                      <Badge
                        variant={
                          item.confidence === "low"
                            ? "destructive"
                            : item.confidence === "medium"
                              ? "secondary"
                              : "default"
                        }
                        className="text-[9px] shrink-0"
                      >
                        {item.confidence}
                      </Badge>
                    </div>
                    {hasItemSources && item.source_refs && item.source_refs.length > 1 && isSelected && (
                      <div className="ml-7 mt-1 mb-1 flex gap-1 flex-wrap">
                        {item.source_refs.map((ref, ri) => (
                          <button
                            key={ri}
                            onClick={(e) => { e.stopPropagation(); openSource(ref, item.text, itemKey); }}
                            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                              activeSource?.docId === ref.doc_id
                                ? "bg-primary/10 border-primary/30 text-primary"
                                : "bg-muted/30 border-border/30 hover:bg-accent/40"
                            }`}
                          >
                            {PROVIDER_ICONS[ref.source_type] ?? "📎"} {ref.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}

      {uniqueSources.size > 0 && (
        <div className="mt-8 pt-4 border-t">
          <h3 className="text-sm font-semibold mb-3">Sources ({uniqueSources.size})</h3>
          <div className="space-y-1.5">
            {Array.from(uniqueSources.values()).map((ref, i) => (
              <div
                key={i}
                className="text-xs bg-muted/30 rounded px-3 py-2 border border-border/30 cursor-pointer hover:bg-accent/30 transition-colors"
                onClick={() => setActiveSource({ docId: ref.doc_id, title: ref.title, sourceType: ref.source_type, highlightText: "" })}
              >
                <div className="flex items-center gap-1.5">
                  <span>{PROVIDER_ICONS[ref.source_type] ?? "📎"}</span>
                  <span className="font-medium">{ref.title}</span>
                  <span className="text-muted-foreground">({ref.source_type})</span>
                  <ExternalLink className="h-2.5 w-2.5 text-muted-foreground ml-auto" />
                </div>
                {ref.excerpt && (
                  <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{ref.excerpt}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (!activeSource) {
    return <ScrollArea className="h-full">{entityContent}</ScrollArea>;
  }

  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={55} minSize={30}>
        <ScrollArea className="h-full">{entityContent}</ScrollArea>
      </Panel>
      <PanelResizeHandle className="w-1.5 bg-border hover:bg-primary/30 transition-colors cursor-col-resize" />
      <Panel defaultSize={45} minSize={20}>
        <SourcePanel
          companySlug={companySlug}
          source={activeSource}
          onClose={closeSource}
        />
      </Panel>
    </PanelGroup>
  );
}
