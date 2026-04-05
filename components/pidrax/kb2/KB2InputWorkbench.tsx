"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Save, Loader2, CheckCircle2, FileText, Braces } from "lucide-react";

const SOURCES = [
  { key: "confluence", label: "Confluence", placeholder: "Paste Confluence wiki export text here...\n\n================================================================================\nDOCUMENT: My Page Title\n--------------------------------------------------------------------------------\nSpace:        Engineering\nAuthor:       Someone\n..." },
  { key: "jira", label: "Jira", placeholder: "Paste Jira ticket export text here...\n\n================================================================================\nPAW-1\n--------------------------------------------------------------------------------\nTitle:        My Ticket Title\nType:         Story\nStatus:       Done\n..." },
  { key: "github", label: "GitHub", placeholder: "Paste GitHub PR export text here...\n\n================================================================================\nPR #12 — Fix something\n--------------------------------------------------------------------------------\nRepository: org/repo\nBranch: fix/something -> main\nAuthor: Someone\n..." },
  { key: "slack", label: "Slack", placeholder: "Paste Slack export text here...\n\n================================================================================\n#general | 2023-01-09 10:12 AM\n--------------------------------------------------------------------------------\nSarah: Hello everyone!\n\nMatt [10:14 AM]: hey!" },
  { key: "customerFeedback", label: "Webform", placeholder: "Paste customer feedback text here...\n\n================================================================================\nSubmission #1\n--------------------------------------------------------------------------------\nName:       Lisa M.\nEmail:      lisa@example.com\nDate:       2024-06-03\nSubject:    My feedback\n\nMessage:\nHello, I have a suggestion..." },
] as const;

interface SavedState {
  [source: string]: {
    exists: boolean;
    charCount: number;
    updatedAt?: string;
    structuredAvailable?: boolean;
  };
}

interface StructuredCheck {
  matches: boolean;
  original_item_count: number;
  structured_item_count: number;
  mismatch_count: number;
  first_mismatch?: {
    index: number;
    original: string;
    structured: string;
  };
}

export function KB2InputWorkbench({ companySlug }: { companySlug: string }) {
  const [activeTab, setActiveTab] = useState<string>(SOURCES[0].key);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [structuredJsons, setStructuredJsons] = useState<Record<string, string>>({});
  const [structuredChecks, setStructuredChecks] = useState<Record<string, StructuredCheck | null>>({});
  const [viewMode, setViewMode] = useState<Record<string, "text" | "json">>({});
  const [savedState, setSavedState] = useState<SavedState>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [converting, setConverting] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const loadSaved = useCallback(async () => {
    try {
      const res = await fetch(`/api/${companySlug}/kb2/input?full=true&include_structured=true`);
      const data = await res.json();
      const sources = data.sources ?? {};
      const loaded: Record<string, string> = {};
      const loadedStructured: Record<string, string> = {};
      const loadedChecks: Record<string, StructuredCheck | null> = {};
      const state: SavedState = {};

      for (const src of SOURCES) {
        const entry = sources[src.key];
        if (entry?.data) {
          const text = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2);
          loaded[src.key] = text;
          if (entry.structured_data) {
            loadedStructured[src.key] = JSON.stringify(entry.structured_data, null, 2);
          }
          loadedChecks[src.key] = entry.structured_check ?? null;
          state[src.key] = {
            exists: true,
            charCount: text.length,
            updatedAt: entry.updated_at,
            structuredAvailable: Boolean(entry.structured_available),
          };
        } else {
          state[src.key] = { exists: false, charCount: 0, structuredAvailable: false };
        }
      }

      setTexts(loaded);
      setStructuredJsons(loadedStructured);
      setStructuredChecks(loadedChecks);
      setViewMode(Object.fromEntries(SOURCES.map((src) => [src.key, "text"])) as Record<string, "text" | "json">);
      setSavedState(state);
      setDirty({});
    } catch {
      toast.error("Failed to load saved inputs");
    } finally {
      setLoading(false);
    }
  }, [companySlug]);

  useEffect(() => { loadSaved(); }, [loadSaved]);

  const handleTextChange = (source: string, value: string) => {
    setTexts((prev) => ({ ...prev, [source]: value }));
    setDirty((prev) => ({ ...prev, [source]: true }));
    setStructuredJsons((prev) => {
      const next = { ...prev };
      delete next[source];
      return next;
    });
    setStructuredChecks((prev) => ({ ...prev, [source]: null }));
    setViewMode((prev) => ({ ...prev, [source]: "text" }));
  };

  const handleConvert = async (source: string) => {
    const text = texts[source];
    if (!text?.trim()) {
      toast.error("Nothing to convert — paste some text first");
      return;
    }

    setConverting((prev) => ({ ...prev, [source]: true }));
    try {
      const res = await fetch(`/api/${companySlug}/kb2/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "convert_preview", source, data: text }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Conversion failed");
      if (!result.structured_data) throw new Error("No structured JSON returned");

      setStructuredJsons((prev) => ({
        ...prev,
        [source]: JSON.stringify(result.structured_data, null, 2),
      }));
      setStructuredChecks((prev) => ({
        ...prev,
        [source]: result.structured_check ?? null,
      }));
      setViewMode((prev) => ({ ...prev, [source]: "json" }));
      toast.success(`Converted ${source} text to JSON`);
    } catch (err: any) {
      toast.error(err.message ?? "Conversion failed");
    } finally {
      setConverting((prev) => ({ ...prev, [source]: false }));
    }
  };

  const handleSave = async (source: string) => {
    const text = texts[source];
    if (!text?.trim()) {
      toast.error("Nothing to save — paste some text first");
      return;
    }

    setSaving((prev) => ({ ...prev, [source]: true }));
    try {
      const res = await fetch(`/api/${companySlug}/kb2/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, data: text }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Save failed");

      setSavedState((prev) => ({
        ...prev,
        [source]: {
          exists: true,
          charCount: text.length,
          updatedAt: new Date().toISOString(),
          structuredAvailable: true,
        },
      }));
      setDirty((prev) => ({ ...prev, [source]: false }));
      toast.success(`Saved ${source} data`);
    } catch (err: any) {
      toast.error(err.message ?? "Save failed");
    } finally {
      setSaving((prev) => ({ ...prev, [source]: false }));
    }
  };

  const handleSaveAll = async () => {
    const toSave = SOURCES.filter((s) => texts[s.key]?.trim());
    if (toSave.length === 0) { toast.error("No data to save"); return; }
    for (const src of toSave) {
      await handleSave(src.key);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading saved inputs...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Input Data (Human Format)</h3>
        </div>
        <Button size="sm" variant="outline" onClick={handleSaveAll} className="text-xs">
          <Save className="h-3 w-3 mr-1" /> Save All
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="h-8">
          {SOURCES.map((src) => {
            const state = savedState[src.key];
            return (
              <TabsTrigger key={src.key} value={src.key} className="text-xs px-3 gap-1.5 relative">
                {src.label}
                {state?.exists && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
                )}
                {dirty[src.key] && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 inline-block" />
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {SOURCES.map((src) => (
          <TabsContent key={src.key} value={src.key} className="mt-2 space-y-2">
            {structuredChecks[src.key] && (
              <div className="flex items-center gap-2 text-xs">
                <Badge
                  variant="outline"
                  className={
                    structuredChecks[src.key]?.matches
                      ? "border-emerald-300 text-emerald-700"
                      : "border-red-300 text-red-700"
                  }
                >
                  {structuredChecks[src.key]?.matches
                    ? "JSON matches text"
                    : `${structuredChecks[src.key]?.mismatch_count ?? 0} mismatches`}
                </Badge>
                <span className="text-muted-foreground">
                  {structuredChecks[src.key]?.structured_item_count ?? 0} items
                </span>
                {!structuredChecks[src.key]?.matches && structuredChecks[src.key]?.first_mismatch && (
                  <span className="text-red-600">
                    first mismatch at block {Number(structuredChecks[src.key]?.first_mismatch?.index ?? 0) + 1}
                  </span>
                )}
              </div>
            )}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {savedState[src.key]?.exists ? (
                  <>
                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    <span>{savedState[src.key].charCount.toLocaleString()} chars saved</span>
                    {savedState[src.key]?.structuredAvailable && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        structured JSON ready
                      </Badge>
                    )}
                    {dirty[src.key] && <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-600 border-amber-300">unsaved changes</Badge>}
                  </>
                ) : (
                  <span>No data saved yet</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleConvert(src.key)}
                  disabled={converting[src.key] || !texts[src.key]?.trim()}
                  className="text-xs h-7"
                >
                  {converting[src.key] ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Braces className="h-3 w-3 mr-1" />}
                  Convert to JSON
                </Button>
                {structuredJsons[src.key] && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setViewMode((prev) => ({
                        ...prev,
                        [src.key]: prev[src.key] === "json" ? "text" : "json",
                      }))
                    }
                    className="text-xs h-7"
                  >
                    {viewMode[src.key] === "json" ? "Show Text" : "Show JSON"}
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => handleSave(src.key)}
                  disabled={saving[src.key] || !texts[src.key]?.trim()}
                  className="text-xs h-7"
                >
                  {saving[src.key] ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                  Save {src.label}
                </Button>
              </div>
            </div>
            <textarea
              value={viewMode[src.key] === "json" ? (structuredJsons[src.key] ?? "") : (texts[src.key] ?? "")}
              onChange={(e) => {
                if (viewMode[src.key] === "json") return;
                handleTextChange(src.key, e.target.value);
              }}
              placeholder={viewMode[src.key] === "json" ? "Structured JSON will appear here after conversion..." : src.placeholder}
              className="w-full min-h-[300px] max-h-[600px] rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              spellCheck={false}
              readOnly={viewMode[src.key] === "json"}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
