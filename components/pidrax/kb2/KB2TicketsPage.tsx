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
import {
  Plus,
  GripVertical,
} from "lucide-react";

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
  created_at: string;
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

export function KB2TicketsPage({ companySlug }: { companySlug: string }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);

  const fetchTickets = useCallback(async () => {
    const res = await fetch(`/api/${companySlug}/kb2?type=tickets`);
    const data = await res.json();
    setTickets(data.tickets ?? []);
  }, [companySlug]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const filteredTickets =
    sourceFilter === "all"
      ? tickets
      : tickets.filter((t) => t.source === sourceFilter);

  const ticketsByColumn = WORKFLOW_COLUMNS.reduce(
    (acc, col) => {
      acc[col] = filteredTickets.filter((t) => t.workflow_state === col);
      return acc;
    },
    {} as Record<string, Ticket[]>
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

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await fetch(`/api/${companySlug}/kb2/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        description: form.get("description"),
        source: form.get("source") || "manual",
        priority: form.get("priority") || "P2",
      }),
    });
    setShowCreate(false);
    await fetchTickets();
  };

  return (
    <div className="flex flex-col h-full">
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
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => setShowCreate(true)}
        >
          <Plus className="h-3 w-3 mr-1" /> New Ticket
        </Button>
      </div>

      <Tabs defaultValue="board" className="flex-1 flex flex-col">
        <div className="px-6 pt-2">
          <TabsList>
            <TabsTrigger value="board">Sprint Board</TabsTrigger>
            <TabsTrigger value="list">My Tickets</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="board" className="flex-1 px-6 py-4">
          <div className="flex gap-4 h-full overflow-x-auto">
            {WORKFLOW_COLUMNS.map((col) => (
              <div
                key={col}
                className="w-64 shrink-0 flex flex-col rounded-lg bg-muted/50 border"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (draggedId) handleDrop(draggedId, col);
                }}
              >
                <div className="px-3 py-2 border-b flex items-center gap-2">
                  <span className="text-xs font-medium">
                    {COLUMN_LABELS[col]}
                  </span>
                  <Badge variant="secondary" className="text-[10px]">
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
                        className="cursor-grab active:cursor-grabbing"
                      >
                        <CardContent className="p-3">
                          <div className="flex items-start gap-2">
                            <GripVertical className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                            <div className="min-w-0">
                              <p className="text-xs font-medium truncate">
                                {ticket.title}
                              </p>
                              <div className="flex gap-1 mt-1">
                                <Badge
                                  className={`text-[9px] ${PRIORITY_COLORS[ticket.priority] ?? ""}`}
                                >
                                  {ticket.priority}
                                </Badge>
                                <Badge variant="outline" className="text-[9px]">
                                  {ticket.source}
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

        <TabsContent value="list" className="flex-1 px-6 py-4">
          <div className="space-y-2 max-w-2xl">
            {filteredTickets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tickets yet.</p>
            ) : (
              filteredTickets.map((t) => (
                <Card key={t.ticket_id}>
                  <CardContent className="p-3 flex items-center gap-3">
                    <Badge className={PRIORITY_COLORS[t.priority]}>
                      {t.priority}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{t.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {t.description}
                      </p>
                    </div>
                    <Badge variant="outline">{t.workflow_state}</Badge>
                    <Badge variant="secondary">{t.source}</Badge>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Create ticket modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-96">
            <CardHeader>
              <CardTitle>New Ticket</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreate} className="space-y-3">
                <Input name="title" placeholder="Title" required />
                <Textarea
                  name="description"
                  placeholder="Description"
                  rows={3}
                />
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
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => setShowCreate(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit">Create</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
