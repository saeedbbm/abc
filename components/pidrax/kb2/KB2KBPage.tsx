"use client";

import { useCallback, useEffect, useState } from "react";
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
  Edit3,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KB2RightPanel, SourceRef, RelatedEntityPage, AutoContext } from "./KB2RightPanel";
import { SplitLayout } from "./SplitLayout";

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
  section_heading?: string;
  excerpt?: string;
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

interface GraphNodeSummary {
  display_name: string;
  type: string;
  truth_status?: string;
  attributes?: Record<string, any>;
  source_refs: {
    source_type: string;
    doc_id: string;
    title: string;
    section_heading?: string;
    excerpt: string;
  }[];
}

type ProjectBucketLabel =
  | "Past Documented"
  | "Past Undocumented"
  | "Ongoing Documented"
  | "Ongoing Undocumented"
  | "Proposed";

function classifyProjectBucket(node?: GraphNodeSummary): ProjectBucketLabel {
  const disc = typeof node?.attributes?.discovery_category === "string"
    ? node.attributes.discovery_category
    : "";
  const status = typeof node?.attributes?.status === "string"
    ? node.attributes.status.toLowerCase()
    : "";
  const docLevel = typeof node?.attributes?.documentation_level === "string"
    ? node.attributes.documentation_level.toLowerCase()
    : "";
  const hasConfluenceSource = (node?.source_refs ?? []).some((ref) => ref.source_type === "confluence");
  const isDone = ["done", "completed", "closed", "past"].some((token) => status.includes(token));
  const isProposed = status === "proposed" || status === "planned";
  const effectiveDocLevel = docLevel || (hasConfluenceSource ? "documented" : "");
  const isDocumented = effectiveDocLevel === "documented";
  const isUndocumented = effectiveDocLevel === "undocumented";

  if (disc === "proposed_project" || disc === "proposed_from_feedback" || isProposed) {
    return "Proposed";
  }
  if (disc === "past_undocumented") return "Past Undocumented";
  if (disc === "ongoing_undocumented") return "Ongoing Undocumented";
  if (disc === "past_documented") return "Past Documented";
  if (disc === "ongoing_documented") return "Ongoing Documented";

  if (isDone) {
    return isDocumented ? "Past Documented" : "Past Undocumented";
  }
  if (isUndocumented) return "Ongoing Undocumented";
  if (isDocumented || node?.truth_status === "direct") return "Ongoing Documented";
  return "Ongoing Undocumented";
}

function isPlaceholderHumanPage(page: HumanPage | null | undefined): boolean {
  if (!page) return false;
  if ((page.linked_entity_page_ids ?? []).length > 0) return false;
  const paragraphs = page.paragraphs ?? [];
  if (paragraphs.length === 0) return true;
  return paragraphs.every((paragraph) => {
    const body = paragraph.body?.trim() ?? "";
    return /^No .* data has been discovered yet\./i.test(body);
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LAYER_ORDER = ["company", "engineering", "marketing", "legal"];
const LAYER_LABELS: Record<string, string> = {
  company: "Company",
  engineering: "Engineering",
  marketing: "Marketing",
  legal: "Legal",
};

const ENTITY_TYPE_ORDER = [
  "team_member", "team", "client_company", "client_person", "repository", "integration", "infrastructure",
  "cloud_resource", "library", "database", "environment", "decision", "process", "project",
  "ticket", "pull_request", "pipeline", "customer_feedback",
];
const ENTITY_TYPE_LABELS: Record<string, string> = {
  person: "People",
  team_member: "Team Members",
  team: "Teams",
  client: "Clients",
  client_company: "Client Companies",
  client_person: "Client People",
  repository: "Repositories",
  integration: "Integrations",
  infrastructure: "Infrastructure",
  cloud_resource: "Cloud Resources",
  library: "Libraries",
  database: "Databases",
  environment: "Environments",
  decision: "Decisions",
  process: "Processes",
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
  const [layerOrder, setLayerOrder] = useState<string[]>(DEFAULT_LAYER_ORDER);
  const [expandedLayers, setExpandedLayers] = useState<Set<string>>(
    new Set(DEFAULT_LAYER_ORDER)
  );
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const [viewTab, setViewTab] = useState("human");
  const [sidebarMode, setSidebarMode] = useState<"human" | "ai">("human");

  const [graphNodes, setGraphNodes] = useState<Record<string, GraphNodeSummary>>({});

  const [rightPanelContext, setRightPanelContext] = useState<AutoContext | null>(null);
  const [rightPanelSources, setRightPanelSources] = useState<SourceRef[]>([]);
  const [rightPanelRelated, setRightPanelRelated] = useState<RelatedEntityPage[]>([]);

  const fetchPages = useCallback(async () => {
    const [hRes, eRes, nRes, cfgRes] = await Promise.all([
      fetch(`/api/${companySlug}/kb2?type=human_pages`),
      fetch(`/api/${companySlug}/kb2?type=entity_pages`),
      fetch(`/api/${companySlug}/kb2?type=graph_nodes`),
      fetch(`/api/${companySlug}/kb2/config`).catch(() => null),
    ]);
    const hData = await hRes.json();
    const eData = await eRes.json();
    const nData = await nRes.json();

    if (cfgRes?.ok) {
      try {
        const cfgData = await cfgRes.json();
        const kbStructure = cfgData.config?.kb_structure;
        if (kbStructure?.layers) {
          const enabledLayers = Object.entries(kbStructure.layers)
            .filter(([_, v]: [string, any]) => v.enabled)
            .map(([k]) => k);
          if (enabledLayers.length > 0) {
            setLayerOrder(enabledLayers);
            setExpandedLayers(new Set(enabledLayers));
          }
        }
      } catch { /* ignore config errors */ }
    }

    const humanPages = hData.pages ?? [];
    const entityPages = eData.pages ?? [];
    setHumanPages(humanPages);
    setEntityPages(entityPages);
    const nodeMap: typeof graphNodes = {};
    for (const n of nData.nodes ?? []) {
      nodeMap[n.node_id] = { display_name: n.display_name, type: n.type, truth_status: n.truth_status, attributes: n.attributes, source_refs: n.source_refs ?? [] };
    }
    setGraphNodes(nodeMap);
    if (humanPages.length > 0) {
      const firstPage = humanPages.find((page: HumanPage) => !isPlaceholderHumanPage(page)) ?? humanPages[0];
      setSelectedPage(firstPage);
      setRightPanelContext({
        type: "human_page",
        id: firstPage.page_id,
        title: firstPage.title,
      });
    }
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

  const pagesByLayer = layerOrder.reduce(
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

  const sourceRefsForEntity = (ep: EntityPage): SourceRef[] =>
    (graphNodes[ep.node_id]?.source_refs ?? []).map((ref) => ({
      source_type: ref.source_type,
      doc_id: ref.doc_id,
      title: ref.title,
      excerpt: ref.excerpt,
      section_heading: ref.section_heading,
    }));

  const relatedPagesForHuman = (page: HumanPage): RelatedEntityPage[] => {
    const related = entityPages.filter(
      (ep) =>
        page.linked_entity_page_ids.includes(ep.page_id) ||
        page.linked_entity_page_ids.includes(ep.node_id),
    );
    return related.map((ep) => ({
      page_id: ep.page_id,
      title: ep.title,
      node_type: ep.node_type,
      sections: ep.sections.map((section) => ({
        section_name: section.section_name,
        items: section.items.map((item) => ({
          text: item.text,
          confidence: item.confidence,
        })),
      })),
    }));
  };

  const navigateToEntity = (refText: string) => {
    const ep = entityPages.find((e) =>
      e.title.toLowerCase().includes(refText.toLowerCase()),
    ) ?? entityPages.find((e) =>
      e.page_id === refText || e.node_id === refText,
    );
    if (ep) {
      setSelectedEntityPage(ep);
      setViewTab("ai");
      setRightPanelContext({ type: "entity_page", id: ep.page_id, title: ep.title });
      setRightPanelSources(sourceRefsForEntity(ep));
      setRightPanelRelated([]);
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
    <div className="flex h-full flex-1 min-w-0">
      {/* Left nav tree */}
      <div className="w-64 border-r flex flex-col">
        <div className="p-4 border-b">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Knowledge Base</h2>
            <div className="ml-auto flex rounded-md border text-[10px] overflow-hidden">
              <button
                onClick={() => {
                  setSidebarMode("human");
                  const page = selectedPage ?? humanPages[0];
                  setSelectedEntityPage(null);
                  if (page) {
                    setSelectedPage(page);
                    setViewTab("human");
                    setRightPanelContext({
                      type: "human_page",
                      id: page.page_id,
                      title: page.title,
                    });
                    setRightPanelSources([]);
                    setRightPanelRelated(relatedPagesForHuman(page));
                  } else {
                    setRightPanelContext(null);
                    setRightPanelSources([]);
                    setRightPanelRelated([]);
                  }
                }}
                className={`px-2 py-0.5 transition-colors ${sidebarMode === "human" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              >
                <BookOpen className="h-3 w-3 inline mr-0.5" />Human
              </button>
              <button
                onClick={() => {
                  setSidebarMode("ai");
                  const ep = selectedEntityPage ?? linkedEntityPages[0] ?? entityPages[0];
                  if (ep) {
                    setSelectedEntityPage(ep);
                    setSelectedPage(null);
                    setViewTab("ai");
                    setRightPanelContext({
                      type: "entity_page",
                      id: ep.page_id,
                      title: ep.title,
                    });
                    setRightPanelSources(sourceRefsForEntity(ep));
                    setRightPanelRelated([]);
                  } else {
                    setSelectedPage(null);
                    setSelectedEntityPage(null);
                    setRightPanelContext(null);
                    setRightPanelSources([]);
                    setRightPanelRelated([]);
                  }
                }}
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
              {layerOrder.map((layer) => {
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
                                setRightPanelContext({ type: "human_page", id: p.page_id, title: p.title });
                                setRightPanelSources([]);
                                setRightPanelRelated(relatedPagesForHuman(p));
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

                if (t === "project") {
                  const PROJECT_SUB_GROUPS = [
                    "Past Documented",
                    "Past Undocumented",
                    "Ongoing Documented",
                    "Ongoing Undocumented",
                    "Proposed",
                  ] as const;
                  const subGroups: Record<string, EntityPage[]> = {};
                  for (const label of PROJECT_SUB_GROUPS) subGroups[label] = [];
                  for (const ep of pages) {
                    const node = graphNodes[ep.node_id];
                    subGroups[classifyProjectBucket(node)].push(ep);
                  }
                  return (
                    <div key={t} className="mb-1">
                      <button
                        onClick={() => toggleType(t)}
                        className="flex items-center gap-1 w-full px-2 py-1.5 text-xs font-medium rounded hover:bg-accent"
                      >
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {ENTITY_TYPE_LABELS[t] ?? t}
                        <Badge variant="secondary" className="ml-auto text-[10px]">{pages.length}</Badge>
                      </button>
                      {isExpanded && (
                        <div className="ml-4 space-y-1">
                          {PROJECT_SUB_GROUPS.map((sg) => {
                            const sgPages = subGroups[sg];
                            const sgKey = `project_${sg}`;
                            const sgExpanded = expandedTypes.has(sgKey);
                            const isEmpty = sgPages.length === 0;
                            return (
                              <div key={sg}>
                                <button
                                  onClick={() => { if (!isEmpty) toggleType(sgKey); }}
                                  className={`flex items-center gap-1 w-full px-2 py-1 text-[11px] font-medium rounded text-muted-foreground ${isEmpty ? "opacity-50 cursor-default" : "hover:bg-accent/50"}`}
                                >
                                  {isEmpty ? (
                                    <span className="h-2.5 w-2.5 inline-block" />
                                  ) : sgExpanded ? (
                                    <ChevronDown className="h-2.5 w-2.5" />
                                  ) : (
                                    <ChevronRight className="h-2.5 w-2.5" />
                                  )}
                                  {sg}
                                  <Badge variant="outline" className="ml-auto text-[9px]">{sgPages.length}</Badge>
                                </button>
                                {sgExpanded && !isEmpty && (
                                  <div className="ml-4 space-y-0.5">
                                    {sgPages.map((ep) => (
                                      <button
                                        key={ep.page_id}
                                        onClick={() => {
                                          setSelectedEntityPage(ep);
                                          setSelectedPage(null);
                                          setViewTab("ai");
                                          setSidebarMode("ai");
                                          setRightPanelContext({ type: "entity_page", id: ep.page_id, title: ep.title });
                                          setRightPanelSources(sourceRefsForEntity(ep));
                                          setRightPanelRelated([]);
                                        }}
                                        className={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
                                          selectedEntityPage?.page_id === ep.page_id ? "bg-accent font-medium" : "hover:bg-accent/50"
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
                        </div>
                      )}
                    </div>
                  );
                }

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
                              setViewTab("ai");
                              setSidebarMode("ai");
                              setRightPanelContext({ type: "entity_page", id: ep.page_id, title: ep.title });
                              setRightPanelSources(sourceRefsForEntity(ep));
                              setRightPanelRelated([]);
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

      {/* Main content area + right panel */}
      <SplitLayout
        autoSaveId="kb-v3"
        mainContent={
        <div className="flex flex-col h-full">
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
                onItemClick={(refs) => setRightPanelSources(refs)}
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
                    <div className="space-y-3">
                      {linkedEntityPages.map((ep) => (
                        <Card
                          key={ep.page_id}
                          className="cursor-pointer hover:bg-accent/50 transition-colors"
                          onClick={() => {
                            setSelectedEntityPage(ep);
                            setViewTab("ai");
                            setRightPanelContext({
                              type: "entity_page",
                              id: ep.page_id,
                              title: ep.title,
                            });
                            setRightPanelSources(sourceRefsForEntity(ep));
                            setRightPanelRelated([]);
                          }}
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
        }
        rightPanel={
          <KB2RightPanel
            companySlug={companySlug}
            autoContext={rightPanelContext}
            sourceRefs={rightPanelSources}
            relatedEntityPages={rightPanelRelated}
            defaultTab="sources"
          />
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entity page detail view
// ---------------------------------------------------------------------------

function EntityPageView({
  companySlug,
  page,
  sourceRefs,
  onBack,
  onItemClick,
}: {
  companySlug: string;
  page: EntityPage;
  sourceRefs: { source_type: string; doc_id: string; title: string; section_heading?: string; excerpt: string }[];
  onBack?: () => void;
  onItemClick?: (refs: SourceRef[]) => void;
}) {
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [verifyFormKey, setVerifyFormKey] = useState<string | null>(null);
  const [verifyTitle, setVerifyTitle] = useState("");
  const [verifyDescription, setVerifyDescription] = useState("");
  const [verifyReviewer, setVerifyReviewer] = useState("");
  const [peopleList, setPeopleList] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    fetch(`/api/${companySlug}/kb2?type=people`)
      .then((r) => r.json())
      .then((data) => {
        const raw = data.people ?? [];
        setPeopleList(raw.map((p: any) => ({
          id: p.person_id ?? p.id ?? p.node_id ?? "",
          name: p.display_name ?? p.name ?? "",
        })).filter((p: any) => p.name));
      })
      .catch(() => {});
  }, [companySlug]);

  const handleAddToVerify = async (sectionName: string, itemText: string) => {
    if (!verifyReviewer) return;
    await fetch(`/api/${companySlug}/kb2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        card: {
          card_type: "edit_proposal",
          title: verifyTitle || `Review: ${page.title} — ${sectionName}`,
          description: verifyDescription || `Item: "${itemText}"`,
          severity: "S3",
          assigned_to: [verifyReviewer],
          page_occurrences: [{ page_id: page.page_id, page_type: "entity", page_title: page.title, section: sectionName }],
          source_refs: [],
        },
      }),
    });
    setVerifyFormKey(null);
    setVerifyTitle("");
    setVerifyDescription("");
    setVerifyReviewer("");
  };

  const visibleSections = page.sections.filter(
    (s) => s.requirement === "MUST" || s.items.length > 0
  );

  return (
    <ScrollArea className="h-full">
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
        {visibleSections.map((section) => {
          const si = page.sections.indexOf(section);
          return (
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
                    const showVerifyForm = verifyFormKey === itemKey;
                    return (
                      <li key={idx} className="text-sm">
                        <div
                          className={`group flex items-start gap-2 px-2 py-1.5 rounded transition-colors ${
                            isSelected
                              ? "bg-primary/10 ring-1 ring-primary/30"
                              : "cursor-pointer hover:bg-accent/40"
                          }`}
                          onClick={() => {
                            if (!showVerifyForm) {
                              setSelectedItemKey(itemKey);
                              if (item.source_refs) onItemClick?.(item.source_refs);
                            }
                          }}
                        >
                          {hasItemSources && (
                            <FileText className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                          )}
                          <span className="flex-1">{item.text}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            <Badge
                              variant={
                                item.confidence === "low"
                                  ? "destructive"
                                  : item.confidence === "medium"
                                    ? "secondary"
                                    : "default"
                              }
                              className="text-[9px]"
                            >
                              {item.confidence}
                            </Badge>
                            {isSelected && !showVerifyForm && (
                              <button
                                className="transition-opacity"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setVerifyFormKey(itemKey);
                                  setVerifyTitle("");
                                  setVerifyDescription("");
                                }}
                                title="Edit in Verify"
                              >
                                <Edit3 className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                              </button>
                            )}
                          </div>
                        </div>
                        {showVerifyForm && (
                          <div className="mt-2 ml-6 space-y-2 p-2 bg-muted/30 rounded border" onClick={(e) => e.stopPropagation()}>
                            <div>
                              <label className="text-[10px] font-medium text-muted-foreground mb-1 block">Reviewer *</label>
                              <Select value={verifyReviewer} onValueChange={setVerifyReviewer}>
                                <SelectTrigger className="h-8 text-xs">
                                  <SelectValue placeholder="Select reviewer..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {peopleList.map((p) => (
                                    <SelectItem key={p.id || p.name} value={p.name}>{p.name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <Input
                              placeholder="Title (optional)"
                              value={verifyTitle}
                              onChange={(e) => setVerifyTitle(e.target.value)}
                              className="text-sm h-8"
                            />
                            <Textarea
                              placeholder="Describe what should change..."
                              value={verifyDescription}
                              onChange={(e) => setVerifyDescription(e.target.value)}
                              className="text-sm min-h-[60px]"
                            />
                            <div className="flex gap-1.5 items-center">
                              <Button size="sm" className="h-6 text-[11px] px-2" disabled={!verifyReviewer} onClick={() => handleAddToVerify(section.section_name, item.text)}>
                                Add to Verify
                              </Button>
                              <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={() => { setVerifyFormKey(null); setVerifyTitle(""); setVerifyDescription(""); setVerifyReviewer(""); }}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
