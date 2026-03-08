"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  MessageSquare,
  Send,
  Loader2,
  Sparkles,
  User,
  Bot,
  Search,
  FileText,
  Link2,
  ExternalLink,
  FolderKanban,
  TicketCheck,
} from "lucide-react";
import { KB2RightPanel, SourceRef } from "./KB2RightPanel";
import { SplitLayout } from "./SplitLayout";

interface HowtoSection {
  section_name: string;
  content: string;
}

interface Howto {
  howto_id: string;
  ticket_id: string;
  project_node_id?: string;
  title: string;
  sections: HowtoSection[];
  linked_entity_ids: string[];
  created_at: string;
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
  linked_entity_names: string[];
  labels: string[];
  created_at: string;
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
    items: { text: string; confidence: string }[];
  }[];
}

interface PersonNode {
  node_id: string;
  display_name: string;
}

type SidebarTab = "tickets" | "projects" | "howtos";

export function KB2HowtoPage({ companySlug }: { companySlug: string }) {
  const [howtos, setHowtos] = useState<Howto[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [projects, setProjects] = useState<ProjectNode[]>([]);
  const [entityPages, setEntityPages] = useState<EntityPage[]>([]);
  const [persons, setPersons] = useState<PersonNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [commentText, setCommentText] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("tickets");
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [ticketStatusFilter, setTicketStatusFilter] = useState<string>("all");
  const [projectStatusFilter, setProjectStatusFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"human" | "agent">("human");
  const [generating, setGenerating] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // When on tickets/projects tab and no howto exists, we track which item was clicked
  const [pendingTicketId, setPendingTicketId] = useState<string | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  const selected = howtos.find((h) => h.howto_id === selectedId) ?? null;

  const fetchData = useCallback(async () => {
    const [hRes, tRes, nRes, epRes] = await Promise.all([
      fetch(`/api/${companySlug}/kb2?type=howto`),
      fetch(`/api/${companySlug}/kb2?type=tickets`),
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
    setPersons(nodes.filter((n: any) => n.type === "team_member"));
  }, [companySlug]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSectionSave = async (sectionName: string, content: string) => {
    if (!selected) return;
    await fetch(`/api/${companySlug}/kb2?type=howto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
        howto_id: selected.howto_id,
        comment: commentText,
      }),
    });
    setCommentText("");
    await fetchData();
  };

  const handleGenerate = async (ticketId?: string, projectNodeId?: string) => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/${companySlug}/kb2/howto/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket_id: ticketId, project_node_id: projectNodeId }),
      });
      const data = await res.json();
      if (data.howto) {
        setPendingTicketId(null);
        setPendingProjectId(null);
        setSidebarTab("howtos");
        setSelectedId(data.howto.howto_id);
        await fetchData();
      }
    } finally {
      setGenerating(false);
    }
  };

  // Lookup maps
  const howtoByTicket = new Map<string, Howto>();
  const howtoByProject = new Map<string, Howto>();
  for (const h of howtos) {
    if (h.ticket_id) howtoByTicket.set(h.ticket_id, h);
    if (h.project_node_id) howtoByProject.set(h.project_node_id, h);
  }

  const ticketById = new Map(tickets.map((t) => [t.ticket_id, t]));
  const projectById = new Map(projects.map((p) => [p.node_id, p]));
  const entityPageByNodeId = new Map(entityPages.map((ep) => [ep.node_id, ep]));

  const classifyTicketStatus = (t: Ticket): string => {
    if (t.workflow_state === "done") return "past";
    if (t.source === "conversation" || t.source === "feedback") return "proposed";
    return "ongoing";
  };

  const classifyProjectStatus = (p: ProjectNode): string => {
    const disc = p.attributes?.discovery_category ?? "";
    const status = (p.attributes?.status ?? "").toLowerCase();
    const isDone = ["done", "completed", "closed", "past"].some((s) => status.includes(s));
    if (disc === "proposed_project") return "proposed";
    if (disc === "past_undocumented") return "past_undocumented";
    if (disc === "ongoing_undocumented") return "ongoing_undocumented";
    if (p.attributes?.truth_status === "inferred") return isDone ? "past_undocumented" : "ongoing_undocumented";
    return isDone ? "past_documented" : "ongoing_documented";
  };

  const filteredTickets = tickets.filter((t) => {
    if (personFilter !== "all" && !t.assignees.includes(personFilter)) return false;
    if (searchQuery && !t.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (ticketStatusFilter !== "all" && classifyTicketStatus(t) !== ticketStatusFilter) return false;
    return true;
  });

  const filteredProjects = projects.filter((p) => {
    if (searchQuery && !p.display_name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (projectStatusFilter !== "all" && classifyProjectStatus(p) !== projectStatusFilter) return false;
    return true;
  });

  const filteredHowtos = howtos.filter((h) => {
    if (searchQuery && !h.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const PRIORITY_COLORS: Record<string, string> = { P0: "bg-red-500", P1: "bg-orange-500", P2: "bg-yellow-500", P3: "bg-blue-500" };
  const agentSections = ["Prompt Section", "Implementation Steps", "Requirements", "Testing Plan"];

  const selectedProject = selected?.project_node_id
    ? projects.find((p) => p.node_id === selected.project_node_id)
    : null;
  const rightPanelSources: SourceRef[] = (selectedProject?.source_refs ?? []).map((ref) => ({
    source_type: ref.source_type,
    doc_id: ref.doc_id,
    title: ref.title,
    excerpt: ref.excerpt,
    section_heading: ref.section_heading,
  }));

  // For the "no howto yet" middle view
  const pendingTicket = pendingTicketId ? ticketById.get(pendingTicketId) : null;
  const pendingProject = pendingProjectId ? projectById.get(pendingProjectId) : null;

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
            <Link2 className="h-3.5 w-3.5" /> Linked Items
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3 space-y-2">
          {linkedTicket && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/50 text-sm">
              <TicketCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Badge className={`text-[8px] px-1 shrink-0 ${PRIORITY_COLORS[linkedTicket.priority] ?? ""}`}>
                {linkedTicket.priority}
              </Badge>
              <span className="truncate flex-1">{linkedTicket.title}</span>
              <button
                onClick={() => { setSidebarTab("tickets"); setPendingTicketId(linkedTicket.ticket_id); setSelectedId(null); }}
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
                onClick={() => { setSidebarTab("projects"); setPendingProjectId(linkedProject.node_id); setSelectedId(null); }}
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
  const sidebarList = (() => {
    switch (sidebarTab) {
      case "tickets":
        return filteredTickets.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">No tickets found.</p>
        ) : (
          filteredTickets.map((t) => {
            const howto = howtoByTicket.get(t.ticket_id);
            return (
              <button
                key={t.ticket_id}
                onClick={() => {
                  if (howto) {
                    setSelectedId(howto.howto_id);
                    setPendingTicketId(null);
                    setPendingProjectId(null);
                  } else {
                    setSelectedId(null);
                    setPendingTicketId(t.ticket_id);
                    setPendingProjectId(null);
                  }
                }}
                className={`w-full text-left px-2 py-1.5 rounded-md mb-1 text-xs transition-colors ${
                  (howto && selectedId === howto.howto_id) || pendingTicketId === t.ticket_id
                    ? "bg-accent"
                    : "hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Badge className={`text-[8px] px-1 ${PRIORITY_COLORS[t.priority] ?? ""}`}>
                    {t.priority}
                  </Badge>
                  <span className="truncate flex-1">{t.title}</span>
                  {howto && <Badge variant="secondary" className="text-[8px] shrink-0">📄</Badge>}
                </div>
                {t.assignees.length > 0 && (
                  <div className="text-[10px] text-muted-foreground mt-0.5 pl-7">
                    {t.assignees.join(", ")}
                  </div>
                )}
              </button>
            );
          })
        );

      case "projects":
        return filteredProjects.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">No projects found.</p>
        ) : (
          filteredProjects.map((p) => {
            const howto = howtoByProject.get(p.node_id);
            return (
              <button
                key={p.node_id}
                onClick={() => {
                  if (howto) {
                    setSelectedId(howto.howto_id);
                    setPendingTicketId(null);
                    setPendingProjectId(null);
                  } else {
                    setSelectedId(null);
                    setPendingTicketId(null);
                    setPendingProjectId(p.node_id);
                  }
                }}
                className={`w-full text-left px-2 py-1.5 rounded-md mb-1 text-xs transition-colors ${
                  (howto && selectedId === howto.howto_id) || pendingProjectId === p.node_id
                    ? "bg-accent"
                    : "hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[8px]">project</Badge>
                  <span className="truncate flex-1">{p.display_name}</span>
                  {howto && <Badge variant="secondary" className="text-[8px] shrink-0">📄</Badge>}
                </div>
              </button>
            );
          })
        );

      case "howtos":
        return filteredHowtos.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">No how-to guides yet.</p>
        ) : (
          filteredHowtos.map((h) => {
            const linkedTicket = h.ticket_id ? ticketById.get(h.ticket_id) : null;
            return (
              <button
                key={h.howto_id}
                onClick={() => {
                  setSelectedId(h.howto_id);
                  setPendingTicketId(null);
                  setPendingProjectId(null);
                }}
                className={`w-full text-left px-2 py-1.5 rounded-md mb-1 text-xs transition-colors ${
                  selectedId === h.howto_id ? "bg-accent" : "hover:bg-accent/50"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1">{h.title}</span>
                </div>
                {linkedTicket && (
                  <div className="text-[10px] text-muted-foreground mt-0.5 pl-5 truncate">
                    {linkedTicket.title}
                  </div>
                )}
              </button>
            );
          })
        );
    }
  })();

  // ---------------------------------------------------------------------------
  // Middle content
  // ---------------------------------------------------------------------------
  const middleContent = (() => {
    // Show existing howto detail
    if (selected) {
      return (
        <ScrollArea className="h-full">
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <h1 className="text-lg font-semibold flex-1">{selected.title}</h1>
              <div className="flex rounded-md border text-[10px] overflow-hidden">
                <button
                  onClick={() => setViewMode("human")}
                  className={`px-2.5 py-1 transition-colors flex items-center gap-1 ${
                    viewMode === "human" ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                  }`}
                >
                  <User className="h-3 w-3" /> Human
                </button>
                <button
                  onClick={() => setViewMode("agent")}
                  className={`px-2.5 py-1 transition-colors border-l flex items-center gap-1 ${
                    viewMode === "agent" ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                  }`}
                >
                  <Bot className="h-3 w-3" /> AI Agent
                </button>
              </div>
            </div>

            <div className="flex gap-2 mb-5 flex-wrap">
              <Badge variant="secondary" className="text-[10px]">
                {new Date(selected.created_at).toLocaleDateString()}
              </Badge>
            </div>

            {/* Linked items */}
            {linkedItemsSection(selected)}

            {/* Sections */}
            {(viewMode === "human"
              ? selected.sections
              : selected.sections
                  .filter((s) => agentSections.includes(s.section_name))
                  .sort((a, b) => agentSections.indexOf(a.section_name) - agentSections.indexOf(b.section_name))
            ).map((sec) => (
              <Card key={sec.section_name} className="mb-4">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">{sec.section_name}</CardTitle>
                </CardHeader>
                <CardContent className="pb-3">
                  {editingSection === sec.section_name ? (
                    <div className="space-y-2">
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
                      onClick={() => {
                        setEditingSection(sec.section_name);
                        setEditContent(sec.content);
                      }}
                      className={`text-sm whitespace-pre-wrap cursor-pointer rounded p-2 hover:bg-accent/50 transition-colors ${
                        viewMode === "agent" ? "font-mono text-xs" : ""
                      }`}
                    >
                      {sec.content || <span className="text-muted-foreground italic">Click to edit...</span>}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}

            {/* Discussion */}
            <Card className="mb-4">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-1">
                  <MessageSquare className="h-3 w-3" /> Discussion
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-3">
                {(!selected.discussion || selected.discussion.length === 0) && (
                  <p className="text-xs text-muted-foreground">No comments yet.</p>
                )}
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
                    placeholder="Leave a comment..."
                    className="text-xs h-16"
                  />
                  <Button size="sm" onClick={handleAddComment} disabled={!commentText.trim()}>
                    <Send className="h-3 w-3 mr-1" /> Add Comment
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </ScrollArea>
      );
    }

    // Ticket selected but no howto yet — show ticket detail + generate button
    if (pendingTicket) {
      const existingHowto = howtoByTicket.get(pendingTicket.ticket_id);
      if (existingHowto) {
        setSelectedId(existingHowto.howto_id);
        setPendingTicketId(null);
        return null;
      }
      const WORKFLOW_LABELS: Record<string, string> = { backlog: "Backlog", todo: "To Do", in_progress: "In Progress", review: "Review", done: "Done" };
      return (
        <ScrollArea className="h-full">
          <div className="p-6 max-w-2xl">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Badge className={`text-xs ${PRIORITY_COLORS[pendingTicket.priority] ?? ""}`}>{pendingTicket.priority}</Badge>
              <Badge variant="outline" className="text-[10px]">{WORKFLOW_LABELS[pendingTicket.workflow_state] ?? pendingTicket.workflow_state}</Badge>
              {pendingTicket.source && <Badge variant="secondary" className="text-[10px]">{pendingTicket.source}</Badge>}
            </div>
            <h1 className="text-xl font-semibold mt-3 mb-4">{pendingTicket.title}</h1>

            {pendingTicket.description && (
              <div className="mb-5">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Description</h3>
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{pendingTicket.description}</p>
              </div>
            )}

            {pendingTicket.assignees.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Assignees</h3>
                <div className="flex gap-1.5 flex-wrap">
                  {pendingTicket.assignees.map((a, i) => <Badge key={i} variant="secondary" className="text-xs">{a}</Badge>)}
                </div>
              </div>
            )}

            {pendingTicket.linked_entity_names?.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Linked Entities</h3>
                <div className="flex gap-1.5 flex-wrap">
                  {pendingTicket.linked_entity_names.map((name, i) => <Badge key={i} variant="outline" className="text-xs">{name}</Badge>)}
                </div>
              </div>
            )}

            {pendingTicket.labels?.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Labels</h3>
                <div className="flex gap-1.5 flex-wrap">
                  {pendingTicket.labels.map((l, i) => <Badge key={i} variant="secondary" className="text-[10px]">{l}</Badge>)}
                </div>
              </div>
            )}

            <div className="border-t pt-5 mt-5">
              <p className="text-sm text-muted-foreground mb-3">No how-to guide exists for this ticket yet.</p>
              <Button onClick={() => handleGenerate(pendingTicket.ticket_id)} disabled={generating}>
                {generating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                Generate How-to Guide
              </Button>
            </div>
          </div>
        </ScrollArea>
      );
    }

    // Project selected but no howto yet — show project entity page detail + generate button
    if (pendingProject) {
      const existingHowto = howtoByProject.get(pendingProject.node_id);
      if (existingHowto) {
        setSelectedId(existingHowto.howto_id);
        setPendingProjectId(null);
        return null;
      }
      const entityPage = entityPageByNodeId.get(pendingProject.node_id);
      const disc = pendingProject.attributes?.discovery_category ?? "";
      return (
        <ScrollArea className="h-full">
          <div className="p-6 max-w-2xl">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className="text-[10px]">project</Badge>
              {disc && <Badge variant="secondary" className="text-[10px]">{disc.replace(/_/g, " ")}</Badge>}
            </div>
            <h1 className="text-xl font-semibold mt-3 mb-4">{pendingProject.display_name}</h1>

            {entityPage ? (
              <div className="space-y-4 mb-6">
                {entityPage.sections.filter((s) => s.items.length > 0).map((section) => (
                  <div key={section.section_name}>
                    <div className="flex items-center gap-2 mb-2 border-b pb-1">
                      <h3 className="text-sm font-semibold">{section.section_name}</h3>
                      <Badge variant={section.requirement === "MUST" ? "default" : "secondary"} className="text-[9px]">
                        {section.requirement}
                      </Badge>
                    </div>
                    <ul className="space-y-1">
                      {section.items.map((item, idx) => (
                        <li key={idx} className="flex items-start gap-2 text-sm">
                          <span className="text-muted-foreground mt-1 shrink-0">•</span>
                          <span className="flex-1">{item.text}</span>
                          <Badge
                            variant={item.confidence === "low" ? "destructive" : item.confidence === "medium" ? "secondary" : "default"}
                            className="text-[9px] shrink-0"
                          >
                            {item.confidence}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground mb-6">No entity page data available for this project.</p>
            )}

            {pendingProject.source_refs && pendingProject.source_refs.length > 0 && (
              <div className="mb-6">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Sources</h3>
                <div className="space-y-1">
                  {pendingProject.source_refs.map((ref, i) => (
                    <div key={i} className="text-xs bg-muted/30 rounded px-3 py-2 border border-border/30">
                      <span className="font-medium">{ref.title}</span>
                      <span className="text-muted-foreground ml-2">({ref.source_type})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t pt-5 mt-5">
              <p className="text-sm text-muted-foreground mb-3">No how-to guide exists for this project yet.</p>
              <Button onClick={() => handleGenerate(undefined, pendingProject.node_id)} disabled={generating}>
                {generating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
                Generate How-to Guide
              </Button>
            </div>
          </div>
        </ScrollArea>
      );
    }

    // Empty state
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-2">
          <FileText className="h-10 w-10 mx-auto text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">
            Select a ticket, project, or how-to guide from the sidebar.
          </p>
        </div>
      </div>
    );
  })();

  return (
    <div className="flex h-full flex-1 min-w-0">
      {/* Left sidebar */}
      <div className="w-64 shrink-0 border-r flex flex-col">
        <div className="p-3 border-b space-y-2">
          <h2 className="text-sm font-medium">How-to Implement</h2>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="h-7 text-xs pl-7"
            />
          </div>
          <Select value={personFilter} onValueChange={setPersonFilter}>
            <SelectTrigger className="h-7 text-xs">
              <User className="h-3 w-3 mr-1" />
              <SelectValue placeholder="Filter by person" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All People</SelectItem>
              {persons.map((p) => (
                <SelectItem key={p.node_id} value={p.display_name}>
                  {p.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={ticketStatusFilter} onValueChange={setTicketStatusFilter}>
            <SelectTrigger className="h-7 text-xs">
              <TicketCheck className="h-3 w-3 mr-1" />
              <SelectValue placeholder="Ticket status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tickets</SelectItem>
              <SelectItem value="past">Past Tickets</SelectItem>
              <SelectItem value="ongoing">Ongoing Tickets</SelectItem>
              <SelectItem value="proposed">Proposed Tickets</SelectItem>
            </SelectContent>
          </Select>
          <Select value={projectStatusFilter} onValueChange={setProjectStatusFilter}>
            <SelectTrigger className="h-7 text-xs">
              <FolderKanban className="h-3 w-3 mr-1" />
              <SelectValue placeholder="Project status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              <SelectItem value="past_documented">Past Documented</SelectItem>
              <SelectItem value="past_undocumented">Past Undocumented</SelectItem>
              <SelectItem value="ongoing_documented">Ongoing Documented</SelectItem>
              <SelectItem value="ongoing_undocumented">Ongoing Undocumented</SelectItem>
              <SelectItem value="proposed">Proposed</SelectItem>
            </SelectContent>
          </Select>
          <Tabs value={sidebarTab} onValueChange={(v) => setSidebarTab(v as SidebarTab)}>
            <TabsList className="w-full h-7">
              <TabsTrigger value="tickets" className="flex-1 text-[10px] h-5">Tickets</TabsTrigger>
              <TabsTrigger value="projects" className="flex-1 text-[10px] h-5">Projects</TabsTrigger>
              <TabsTrigger value="howtos" className="flex-1 text-[10px] h-5">
                How-to
                {howtos.length > 0 && (
                  <Badge variant="secondary" className="text-[7px] h-3.5 px-1 ml-0.5">{howtos.length}</Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <ScrollArea className="flex-1 p-2">
          {sidebarList}
        </ScrollArea>
      </div>

      {/* Middle content + right panel */}
      <SplitLayout
        autoSaveId="howto-v2"
        mainContent={<div className="h-full overflow-hidden">{middleContent}</div>}
        rightPanel={
          <KB2RightPanel
            companySlug={companySlug}
            autoContext={selected ? { type: "howto" as const, id: selected.howto_id, title: selected.title } : null}
            sourceRefs={rightPanelSources}
            relatedEntityPages={[]}
            defaultTab="sources"
          />
        }
      />
    </div>
  );
}
