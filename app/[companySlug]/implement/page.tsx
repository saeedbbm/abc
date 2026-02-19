"use client";

import { useState, useCallback, useEffect } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Wrench, Loader2, Play, ChevronDown, ChevronRight,
  FileText, User, ChevronLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Ticket {
  ticket_id: string;
  type: string;
  title: string;
  priority: string;
  description: string;
  assigned_to: string;
  complexity: string;
}

interface HowToDoc {
  ticket_id: string;
  title: string;
  sections: {
    section_name: string;
    content: string;
  }[];
}

export default function ImplementPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const [selectedPerson, setSelectedPerson] = useState("all");
  const [people] = useState<string[]>([]);
  const [tickets] = useState<Ticket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<string | null>(null);
  const [generatingDoc, setGeneratingDoc] = useState(false);
  const [howToDoc, setHowToDoc] = useState<HowToDoc | null>(null);

  const filteredTickets = selectedPerson === "all"
    ? tickets
    : tickets.filter(t => t.assigned_to === selectedPerson);

  const handleGenerateDoc = useCallback(async (ticketId: string) => {
    setGeneratingDoc(true);
    setSelectedTicket(ticketId);
    try {
      const res = await fetch(`/api/${companySlug}/implement/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket_id: ticketId }),
      });
      if (res.ok) {
        const data = await res.json();
        setHowToDoc(data.doc);
      }
    } catch { /* ignore */ }
    setGeneratingDoc(false);
  }, [companySlug]);

  if (howToDoc) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6">
          <Button variant="ghost" size="sm" className="mb-4 gap-1" onClick={() => setHowToDoc(null)}>
            <ChevronLeft className="h-4 w-4" /> Back to tickets
          </Button>
          <h1 className="text-xl font-semibold mb-1">{howToDoc.title}</h1>
          <p className="text-sm text-muted-foreground mb-6">Implementation document — edit below, @mention people for verification</p>
          <div className="space-y-6">
            {howToDoc.sections.map((section, i) => (
              <div key={i}>
                <h2 className="text-lg font-semibold mb-2">{section.section_name}</h2>
                <div
                  className="prose prose-sm dark:prose-invert max-w-none p-4 rounded-lg border bg-card min-h-[80px]"
                  contentEditable
                  suppressContentEditableWarning
                  dangerouslySetInnerHTML={{ __html: section.content.replace(/\n/g, "<br />") }}
                />
              </div>
            ))}
          </div>
          <div className="mt-6 flex gap-2">
            <Button className="gap-2">
              <FileText className="h-4 w-4" /> Save to KB (New Projects)
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold mb-1">How to Implement</h1>
          <p className="text-sm text-muted-foreground">
            Select a ticket and generate an implementation document.
          </p>
        </div>

        {/* Person filter */}
        <div className="mb-4 flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <select
            value={selectedPerson}
            onChange={e => setSelectedPerson(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            <option value="all">All people</option>
            {people.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        {filteredTickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Wrench className="h-10 w-10 text-muted-foreground/30 mb-4" />
            <h2 className="text-base font-semibold mb-1">No tickets assigned</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              When tickets are accepted from the PM section, they will appear here for implementation.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredTickets.map(ticket => (
              <div key={ticket.ticket_id} className="border rounded-lg bg-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium uppercase",
                      ticket.type === "bug" ? "bg-red-100 text-red-700" :
                      ticket.type === "feature" ? "bg-green-100 text-green-700" :
                      "bg-blue-100 text-blue-700"
                    )}>{ticket.type}</span>
                    <span className="font-medium text-sm">{ticket.title}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{ticket.priority} / {ticket.complexity}</span>
                </div>
                <p className="text-sm text-muted-foreground mb-3">{ticket.description}</p>
                <Button size="sm" className="gap-2"
                  disabled={generatingDoc && selectedTicket === ticket.ticket_id}
                  onClick={() => handleGenerateDoc(ticket.ticket_id)}>
                  {generatingDoc && selectedTicket === ticket.ticket_id ? (
                    <><Loader2 className="h-3 w-3 animate-spin" /> Generating...</>
                  ) : (
                    <><Play className="h-3 w-3" /> Generate Implementation Doc</>
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
