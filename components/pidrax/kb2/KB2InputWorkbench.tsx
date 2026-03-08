"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Save, Loader2, CheckCircle2, FileText } from "lucide-react";

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
  };
}

export function KB2InputWorkbench({ companySlug }: { companySlug: string }) {
  const [activeTab, setActiveTab] = useState<string>(SOURCES[0].key);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [savedState, setSavedState] = useState<SavedState>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  const loadSaved = useCallback(async () => {
    try {
      const res = await fetch(`/api/${companySlug}/kb2/input?full=true`);
      const data = await res.json();
      const sources = data.sources ?? {};
      const loaded: Record<string, string> = {};
      const state: SavedState = {};

      for (const src of SOURCES) {
        const entry = sources[src.key];
        if (entry?.data) {
          const text = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2);
          loaded[src.key] = text;
          state[src.key] = { exists: true, charCount: text.length, updatedAt: entry.updated_at };
        } else {
          state[src.key] = { exists: false, charCount: 0 };
        }
      }

      setTexts(loaded);
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
        [source]: { exists: true, charCount: text.length, updatedAt: new Date().toISOString() },
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
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {savedState[src.key]?.exists ? (
                  <>
                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                    <span>{savedState[src.key].charCount.toLocaleString()} chars saved</span>
                    {dirty[src.key] && <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-600 border-amber-300">unsaved changes</Badge>}
                  </>
                ) : (
                  <span>No data saved yet</span>
                )}
              </div>
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
            <textarea
              value={texts[src.key] ?? ""}
              onChange={(e) => handleTextChange(src.key, e.target.value)}
              placeholder={src.placeholder}
              className="w-full min-h-[300px] max-h-[600px] rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              spellCheck={false}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
