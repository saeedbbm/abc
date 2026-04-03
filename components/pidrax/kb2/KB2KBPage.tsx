"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { LeftSidebarLayout } from "./LeftSidebarLayout";

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

interface HumanSidebarCategoryGroup {
  key: string;
  label: string;
  humanPages: HumanPage[];
  feedbackEntityPages: EntityPage[];
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

const ENTITY_GROUPS: { label: string; types: string[] }[] = [
  { label: "People & Teams", types: ["team_member", "team", "client_company", "client_person"] },
  { label: "Projects & Work", types: ["project", "ticket", "pull_request", "pipeline"] },
  { label: "Decisions & Patterns", types: ["decision", "process"] },
  { label: "Systems & Infrastructure", types: ["repository", "integration", "infrastructure", "cloud_resource", "library", "database", "environment"] },
  { label: "Customer Feedback", types: ["customer_feedback"] },
];

const HUMAN_FEEDBACK_CATEGORY_KEY = "customer_feedback";
const HUMAN_FEEDBACK_CATEGORY_LABEL = "Customer Feedback";
const STANDALONE_HUMAN_FEEDBACK_GROUP_KEY = `standalone:${HUMAN_FEEDBACK_CATEGORY_KEY}`;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function KB2KBPage({ companySlug }: { companySlug: string }) {
  const [humanPages, setHumanPages] = useState<HumanPage[]>([]);
  const [entityPages, setEntityPages] = useState<EntityPage[]>([]);
  const [selectedPage, setSelectedPage] = useState<HumanPage | null>(null);
  const [selectedEntityPage, setSelectedEntityPage] =
    useState<EntityPage | null>(null);
  const [selectedHumanParagraphKey, setSelectedHumanParagraphKey] = useState<string | null>(null);
  const [layerOrder, setLayerOrder] = useState<string[]>(DEFAULT_LAYER_ORDER);
  const [expandedLayers, setExpandedLayers] = useState<Set<string>>(
    new Set(DEFAULT_LAYER_ORDER)
  );
  const [expandedHumanCategories, setExpandedHumanCategories] = useState<Set<string>>(
    new Set([STANDALONE_HUMAN_FEEDBACK_GROUP_KEY])
  );
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
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

    const baseHumanPages = hData.pages ?? [];
    const entityPages = eData.pages ?? [];
    const nodeMap: typeof graphNodes = {};
    for (const n of nData.nodes ?? []) {
      nodeMap[n.node_id] = { display_name: n.display_name, type: n.type, truth_status: n.truth_status, attributes: n.attributes, source_refs: n.source_refs ?? [] };
    }

    const feedbackHumanPages = await Promise.all(
      entityPages
        .filter((ep) => ep.node_type === HUMAN_FEEDBACK_CATEGORY_KEY)
        .map(async (ep) => {
          const primarySource = nodeMap[ep.node_id]?.source_refs?.[0];
          let content = primarySource?.excerpt ?? "";

          if (primarySource?.doc_id) {
            try {
              const params = new URLSearchParams({
                type: "parsed_doc",
                doc_id: primarySource.doc_id,
              });
              if (primarySource.source_type) {
                params.set("source_type", primarySource.source_type);
              }
              const response = await fetch(`/api/${companySlug}/kb2?${params.toString()}`);
              if (response.ok) {
                const data = await response.json();
                const parsedContent = getParsedDocContent(data.document);
                if (parsedContent) content = parsedContent;
              }
            } catch {
              // Fall back to the stored excerpt below.
            }
          }

          const parsed = parseFeedbackDocument(content, ep.title);
          const normalizedBody = (parsed.body || content)
            .replace(/\s*\n\s*/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          return {
            page_id: `customer-feedback:${ep.page_id}`,
            title: parsed.title || ep.title,
            layer: "company",
            category: HUMAN_FEEDBACK_CATEGORY_KEY,
            paragraphs: normalizedBody
              ? [{ heading: "", body: normalizedBody, entity_refs: [] }]
              : [],
            linked_entity_page_ids: [ep.page_id, ep.node_id],
          } satisfies HumanPage;
        }),
    );

    const humanPages = [...baseHumanPages, ...feedbackHumanPages];
    setHumanPages(humanPages);
    setEntityPages(entityPages);
    setGraphNodes(nodeMap);
    if (humanPages.length > 0) {
      const firstPage =
        baseHumanPages.find((page: HumanPage) => !isPlaceholderHumanPage(page))
        ?? humanPages.find((page: HumanPage) => !isPlaceholderHumanPage(page))
        ?? humanPages[0];
      setSelectedPage(firstPage);
      setRightPanelContext({
        type: "human_page",
        id: firstPage.page_id,
        title: firstPage.title,
      });
      setRightPanelSources([]);
      setRightPanelRelated([]);
      setSelectedHumanParagraphKey(null);
    } else {
      setSelectedPage(null);
      setSelectedEntityPage(null);
      setRightPanelContext(null);
      setRightPanelSources([]);
      setRightPanelRelated([]);
      setSelectedHumanParagraphKey(null);
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

  const toggleHumanCategory = (categoryKey: string) => {
    setExpandedHumanCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryKey)) next.delete(categoryKey);
      else next.add(categoryKey);
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
      acc[layer] = humanPages.filter(
        (p) => p.layer === layer && p.category !== HUMAN_FEEDBACK_CATEGORY_KEY,
      );
      return acc;
    },
    {} as Record<string, HumanPage[]>
  );

  const feedbackHumanPages = humanPages.filter(
    (page) => page.category === HUMAN_FEEDBACK_CATEGORY_KEY,
  );
  const humanSidebarGroupsByLayer = layerOrder.reduce(
    (acc, layer) => {
      const groups = new Map<string, HumanSidebarCategoryGroup>();

      for (const page of pagesByLayer[layer] ?? []) {
        const groupKey = page.category || page.page_id;
        const existing = groups.get(groupKey);
        if (existing) {
          existing.humanPages.push(page);
        } else {
          groups.set(groupKey, {
            key: groupKey,
            label: page.title,
            humanPages: [page],
            feedbackEntityPages: [],
          });
        }
      }

      acc[layer] = Array.from(groups.values());
      return acc;
    },
    {} as Record<string, HumanSidebarCategoryGroup[]>,
  );
  const standaloneHumanFeedbackGroup =
    feedbackHumanPages.length > 0
      ? {
          key: HUMAN_FEEDBACK_CATEGORY_KEY,
          label: HUMAN_FEEDBACK_CATEGORY_LABEL,
          humanPages: feedbackHumanPages,
          feedbackEntityPages: [],
        }
      : null;

  const linkedEntityPages = selectedPage
    ? entityPages.filter((ep) =>
        selectedPage.linked_entity_page_ids.includes(ep.page_id) ||
        selectedPage.linked_entity_page_ids.includes(ep.node_id)
      )
    : [];

  const buildRelatedEntityPage = (
    ep: EntityPage,
    options?: {
      highlightedSectionNames?: string[];
      highlightedItemTexts?: string[];
    },
  ): RelatedEntityPage => ({
    page_id: ep.page_id,
    title: ep.title,
    node_type: ep.node_type,
    highlighted_section_names: options?.highlightedSectionNames,
    highlighted_item_texts: options?.highlightedItemTexts,
    sections: ep.sections.map((section) => ({
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

  function entityPagesForHumanParagraph(
    page: HumanPage,
    paragraph: HumanPage["paragraphs"][number],
  ): EntityPage[] {
    const explicitRefs = paragraph.entity_refs
      .map((ref) => {
        const resolvedRef = resolveEntityRef(ref).toLowerCase();
        return entityPages.find((ep) =>
          ep.page_id === ref ||
          ep.node_id === ref ||
          ep.title.toLowerCase() === resolvedRef ||
          ep.title.toLowerCase().includes(resolvedRef) ||
          resolvedRef.includes(ep.title.toLowerCase())
        ) ?? null;
      })
      .filter((ep): ep is EntityPage => Boolean(ep));

    if (explicitRefs.length > 0) return explicitRefs;

    return entityPages.filter(
      (ep) =>
        page.linked_entity_page_ids.includes(ep.page_id) ||
        page.linked_entity_page_ids.includes(ep.node_id),
    );
  }

  function sourceRefsForHumanParagraph(
    page: HumanPage,
    paragraph: HumanPage["paragraphs"][number],
  ): SourceRef[] {
    const refs: SourceRef[] = [];
    const seen = new Set<string>();
    for (const ep of entityPagesForHumanParagraph(page, paragraph)) {
      for (const ref of graphNodes[ep.node_id]?.source_refs ?? []) {
        const nextRef: SourceRef = {
          source_type: ref.source_type,
          doc_id: ref.doc_id,
          title: ref.title,
          excerpt: ref.excerpt,
          section_heading: ref.section_heading,
        };
        const key = `${nextRef.source_type}::${nextRef.doc_id}::${nextRef.title}::${nextRef.section_heading ?? ""}::${nextRef.excerpt ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(nextRef);
      }
    }
    return refs;
  }

  function relatedPagesForHumanParagraph(
    page: HumanPage,
    paragraph: HumanPage["paragraphs"][number],
  ): RelatedEntityPage[] {
    return mergeRelatedEntityPages(
      entityPagesForHumanParagraph(page, paragraph).map((ep) =>
        buildRelatedEntityPage(ep, {
          highlightedSectionNames: paragraph.heading ? [paragraph.heading] : [],
          highlightedItemTexts: paragraph.body ? [paragraph.body] : [],
        }),
      ),
    );
  }

  const selectHumanParagraph = (
    page: HumanPage,
    paragraph: HumanPage["paragraphs"][number],
    paragraphKey: string,
  ) => {
    setSelectedHumanParagraphKey(paragraphKey);
    setRightPanelSources(sourceRefsForHumanParagraph(page, paragraph));
    setRightPanelRelated(relatedPagesForHumanParagraph(page, paragraph));
  };

  const selectHumanSidebarPage = (page: HumanPage) => {
    setSelectedPage(page);
    setSelectedEntityPage(null);
    setSelectedHumanParagraphKey(null);
    setRightPanelContext({ type: "human_page", id: page.page_id, title: page.title });
    setRightPanelSources([]);
    setRightPanelRelated([]);
  };

  const renderHumanSidebarGroup = (
    group: HumanSidebarCategoryGroup,
    groupKey: string,
  ) => {
    const itemCount = group.humanPages.length + group.feedbackEntityPages.length;
    const isGroupExpanded = expandedHumanCategories.has(groupKey);
    const shouldNest =
      group.feedbackEntityPages.length > 0 || group.humanPages.length > 1;

    if (!shouldNest && group.humanPages.length === 1) {
      const page = group.humanPages[0];
      return (
        <button
          key={page.page_id}
          onClick={() => selectHumanSidebarPage(page)}
          className={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
            selectedPage?.page_id === page.page_id
              ? "bg-accent font-medium"
              : "hover:bg-accent/50"
          }`}
        >
          {page.title}
        </button>
      );
    }

    return (
      <div key={groupKey} className="mb-0.5">
        <button
          onClick={() => toggleHumanCategory(groupKey)}
          className="flex items-center gap-1 w-full px-2 py-1 text-[11px] font-medium rounded text-muted-foreground hover:bg-accent/50"
        >
          {isGroupExpanded ? (
            <ChevronDown className="h-2.5 w-2.5" />
          ) : (
            <ChevronRight className="h-2.5 w-2.5" />
          )}
          {group.label}
          <Badge variant="outline" className="ml-auto text-[9px]">
            {itemCount}
          </Badge>
        </button>
        {isGroupExpanded && (
          <div className="ml-4 space-y-0.5">
            {group.humanPages.map((page) => (
              <button
                key={page.page_id}
                onClick={() => selectHumanSidebarPage(page)}
                className={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
                  selectedPage?.page_id === page.page_id
                    ? "bg-accent font-medium"
                    : "hover:bg-accent/50"
                }`}
              >
                {page.title}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const navigateToEntity = (refText: string) => {
    const ep = entityPages.find((e) =>
      e.title.toLowerCase().includes(refText.toLowerCase()),
    ) ?? entityPages.find((e) =>
      e.page_id === refText || e.node_id === refText,
    );
    if (ep) {
      setSelectedHumanParagraphKey(null);
      setSelectedEntityPage(ep);
      setRightPanelContext({ type: "entity_page", id: ep.page_id, title: ep.title });
      setRightPanelSources([]);
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

  const highlightEntityRefs = (text: string, resolvedRefs: string[]) => {
    if (resolvedRefs.length === 0) return <>{text}</>;
    const escaped = resolvedRefs.map((r) =>
      r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    );
    const regex = new RegExp(`(${escaped.join("|")})`, "gi");
    const parts = text.split(regex);
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
                onClick={(e) => {
                  e.stopPropagation();
                  navigateToEntity(part);
                }}
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

  const renderInlineFormattedText = (text: string, resolvedRefs: string[]) => {
    const parts = text.split(/(\*\*[^*]+\*\*|__[^_]+__)/g);
    return (
      <>
        {parts.map((part, i) => {
          const isBold =
            (part.startsWith("**") && part.endsWith("**")) ||
            (part.startsWith("__") && part.endsWith("__"));
          if (!isBold) {
            return <span key={i}>{highlightEntityRefs(part, resolvedRefs)}</span>;
          }
          const inner = part.slice(2, -2);
          return <strong key={i}>{highlightEntityRefs(inner, resolvedRefs)}</strong>;
        })}
      </>
    );
  };

  const BULLET_RE = /^[\s]*[-•*]\s+/;

  const renderStructuredBody = (body: string, entityRefs: string[]) => {
    const resolvedRefs = entityRefs.map(resolveEntityRef).filter((r) => r.length > 1);
    const lines = body.split("\n");
    const blocks: Array<{ type: "text"; content: string } | { type: "list"; items: string[] }> = [];
    let currentList: string[] | null = null;

    for (const line of lines) {
      if (BULLET_RE.test(line)) {
        if (!currentList) currentList = [];
        currentList.push(line.replace(BULLET_RE, "").trim());
      } else {
        if (currentList) {
          blocks.push({ type: "list", items: currentList });
          currentList = null;
        }
        const trimmed = line.trim();
        if (trimmed) blocks.push({ type: "text", content: trimmed });
      }
    }
    if (currentList) blocks.push({ type: "list", items: currentList });

    return (
      <>
        {blocks.map((block, i) =>
          block.type === "list" ? (
            <ul key={i} className="list-disc pl-5 space-y-1 text-sm leading-relaxed my-2">
              {block.items.map((item, j) => (
                <li key={j}>{renderInlineFormattedText(item, resolvedRefs)}</li>
              ))}
            </ul>
          ) : (
            <p key={i} className="text-sm leading-relaxed">
              {renderInlineFormattedText(block.content, resolvedRefs)}
            </p>
          )
        )}
      </>
    );
  };

  return (
    <LeftSidebarLayout
      autoSaveId="kb-left"
      leftSidebar={
        <div className="h-full border-r flex flex-col">
          <div className="p-4 border-b">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">Docs</h2>
              <div className="ml-auto flex rounded-md border text-[10px] overflow-hidden">
                <button
                  onClick={() => {
                    setSidebarMode("human");
                    const page = selectedPage ?? humanPages[0];
                    setSelectedEntityPage(null);
                    setSelectedHumanParagraphKey(null);
                    if (page) {
                      setSelectedPage(page);
                      setRightPanelContext({
                        type: "human_page",
                        id: page.page_id,
                        title: page.title,
                      });
                      setRightPanelSources([]);
                      setRightPanelRelated([]);
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
                      setSelectedHumanParagraphKey(null);
                      setSelectedEntityPage(ep);
                      setSelectedPage(null);
                      setRightPanelContext({
                        type: "entity_page",
                        id: ep.page_id,
                        title: ep.title,
                      });
                      setRightPanelSources([]);
                      setRightPanelRelated([]);
                    } else {
                      setSelectedHumanParagraphKey(null);
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
                {standaloneHumanFeedbackGroup && (
                  <div className="mb-2">
                    {renderHumanSidebarGroup(
                      standaloneHumanFeedbackGroup,
                      STANDALONE_HUMAN_FEEDBACK_GROUP_KEY,
                    )}
                  </div>
                )}
                {layerOrder.map((layer) => {
                  const groups = humanSidebarGroupsByLayer[layer] ?? [];
                  const isExpanded = expandedLayers.has(layer);
                  const visibleItemCount = groups.reduce(
                    (count, group) => count + group.humanPages.length + group.feedbackEntityPages.length,
                    0,
                  );
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
                        {visibleItemCount > 0 && (
                          <Badge variant="secondary" className="ml-auto text-[10px]">
                            {visibleItemCount}
                          </Badge>
                        )}
                      </button>
                      {isExpanded && (
                        <div className="ml-4 space-y-0.5">
                          {groups.length === 0 ? (
                            <div className="text-[10px] text-muted-foreground px-2 py-1">
                              No pages yet
                            </div>
                          ) : (
                            groups.map((group) =>
                              renderHumanSidebarGroup(group, `${layer}:${group.key}`),
                            )
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            ) : (
              <>
                {ENTITY_GROUPS.map((group) => {
                  const groupPages = group.types.flatMap((t) => entityPagesByType[t] ?? []);
                  if (groupPages.length === 0) return null;
                  const groupKey = `group_${group.label}`;
                  const isGroupExpanded = expandedTypes.has(groupKey);

                  return (
                    <div key={group.label} className="mb-1">
                      <button
                        onClick={() => toggleType(groupKey)}
                        className="flex items-center gap-1 w-full px-2 py-1.5 text-xs font-medium rounded hover:bg-accent"
                      >
                        {isGroupExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {group.label}
                        <Badge variant="secondary" className="ml-auto text-[10px]">{groupPages.length}</Badge>
                      </button>
                      {isGroupExpanded && (
                        <div className="ml-4 space-y-0.5">
                          {group.types.map((t) => {
                            const pages = entityPagesByType[t] ?? [];
                            if (pages.length === 0) return null;
                            const isTypeExpanded = expandedTypes.has(t);

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
                                <div key={t} className="mb-0.5">
                                  <button
                                    onClick={() => toggleType(t)}
                                    className="flex items-center gap-1 w-full px-2 py-1 text-[11px] font-medium rounded text-muted-foreground hover:bg-accent/50"
                                  >
                                    {isTypeExpanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
                                    {ENTITY_TYPE_LABELS[t] ?? t}
                                    <Badge variant="outline" className="ml-auto text-[9px]">{pages.length}</Badge>
                                  </button>
                                  {isTypeExpanded && (
                                    <div className="ml-4 space-y-0.5">
                                      {PROJECT_SUB_GROUPS.map((sg) => {
                                        const sgPages = subGroups[sg];
                                        if (sgPages.length === 0) return null;
                                        const sgKey = `project_${sg}`;
                                        const sgExpanded = expandedTypes.has(sgKey);
                                        return (
                                          <div key={sg}>
                                            <button
                                              onClick={() => toggleType(sgKey)}
                                              className="flex items-center gap-1 w-full px-2 py-1 text-[11px] font-medium rounded text-muted-foreground hover:bg-accent/50"
                                            >
                                              {sgExpanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
                                              {sg}
                                              <Badge variant="outline" className="ml-auto text-[9px]">{sgPages.length}</Badge>
                                            </button>
                                            {sgExpanded && (
                                              <div className="ml-4 space-y-0.5">
                                                {sgPages.map((ep) => (
                                                  <button
                                                    key={ep.page_id}
                                                    onClick={() => {
                                                      setSelectedHumanParagraphKey(null);
                                                      setSelectedEntityPage(ep);
                                                      setSelectedPage(null);
                                                      setSidebarMode("ai");
                                                      setRightPanelContext({ type: "entity_page", id: ep.page_id, title: ep.title });
                                                      setRightPanelSources([]);
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

                            if (group.types.length === 1 || pages.length <= 5) {
                              return pages.map((ep) => (
                                <button
                                  key={ep.page_id}
                                  onClick={() => {
                                    setSelectedHumanParagraphKey(null);
                                    setSelectedEntityPage(ep);
                                    setSelectedPage(null);
                                    setSidebarMode("ai");
                                    setRightPanelContext({ type: "entity_page", id: ep.page_id, title: ep.title });
                                    setRightPanelSources([]);
                                    setRightPanelRelated([]);
                                  }}
                                  className={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
                                    selectedEntityPage?.page_id === ep.page_id ? "bg-accent font-medium" : "hover:bg-accent/50"
                                  }`}
                                >
                                  {ep.title}
                                </button>
                              ));
                            }

                            return (
                              <div key={t} className="mb-0.5">
                                <button
                                  onClick={() => toggleType(t)}
                                  className="flex items-center gap-1 w-full px-2 py-1 text-[11px] font-medium rounded text-muted-foreground hover:bg-accent/50"
                                >
                                  {isTypeExpanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
                                  {ENTITY_TYPE_LABELS[t] ?? t}
                                  <Badge variant="outline" className="ml-auto text-[9px]">{pages.length}</Badge>
                                </button>
                                {isTypeExpanded && (
                                  <div className="ml-4 space-y-0.5">
                                    {pages.map((ep) => (
                                      <button
                                        key={ep.page_id}
                                        onClick={() => {
                                          setSelectedHumanParagraphKey(null);
                                          setSelectedEntityPage(ep);
                                          setSelectedPage(null);
                                          setSidebarMode("ai");
                                          setRightPanelContext({ type: "entity_page", id: ep.page_id, title: ep.title });
                                          setRightPanelSources([]);
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
                })}
              </>
            )}
          </ScrollArea>
        </div>
      }
      mainContent={
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
                      onBack={sidebarMode === "ai" ? undefined : () => {
                        setSelectedEntityPage(null);
                        setSelectedHumanParagraphKey(null);
                        if (selectedPage) {
                          setRightPanelContext({
                            type: "human_page",
                            id: selectedPage.page_id,
                            title: selectedPage.title,
                          });
                          setRightPanelSources([]);
                          setRightPanelRelated([]);
                        }
                      }}
                      onItemClick={(selection) => {
                        setRightPanelSources(selection.sourceRefs);
                        setRightPanelRelated(selection.relatedPages);
                      }}
                    />
                  </div>
                ) : (
                  <ScrollArea className="flex-1 p-6">
                    <div className="mb-6">
                      <h1 className="text-lg font-semibold">{selectedPage?.title}</h1>
                    </div>
                    {!selectedPage?.paragraphs.length ? (
                      <p className="text-xs text-muted-foreground italic">
                        No content yet
                      </p>
                    ) : (
                      selectedPage.paragraphs.map((para, pi) => (
                        <div
                          key={pi}
                          className={`mb-6 cursor-pointer rounded-md px-2 py-2 transition-colors ${
                            selectedHumanParagraphKey === `${selectedPage.page_id}:${pi}`
                              ? "bg-primary/5 ring-1 ring-primary/20"
                              : "hover:bg-accent/30"
                          }`}
                          onClick={() =>
                            selectedPage &&
                            selectHumanParagraph(
                              selectedPage,
                              para,
                              `${selectedPage.page_id}:${pi}`,
                            )
                          }
                        >
                          {para.heading && (
                            <h2 className="text-sm font-semibold mb-2 border-b pb-1">
                              {para.heading}
                            </h2>
                          )}
                          {renderStructuredBody(para.body, para.entity_refs)}
                          {para.entity_refs.length > 0 && (
                            <div className="flex gap-1 mt-2 flex-wrap">
                              {para.entity_refs.map((ref, ri) => {
                                const displayName = resolveEntityRef(ref);
                                return (
                                  <Badge
                                    key={ri}
                                    variant="outline"
                                    className="text-[10px] cursor-pointer hover:bg-accent"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigateToEntity(ref);
                                    }}
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
                  </ScrollArea>
                )
              ) : (
                <div className="flex items-center justify-center flex-1">
                  <p className="text-muted-foreground">
                    {sidebarMode === "human"
                      ? humanPages.length === 0
                        ? "No docs pages yet. Run the pipeline from KB Admin."
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
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Entity page detail view
// ---------------------------------------------------------------------------

function getParsedDocContent(document: any): string {
  const rawContent = typeof document?.content === "string" ? document.content.trim() : "";
  if (rawContent) return rawContent;
  if (!Array.isArray(document?.sections) || document.sections.length === 0) return "";
  return document.sections
    .map((section: { heading?: string; content?: string }) =>
      section.heading ? `## ${section.heading}\n${section.content ?? ""}` : section.content ?? "",
    )
    .join("\n\n")
    .trim();
}

function parseFeedbackDocument(
  content: string,
  fallbackTitle: string,
): { title: string; meta: string; body: string } {
  const trimmed = content.trim();
  if (!trimmed) {
    return { title: fallbackTitle, meta: "", body: "" };
  }

  let title = fallbackTitle;
  let remaining = trimmed;

  const headingMatch = remaining.match(/^#\s+([^\n]+)\r?\n+/);
  if (headingMatch) {
    title = headingMatch[1].trim() || fallbackTitle;
    remaining = remaining.slice(headingMatch[0].length).trim();
  }

  let meta = "";
  const lines = remaining.split(/\r?\n/);
  if (lines[0]?.trim().startsWith("From:")) {
    meta = lines[0].trim();
    remaining = lines.slice(1).join("\n").trim();
  }

  return {
    title,
    meta,
    body: remaining || trimmed,
  };
}

function EntityPageView({
  companySlug,
  page,
  onBack,
  onItemClick,
}: {
  companySlug: string;
  page: EntityPage;
  onBack?: () => void;
  onItemClick?: (selection: {
    sourceRefs: SourceRef[];
    relatedPages: RelatedEntityPage[];
  }) => void;
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

  useEffect(() => {
    setSelectedItemKey(null);
    setVerifyFormKey(null);
  }, [page.page_id]);

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
    (s) => s.items.length > 0
  );

  return (
    <ScrollArea className="h-full">
      <div className="max-w-3xl mx-auto p-6">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="mb-4">
            &larr; Back to human view
          </Button>
        )}
        <div className="flex items-center gap-2 mb-6">
          <h2 className="text-lg font-semibold flex-1">{page.title}</h2>
          <Badge variant="outline" className="shrink-0">
            {page.node_type}
          </Badge>
        </div>
        {visibleSections.map((section) => {
          return (
            <div key={section.section_name} className="mb-4 rounded-md border border-border">
              <div className="flex items-center gap-2 p-3 border-b bg-muted/20">
                <h3 className="text-sm font-semibold flex-1">{section.section_name}</h3>
                <Badge
                  variant={section.requirement === "MUST" ? "default" : "secondary"}
                  className="text-[9px] shrink-0"
                >
                  {section.requirement}
                </Badge>
              </div>
              {section.items.length > 0 && (
                <ul className="space-y-1 p-3">
                  {section.items.map((item, idx) => {
                    const itemKey = `${section.section_name}-${idx}`;
                    const hasItemSources = (item.source_refs ?? []).length > 0;
                    const isSelected = selectedItemKey === itemKey;
                    const showVerifyForm = verifyFormKey === itemKey;
                    return (
                      <li key={idx} className="text-sm">
                        <div
                          className={`group flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors ${
                            isSelected
                              ? "bg-primary/10 ring-1 ring-primary/30"
                              : "cursor-pointer hover:bg-muted/60"
                          }`}
                          onClick={() => {
                            if (!showVerifyForm) {
                              setSelectedItemKey(itemKey);
                              onItemClick?.({
                                sourceRefs: (item.source_refs ?? []).map((ref) => ({
                                  source_type: ref.source_type,
                                  doc_id: ref.doc_id,
                                  title: ref.title,
                                  section_heading: ref.section_heading,
                                  excerpt: ref.excerpt,
                                })),
                                relatedPages: [
                                  {
                                    page_id: page.page_id,
                                    title: page.title,
                                    node_type: page.node_type,
                                    highlighted_section_names: [section.section_name],
                                    highlighted_item_texts: [item.text],
                                    sections: page.sections.map((pageSection) => ({
                                      section_name: pageSection.section_name,
                                      items: pageSection.items.map((pageItem) => ({
                                        text: pageItem.text,
                                        confidence: pageItem.confidence,
                                      })),
                                    })),
                                  },
                                ],
                              });
                            }
                          }}
                        >
                          {hasItemSources && (
                            <FileText className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                          )}
                          <span
                            className="flex-1 text-sm leading-relaxed"
                            title={item.confidence !== "high" ? `Confidence: ${item.confidence}` : undefined}
                          >
                            {item.text}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
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
                          <div
                            className="mt-2 ml-6 space-y-2 p-3 bg-muted/30 rounded-md border"
                            onClick={(e) => e.stopPropagation()}
                          >
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
