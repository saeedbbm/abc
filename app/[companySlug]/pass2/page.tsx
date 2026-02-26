"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { KBPagesView } from "@/components/pidrax/PidraxKBViews";
import type { ScoreFormatOutputType, KBCategory } from "@/src/entities/models/score-format";

export default function Pass2Page() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const [data, setData] = useState<ScoreFormatOutputType | null>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/${companySlug}/pidrax?type=pass2`);
      if (res.ok) {
        const json = await res.json();
        if (json.data) setData(json.data);
        if (json.metrics) setMetrics(json.metrics);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [companySlug]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading Pass 2 results...</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6">
        <h2 className="text-lg font-semibold mb-1">No Pass 2 Results</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Refined KB pages will appear here after the second-pass pipeline has been run and data replicated.
        </p>
      </div>
    );
  }

  const allPages = [...(data.kb_pages || []), ...(data.howto_pages || [])];
  const allCategories = [...new Set(allPages.map(p => p.category))] as KBCategory[];

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-6 pb-3 shrink-0">
        <h1 className="text-xl font-semibold">Pass 2 — Refined KB</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Deduplicated, citation-repaired, and verification-grouped KB pages from the second pass.
        </p>
        {metrics && (
          <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
            {metrics.mergedCount != null && <span>Merged: {metrics.mergedCount}</span>}
            {metrics.citationsRepaired != null && <span>Citations repaired: {metrics.citationsRepaired}</span>}
            {metrics.durationMs != null && <span>Duration: {(metrics.durationMs / 1000).toFixed(1)}s</span>}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <KBPagesView pages={allPages} categories={allCategories} showSources />
      </div>
    </div>
  );
}
