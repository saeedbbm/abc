"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { KBPagesView } from "@/components/pidrax/PidraxKBViews";
import type { ScoreFormatOutputType, KBCategory } from "@/src/entities/models/score-format";

export default function Pass1Page() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const [data, setData] = useState<ScoreFormatOutputType | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/${companySlug}/pidrax?type=pass1`);
      if (res.ok) {
        const json = await res.json();
        if (json.data) setData(json.data);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [companySlug]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading Pass 1 results...</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6">
        <h2 className="text-lg font-semibold mb-1">No Pass 1 Results</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          First-pass KB pages will appear here after data has been replicated from the pipeline.
        </p>
      </div>
    );
  }

  const allPages = [...(data.kb_pages || []), ...(data.howto_pages || [])];
  const allCategories = [...new Set(allPages.map(p => p.category))] as KBCategory[];

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-6 pb-3 shrink-0">
        <h1 className="text-xl font-semibold">Pass 1 — First-Pass KB</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Knowledge base pages generated from the first pass of the Pidrax pipeline.
        </p>
      </div>
      <div className="flex-1 min-h-0">
        <KBPagesView pages={allPages} categories={allCategories} showSources />
      </div>
    </div>
  );
}
