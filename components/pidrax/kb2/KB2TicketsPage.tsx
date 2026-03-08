"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KB2RightPanel, SourceRef } from "./KB2RightPanel";
import { SplitLayout } from "./SplitLayout";
import {
  Plus,
  GripVertical,
  RefreshCw,
  MessageSquareText,
  Loader2,
  Sparkles,
  Check,
  Link2,
  MessageCircle,
  Send,
  ListTree,
  Calendar,
  Tag,
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  Search,
} from "lucide-react";
import { useMemo } from "react";

interface TicketComment {
  id: string;
  author: string;
  text: string;
  source: string;
  timestamp: string;
}

interface Ticket {
  ticket_id: string;
  source: string;
  title: string;
  description: string;
  assignees: string[];
  status: string;
  priority: string;
  workflow_state: string;
  linked_entity_ids: string[];
  linked_entity_names: string[];
  created_at: string;
  parent_ticket_id?: string;
  subtask_ids: string[];
  labels: string[];
  comments: TicketComment[];
}

interface GeneratedTicket {
  title: string;
  description: string;
  priority: string;
  priority_rationale: string;
  affected_systems: string[];
  customer_evidence: { excerpt: string; sentiment: string }[];
}

const WORKFLOW_COLUMNS = ["backlog", "todo", "in_progress", "review", "done"];
const COLUMN_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-red-500",
  P1: "bg-orange-500",
  P2: "bg-yellow-500",
  P3: "bg-blue-500",
};

const SOURCE_LABELS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  jira: { label: "Jira", variant: "secondary" },
  conversation: { label: "Conversation", variant: "outline" },
  feedback: { label: "Feedback", variant: "outline" },
  manual: { label: "Manual", variant: "outline" },
};

type ViewMode = "board" | "detail" | "create";

// ---------------------------------------------------------------------------
// Inline ticket detail view
// ---------------------------------------------------------------------------

function TicketDetailView({
  ticket,
  companySlug,
  onBack,
  onUpdated,
}: {
  ticket: Ticket;
  companySlug: string;
  onBack: () => void;
  onUpdated: () => void;
}) {
  const [subtasks, setSubtasks] = useState<Ticket[]>([]);
  const [loadingSubtasks, setLoadingSubtasks] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [addingComment, setAddingComment] = useState(false);
  const [creatingSubtask, setCreatingSubtask] = useState(false);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [localTicket, setLocalTicket] = useState(ticket);
  const [showVerifyForm, setShowVerifyForm] = useState(false);
  const [verifyTitle, setVerifyTitle] = useState("");
  const [verifyDesc, setVerifyDesc] = useState("");

  useEffect(() => {
    setLocalTicket(ticket);
  }, [ticket]);

  const fetchSubtasks = useCallback(async () => {
    setLoadingSubtasks(true);
    try {
      const res = await fetch(
        `/api/${companySlug}/kb2/tickets?ticket_id=${ticket.ticket_id}`,
      );
      const data = await res.json();
      setSubtasks(data.subtasks ?? []);
      if (data.ticket) setLocalTicket(data.ticket);
    } finally {
      setLoadingSubtasks(false);
    }
  }, [companySlug, ticket.ticket_id]);

  useEffect(() => {
    fetchSubtasks();
  }, [fetchSubtasks]);

  const patchField = async (fields: Record<string, unknown>) => {
    await fetch(`/api/${companySlug}/kb2/tickets`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId: ticket.ticket_id, ...fields }),
    });
    onUpdated();
  };

  const handleAddToVerify = async () => {
    await fetch(`/api/${companySlug}/kb2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        card: {
          card_type: "edit_proposal",
          title: verifyTitle || `Review: ${ticket.title}`,
          description: verifyDesc || `Ticket: "${ticket.title}" — ${ticket.description?.slice(0, 200)}`,
          severity: "S3",
          page_occurrences: [{ page_id: ticket.ticket_id, page_type: "ticket", page_title: ticket.title }],
          source_refs: [],
        },
      }),
    });
    setShowVerifyForm(false);
    setVerifyTitle("");
    setVerifyDesc("");
  };

  const handleAddComment = async () => {
    if (!commentText.trim()) return;
    setAddingComment(true);
    try {
      await patchField({ add_comment: commentText });
      setCommentText("");
      await fetchSubtasks();
    } finally {
      setAddingComment(false);
    }
  };

  const handleCreateSubtask = async () => {
    if (!subtaskTitle.trim()) return;
    setCreatingSubtask(true);
    try {
      await fetch(`/api/${companySlug}/kb2/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: subtaskTitle,
          description: "",
          source: "manual",
          priority: "P2",
          parent_ticket_id: ticket.ticket_id,
        }),
      });
      setSubtaskTitle("");
      await fetchSubtasks();
      onUpdated();
    } finally {
      setCreatingSubtask(false);
    }
  };

  const comments = localTicket.comments ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* Back bar */}
      <div className="border-b px-4 py-3 flex items-center gap-3 shrink-0">
        <Button size="icon" variant="ghost" onClick={onBack} className="h-7 w-7">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge className={PRIORITY_COLORS[localTicket.priority]}>
            {localTicket.priority}
          </Badge>
          <span className="font-mono">{localTicket.ticket_id.slice(0, 8)}</span>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-6 space-y-6">
            {/* Title */}
            <h1 className="text-lg font-semibold">{localTicket.title}</h1>

            {/* Description */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Description
              </label>
              <p className="text-sm whitespace-pre-wrap">{localTicket.description || "No description."}</p>
            </div>

            {/* Edit in Verify */}
            <div>
              {!showVerifyForm ? (
                <Button size="sm" variant="outline" onClick={() => setShowVerifyForm(true)}>
                  Edit in Verify
                </Button>
              ) : (
                <Card className="p-3 space-y-2">
                  <Input
                    value={verifyTitle}
                    onChange={(e) => setVerifyTitle(e.target.value)}
                    placeholder="Title (optional)"
                    className="h-8 text-xs"
                  />
                  <Textarea
                    value={verifyDesc}
                    onChange={(e) => setVerifyDesc(e.target.value)}
                    placeholder="Describe what should change..."
                    rows={2}
                    className="text-xs"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleAddToVerify}>Add to Verify</Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowVerifyForm(false)}>Cancel</Button>
                  </div>
                </Card>
              )}
            </div>

            {/* Subtasks */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <ListTree className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Subtasks
                </span>
                {loadingSubtasks && (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                )}
              </div>
              {subtasks.length > 0 && (
                <div className="space-y-1 mb-2">
                  {subtasks.map((st) => (
                    <div
                      key={st.ticket_id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 text-sm"
                    >
                      <span className="flex-1 truncate">{st.title}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {COLUMN_LABELS[st.workflow_state] ?? st.workflow_state}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
              {!loadingSubtasks && subtasks.length === 0 && (
                <p className="text-xs text-muted-foreground mb-2">
                  No subtasks yet.
                </p>
              )}
              <div className="flex gap-2">
                <Input
                  value={subtaskTitle}
                  onChange={(e) => setSubtaskTitle(e.target.value)}
                  placeholder="New subtask title..."
                  className="text-xs h-8"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleCreateSubtask();
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCreateSubtask}
                  disabled={creatingSubtask || !subtaskTitle.trim()}
                  className="shrink-0 h-8"
                >
                  {creatingSubtask ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                </Button>
              </div>
            </div>

            {/* Linked entities */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Linked Entities
                </span>
              </div>
              {localTicket.linked_entity_names?.length > 0 ||
              localTicket.linked_entity_ids?.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {localTicket.linked_entity_names?.length > 0
                    ? localTicket.linked_entity_names.map((name, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">
                          {name}
                        </Badge>
                      ))
                    : localTicket.linked_entity_ids.map((id, i) => (
                        <Badge
                          key={i}
                          variant="outline"
                          className="text-[10px] font-mono"
                        >
                          {id.slice(0, 12)}...
                        </Badge>
                      ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No linked entities.
                </p>
              )}
            </div>

            {/* Comments */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Comments ({comments.length})
                </span>
              </div>
              {comments.length > 0 && (
                <div className="space-y-3 mb-4">
                  {comments.map((c) => (
                    <div
                      key={c.id}
                      className="rounded-md border px-3 py-2 text-sm"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium">{c.author}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(c.timestamp).toLocaleString()}
                        </span>
                        {c.source && c.source !== "manual" && (
                          <Badge variant="outline" className="text-[9px]">
                            {c.source}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs whitespace-pre-wrap">{c.text}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Add a comment..."
                  rows={2}
                  className="text-xs resize-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleAddComment();
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddComment}
                  disabled={addingComment || !commentText.trim()}
                  className="shrink-0 self-end"
                >
                  {addingComment ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="h-3 w-3" />
                  )}
                </Button>
              </div>
            </div>
          {/* Metadata */}
          <div className="border-t pt-4 mt-4">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Details</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Status</label>
                <Select
                  value={localTicket.workflow_state}
                  onValueChange={async (val) => {
                    setLocalTicket((prev) => ({ ...prev, workflow_state: val }));
                    await patchField({ workflow_state: val });
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORKFLOW_COLUMNS.map((ws) => (
                      <SelectItem key={ws} value={ws}>{COLUMN_LABELS[ws]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Priority</label>
                <Select
                  value={localTicket.priority}
                  onValueChange={async (val) => {
                    setLocalTicket((prev) => ({ ...prev, priority: val }));
                    await patchField({ priority: val });
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="P0">P0 — Critical</SelectItem>
                    <SelectItem value="P1">P1 — High</SelectItem>
                    <SelectItem value="P2">P2 — Medium</SelectItem>
                    <SelectItem value="P3">P3 — Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">Source</label>
                <Badge variant={SOURCE_LABELS[localTicket.source]?.variant ?? "outline"}>
                  {SOURCE_LABELS[localTicket.source]?.label ?? localTicket.source}
                </Badge>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground block mb-1">
                  <Calendar className="h-3 w-3 inline mr-1" />Created
                </label>
                <p className="text-xs">
                  {new Date(localTicket.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                </p>
              </div>
              {localTicket.labels?.length > 0 && (
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">
                    <Tag className="h-3 w-3 inline mr-1" />Labels
                  </label>
                  <div className="flex flex-wrap gap-1">
                    {localTicket.labels.map((l, i) => (
                      <Badge key={i} variant="secondary" className="text-[10px]">{l}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {localTicket.parent_ticket_id && (
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">Parent</label>
                  <Badge variant="outline" className="text-[10px] font-mono">
                    {localTicket.parent_ticket_id.slice(0, 12)}...
                  </Badge>
                </div>
              )}
            </div>
          </div>
          </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline create form
// ---------------------------------------------------------------------------

function TicketCreateView({
  companySlug,
  onBack,
  onCreated,
}: {
  companySlug: string;
  onBack: () => void;
  onCreated: () => void;
}) {
  const [creating, setCreating] = useState(false);

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreating(true);
    try {
      const form = new FormData(e.currentTarget);
      await fetch(`/api/${companySlug}/kb2/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.get("title"),
          description: form.get("description"),
          assignee: form.get("assignee"),
          source: form.get("source") || "manual",
          priority: form.get("priority") || "P2",
        }),
      });
      onCreated();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3 flex items-center gap-3 shrink-0">
        <Button size="icon" variant="ghost" onClick={onBack} className="h-7 w-7">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-sm font-semibold">New Ticket</h2>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 max-w-2xl">
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Title *
              </label>
              <Input name="title" placeholder="Ticket title" required />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Description
              </label>
              <Textarea
                name="description"
                placeholder="Describe the issue or request..."
                rows={5}
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Assignee *
              </label>
              <Input
                name="assignee"
                placeholder="Assignee name or email"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Source
                </label>
                <Select name="source" defaultValue="manual">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="jira">From Jira</SelectItem>
                    <SelectItem value="conversation">Conversation</SelectItem>
                    <SelectItem value="feedback">Feedback</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Priority
                </label>
                <Select name="priority" defaultValue="P2">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="P0">P0 — Critical</SelectItem>
                    <SelectItem value="P1">P1 — High</SelectItem>
                    <SelectItem value="P2">P2 — Medium</SelectItem>
                    <SelectItem value="P3">P3 — Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" type="button" onClick={onBack}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                Create Ticket
              </Button>
            </div>
          </form>
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar helpers
// ---------------------------------------------------------------------------

const getTicketKey = (t: Ticket) => {
  const match = t.ticket_id?.match(/^[A-Z]+-\d+/);
  if (match) return match[0];
  const titleMatch = t.title?.match(/^([A-Z]+-\d+)/);
  if (titleMatch) return titleMatch[1];
  return null;
};

const formatTicketLabel = (t: Ticket) => {
  const key = getTicketKey(t);
  if (key) return `${key}: ${t.title.replace(/^[A-Z]+-\d+[:\s]*/, "")}`;
  return t.title;
};

function TicketGroup({
  label,
  tickets,
  selectedTicketId,
  onSelect,
}: {
  label: string;
  tickets: Ticket[];
  selectedTicketId: string | null;
  onSelect: (t: Ticket) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider hover:bg-muted/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="flex-1 text-left">{label}</span>
        <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
          {tickets.length}
        </Badge>
      </button>
      {open && (
        <div className="pb-1">
          {tickets.length === 0 ? (
            <p className="px-3 py-1.5 text-[11px] text-muted-foreground/60 italic">
              None
            </p>
          ) : (
            tickets.map((t) => {
              const isSelected = t.ticket_id === selectedTicketId;
              return (
                <button
                  key={t.ticket_id}
                  onClick={() => onSelect(t)}
                  className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs transition-colors ${
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${PRIORITY_COLORS[t.priority] ?? "bg-muted-foreground/40"}`}
                  />
                  <span className="flex-1 truncate">
                    {formatTicketLabel(t)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function KB2TicketsPage({ companySlug }: { companySlug: string }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const [feedbackText, setFeedbackText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedTickets, setGeneratedTickets] = useState<GeneratedTicket[]>(
    [],
  );
  const [addedIndices, setAddedIndices] = useState<Set<number>>(new Set());
  const [graphNodes, setGraphNodes] = useState<Record<string, { display_name: string; type: string; source_refs: { source_type: string; doc_id: string; title: string; excerpt?: string }[] }>>({});

  const fetchTickets = useCallback(async () => {
    const [tRes, nRes] = await Promise.all([
      fetch(`/api/${companySlug}/kb2?type=tickets`),
      fetch(`/api/${companySlug}/kb2?type=graph_nodes`),
    ]);
    const tData = await tRes.json();
    const nData = await nRes.json();
    setTickets(tData.tickets ?? []);
    const nodeMap: typeof graphNodes = {};
    for (const n of nData.nodes ?? []) {
      nodeMap[n.node_id] = { display_name: n.display_name, type: n.type, source_refs: n.source_refs ?? [] };
    }
    setGraphNodes(nodeMap);
  }, [companySlug]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const getTicketSources = (ticket: Ticket): SourceRef[] => {
    const refs: SourceRef[] = [];
    for (const entityId of ticket.linked_entity_ids ?? []) {
      const node = graphNodes[entityId];
      if (node?.source_refs) {
        for (const r of node.source_refs) {
          if (!refs.some((existing) => existing.doc_id === r.doc_id)) {
            refs.push({ source_type: r.source_type, doc_id: r.doc_id, title: r.title, excerpt: r.excerpt });
          }
        }
      }
    }
    return refs;
  };

  const filteredTickets =
    sourceFilter === "all"
      ? tickets
      : tickets.filter((t) => t.source === sourceFilter);

  const ticketsByColumn = WORKFLOW_COLUMNS.reduce(
    (acc, col) => {
      acc[col] = filteredTickets.filter((t) => t.workflow_state === col);
      return acc;
    },
    {} as Record<string, Ticket[]>,
  );

  const handleDrop = async (ticketId: string, newState: string) => {
    await fetch(`/api/${companySlug}/kb2/tickets`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, workflow_state: newState }),
    });
    setDraggedId(null);
    await fetchTickets();
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch(`/api/${companySlug}/kb2/tickets?action=sync`);
      const data = await res.json();
      setTickets(data.tickets ?? []);
      const s = data.sync;
      if (s) {
        setSyncMsg(
          s.synced > 0
            ? `Synced ${s.synced} new ticket${s.synced !== 1 ? "s" : ""} from pipeline`
            : "Already up to date",
        );
      }
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 4000);
    }
  };

  const handleGenerate = async () => {
    if (!feedbackText.trim()) return;
    setGenerating(true);
    setGeneratedTickets([]);
    setAddedIndices(new Set());
    try {
      const res = await fetch(`/api/${companySlug}/kb2/tickets/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: feedbackText }),
      });
      const data = await res.json();
      setGeneratedTickets(data.tickets ?? []);
    } finally {
      setGenerating(false);
    }
  };

  const addGeneratedTicket = async (gt: GeneratedTicket, index: number) => {
    await fetch(`/api/${companySlug}/kb2/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: gt.title,
        description: gt.description,
        source: "feedback",
        priority: gt.priority,
      }),
    });
    setAddedIndices((prev) => new Set(prev).add(index));
    await fetchTickets();
  };

  const addAllGenerated = async () => {
    for (let i = 0; i < generatedTickets.length; i++) {
      if (!addedIndices.has(i)) {
        await addGeneratedTicket(generatedTickets[i], i);
      }
    }
  };

  const handleTicketUpdated = async () => {
    await fetchTickets();
    if (selectedTicket) {
      const fresh = tickets.find(
        (t) => t.ticket_id === selectedTicket.ticket_id,
      );
      if (fresh) setSelectedTicket(fresh);
    }
  };

  const openTicketDetail = (ticket: Ticket) => {
    setSelectedTicket(ticket);
    setViewMode("detail");
  };

  const goBackToBoard = () => {
    setViewMode("board");
  };

  // ---------------------------------------------------------------------------
  // Sidebar search + temporal grouping
  // ---------------------------------------------------------------------------

  const [sidebarSearch, setSidebarSearch] = useState("");

  const sidebarFiltered = useMemo(() => {
    if (!sidebarSearch.trim()) return filteredTickets;
    const q = sidebarSearch.toLowerCase();
    return filteredTickets.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.ticket_id.toLowerCase().includes(q) ||
        t.priority.toLowerCase().includes(q),
    );
  }, [filteredTickets, sidebarSearch]);

  const pastTickets = useMemo(
    () => sidebarFiltered.filter((t) => t.workflow_state === "done" || t.status === "closed"),
    [sidebarFiltered],
  );
  const ongoingTickets = useMemo(
    () => sidebarFiltered.filter((t) => ["in_progress", "review", "todo"].includes(t.workflow_state)),
    [sidebarFiltered],
  );
  const proposedTickets = useMemo(
    () =>
      sidebarFiltered.filter(
        (t) =>
          (t.source === "feedback" || t.source === "conversation") &&
          t.workflow_state === "backlog",
      ),
    [sidebarFiltered],
  );
  const backlogTickets = useMemo(
    () =>
      sidebarFiltered.filter(
        (t) =>
          t.workflow_state === "backlog" &&
          t.source !== "feedback" &&
          t.source !== "conversation",
      ),
    [sidebarFiltered],
  );

  const handleSidebarSelect = (ticket: Ticket) => {
    setSelectedTicket(ticket);
    setViewMode("detail");
  };

  // ---------------------------------------------------------------------------
  // Board view (with tabs: board, list, feedback)
  // ---------------------------------------------------------------------------

  const boardView = (
    <>
      <div className="border-b px-6 py-4 flex items-center gap-4">
        <h1 className="text-xl font-semibold">Tickets</h1>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="jira">From Jira</SelectItem>
            <SelectItem value="conversation">From Conversations</SelectItem>
            <SelectItem value="feedback">From Feedback</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
          </SelectContent>
        </Select>
        {syncMsg && (
          <span className="text-xs text-muted-foreground animate-in fade-in">
            {syncMsg}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleSync}
            disabled={syncing}
          >
            <RefreshCw
              className={`h-3 w-3 mr-1 ${syncing ? "animate-spin" : ""}`}
            />
            Sync
          </Button>
          <Button size="sm" onClick={() => setViewMode("create")}>
            <Plus className="h-3 w-3 mr-1" /> New Ticket
          </Button>
        </div>
      </div>

      <Tabs defaultValue="board" className="flex-1 flex flex-col min-h-0">
        <div className="px-6 pt-2">
          <TabsList>
            <TabsTrigger value="board">Sprint Board</TabsTrigger>
            <TabsTrigger value="list">My Tickets</TabsTrigger>
            <TabsTrigger value="feedback">
              <MessageSquareText className="h-3 w-3 mr-1" />
              Generate from Feedback
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Board tab */}
        <TabsContent value="board" className="flex-1 min-h-0 overflow-hidden px-6 py-4">
          <div className="flex gap-3 h-full min-w-0">
            {WORKFLOW_COLUMNS.map((col) => (
              <div
                key={col}
                className="flex-1 min-w-0 flex flex-col rounded-lg bg-muted/50 border"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (draggedId) handleDrop(draggedId, col);
                }}
              >
                <div className="px-3 py-2 border-b flex items-center gap-1.5 min-w-0">
                  <span className="text-xs font-medium truncate">
                    {COLUMN_LABELS[col]}
                  </span>
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {ticketsByColumn[col]?.length ?? 0}
                  </Badge>
                </div>
                <ScrollArea className="flex-1 p-2">
                  <div className="space-y-2">
                    {(ticketsByColumn[col] ?? []).map((ticket) => (
                      <Card
                        key={ticket.ticket_id}
                        draggable
                        onDragStart={() => setDraggedId(ticket.ticket_id)}
                        onClick={() => openTicketDetail(ticket)}
                        className="cursor-grab active:cursor-grabbing hover:ring-1 hover:ring-ring/40 transition-shadow"
                      >
                        <CardContent className="p-3">
                          <div className="flex items-start gap-2">
                            <GripVertical className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                            <div className="min-w-0">
                              <p className="text-xs font-medium line-clamp-2">
                                {ticket.title}
                              </p>
                              <div className="flex gap-1 mt-1 flex-wrap">
                                <Badge
                                  className={`text-[9px] ${PRIORITY_COLORS[ticket.priority] ?? ""}`}
                                >
                                  {ticket.priority}
                                </Badge>
                                <Badge
                                  variant={
                                    SOURCE_LABELS[ticket.source]?.variant ??
                                    "outline"
                                  }
                                  className="text-[9px]"
                                >
                                  {SOURCE_LABELS[ticket.source]?.label ??
                                    ticket.source}
                                </Badge>
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            ))}
          </div>
        </TabsContent>

        {/* List tab */}
        <TabsContent value="list" className="flex-1 min-h-0 overflow-auto px-6 py-4">
          <div className="space-y-2 max-w-3xl">
            {filteredTickets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tickets yet.</p>
            ) : (
              filteredTickets.map((t) => (
                <Card
                  key={t.ticket_id}
                  className="hover:ring-1 hover:ring-ring/40 transition-shadow cursor-pointer"
                  onClick={() => openTicketDetail(t)}
                >
                  <CardContent className="p-0">
                    <div className="w-full text-left p-3 flex items-center gap-3">
                      <Badge className={PRIORITY_COLORS[t.priority]}>
                        {t.priority}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {t.title}
                        </p>
                      </div>
                      <Badge variant="outline">
                        {COLUMN_LABELS[t.workflow_state] ?? t.workflow_state}
                      </Badge>
                      <Badge
                        variant={
                          SOURCE_LABELS[t.source]?.variant ?? "outline"
                        }
                      >
                        {SOURCE_LABELS[t.source]?.label ?? t.source}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>

        {/* Feedback generation tab */}
        <TabsContent value="feedback" className="flex-1 min-h-0 overflow-auto px-6 py-4">
          <div className="max-w-3xl space-y-4">
            <div>
              <h2 className="text-sm font-semibold mb-1">
                Generate Tickets from Customer Feedback
              </h2>
              <p className="text-xs text-muted-foreground mb-3">
                Paste customer feedback, support tickets, or email threads
                below. The AI will analyze the text and propose actionable
                tickets.
              </p>
              <Textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Paste customer feedback here... (e.g. support tickets, email threads, survey responses)"
                rows={8}
                className="font-mono text-xs"
              />
              <div className="flex items-center gap-2 mt-2">
                <Button
                  onClick={handleGenerate}
                  disabled={generating || !feedbackText.trim()}
                  size="sm"
                >
                  {generating ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3 mr-1" />
                  )}
                  {generating ? "Generating..." : "Generate Tickets"}
                </Button>
                {generatedTickets.length > 0 && !generating && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addAllGenerated}
                    disabled={addedIndices.size === generatedTickets.length}
                  >
                    <Check className="h-3 w-3 mr-1" />
                    Add All to Backlog (
                    {generatedTickets.length - addedIndices.size})
                  </Button>
                )}
              </div>
            </div>

            {generatedTickets.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Generated Tickets ({generatedTickets.length})
                </h3>
                {generatedTickets.map((gt, i) => {
                  const isAdded = addedIndices.has(i);
                  return (
                    <Card key={i} className={isAdded ? "opacity-60" : ""}>
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <Badge
                            className={`shrink-0 ${PRIORITY_COLORS[gt.priority] ?? ""}`}
                          >
                            {gt.priority}
                          </Badge>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold">{gt.title}</p>
                            <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                              {gt.description}
                            </p>
                            {gt.priority_rationale && (
                              <p className="text-[10px] text-muted-foreground mt-2 italic">
                                Priority rationale: {gt.priority_rationale}
                              </p>
                            )}
                            {gt.affected_systems.length > 0 && (
                              <div className="flex gap-1 mt-2 flex-wrap">
                                {gt.affected_systems.map((sys, si) => (
                                  <Badge
                                    key={si}
                                    variant="outline"
                                    className="text-[10px]"
                                  >
                                    {sys}
                                  </Badge>
                                ))}
                              </div>
                            )}
                            {gt.customer_evidence.length > 0 && (
                              <div className="mt-2 space-y-1">
                                {gt.customer_evidence.map((ev, ei) => (
                                  <div
                                    key={ei}
                                    className="text-[10px] bg-muted/50 rounded px-2 py-1 border-l-2 border-muted-foreground/30"
                                  >
                                    &ldquo;{ev.excerpt}&rdquo;
                                    <Badge
                                      variant="outline"
                                      className="text-[9px] ml-1"
                                    >
                                      {ev.sentiment}
                                    </Badge>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0">
                            {isAdded ? (
                              <Badge
                                variant="secondary"
                                className="text-[10px]"
                              >
                                <Check className="h-2.5 w-2.5 mr-0.5" />
                                Added
                              </Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => addGeneratedTicket(gt, i)}
                              >
                                <Plus className="h-3 w-3 mr-1" />
                                Add
                              </Button>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </>
  );

  // ---------------------------------------------------------------------------
  // Render — right-side content area
  // ---------------------------------------------------------------------------

  const contentArea = (() => {
    switch (viewMode) {
      case "detail":
        return selectedTicket ? (
          <TicketDetailView
            ticket={selectedTicket}
            companySlug={companySlug}
            onBack={goBackToBoard}
            onUpdated={handleTicketUpdated}
          />
        ) : (
          boardView
        );
      case "create":
        return (
          <TicketCreateView
            companySlug={companySlug}
            onBack={goBackToBoard}
            onCreated={async () => {
              await fetchTickets();
              setViewMode("board");
            }}
          />
        );
      default:
        return boardView;
    }
  })();

  return (
    <SplitLayout
      autoSaveId="tickets"
      mainContent={
        <div className="flex h-full overflow-hidden">
          {/* ---- LEFT SIDEBAR ---- */}
          <div className="w-64 border-r flex flex-col shrink-0 bg-background">
            <div className="p-3 border-b">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={sidebarSearch}
                  onChange={(e) => setSidebarSearch(e.target.value)}
                  placeholder="Search tickets..."
                  className="h-8 pl-8 text-xs"
                />
              </div>
            </div>
            <ScrollArea className="flex-1">
              <TicketGroup
                label="Ongoing"
                tickets={ongoingTickets}
                selectedTicketId={selectedTicket?.ticket_id ?? null}
                onSelect={handleSidebarSelect}
              />
              <TicketGroup
                label="Proposed"
                tickets={proposedTickets}
                selectedTicketId={selectedTicket?.ticket_id ?? null}
                onSelect={handleSidebarSelect}
              />
              <TicketGroup
                label="Past"
                tickets={pastTickets}
                selectedTicketId={selectedTicket?.ticket_id ?? null}
                onSelect={handleSidebarSelect}
              />
              <TicketGroup
                label="Backlog"
                tickets={backlogTickets}
                selectedTicketId={selectedTicket?.ticket_id ?? null}
                onSelect={handleSidebarSelect}
              />
            </ScrollArea>
          </div>

          {/* ---- MAIN CONTENT AREA ---- */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {contentArea}
          </div>
        </div>
      }
      rightPanel={
        <KB2RightPanel
          companySlug={companySlug}
          autoContext={
            selectedTicket
              ? {
                  type: "ticket",
                  id: selectedTicket.ticket_id,
                  title: selectedTicket.title,
                }
              : null
          }
          sourceRefs={selectedTicket ? getTicketSources(selectedTicket) : []}
          relatedEntityPages={[]}
          defaultTab={selectedTicket ? "sources" : "chat"}
        />
      }
    />
  );
}
