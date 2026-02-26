"use client";

import { useState, useMemo } from "react";
import { ChevronRight, ChevronDown, X, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  KB_CATEGORY_LABELS,
  type KBCategory,
  type ScoreFormatPageType,
  type AtomicItemType,
} from "@/src/entities/models/score-format";

const ITEM_TYPE_COLORS: Record<string, string> = {
  fact: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  step: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  decision: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  owner: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  conflict: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  gap: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  outdated: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  ticket: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400",
  risk: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  dependency: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
  question: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
};

const SEVERITY_COLORS: Record<string, string> = {
  S1: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  S2: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  S3: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  S4: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400",
};

const SOURCE_TYPE_STYLES: Record<string, { label: string; color: string }> = {
  confluence: { label: "Confluence", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  slack: { label: "Slack", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
  jira: { label: "Jira", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  github: { label: "GitHub", color: "bg-gray-800 text-gray-100 dark:bg-gray-700 dark:text-gray-200" },
  customer_feedback: { label: "Customer Feedback", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" },
};

const VERIFICATION_STYLES: Record<string, string> = {
  verified_authoritative: "bg-green-100 text-green-700 dark:bg-green-900/30",
  supported_multi_source: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30",
  weak_support: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30",
  needs_verification: "bg-red-100 text-red-700 dark:bg-red-900/30",
  verified_human: "bg-blue-100 text-blue-700 dark:bg-blue-900/30",
};

const CONFIDENCE_STYLES: Record<string, string> = {
  high: "bg-green-100 text-green-700 dark:bg-green-900/30",
  medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30",
  low: "bg-red-100 text-red-700 dark:bg-red-900/30",
};

function sortSectionsEmptyLast(sections: ScoreFormatPageType["sections"]) {
  return [...sections].sort((a, b) => {
    const aEmpty = !a.bullets || a.bullets.length === 0;
    const bEmpty = !b.bullets || b.bullets.length === 0;
    if (aEmpty && !bEmpty) return 1;
    if (!aEmpty && bEmpty) return -1;
    return 0;
  });
}

function AtomicItemRow({ item, onClick, isSelected }: {
  item: AtomicItemType;
  onClick?: () => void;
  isSelected?: boolean;
}) {
  const severity = item.action_routing?.severity;
  const srcCount = item.source_refs?.length || 0;

  return (
    <div
      onClick={onClick}
      className={cn(
        "flex items-start gap-1.5 px-1.5 py-1 rounded text-xs transition-colors",
        onClick && "cursor-pointer hover:bg-accent/40",
        isSelected && "ring-1 ring-primary bg-primary/5",
        !isSelected && item.verification?.status === "needs_verification" && "bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800",
      )}
    >
      <span className={cn("shrink-0 px-1 py-0.5 rounded text-[9px] font-medium uppercase leading-none", ITEM_TYPE_COLORS[item.item_type] || "bg-gray-100 text-gray-600")}>
        {item.item_type}
      </span>
      <span className="flex-1">{item.item_text}</span>
      {severity && (severity as string) !== "none" && (
        <span className={cn("shrink-0 text-[9px] px-1 py-0.5 rounded font-medium leading-none", SEVERITY_COLORS[severity] || "bg-gray-100 text-gray-600")}>
          {severity}
        </span>
      )}
      {item.action_routing?.action && item.action_routing.action !== "none" && (
        <span className={cn("shrink-0 text-[9px] px-1 py-0.5 rounded font-medium leading-none",
          item.action_routing.action === "create_jira_ticket" ? "bg-pink-100 text-pink-700 dark:bg-pink-900/30" :
          item.action_routing.action === "verify_task" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30" :
          "bg-blue-100 text-blue-700 dark:bg-blue-900/30"
        )}>{item.action_routing.action.replace(/_/g, " ")}</span>
      )}
      {srcCount > 0 && (
        <span className="shrink-0 text-[9px] text-muted-foreground/60 tabular-nums">{srcCount}s</span>
      )}
    </div>
  );
}

function SourcePanel({ item, onClose }: { item: AtomicItemType; onClose: () => void }) {
  return (
    <div className="border rounded-lg bg-card shadow-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sources &amp; Metadata</h4>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground rounded p-0.5 hover:bg-muted">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="p-3 space-y-3">
        <div className="rounded bg-muted/50 p-2">
          <div className="flex items-center gap-1.5 mb-1">
            <span className={cn("px-1 py-0.5 rounded text-[9px] font-medium uppercase leading-none", ITEM_TYPE_COLORS[item.item_type] || "bg-gray-100 text-gray-600")}>
              {item.item_type}
            </span>
          </div>
          <p className="text-xs leading-relaxed">{item.item_text}</p>
        </div>
        <div>
          <h5 className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">
            References ({item.source_refs?.length || 0})
          </h5>
          {item.source_refs && item.source_refs.length > 0 ? (
            <div className="space-y-2">
              {item.source_refs.map((ref, i) => {
                const style = SOURCE_TYPE_STYLES[ref.source_type] || { label: ref.source_type, color: "bg-gray-100 text-gray-600" };
                return (
                  <div key={i} className="border rounded-md p-2 space-y-1 hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-1.5">
                      <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0", style.color)}>{style.label}</span>
                      <span className="text-xs font-medium truncate flex-1">{ref.title}</span>
                    </div>
                    {ref.excerpt && (
                      <p className="text-[10px] text-muted-foreground italic leading-relaxed pl-1 border-l-2 border-muted-foreground/20">
                        &ldquo;{ref.excerpt}&rdquo;
                      </p>
                    )}
                    <div className="flex items-center gap-2 text-[9px] text-muted-foreground/70">
                      {ref.location && <span>{ref.location}</span>}
                      {ref.doc_id && <span className="font-mono">{ref.doc_id}</span>}
                      {ref.timestamp && <span>{ref.timestamp}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground/60 italic py-2 text-center border rounded-md bg-muted/20">
              No source references attached to this item.
            </p>
          )}
        </div>
        <div className="border-t pt-2 space-y-1.5">
          <h5 className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Verification</h5>
          <div className="flex flex-wrap gap-1.5">
            {item.verification?.status && (
              <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-medium", VERIFICATION_STYLES[item.verification.status] || "bg-gray-100 text-gray-600")}>
                {item.verification.status.replace(/_/g, " ")}
              </span>
            )}
            {item.confidence_bucket && (
              <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-medium", CONFIDENCE_STYLES[item.confidence_bucket] || "bg-gray-100 text-gray-600")}>
                confidence: {item.confidence_bucket}
              </span>
            )}
            {item.action_routing?.severity && (item.action_routing.severity as string) !== "none" && (
              <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-medium", SEVERITY_COLORS[item.action_routing.severity] || "bg-gray-100 text-gray-600")}>
                {item.action_routing.severity}
              </span>
            )}
          </div>
          {item.verification?.verifier && (
            <p className="text-[10px] text-muted-foreground">
              Assigned to: <span className="font-medium text-indigo-600 dark:text-indigo-400">@{item.verification.verifier}</span>
            </p>
          )}
          {item.action_routing?.reason && (
            <p className="text-[10px] text-muted-foreground leading-relaxed">{item.action_routing.reason}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function PageCard({ page, expanded, onToggle, onItemClick, selectedItemId }: {
  page: ScoreFormatPageType;
  expanded: boolean;
  onToggle: () => void;
  onItemClick?: (item: AtomicItemType) => void;
  selectedItemId?: string;
}) {
  const totalItems = page.sections.reduce((s, sec) => s + sec.bullets.length, 0);
  const sortedSections = sortSectionsEmptyLast(page.sections);
  return (
    <div className="border rounded-lg bg-card">
      <button onClick={onToggle} className="w-full p-2.5 flex items-center justify-between text-left">
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="font-medium text-sm">{page.title}</span>
        </div>
        <span className="text-xs text-muted-foreground">{totalItems} items</span>
      </button>
      {expanded && (
        <div className="border-t p-2.5 space-y-2">
          {sortedSections.map((section, si) => (
            <div key={si}>
              <h4 className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">{section.section_name}</h4>
              <div className="space-y-0.5">
                {section.bullets.map((item, ii) => (
                  <AtomicItemRow
                    key={item.item_id || ii}
                    item={item}
                    onClick={onItemClick ? () => onItemClick(item) : undefined}
                    isSelected={!!selectedItemId && item.item_id === selectedItemId}
                  />
                ))}
                {section.bullets.length === 0 && <p className="text-[10px] text-muted-foreground/50 italic">No data</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navigation groups — maps categories to high-level sidebar sections
// ---------------------------------------------------------------------------

type NavGroup = {
  key: string;
  label: string;
  categories: KBCategory[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    key: "company",
    label: "Company Overview",
    categories: ["company_overview", "glossary"],
  },
  {
    key: "people",
    label: "People",
    categories: ["org_map", "person", "people", "client", "clients"],
  },
  {
    key: "engineering",
    label: "Engineering",
    categories: [
      "system_architecture", "service", "integration",
      "setup_onboarding", "environments_cicd", "observability",
      "process", "processes", "decision_record",
    ],
  },
  {
    key: "projects",
    label: "Projects",
    categories: [
      "past_documented", "past_undocumented",
      "ongoing_documented", "ongoing_undocumented",
    ],
  },
  {
    key: "tickets",
    label: "Tickets",
    categories: ["ticket"],
  },
  {
    key: "proposed",
    label: "Proposed Work",
    categories: ["proposed_project", "howto_implementation", "new_projects"],
  },
];

function resolveGroup(category: string): string {
  for (const g of NAV_GROUPS) {
    if (g.categories.includes(category as KBCategory)) return g.key;
  }
  return "other";
}

export function KBPagesView({ pages, categories, showSources }: {
  pages: ScoreFormatPageType[];
  categories?: KBCategory[];
  showSources?: boolean;
}) {
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<AtomicItemType | null>(null);

  const byGroup = useMemo(() => {
    const map = new Map<string, { pages: ScoreFormatPageType[]; itemCount: number }>();
    for (const page of pages) {
      const gk = resolveGroup(page.category);
      const entry = map.get(gk) || { pages: [], itemCount: 0 };
      entry.pages.push(page);
      entry.itemCount += (page.sections || []).reduce((s, sec) => s + (sec.bullets || []).length, 0);
      map.set(gk, entry);
    }
    return map;
  }, [pages]);

  const groupsWithData = useMemo(() => {
    const result: (NavGroup & { pageCount: number; itemCount: number })[] = [];
    for (const g of NAV_GROUPS) {
      const entry = byGroup.get(g.key);
      if (entry && entry.pages.length > 0) {
        result.push({ ...g, pageCount: entry.pages.length, itemCount: entry.itemCount });
      }
    }
    const other = byGroup.get("other");
    if (other && other.pages.length > 0) {
      result.push({ key: "other", label: "Other", categories: [], pageCount: other.pages.length, itemCount: other.itemCount });
    }
    return result;
  }, [byGroup]);

  const activeGroup = selectedGroupKey || (groupsWithData.length > 0 ? groupsWithData[0].key : null);
  const activePages = activeGroup ? (byGroup.get(activeGroup)?.pages || []) : [];

  const byCategoryInGroup = useMemo(() => {
    const map = new Map<string, ScoreFormatPageType[]>();
    for (const p of activePages) {
      const list = map.get(p.category) || [];
      list.push(p);
      map.set(p.category, list);
    }
    return map;
  }, [activePages]);

  const handleItemClick = showSources
    ? (item: AtomicItemType) => setSelectedItem(prev => prev?.item_id === item.item_id ? null : item)
    : undefined;

  const totalItems = pages.reduce((s, p) => s + (p.sections || []).reduce((ss, sec) => ss + (sec.bullets || []).length, 0), 0);

  return (
    <div className="flex h-full gap-0">
      {/* Left sidebar — group navigation */}
      <div className="w-56 shrink-0 border-r flex flex-col bg-card">
        <div className="p-3 border-b">
          <p className="text-[10px] text-muted-foreground">
            {pages.length} pages &middot; {totalItems} items
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {groupsWithData.map(g => (
            <button
              key={g.key}
              onClick={() => { setSelectedGroupKey(g.key); setExpandedPage(null); setSelectedItem(null); }}
              className={cn(
                "w-full text-left rounded-md px-2.5 py-2 transition-colors",
                activeGroup === g.key
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50 text-foreground",
              )}
            >
              <span className="text-xs font-medium block">{g.label}</span>
              <span className="text-[10px] text-muted-foreground">
                {g.pageCount} {g.pageCount === 1 ? "page" : "pages"} &middot; {g.itemCount} items
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="flex gap-0 items-start h-full">
          <div className={cn("min-w-0 p-4 space-y-2 transition-all", selectedItem ? "flex-1" : "w-full")}>
            {activePages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <FileText className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-sm text-muted-foreground">Select a category from the sidebar</p>
              </div>
            ) : (
              [...byCategoryInGroup.entries()].map(([cat, catPages]) => {
                const label = KB_CATEGORY_LABELS[cat as KBCategory] || cat;
                const catItems = catPages.reduce((s, p) => s + (p.sections || []).reduce((ss, sec) => ss + (sec.bullets || []).length, 0), 0);
                return (
                  <div key={cat}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
                      <span className="text-[10px] text-muted-foreground/60">
                        {catPages.length} {catPages.length === 1 ? "page" : "pages"} &middot; {catItems} items
                      </span>
                    </div>
                    <div className="space-y-1 mb-3">
                      {catPages.map(page => (
                        <PageCard
                          key={page.page_id}
                          page={page}
                          expanded={expandedPage === page.page_id}
                          onToggle={() => setExpandedPage(expandedPage === page.page_id ? null : page.page_id)}
                          onItemClick={handleItemClick}
                          selectedItemId={selectedItem?.item_id || undefined}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {selectedItem && (
            <div className="w-[380px] shrink-0 sticky top-0 p-4 pl-0">
              <SourcePanel item={selectedItem} onClose={() => setSelectedItem(null)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
