"use client";

import { useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Hash, Bug, Play, Loader2, CheckCircle2, Pencil, X,
  ChevronDown, ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Ticket {
  ticket_id: string;
  type: string;
  title: string;
  priority: string;
  priority_rationale: string;
  description: string;
  acceptance_criteria: string[];
  assigned_to: string;
  assignment_rationale: string;
  affected_systems: string[];
  customer_evidence: { feedback_id: string; customer_name: string; excerpt: string; sentiment: string }[];
  technical_constraints: { constraint: string; source: string; impact: string }[];
  complexity: string;
  related_tickets: string[];
  status?: "pending" | "accepted" | "rejected";
}

export default function PMPage() {
  const { companySlug } = useParams<{ companySlug: string }>();

  return (
    <div className="h-full overflow-hidden flex flex-col">
      <div className="p-6 border-b">
        <h1 className="text-xl font-semibold">Product Management</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review tickets from conversations and generate new ones from customer feedback.
        </p>
      </div>
      <Tabs defaultValue="conversations" className="flex-1 flex flex-col overflow-hidden">
        <div className="px-6 pt-2">
          <TabsList>
            <TabsTrigger value="conversations" className="gap-2">
              <Hash className="h-3.5 w-3.5" /> Tickets from Conversations
            </TabsTrigger>
            <TabsTrigger value="feedback" className="gap-2">
              <Bug className="h-3.5 w-3.5" /> New Feature / Bug
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="conversations" className="flex-1 overflow-auto px-6 pb-6">
          <ConversationTicketsTab companySlug={companySlug} />
        </TabsContent>
        <TabsContent value="feedback" className="flex-1 overflow-auto px-6 pb-6">
          <FeedbackTicketsTab companySlug={companySlug} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ConversationTicketsTab({ companySlug }: { companySlug: string }) {
  const [tickets] = useState<Ticket[]>([]);

  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Hash className="h-10 w-10 text-muted-foreground/30 mb-4" />
        <h2 className="text-base font-semibold mb-1">No conversation tickets yet</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          When Pidrax detects issues in Slack/Jira conversations that need PM attention, they will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 py-2">
      {tickets.map(ticket => (
        <TicketCard key={ticket.ticket_id} ticket={ticket} />
      ))}
    </div>
  );
}

function FeedbackTicketsTab({ companySlug }: { companySlug: string }) {
  const [feedbackText, setFeedbackText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generatedTickets, setGeneratedTickets] = useState<Ticket[]>([]);

  const handleGenerate = useCallback(async () => {
    if (!feedbackText.trim() || generating) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/${companySlug}/pm/generate-tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: feedbackText }),
      });
      if (res.ok) {
        const data = await res.json();
        setGeneratedTickets(data.tickets || []);
      }
    } catch { /* ignore */ }
    setGenerating(false);
  }, [feedbackText, generating, companySlug]);

  const handleAccept = (ticketId: string) => {
    setGeneratedTickets(prev => prev.map(t =>
      t.ticket_id === ticketId ? { ...t, status: "accepted" as const } : t
    ));
  };

  const handleReject = (ticketId: string) => {
    setGeneratedTickets(prev => prev.map(t =>
      t.ticket_id === ticketId ? { ...t, status: "rejected" as const } : t
    ));
  };

  return (
    <div className="space-y-4 py-2">
      <div>
        <label className="text-sm font-medium mb-2 block">Paste customer feedback report</label>
        <textarea
          value={feedbackText}
          onChange={e => setFeedbackText(e.target.value)}
          placeholder="Paste customer feedback, support tickets, sales notes, app reviews..."
          className="w-full h-40 p-3 rounded-lg border bg-background font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <Button onClick={handleGenerate} disabled={generating || !feedbackText.trim()} className="mt-2 gap-2">
          {generating ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</>
          ) : (
            <><Play className="h-4 w-4" /> Generate Report</>
          )}
        </Button>
      </div>

      {generatedTickets.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Generated Tickets ({generatedTickets.length})</h3>
          <div className="space-y-3">
            {generatedTickets.map(ticket => (
              <TicketCard key={ticket.ticket_id} ticket={ticket}
                showActions
                onAccept={() => handleAccept(ticket.ticket_id)}
                onReject={() => handleReject(ticket.ticket_id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TicketCard({ ticket, showActions, onAccept, onReject }: {
  ticket: Ticket;
  showActions?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn(
      "border rounded-lg bg-card",
      ticket.status === "accepted" && "border-green-300 bg-green-50/50 dark:border-green-800 dark:bg-green-900/10",
      ticket.status === "rejected" && "border-red-300 bg-red-50/50 dark:border-red-800 dark:bg-red-900/10 opacity-60",
    )}>
      <button onClick={() => setExpanded(!expanded)} className="w-full p-3 text-left">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium uppercase",
              ticket.type === "bug" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
              ticket.type === "feature" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
              "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
            )}>{ticket.type}</span>
            <span className="font-medium text-sm">{ticket.title}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn("text-xs font-medium",
              ticket.priority === "P0" ? "text-red-600" :
              ticket.priority === "P1" ? "text-orange-600" :
              ticket.priority === "P2" ? "text-yellow-600" : "text-gray-500"
            )}>{ticket.priority}</span>
            {ticket.status && (
              <span className={cn("text-xs px-1.5 py-0.5 rounded font-medium",
                ticket.status === "accepted" ? "bg-green-100 text-green-700" :
                ticket.status === "rejected" ? "bg-red-100 text-red-700" :
                "bg-yellow-100 text-yellow-700"
              )}>{ticket.status}</span>
            )}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t p-3 space-y-2 text-sm">
          <p>{ticket.description}</p>
          <div><span className="font-medium">Assigned to:</span> {ticket.assigned_to} — {ticket.assignment_rationale}</div>
          <div><span className="font-medium">Complexity:</span> {ticket.complexity}</div>
          {ticket.acceptance_criteria.length > 0 && (
            <div>
              <span className="font-medium">Acceptance Criteria:</span>
              <ul className="list-disc ml-5 mt-1 space-y-0.5">
                {ticket.acceptance_criteria.map((ac, i) => <li key={i}>{ac}</li>)}
              </ul>
            </div>
          )}
          {ticket.customer_evidence.length > 0 && (
            <div>
              <span className="font-medium">Customer Evidence:</span>
              <ul className="list-disc ml-5 mt-1">
                {ticket.customer_evidence.map((ce, i) => (
                  <li key={i}><span className="font-medium">{ce.customer_name}:</span> {ce.excerpt}</li>
                ))}
              </ul>
            </div>
          )}
          {showActions && !ticket.status && (
            <div className="flex gap-2 pt-2" onClick={e => e.stopPropagation()}>
              <Button size="sm" className="h-7 text-xs gap-1" onClick={onAccept}>
                <CheckCircle2 className="h-3 w-3" /> Accept
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={onReject}>
                <X className="h-3 w-3" /> Reject
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1">
                <Pencil className="h-3 w-3" /> Edit
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
