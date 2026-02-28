"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Howto {
  howto_id: string;
  ticket_id: string;
  title: string;
  sections: { section_name: string; content: string }[];
  linked_entity_ids: string[];
  created_at: string;
}

const SECTION_LABELS: Record<string, string> = {
  "Goal and Non-Goals": "Goal and Non-Goals",
  "Options and Tradeoffs": "Options and Tradeoffs",
  "Proposed Plan": "Proposed Plan",
  "Rollout and Testing": "Rollout and Testing",
  "Open Questions": "Open Questions",
};

export function KB2HowtoPage({ companySlug }: { companySlug: string }) {
  const [howtos, setHowtos] = useState<Howto[]>([]);
  const [selected, setSelected] = useState<Howto | null>(null);

  const fetchHowtos = useCallback(async () => {
    const res = await fetch(`/api/${companySlug}/kb2?type=howto`);
    const data = await res.json();
    setHowtos(data.howtos ?? []);
  }, [companySlug]);

  useEffect(() => {
    fetchHowtos();
  }, [fetchHowtos]);

  return (
    <div className="flex h-full">
      <div className="w-72 border-r flex flex-col">
        <div className="p-4 border-b">
          <h2 className="text-sm font-medium">How-to Implement</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Implementation guides linked to tickets
          </p>
        </div>
        <ScrollArea className="flex-1 p-2">
          {howtos.length === 0 ? (
            <p className="text-xs text-muted-foreground p-2">
              No how-to guides yet. They will be generated when tickets are
              linked.
            </p>
          ) : (
            howtos.map((h) => (
              <button
                key={h.howto_id}
                onClick={() => setSelected(h)}
                className={`w-full text-left px-3 py-2 rounded-md mb-1 text-xs transition-colors ${
                  selected?.howto_id === h.howto_id
                    ? "bg-accent"
                    : "hover:bg-accent/50"
                }`}
              >
                {h.title}
              </button>
            ))
          )}
        </ScrollArea>
      </div>

      <div className="flex-1 min-w-0">
        {selected ? (
          <ScrollArea className="h-full p-6">
            <h1 className="text-lg font-semibold mb-4">{selected.title}</h1>
            <Badge variant="outline" className="mb-4">
              Ticket: {selected.ticket_id.slice(0, 8)}
            </Badge>
            {selected.sections.map((sec) => (
              <Card key={sec.section_name} className="mb-4">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">{sec.section_name}</CardTitle>
                </CardHeader>
                <CardContent className="pb-3">
                  <p className="text-sm whitespace-pre-wrap">{sec.content}</p>
                </CardContent>
              </Card>
            ))}
          </ScrollArea>
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted-foreground">
              {howtos.length === 0
                ? "No how-to guides yet."
                : "Select a guide from the left panel."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
