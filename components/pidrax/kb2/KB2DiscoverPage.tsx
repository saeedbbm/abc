"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageSquareQuote, Lightbulb, Eye } from "lucide-react";
import { KB2RightPanel, SourceRef, RelatedEntityPage } from "./KB2RightPanel";
import { SplitLayout } from "./SplitLayout";

interface GraphNode {
  node_id: string;
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

type GraphSourceRef = GraphNode["source_refs"][number];

interface EntityPage {
  page_id: string;
  node_id: string;
  title: string;
  node_type: string;
  sections: {
    section_name: string;
    items: { text: string; confidence: string }[];
  }[];
}

function getSourceRefCacheKey(ref?: GraphSourceRef | null): string | null {
  if (!ref?.doc_id) return null;
  return `${ref.source_type ?? ""}:${ref.doc_id}`;
}

function getParsedDocContent(document: any): string | null {
  const rawContent = typeof document?.content === "string" ? document.content.trim() : "";
  if (rawContent) return rawContent;
  if (!Array.isArray(document?.sections) || document.sections.length === 0) return null;
  const sectionContent = document.sections
    .map((section: { heading?: string; content?: string }) =>
      section.heading ? `## ${section.heading}\n${section.content ?? ""}` : section.content ?? "",
    )
    .join("\n\n")
    .trim();
  return sectionContent || null;
}

function stripDuplicateHeading(content: string, titles: Array<string | undefined>): string {
  const trimmed = content.trim();
  const headingMatch = trimmed.match(/^#\s+([^\n]+)\r?\n+/);
  if (!headingMatch) return trimmed;

  const heading = headingMatch[1].trim().toLowerCase();
  const hasMatchingTitle = titles.some((title) => title?.trim().toLowerCase() === heading);
  if (!hasMatchingTitle) return trimmed;

  return trimmed.slice(headingMatch[0].length).trim();
}

export function KB2DiscoverPage({ companySlug }: { companySlug: string }) {
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [entityPages, setEntityPages] = useState<EntityPage[]>([]);
  const [sourceRefs, setSourceRefs] = useState<SourceRef[]>([]);
  const [relatedPages, setRelatedPages] = useState<RelatedEntityPage[]>([]);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [fullFeedbackDocs, setFullFeedbackDocs] = useState<Record<string, string | null>>({});
  const fetchedFeedbackDocsRef = useRef<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    const [nRes, epRes] = await Promise.all([
      fetch(`/api/${companySlug}/kb2?type=graph_nodes`),
      fetch(`/api/${companySlug}/kb2?type=entity_pages`),
    ]);
    const nData = await nRes.json();
    const epData = await epRes.json();
    setGraphNodes(nData.nodes ?? []);
    setEntityPages(epData.pages ?? []);
  }, [companySlug]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchedFeedbackDocsRef.current.clear();
    setFullFeedbackDocs({});
  }, [companySlug]);

  const feedbackNodes = graphNodes.filter((n) => n.type === "customer_feedback");
  const proposedProjects = graphNodes.filter((n) => {
    if (n.type !== "project") return false;
    const status = (n.attributes?.status ?? "").toLowerCase();
    const disc = (n.attributes?.discovery_category ?? "").toLowerCase();
    return status === "proposed" || status === "planned" || disc.includes("proposed");
  });
  const conventionNodes = graphNodes.filter((n) => {
    if (n.type !== "decision") return false;
    const attrs = n.attributes ?? {};
    return attrs.is_convention === true || attrs.decision_type === "convention" || (n.display_name ?? "").toLowerCase().includes("convention");
  });

  useEffect(() => {
    const refsToFetch = Array.from(new Map(
      feedbackNodes
        .map((node) => node.source_refs?.[0])
        .filter((ref): ref is GraphSourceRef => Boolean(ref?.doc_id))
        .map((ref) => [getSourceRefCacheKey(ref) ?? "", ref]),
    ).values()).filter((ref) => {
      const key = getSourceRefCacheKey(ref);
      if (!key || fetchedFeedbackDocsRef.current.has(key)) return false;
      fetchedFeedbackDocsRef.current.add(key);
      return true;
    });

    if (refsToFetch.length === 0) return;

    let cancelled = false;

    const fetchFullFeedbackDocs = async () => {
      const results = await Promise.all(
        refsToFetch.map(async (ref) => {
          const key = getSourceRefCacheKey(ref);
          if (!key) return null;

          try {
            const params = new URLSearchParams({ type: "parsed_doc", doc_id: ref.doc_id });
            if (ref.source_type) params.set("source_type", ref.source_type);
            const response = await fetch(`/api/${companySlug}/kb2?${params.toString()}`);
            if (!response.ok) return { key, content: null };

            const data = await response.json();
            return { key, content: getParsedDocContent(data.document) };
          } catch {
            return { key, content: null };
          }
        }),
      );

      if (cancelled) return;

      setFullFeedbackDocs((prev) => {
        const next = { ...prev };
        for (const result of results) {
          if (!result) continue;
          next[result.key] = result.content;
        }
        return next;
      });
    };

    void fetchFullFeedbackDocs();

    return () => {
      cancelled = true;
    };
  }, [companySlug, feedbackNodes]);

  const handleSelectNode = (node: GraphNode) => {
    setSelectedLabel(node.display_name);
    const refs: SourceRef[] = (node.source_refs ?? []).map((r) => ({
      source_type: r.source_type,
      doc_id: r.doc_id,
      title: r.title,
      excerpt: r.excerpt,
      section_heading: r.section_heading,
    }));
    setSourceRefs(refs);

    const ep = entityPages.find((p) => p.node_id === node.node_id);
    if (ep) {
      setRelatedPages([{
        page_id: ep.page_id,
        title: ep.title,
        node_type: ep.node_type,
        sections: ep.sections.map((s) => ({
          section_name: s.section_name,
          items: s.items.map((i) => ({ text: i.text, confidence: i.confidence })),
        })),
      }]);
    } else {
      setRelatedPages([]);
    }
  };

  return (
    <SplitLayout
      autoSaveId="discover"
      mainContent={
        <ScrollArea className="h-full">
          <div className="p-6 max-w-3xl mx-auto space-y-10">
            <div>
              <h1 className="text-xl font-semibold mb-1">Discover</h1>
              <p className="text-sm text-muted-foreground">
                Customer signals, proposed work, and hidden patterns found across your company data.
              </p>
            </div>

            {/* Customer Feedback */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <MessageSquareQuote className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Customer Feedback
                </h2>
                {feedbackNodes.length > 0 && (
                  <Badge variant="secondary" className="text-[10px]">{feedbackNodes.length}</Badge>
                )}
              </div>
              {feedbackNodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No customer feedback discovered yet.</p>
              ) : (
                <div className="space-y-2">
                  {feedbackNodes.map((node) => {
                    const primarySourceRef = node.source_refs?.[0];
                    const excerpt = primarySourceRef?.excerpt;
                    const sourceType = primarySourceRef?.source_type;
                    const primarySourceKey = getSourceRefCacheKey(primarySourceRef);
                    const fullFeedback = primarySourceKey ? fullFeedbackDocs[primarySourceKey] : null;
                    const feedbackText = fullFeedback
                      ? stripDuplicateHeading(fullFeedback, [node.display_name, primarySourceRef?.title]) || excerpt
                      : excerpt;
                    return (
                      <Card
                        key={node.node_id}
                        className={`cursor-pointer transition-colors hover:bg-accent/30 ${
                          selectedLabel === node.display_name ? "ring-1 ring-primary/40 bg-accent/20" : ""
                        }`}
                        onClick={() => handleSelectNode(node)}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-start gap-3">
                            <div className="w-1 shrink-0 self-stretch rounded-full bg-muted-foreground/20" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium mb-1">{node.display_name}</p>
                              {feedbackText && (
                                <p
                                  className={`text-xs text-muted-foreground whitespace-pre-wrap break-words ${
                                    fullFeedback ? "" : "italic"
                                  }`}
                                >
                                  {feedbackText}
                                </p>
                              )}
                              <div className="flex gap-1.5 mt-2">
                                {sourceType && (
                                  <Badge variant="outline" className="text-[9px]">{sourceType}</Badge>
                                )}
                                {node.source_refs.length > 1 && (
                                  <Badge variant="secondary" className="text-[9px]">
                                    {node.source_refs.length} sources
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Proposed Projects */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Lightbulb className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Proposed Projects
                </h2>
                {proposedProjects.length > 0 && (
                  <Badge variant="secondary" className="text-[10px]">{proposedProjects.length}</Badge>
                )}
              </div>
              {proposedProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No proposed projects discovered yet.</p>
              ) : (
                <div className="space-y-2">
                  {proposedProjects.map((node) => {
                    const desc = node.attributes?.description ?? node.attributes?.summary ?? "";
                    return (
                      <Card
                        key={node.node_id}
                        className={`cursor-pointer transition-colors hover:bg-accent/30 ${
                          selectedLabel === node.display_name ? "ring-1 ring-primary/40 bg-accent/20" : ""
                        }`}
                        onClick={() => handleSelectNode(node)}
                      >
                        <CardContent className="p-4">
                          <p className="text-sm font-medium">{node.display_name}</p>
                          {desc && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{desc}</p>
                          )}
                          <div className="flex gap-1.5 mt-2">
                            <Badge variant="outline" className="text-[9px]">Proposed</Badge>
                            {node.source_refs.length > 0 && (
                              <Badge variant="secondary" className="text-[9px]">
                                {node.source_refs.length} source{node.source_refs.length !== 1 ? "s" : ""}
                              </Badge>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Hidden Patterns / Conventions */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Eye className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Hidden Patterns
                </h2>
                {conventionNodes.length > 0 && (
                  <Badge variant="secondary" className="text-[10px]">{conventionNodes.length}</Badge>
                )}
              </div>
              {conventionNodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No hidden conventions or patterns discovered yet.</p>
              ) : (
                <div className="space-y-2">
                  {conventionNodes.map((node) => {
                    const establishedBy = node.attributes?.established_by ?? node.attributes?.owner ?? "";
                    return (
                      <Card
                        key={node.node_id}
                        className={`cursor-pointer transition-colors hover:bg-accent/30 ${
                          selectedLabel === node.display_name ? "ring-1 ring-primary/40 bg-accent/20" : ""
                        }`}
                        onClick={() => handleSelectNode(node)}
                      >
                        <CardContent className="p-4">
                          <p className="text-sm font-medium">{node.display_name}</p>
                          <div className="flex gap-1.5 mt-2">
                            {establishedBy && (
                              <Badge variant="outline" className="text-[9px]">{establishedBy}</Badge>
                            )}
                            {node.source_refs.length > 0 && (
                              <Badge variant="secondary" className="text-[9px]">
                                {node.source_refs.length} source{node.source_refs.length !== 1 ? "s" : ""}
                              </Badge>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
      }
      rightPanel={
        <KB2RightPanel
          companySlug={companySlug}
          autoContext={selectedLabel ? { type: "entity_page", id: "", title: selectedLabel } : null}
          sourceRefs={sourceRefs}
          relatedEntityPages={relatedPages}
          defaultTab="sources"
        />
      }
    />
  );
}
