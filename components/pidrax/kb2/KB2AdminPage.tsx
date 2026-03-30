"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { normalizeForMatch } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Play,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Terminal,
  Zap,
  DollarSign,
  Hash,
  Braces,
  FileText,
  Settings2,
  Save,
  Info,
  Ban,
  RefreshCw,
} from "lucide-react";
import { KB2RightPanel } from "./KB2RightPanel";
import { SplitLayout } from "./SplitLayout";
import { KB2InputWorkbench } from "./KB2InputWorkbench";

const KB2GraphExplorer = dynamic(
  () =>
    import("@/components/pidrax/kb2/KB2GraphExplorer").then(
      (m) => m.KB2GraphExplorer,
    ),
  { ssr: false, loading: () => <GraphPlaceholder /> },
);

function GraphPlaceholder() {
  return (
    <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
      <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading graph…
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepDef {
  name: string;
  index: number;
  pass: "pass1" | "pass2";
}

interface Run {
  run_id: string;
  title?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at?: string;
  current_step?: number;
  total_steps?: number;
  error?: string;
}

interface DemoState {
  state_id: string;
  company_slug: string;
  kind: "baseline" | "workspace" | "checkpoint";
  label: string;
  base_run_id: string;
  parent_state_id?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
}

interface DemoStateInfo {
  active_state: DemoState | null;
  states: DemoState[];
  latest_completed_run_id: string | null;
}

interface RunStep {
  step_id: string;
  run_id: string;
  pass: "pass1" | "pass2";
  step_number: number;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  execution_id?: string;
  execution_number?: number;
  parent_execution_id?: string | null;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  summary?: string;
  artifact?: unknown;
  progress_log?: { detail: string; percent: number; step_percent?: number; ts: string }[];
  metrics?: {
    llm_calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  highlight_failures?: {
    checked_at: string;
    algorithm_version: number;
    failures: string[];
    total_checked: number;
    failure_details: Array<{
      entity_key: string;
      source_ref: { source_type: string; doc_id: string; title: string; excerpt_preview: string };
      reason: string;
    }>;
  };
  judge_result?: {
    overall_score: number;
    pass: boolean;
    sub_scores: { name: string; score: number; max: number; reason: string }[];
    issues: { severity: string; message: string; entity: string | null }[];
    recommendations: string[];
    judge_model?: string;
    cross_check_model?: string;
    agreement_rate?: number;
    tokens_used?: number;
    cost_usd?: number;
    evaluated_at?: string;
    llm_judge_error?: string;
    cross_check_details?: Record<string, unknown>;
  };
}

interface LLMCall {
  call_id: string;
  model: string;
  prompt: string;
  response: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  timestamp: string;
}

interface LogEntry {
  type: string;
  detail?: string;
  percent?: number;
  step_percent?: number;
  step_id?: string;
  step_number?: number;
  total_steps?: number;
  step_name?: string;
  pass?: string;
  duration_ms?: number;
  summary?: string;
  steps_remaining?: number;
  error?: string;
  metrics?: { llm_calls?: number; input_tokens?: number; output_tokens?: number; cost_usd?: number };
  started_at?: string;
  message?: string;
  runId?: string;
  status?: string;
}

interface StepTrackerEntry {
  step_number: number;
  step_name: string;
  pass: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  started_at?: string;
  duration_ms?: number;
  summary?: string;
  error?: string;
  metrics?: { llm_calls?: number; cost_usd?: number };
}

// ---------------------------------------------------------------------------
// Input data viewer
// ---------------------------------------------------------------------------

interface RawInputSource {
  doc_count: number;
  updated_at: string;
  raw_json: string;
}

interface RawInputInfo {
  exists: boolean;
  company_slug?: string;
  sources?: Record<string, RawInputSource>;
}

const SOURCE_LABELS: Record<string, string> = {
  confluence: "Confluence",
  jira: "Jira",
  slack: "Slack",
  github: "GitHub",
  customerFeedback: "Customer Feedback",
};

function InputDataViewer({ rawInput }: { rawInput: RawInputInfo }) {
  const [expanded, setExpanded] = useState(false);
  const sources = rawInput.sources ?? {};
  const sourceKeys = Object.keys(sources);
  const [activeSource, setActiveSource] = useState<string | null>(null);

  const totalDocs = Object.values(sources).reduce((a, s) => a + s.doc_count, 0);

  return (
    <Card>
      <CardContent className="p-0">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 w-full px-3 py-2 hover:bg-accent/50 transition-colors"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <span className="text-sm font-medium">Input Data</span>
          <span className="text-xs text-muted-foreground ml-1">
            ({sourceKeys.length} source{sourceKeys.length !== 1 ? "s" : ""},{" "}
            {totalDocs} document{totalDocs !== 1 ? "s" : ""})
          </span>
        </button>

        {expanded && (
          <div className="border-t">
            {/* Source tabs */}
            <div className="flex border-b overflow-x-auto">
              {sourceKeys.map((key) => (
                <button
                  key={key}
                  onClick={() => setActiveSource(activeSource === key ? null : key)}
                  className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                    activeSource === key
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {SOURCE_LABELS[key] ?? key}
                  <span className="ml-1 text-[10px] opacity-60">
                    ({sources[key].doc_count})
                  </span>
                </button>
              ))}
            </div>

            {/* Raw JSON viewer */}
            {activeSource && sources[activeSource] && (
              <ScrollArea className="h-80">
                <pre className="p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all">
                  {sources[activeSource].raw_json}
                </pre>
              </ScrollArea>
            )}

            {!activeSource && (
              <div className="p-3 text-xs text-muted-foreground">
                Click a source tab to view raw JSON.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type AdminSection = "demo_state" | "runs" | "context" | "prompts" | "settings" | "templates" | "refinements" | "step_detail" | "input_workbench";

const ADMIN_NAV: { key: AdminSection; label: string; icon: React.ReactNode }[] = [
  { key: "demo_state", label: "Demo State", icon: <RefreshCw className="h-4 w-4" /> },
  { key: "runs", label: "Pipeline Runs", icon: <Play className="h-4 w-4" /> },
  { key: "context", label: "SE Context", icon: <Info className="h-4 w-4" /> },
  { key: "prompts", label: "Prompts", icon: <FileText className="h-4 w-4" /> },
  { key: "templates", label: "Templates", icon: <Braces className="h-4 w-4" /> },
  { key: "settings", label: "Pipeline Settings", icon: <Settings2 className="h-4 w-4" /> },
  { key: "refinements", label: "Refinements", icon: <Zap className="h-4 w-4" /> },
];

const STEP_PROMPT_MAP: Record<string, string> = {
  "Input Snapshot": "",
  "Embed Documents": "",
  "Entity Extraction": "entity_extraction",
  "Extraction Validation": "extraction_validation",
  "Entity Resolution": "entity_resolution",
  "Graph Build": "",
  "Graph Enrichment": "graph_enrichment",
  "Project & Ticket Discovery": "discovery",
  "Page Plan": "",
  "GraphRAG Retrieval": "",
  "Generate Entity Pages": "generate_entity_pages",
  "Generate Human Pages": "generate_human_pages",
  "Generate How-To Guides": "generate_howto",
  "Extract Claims": "extract_claims",
  "Create Verify Cards": "create_verify_cards",
  "Admin Refinements": "",
  "Cluster FactGroups": "cluster_factgroups",
  "Conflict Detection": "conflict_detection",
  "Evidence Upgrade": "",
  "Propagation": "propagation",
  "Finalize": "",
};

const STEP_TEMPLATE_MAP: Record<string, boolean> = {
  "Generate Entity Pages": true,
  "Generate Human Pages": true,
};

const STEP_SETTINGS_MAP: Record<string, string> = {
  "Entity Extraction": "entity_extraction",
  "Entity Resolution": "entity_resolution",
  "Embed Documents": "embed",
  "Graph Enrichment": "graph_enrichment",
  "Project & Ticket Discovery": "discovery",
  "Generate Entity Pages": "page_generation",
  "Generate Human Pages": "page_generation",
  "Generate How-To Guides": "howto",
  "Create Verify Cards": "verification",
  "Cluster FactGroups": "pass2",
  "Conflict Detection": "pass2",
  "Evidence Upgrade": "pass2",
  "Propagation": "pass2",
  "GraphRAG Retrieval": "graphrag",
};

const STEP_USES_LLM = new Set([
  "Entity Extraction", "Extraction Validation", "Entity Resolution",
  "Graph Enrichment", "Project & Ticket Discovery",
  "Generate Entity Pages", "Generate Human Pages", "Generate How-To Guides",
  "Extract Claims", "Create Verify Cards",
  "Cluster FactGroups", "Conflict Detection",
]);

export function KB2AdminPage({ companySlug }: { companySlug: string }) {
  const [activeSection, setActiveSection] = useState<AdminSection>("runs");
  const [selectedStepName, setSelectedStepName] = useState<string | null>(null);
  const [stepNavExpanded, setStepNavExpanded] = useState<{ pass1: boolean; pass2: boolean }>({ pass1: true, pass2: false });

  const [pass1Steps, setPass1Steps] = useState<StepDef[]>([]);
  const [pass2Steps, setPass2Steps] = useState<StepDef[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [demoStateInfo, setDemoStateInfo] = useState<DemoStateInfo | null>(null);
  const [demoStateLoading, setDemoStateLoading] = useState(true);
  const [demoActionLoading, setDemoActionLoading] = useState<string | null>(null);
  const [demoLabel, setDemoLabel] = useState("");
  const [demoSourceRunId, setDemoSourceRunId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [selectedExecutions, setSelectedExecutions] = useState<Record<string, string>>({});
  const [stepsLoading, setStepsLoading] = useState(false);
  const [inspectorTab, setInspectorTab] = useState("pass1");
  const [rightPanelSources, setRightPanelSources] = useState<{ source_type: string; doc_id: string; title: string; excerpt: string; section_heading?: string }[]>([]);
  const [rightPanelRunId, setRightPanelRunId] = useState<string | null>(null);

  // Config state for SE context, prompts, pipeline settings, templates, refinements
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [companyContext, setCompanyContext] = useState("");
  const [refinementFeedback, setRefinementFeedback] = useState("");
  const [profile, setProfile] = useState<Record<string, any>>({});
  const [promptEditing, setPromptEditing] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, any>>({});
  const [pipelineSettings, setPipelineSettings] = useState<Record<string, any>>({});
  const [entityTemplates, setEntityTemplates] = useState<Record<string, any>>({});
  const [kbStructure, setKbStructure] = useState<Record<string, any>>({});
  const [refinements, setRefinements] = useState<Record<string, any>>({});
  const [editingTemplateType, setEditingTemplateType] = useState<string | null>(null);
  const [judgeRerunning, setJudgeRerunning] = useState(false);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const res = await fetch(`/api/${companySlug}/kb2/config`);
      if (res.ok) {
        const data = await res.json();
        if (data.config) {
          setCompanyContext(data.config.profile?.company_context ?? "");
          setProfile(data.config.profile ?? {});
          setRefinementFeedback(data.config.refinements?.general_feedback ?? "");
          setPrompts(data.config.prompts ?? {});
          setPipelineSettings(data.config.pipeline_settings ?? {});
          setEntityTemplates(data.config.entity_templates ?? {});
          setKbStructure(data.config.kb_structure ?? {});
          setRefinements(data.config.refinements ?? {});
        }
      }
    } catch { /* ignore */ }
    finally { setConfigLoading(false); }
  }, [companySlug]);

  const saveConfigSection = async (section: string, partialData: Record<string, any>) => {
    setConfigSaving(true);
    try {
      const res = await fetch(`/api/${companySlug}/kb2/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: partialData,
          changed_by: "Solution Engineer",
          change_summary: `Updated ${section}`,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      toast.success(`${section} saved`);
    } catch (e: any) {
      toast.error("Failed to save", { description: e.message });
    } finally {
      setConfigSaving(false);
    }
  };

  // Raw input data
  const [rawInput, setRawInput] = useState<RawInputInfo | null>(null);
  const [rawInputLoading, setRawInputLoading] = useState(true);

  // Pipeline controls
  const [singleStep, setSingleStep] = useState<string>("");
  const [fromStep, setFromStep] = useState<string>("");
  const [toStep, setToStep] = useState<string>("");
  const [reuseRunId, setReuseRunId] = useState("");
  const [pipelineRunning, setPipelineRunning] = useState(false);

  // Live log
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [stepTracker, setStepTracker] = useState<StepTrackerEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // -------------------------------------------------------------------------
  // Fetch step definitions + runs + raw input on mount
  // -------------------------------------------------------------------------

  const fetchRawInput = useCallback(async () => {
    setRawInputLoading(true);
    try {
      const res = await fetch(`/api/${companySlug}/kb2?type=raw_input`);
      const data = await res.json();
      setRawInput(data);
    } catch {
      setRawInput({ exists: false });
    } finally {
      setRawInputLoading(false);
    }
  }, [companySlug]);

  const fetchStepDefs = useCallback(async () => {
    try {
      const res = await fetch(`/api/${companySlug}/kb2/run`);
      const data = await res.json();
      const p1: StepDef[] = (data.pass1Steps ?? []).map(
        (s: { name: string; index: number }) => ({ name: s.name, index: s.index, pass: "pass1" as const }),
      );
      const p2: StepDef[] = (data.pass2Steps ?? []).map(
        (s: { name: string; index: number }) => ({ name: s.name, index: s.index, pass: "pass2" as const }),
      );
      setPass1Steps(p1);
      setPass2Steps(p2);
    } catch {
      /* ignore */
    }
  }, [companySlug]);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/${companySlug}/kb2?type=runs`);
      const data = await res.json();
      setRuns(data.runs ?? []);
    } catch {
      /* ignore */
    }
  }, [companySlug]);

  const fetchDemoState = useCallback(async (showLoading = true) => {
    if (showLoading) setDemoStateLoading(true);
    try {
      const res = await fetch(`/api/${companySlug}/kb2/demo-state`);
      const data = await res.json();
      setDemoStateInfo({
        active_state: data.active_state ?? null,
        states: data.states ?? [],
        latest_completed_run_id: data.latest_completed_run_id ?? null,
      });
    } catch {
      setDemoStateInfo({
        active_state: null,
        states: [],
        latest_completed_run_id: null,
      });
    } finally {
      if (showLoading) setDemoStateLoading(false);
    }
  }, [companySlug]);

  useEffect(() => {
    fetchStepDefs();
    fetchRuns();
    fetchDemoState();
    fetchRawInput();
    loadConfig();
  }, [fetchStepDefs, fetchRuns, fetchDemoState, fetchRawInput, loadConfig]);

  const completedRuns = useMemo(
    () => runs.filter((run) => run.status === "completed"),
    [runs],
  );

  useEffect(() => {
    if (!demoSourceRunId && demoStateInfo?.latest_completed_run_id) {
      setDemoSourceRunId(demoStateInfo.latest_completed_run_id);
    }
  }, [demoSourceRunId, demoStateInfo?.latest_completed_run_id]);

  const runDemoStateAction = useCallback(
    async (
      action: string,
      body: Record<string, unknown> = {},
      successMessage = "Demo state updated",
    ) => {
      setDemoActionLoading(action);
      try {
        const res = await fetch(`/api/${companySlug}/kb2/demo-state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...body }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Action failed");
        await Promise.all([fetchRuns(), fetchDemoState(false)]);
        const baseRunId =
          data.workspace?.base_run_id
          ?? data.checkpoint?.base_run_id
          ?? data.baseline?.base_run_id
          ?? data.state?.base_run_id
          ?? demoStateInfo?.latest_completed_run_id
          ?? null;
        if (baseRunId) setSelectedRunId(baseRunId);
        if (body.label) setDemoLabel("");
        toast.success(successMessage);
        return data;
      } catch (e: any) {
        toast.error("Demo state action failed", { description: e?.message ?? "Unknown error" });
        return null;
      } finally {
        setDemoActionLoading(null);
      }
    },
    [companySlug, demoStateInfo?.latest_completed_run_id, fetchDemoState, fetchRuns],
  );

  // -------------------------------------------------------------------------
  // Fetch steps for a selected run
  // -------------------------------------------------------------------------

  const fetchRunSteps = useCallback(
    async (runId: string) => {
      setStepsLoading(true);
      try {
        const res = await fetch(
          `/api/${companySlug}/kb2?type=steps&run_id=${runId}`,
        );
        const data = await res.json();
        setRunSteps(data.steps ?? []);
      } catch {
        setRunSteps([]);
      } finally {
        setStepsLoading(false);
      }
    },
    [companySlug],
  );

  useEffect(() => {
    if (selectedRunId) fetchRunSteps(selectedRunId);
    else setRunSteps([]);
  }, [selectedRunId, fetchRunSteps]);

  // -------------------------------------------------------------------------
  // Run pipeline via SSE
  // -------------------------------------------------------------------------

  const runPipeline = useCallback(
    async (body: Record<string, unknown>) => {
      if (pipelineRunning) return;
      setPipelineRunning(true);
      setLogEntries([]);
      setStepTracker([]);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const activeRunId = (body.reuseRunId as string | undefined) ?? reuseRunId ?? selectedRunId;
      const pollInterval = setInterval(() => {
        if (activeRunId) {
          fetchRunSteps(activeRunId);
          fetchRuns();
        }
      }, 5_000);

      try {
        const res = await fetch(`/api/${companySlug}/kb2/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reuseRunId: reuseRunId || undefined,
            ...body,
          }),
          signal: ctrl.signal,
        });

        if (activeRunId) {
          setTimeout(() => { fetchRunSteps(activeRunId); fetchRuns(); }, 1_500);
        }

        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const entry: LogEntry = JSON.parse(line.slice(6));
              setLogEntries((prev) => [...prev, entry]);

              if (entry.type === "step_started") {
                setStepTracker((prev) => {
                  const existing = prev.find((s) => s.step_number === entry.step_number && s.pass === entry.pass);
                  if (existing) {
                    return prev.map((s) => s === existing ? { ...s, status: "running", started_at: entry.started_at } : s);
                  }
                  return [...prev, {
                    step_number: entry.step_number!, step_name: entry.step_name!, pass: entry.pass!,
                    status: "running", started_at: entry.started_at,
                  }];
                });
              } else if (entry.type === "step_completed") {
                setStepTracker((prev) => prev.map((s) =>
                  s.step_number === entry.step_number && s.pass === entry.pass
                    ? { ...s, status: "completed", duration_ms: entry.duration_ms, summary: entry.summary, metrics: entry.metrics }
                    : s,
                ));
              } else if (entry.type === "step_failed") {
                setStepTracker((prev) => prev.map((s) =>
                  s.step_number === entry.step_number && s.pass === entry.pass
                    ? { ...s, status: entry.error?.includes("cancelled") ? "cancelled" : "failed", duration_ms: entry.duration_ms, error: entry.error }
                    : s,
                ));
              }

              if (entry.type === "done" || entry.type === "error") {
                fetchRuns();
                fetchDemoState(false);
                if (entry.runId) {
                  setSelectedRunId(entry.runId);
                  fetchRunSteps(entry.runId);
                }
              }
            } catch {
              /* malformed event */
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Stop button was pressed — don't clear logs, just stop reading
          return;
        }
        setLogEntries((prev) => [
          ...prev,
          {
            type: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          },
        ]);
      } finally {
        clearInterval(pollInterval);
        setPipelineRunning(false);
        abortRef.current = null;
      }
    },
    [companySlug, pipelineRunning, reuseRunId, selectedRunId, fetchRuns, fetchRunSteps, fetchDemoState],
  );

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logEntries]);

  useEffect(() => {
    if (pipelineRunning || logEntries.length > 0 || runSteps.length === 0) return;
    const selectedSteps: RunStep[] = [];
    const seen = new Set<string>();
    for (const [stepId, execId] of Object.entries(selectedExecutions)) {
      if (execId === "__new__") continue;
      const step = runSteps.find((s) => s.execution_id === execId) ?? runSteps.find((s) => s.step_id === stepId);
      if (step && !seen.has(step.step_id)) {
        seen.add(step.step_id);
        selectedSteps.push(step);
      }
    }
    selectedSteps.sort((a, b) => (a.step_number ?? 0) - (b.step_number ?? 0));

    const synthetic: LogEntry[] = [];
    for (const s of selectedSteps) {
      if (s.progress_log?.length) {
        for (const p of s.progress_log) {
          synthetic.push({ type: "progress", detail: p.detail, percent: p.percent, step_percent: p.step_percent });
        }
      } else if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") {
        synthetic.push({
          type: "progress",
          detail: `[${s.pass} Step ${s.step_number}] ${s.status === "completed" ? "Completed" : s.status}: ${s.name}${s.summary ? ` — ${s.summary}` : ""}${s.duration_ms != null ? ` (${(s.duration_ms / 1000).toFixed(1)}s)` : ""}`,
          percent: 100,
        });
      }
    }
    if (synthetic.length > 0) {
      const lastRun = runs.find((r) => r.run_id === selectedRunId);
      if (lastRun?.status === "completed") {
        synthetic.push({ type: "done" as const, runId: selectedRunId } as LogEntry);
      } else if (lastRun?.status === "failed") {
        synthetic.push({ type: "error", message: lastRun.error ?? "Pipeline failed" } as LogEntry);
      }
      setLogEntries(synthetic);
    }
  }, [runSteps, pipelineRunning, selectedRunId, runs, selectedExecutions]);

  // -------------------------------------------------------------------------
  // All step names for dropdowns
  // -------------------------------------------------------------------------

  const allSteps = [...pass1Steps, ...pass2Steps];

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const statusBadge = (status: string) => {
    switch (status) {
      case "running":
        return (
          <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/25 text-[10px]">
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
            Running
          </Badge>
        );
      case "completed":
        return (
          <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/25 text-[10px]">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Completed
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive" className="text-[10px]">
            <XCircle className="h-3 w-3 mr-1" />
            Failed
          </Badge>
        );
      case "cancelled":
        return (
          <Badge className="bg-orange-500/15 text-orange-600 border-orange-500/25 text-[10px]">
            <Ban className="h-3 w-3 mr-1" />
            Cancelled
          </Badge>
        );
      case "pending":
        return (
          <Badge variant="secondary" className="text-[10px]">
            <Clock className="h-3 w-3 mr-1" />
            Pending
          </Badge>
        );
      default:
        return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
    }
  };

  // fmtDate is defined as module-level helper below

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const stepExecutions = useMemo(() => {
    const map: Record<string, RunStep[]> = {};
    for (const s of runSteps) {
      (map[s.step_id] ??= []).push(s);
    }
    for (const arr of Object.values(map)) {
      arr.sort((a, b) => (a.execution_number ?? 1) - (b.execution_number ?? 1));
    }
    return map;
  }, [runSteps]);

  useEffect(() => {
    if (runSteps.length === 0) { setSelectedExecutions({}); return; }
    setSelectedExecutions((prev) => {
      const next = { ...prev };
      for (const [stepId, execs] of Object.entries(stepExecutions)) {
        const latest = execs[execs.length - 1];
        const latestId = latest.execution_id ?? latest.step_id;
        const current = prev[stepId];
        if (!current || current === "__new__" || !execs.some((e) => (e.execution_id ?? e.step_id) === current)) {
          next[stepId] = latestId;
        }
      }
      for (const key of Object.keys(next)) {
        if (!stepExecutions[key]) delete next[key];
      }
      return next;
    });
  }, [runSteps, stepExecutions]);

  const selectSubRun = useCallback((stepId: string, executionId: string) => {
    setSelectedExecutions((prev) => {
      const next = { ...prev, [stepId]: executionId };
      const selected = runSteps.find((s) => s.execution_id === executionId);
      if (!selected) return next;
      const stepIds = Object.keys(stepExecutions).sort();
      const idx = stepIds.indexOf(stepId);
      let parentExecId = executionId;
      for (let i = idx + 1; i < stepIds.length; i++) {
        const downId = stepIds[i];
        const execs = stepExecutions[downId] ?? [];
        const children = execs.filter((e) => e.parent_execution_id === parentExecId);
        if (children.length > 0) {
          const pick = children[children.length - 1];
          next[downId] = pick.execution_id;
          parentExecId = pick.execution_id;
        } else if (execs.length > 0) {
          next[downId] = execs[execs.length - 1].execution_id;
          parentExecId = next[downId];
        }
      }
      return next;
    });
  }, [runSteps, stepExecutions]);

  const getSelectedStep = useCallback((stepKey: string): RunStep | undefined => {
    const execId = selectedExecutions[stepKey];
    if (execId === "__new__") return undefined;
    if (execId) {
      const byExec = runSteps.find((s) => s.execution_id === execId);
      if (byExec) return byExec;
    }
    return runSteps.find((s) => s.step_id === stepKey);
  }, [runSteps, selectedExecutions]);

  const pass1StepIds = useMemo(() => Object.keys(stepExecutions).filter((k) => k.startsWith("pass1")).sort(), [stepExecutions]);
  const pass2StepIds = useMemo(() => Object.keys(stepExecutions).filter((k) => k.startsWith("pass2")).sort(), [stepExecutions]);
  const pass1RunSteps = useMemo(() => pass1StepIds.map((id) => getSelectedStep(id)).filter(Boolean) as RunStep[], [pass1StepIds, getSelectedStep]);
  const pass2RunSteps = useMemo(() => pass2StepIds.map((id) => getSelectedStep(id)).filter(Boolean) as RunStep[], [pass2StepIds, getSelectedStep]);

  const PROMPT_SECTIONS: { heading: string; keys: { key: string; label: string; subKeys?: string[] }[] }[] = [
    {
      heading: "Pass 1 — Pipeline Prompts",
      keys: [
        { key: "entity_extraction", label: "Entity Extraction" },
        { key: "entity_resolution", label: "Entity Resolution" },
        { key: "extraction_validation", label: "Extraction Validation", subKeys: ["system_attr_inference", "system_gap", "system_judge"] },
        { key: "discovery", label: "Discovery" },
        { key: "graph_enrichment", label: "Graph Enrichment" },
        { key: "generate_entity_pages", label: "Entity Page Generation" },
        { key: "generate_human_pages", label: "Human Page Generation" },
        { key: "generate_howto", label: "How-To Generation (Pipeline)" },
        { key: "extract_claims", label: "Claim Extraction" },
        { key: "create_verify_cards", label: "Verify Card Creation" },
      ],
    },
    {
      heading: "Pass 2 — Refinement Prompts",
      keys: [
        { key: "cluster_factgroups", label: "Cluster Factgroups" },
        { key: "conflict_detection", label: "Conflict Detection" },
      ],
    },
    {
      heading: "Feature Prompts",
      keys: [
        { key: "verify_analyst", label: "Verify — Analyst" },
        { key: "verify_editor", label: "Verify — Editor" },
        { key: "verify_check", label: "Verify — Check" },
        { key: "chat", label: "Chat" },
        { key: "ticket_generation", label: "Ticket Generation" },
        { key: "howto_on_demand", label: "How-To (On-Demand)" },
        { key: "impact_analysis", label: "Impact Analysis" },
        { key: "propagation", label: "Propagation" },
        { key: "execute_coding", label: "Execute — Coding Agent" },
        { key: "execute_generic", label: "Execute — Generic Agent" },
      ],
    },
    {
      heading: "Sync Prompts",
      keys: [
        { key: "sync_entity_extraction", label: "Sync Entity Extraction" },
        { key: "sync_entity_resolution", label: "Sync Entity Resolution" },
      ],
    },
  ];

  const SETTINGS_SECTIONS: { heading: string; settingsKey: string; fields: { key: string; label: string; type: "number" | "boolean" | "text" }[] }[] = [
    {
      heading: "Entity Extraction",
      settingsKey: "entity_extraction",
      fields: [
        { key: "default_batch_size", label: "Default Batch Size", type: "number" },
        { key: "dense_batch_size", label: "Dense Content Batch Size", type: "number" },
        { key: "evidence_excerpt_max_length", label: "Evidence Excerpt Max Length", type: "number" },
      ],
    },
    {
      heading: "Entity Resolution",
      settingsKey: "entity_resolution",
      fields: [
        { key: "similarity_threshold", label: "Similarity Threshold", type: "number" },
        { key: "llm_batch_size", label: "LLM Batch Size", type: "number" },
        { key: "auto_merge_first_names", label: "Auto-Merge First Names", type: "boolean" },
        { key: "auto_merge_dotted_names", label: "Auto-Merge Dotted Names", type: "boolean" },
      ],
    },
    {
      heading: "Discovery",
      settingsKey: "discovery",
      fields: [
        { key: "batch_size", label: "Batch Size", type: "number" },
        { key: "content_cap_per_doc", label: "Content Cap Per Doc", type: "number" },
      ],
    },
    {
      heading: "Page Generation",
      settingsKey: "page_generation",
      fields: [
        { key: "doc_snippets_per_entity_page", label: "Doc Snippets Per Entity Page", type: "number" },
        { key: "vector_snippets_per_entity_page", label: "Vector Snippets Per Entity Page", type: "number" },
        { key: "max_entity_pages_per_human_page", label: "Max Entity Pages Per Human Page", type: "number" },
      ],
    },
    {
      heading: "How-To (Pipeline)",
      settingsKey: "howto",
      fields: [
        { key: "sections", label: "Sections (comma-separated)", type: "text" },
      ],
    },
    {
      heading: "Verification",
      settingsKey: "verification",
      fields: [
        { key: "batch_size", label: "Batch Size", type: "number" },
        { key: "card_sections", label: "Card Sections (comma-separated: problem_explanation, supporting_evidence, missing_evidence, affected_entities, required_data, verification_question, recommended_action)", type: "text" },
      ],
    },
    {
      heading: "Pass 2",
      settingsKey: "pass2",
      fields: [
        { key: "cluster_similarity_threshold", label: "Cluster Similarity Threshold", type: "number" },
        { key: "cluster_max_pairs", label: "Cluster Max Pairs", type: "number" },
        { key: "conflict_batch_size", label: "Conflict Batch Size", type: "number" },
        { key: "evidence_score_threshold", label: "Evidence Score Threshold", type: "number" },
        { key: "evidence_min_hits", label: "Evidence Min Hits", type: "number" },
        { key: "propagation_chunk_size", label: "Propagation Chunk Size", type: "number" },
      ],
    },
    {
      heading: "Embedding",
      settingsKey: "embed",
      fields: [
        { key: "chunk_size", label: "Chunk Size", type: "number" },
        { key: "chunk_overlap", label: "Chunk Overlap", type: "number" },
        { key: "embed_batch_size", label: "Embed Batch Size", type: "number" },
      ],
    },
    {
      heading: "GraphRAG",
      settingsKey: "graphrag",
      fields: [
        { key: "vector_top_k", label: "Vector Top-K", type: "number" },
        { key: "neighbor_edges_limit", label: "Neighbor Edges Limit", type: "number" },
        { key: "related_nodes_limit", label: "Related Nodes Limit", type: "number" },
        { key: "doc_snippet_length", label: "Doc Snippet Length", type: "number" },
        { key: "doc_snippets_limit", label: "Doc Snippets Limit", type: "number" },
      ],
    },
    {
      heading: "Graph Enrichment",
      settingsKey: "graph_enrichment",
      fields: [
        { key: "batch_size", label: "Batch Size", type: "number" },
        { key: "edge_weight", label: "Default Edge Weight", type: "number" },
      ],
    },
    {
      heading: "Chat",
      settingsKey: "chat",
      fields: [
        { key: "graph_node_limit", label: "Graph Node Limit", type: "number" },
        { key: "edge_limit", label: "Edge Limit", type: "number" },
        { key: "entity_page_limit", label: "Entity Page Limit", type: "number" },
        { key: "human_page_limit", label: "Human Page Limit", type: "number" },
        { key: "page_context_length", label: "Page Context Length", type: "number" },
        { key: "vector_limit", label: "Vector Search Limit", type: "number" },
        { key: "vector_score_threshold", label: "Vector Score Threshold", type: "number" },
        { key: "rag_context_length", label: "RAG Context Length", type: "number" },
        { key: "max_output_tokens", label: "Max Output Tokens", type: "number" },
      ],
    },
    {
      heading: "Verify Check",
      settingsKey: "verify_check",
      fields: [
        { key: "batch_size", label: "Batch Size", type: "number" },
        { key: "max_tokens", label: "Max Tokens", type: "number" },
      ],
    },
    {
      heading: "Ticket Generation",
      settingsKey: "ticket_generation",
      fields: [
        { key: "node_limit", label: "Node Limit", type: "number" },
        { key: "existing_tickets_limit", label: "Existing Tickets Limit", type: "number" },
        { key: "feedback_max_length", label: "Feedback Max Length", type: "number" },
      ],
    },
    {
      heading: "How-To (On-Demand)",
      settingsKey: "howto_on_demand",
      fields: [
        { key: "edges_limit", label: "Edges Limit", type: "number" },
        { key: "related_nodes_limit", label: "Related Nodes Limit", type: "number" },
        { key: "max_output_tokens", label: "Max Output Tokens", type: "number" },
      ],
    },
    {
      heading: "Impact Analysis",
      settingsKey: "impact",
      fields: [
        { key: "edges_limit", label: "Edges Limit", type: "number" },
        { key: "related_pages_limit", label: "Related Pages Limit", type: "number" },
        { key: "min_value_length", label: "Min Value Length", type: "number" },
      ],
    },
    {
      heading: "Models",
      settingsKey: "models",
      fields: [
        { key: "fast", label: "Fast Model", type: "text" },
        { key: "reasoning", label: "Reasoning Model", type: "text" },
        { key: "judge", label: "Judge / Cross-Check Model", type: "text" },
      ],
    },
  ];

  const renderSEContext = () => (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold">Solution Engineer Context</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Write what you know about this company to ground the LLM during pipeline runs.
        </p>
      </div>
      <Card>
        <CardHeader>
          <Label className="text-sm font-medium">Company Context (injected into LLM prompts)</Label>
        </CardHeader>
        <CardContent>
          <Textarea
            value={companyContext}
            onChange={(e) => setCompanyContext(e.target.value)}
            placeholder="This company builds a pet adoption platform. They have a web app (Next.js), mobile app (React Native), and a Django API backend. The team is 6 engineers. Their main pain points are..."
            rows={10}
            className="resize-y font-mono text-sm"
          />
          <Button
            className="mt-4 gap-2"
            onClick={() => saveConfigSection("Company Context", { profile: { company_context: companyContext } })}
            disabled={configSaving}
          >
            {configSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Context
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Label className="text-sm font-medium">Refinement Feedback</Label>
          <p className="text-xs text-muted-foreground">
            After Pass 1, write general feedback here. This gets used in Pass 2's Admin Refinements step.
          </p>
        </CardHeader>
        <CardContent>
          <Textarea
            value={refinementFeedback}
            onChange={(e) => setRefinementFeedback(e.target.value)}
            placeholder='The entity pages look good. Remove the "legacy-importer" entity, it was decommissioned. Merge all Redis-related cloud resources into one. The client segments need to be broader...'
            rows={6}
            className="resize-y font-mono text-sm"
          />
          <Button
            className="mt-4 gap-2"
            onClick={() => saveConfigSection("Refinement Feedback", { refinements: { general_feedback: refinementFeedback } })}
            disabled={configSaving}
          >
            {configSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Feedback
          </Button>
        </CardContent>
      </Card>
    </div>
  );

  const renderPromptCard = (key: string, label: string, subKeys?: string[]) => {
    const entry = prompts[key];
    if (entry === null || entry === undefined) return null;
    const isEditing = promptEditing === key;
    const fields = subKeys && subKeys.length > 0
      ? subKeys
      : typeof entry === "object" ? Object.keys(entry).filter((k) => typeof entry[k] === "string") : ["system"];

    const totalChars = fields.reduce((acc, f) => acc + (entry?.[f]?.length ?? 0), 0);

    return (
      <Card key={key}>
        <button
          className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-accent/30 transition-colors"
          onClick={() => setPromptEditing(isEditing ? null : key)}
        >
          {isEditing ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted-foreground ml-auto">
            {totalChars} chars · {fields.length} field{fields.length > 1 ? "s" : ""}
          </span>
        </button>
        {isEditing && (
          <CardContent className="pt-0 pb-4 border-t space-y-3">
            {fields.map((field) => (
              <div key={field}>
                {fields.length > 1 && (
                  <Label className="text-xs text-muted-foreground mb-1 block">{field}</Label>
                )}
                <Textarea
                  value={entry?.[field] ?? ""}
                  onChange={(e) => {
                    const updated = { ...prompts };
                    updated[key] = { ...(entry ?? {}), [field]: e.target.value };
                    setPrompts(updated);
                  }}
                  rows={12}
                  className="font-mono text-xs resize-y"
                />
              </div>
            ))}
            <Button
              size="sm"
              onClick={() => saveConfigSection("Prompts", { prompts })}
              disabled={configSaving}
              className="gap-2"
            >
              {configSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save All Prompts
            </Button>
          </CardContent>
        )}
      </Card>
    );
  };

  const renderPromptsEditor = () => (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-semibold">Prompt Editor</h2>
        <p className="text-sm text-muted-foreground mt-1">
          View and edit every system prompt in the pipeline and features. Organized by phase.
        </p>
      </div>
      {PROMPT_SECTIONS.map((section) => (
        <div key={section.heading}>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2 mt-4">{section.heading}</h3>
          <div className="space-y-1.5">
            {section.keys.map((p) => renderPromptCard(p.key, p.label, p.subKeys))}
          </div>
        </div>
      ))}
    </div>
  );

  const updateSetting = (sectionKey: string, fieldKey: string, value: any) => {
    setPipelineSettings((prev) => ({
      ...prev,
      [sectionKey]: { ...(prev[sectionKey] ?? {}), [fieldKey]: value },
    }));
  };

  const renderPipelineSettings = () => (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Pipeline Settings</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Adjust batch sizes, thresholds, limits, and model selections. Changes affect future runs only.
          </p>
        </div>
        <Button
          onClick={() => saveConfigSection("Pipeline Settings", { pipeline_settings: pipelineSettings })}
          disabled={configSaving}
          className="gap-2"
        >
          {configSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Settings
        </Button>
      </div>
      {SETTINGS_SECTIONS.map((section) => {
        const sectionData = pipelineSettings[section.settingsKey] ?? {};
        return (
          <Card key={section.settingsKey}>
            <CardHeader className="pb-3">
              <h3 className="text-sm font-semibold">{section.heading}</h3>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {section.fields.map((field) => {
                  const val = sectionData[field.key];
                  if (field.type === "boolean") {
                    return (
                      <div key={field.key} className="flex items-center justify-between rounded-md border px-3 py-2">
                        <Label className="text-xs">{field.label}</Label>
                        <input
                          type="checkbox"
                          checked={val ?? false}
                          onChange={(e) => updateSetting(section.settingsKey, field.key, e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                      </div>
                    );
                  }
                  if (field.type === "text") {
                    const displayVal = Array.isArray(val) ? val.join(", ") : String(val ?? "");
                    return (
                      <div key={field.key} className="space-y-1">
                        <Label className="text-xs text-muted-foreground">{field.label}</Label>
                        <input
                          type="text"
                          value={displayVal}
                          onChange={(e) => {
                            const v = field.key === "sections"
                              ? e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean)
                              : e.target.value;
                            updateSetting(section.settingsKey, field.key, v);
                          }}
                          className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                        />
                      </div>
                    );
                  }
                  return (
                    <div key={field.key} className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{field.label}</Label>
                      <input
                        type="number"
                        value={val ?? ""}
                        onChange={(e) => updateSetting(section.settingsKey, field.key, Number(e.target.value))}
                        step={field.key.includes("threshold") || field.key.includes("weight") ? 0.01 : 1}
                        className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-mono"
                      />
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );

  const renderTemplatesEditor = () => {
    const templateTypes = Object.keys(entityTemplates);

    return (
      <div className="p-6 space-y-6 max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Entity Templates</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Define the section structure for each entity type&apos;s knowledge base page.
            </p>
          </div>
          <Button
            onClick={() => saveConfigSection("Entity Templates", { entity_templates: entityTemplates })}
            disabled={configSaving}
            className="gap-2"
          >
            {configSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Templates
          </Button>
        </div>
        <div className="space-y-2">
          {templateTypes.map((type) => {
            const tmpl = entityTemplates[type];
            if (!tmpl) return null;
            const isOpen = editingTemplateType === type;
            return (
              <Card key={type}>
                <button
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-accent/30 transition-colors"
                  onClick={() => setEditingTemplateType(isOpen ? null : type)}
                >
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <Badge variant="secondary" className="text-[10px]">{type.replace(/_/g, " ")}</Badge>
                  <span className="text-sm font-medium">{tmpl.description ?? type}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {tmpl.sections?.length ?? 0} sections
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${tmpl.enabled !== false ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                    {tmpl.enabled !== false ? "Enabled" : "Disabled"}
                  </span>
                </button>
                {isOpen && (
                  <CardContent className="pt-0 pb-4 border-t space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Description</Label>
                        <input
                          type="text"
                          value={tmpl.description ?? ""}
                          onChange={(e) => setEntityTemplates((p) => ({
                            ...p, [type]: { ...tmpl, description: e.target.value },
                          }))}
                          className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="text-xs">Enabled</Label>
                        <input
                          type="checkbox"
                          checked={tmpl.enabled !== false}
                          onChange={(e) => setEntityTemplates((p) => ({
                            ...p, [type]: { ...tmpl, enabled: e.target.checked },
                          }))}
                          className="h-4 w-4"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Include Rules</Label>
                      <Textarea
                        value={tmpl.includeRules ?? ""}
                        onChange={(e) => setEntityTemplates((p) => ({
                          ...p, [type]: { ...tmpl, includeRules: e.target.value },
                        }))}
                        rows={2}
                        className="font-mono text-xs resize-y"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Exclude Rules</Label>
                      <Textarea
                        value={tmpl.excludeRules ?? ""}
                        onChange={(e) => setEntityTemplates((p) => ({
                          ...p, [type]: { ...tmpl, excludeRules: e.target.value },
                        }))}
                        rows={2}
                        className="font-mono text-xs resize-y"
                      />
                    </div>
                    <div>
                      <Label className="text-xs mb-2 block">Sections ({tmpl.sections?.length ?? 0})</Label>
                      <div className="space-y-2">
                        {(tmpl.sections ?? []).map((sec: any, si: number) => (
                          <div key={si} className="rounded border p-2 text-xs space-y-1.5">
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={sec.title ?? ""}
                                onChange={(e) => {
                                  const sections = [...(tmpl.sections ?? [])];
                                  sections[si] = { ...sections[si], title: e.target.value };
                                  setEntityTemplates((p) => ({ ...p, [type]: { ...tmpl, sections } }));
                                }}
                                className="flex h-7 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs font-medium"
                                placeholder="Section Title"
                              />
                              <Badge variant="outline" className="text-[9px] shrink-0">
                                {sec.requirement ?? "required"}
                              </Badge>
                              <button
                                onClick={() => {
                                  const sections = (tmpl.sections ?? []).filter((_: any, i: number) => i !== si);
                                  setEntityTemplates((p) => ({ ...p, [type]: { ...tmpl, sections } }));
                                }}
                                className="text-red-500 hover:text-red-700 text-xs px-1"
                              >
                                &times;
                              </button>
                            </div>
                            <input
                              type="text"
                              value={sec.prompt ?? ""}
                              onChange={(e) => {
                                const sections = [...(tmpl.sections ?? [])];
                                sections[si] = { ...sections[si], prompt: e.target.value };
                                setEntityTemplates((p) => ({ ...p, [type]: { ...tmpl, sections } }));
                              }}
                              className="flex h-7 w-full rounded-md border border-input bg-background px-2 py-1 text-[11px] text-muted-foreground"
                              placeholder="Prompt for this section..."
                            />
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs"
                          onClick={() => {
                            const sections = [...(tmpl.sections ?? []), { title: "New Section", prompt: "", requirement: "optional", items: { min: 1, max: 5, style: "bullets" } }];
                            setEntityTemplates((p) => ({ ...p, [type]: { ...tmpl, sections } }));
                          }}
                        >
                          + Add Section
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    );
  };

  const renderRefinements = () => {
    const merges = refinements.entity_merges ?? [];
    const removals = refinements.entity_removals ?? [];
    const discoveries = refinements.discovery_decisions ?? [];

    return (
      <div className="p-6 space-y-6 max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Admin Refinements</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Define entity merges, removals, and discovery decisions that will be applied during Pass 2.
            </p>
          </div>
          <Button
            onClick={() => saveConfigSection("Refinements", { refinements })}
            disabled={configSaving}
            className="gap-2"
          >
            {configSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Refinements
          </Button>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <h3 className="text-sm font-semibold">Entity Merges</h3>
            <p className="text-xs text-muted-foreground">Specify entities that should be merged into a canonical name.</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {merges.map((m: any, i: number) => (
              <div key={i} className="flex items-center gap-2 rounded border p-2">
                <div className="flex-1 space-y-1">
                  <input
                    type="text"
                    value={m.keep_name ?? ""}
                    onChange={(e) => {
                      const updated = [...merges];
                      updated[i] = { ...updated[i], keep_name: e.target.value };
                      setRefinements((p) => ({ ...p, entity_merges: updated }));
                    }}
                    className="flex h-7 w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-medium"
                    placeholder="Canonical name"
                  />
                  <input
                    type="text"
                    value={(m.merge_names ?? []).join(", ")}
                    onChange={(e) => {
                      const updated = [...merges];
                      updated[i] = { ...updated[i], merge_names: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) };
                      setRefinements((p) => ({ ...p, entity_merges: updated }));
                    }}
                    className="flex h-7 w-full rounded-md border border-input bg-background px-2 py-1 text-[11px] text-muted-foreground"
                    placeholder="Names to merge (comma-separated)"
                  />
                </div>
                <button
                  onClick={() => {
                    setRefinements((p) => ({ ...p, entity_merges: merges.filter((_: any, j: number) => j !== i) }));
                  }}
                  className="text-red-500 hover:text-red-700 text-sm px-2"
                >
                  &times;
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setRefinements((p) => ({
                ...p, entity_merges: [...merges, { keep_name: "", merge_names: [] }],
              }))}
            >
              + Add Merge
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <h3 className="text-sm font-semibold">Entity Removals</h3>
            <p className="text-xs text-muted-foreground">Entities to remove from the knowledge graph.</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {removals.map((r: any, i: number) => (
              <div key={i} className="flex items-center gap-2 rounded border p-2">
                <input
                  type="text"
                  value={r.display_name ?? ""}
                  onChange={(e) => {
                    const updated = [...removals];
                    updated[i] = { ...updated[i], display_name: e.target.value };
                    setRefinements((p) => ({ ...p, entity_removals: updated }));
                  }}
                  className="flex h-7 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
                  placeholder="Entity name"
                />
                <input
                  type="text"
                  value={r.reason ?? ""}
                  onChange={(e) => {
                    const updated = [...removals];
                    updated[i] = { ...updated[i], reason: e.target.value };
                    setRefinements((p) => ({ ...p, entity_removals: updated }));
                  }}
                  className="flex h-7 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground"
                  placeholder="Reason"
                />
                <button
                  onClick={() => setRefinements((p) => ({ ...p, entity_removals: removals.filter((_: any, j: number) => j !== i) }))}
                  className="text-red-500 hover:text-red-700 text-sm px-2"
                >
                  &times;
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setRefinements((p) => ({
                ...p, entity_removals: [...removals, { display_name: "", reason: "" }],
              }))}
            >
              + Add Removal
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <h3 className="text-sm font-semibold">Discovery Decisions</h3>
            <p className="text-xs text-muted-foreground">Accept or reject discovered projects and tickets.</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {discoveries.map((d: any, i: number) => (
              <div key={i} className="flex items-center gap-2 rounded border p-2">
                <input
                  type="text"
                  value={d.display_name ?? ""}
                  onChange={(e) => {
                    const updated = [...discoveries];
                    updated[i] = { ...updated[i], display_name: e.target.value };
                    setRefinements((p) => ({ ...p, discovery_decisions: updated }));
                  }}
                  className="flex h-7 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
                  placeholder="Discovery name"
                />
                <select
                  value={d.accepted ? "accept" : "reject"}
                  onChange={(e) => {
                    const updated = [...discoveries];
                    updated[i] = { ...updated[i], accepted: e.target.value === "accept" };
                    setRefinements((p) => ({ ...p, discovery_decisions: updated }));
                  }}
                  className="flex h-7 rounded-md border border-input bg-background px-2 py-1 text-xs"
                >
                  <option value="accept">Accept</option>
                  <option value="reject">Reject</option>
                </select>
                <button
                  onClick={() => setRefinements((p) => ({ ...p, discovery_decisions: discoveries.filter((_: any, j: number) => j !== i) }))}
                  className="text-red-500 hover:text-red-700 text-sm px-2"
                >
                  &times;
                </button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setRefinements((p) => ({
                ...p, discovery_decisions: [...discoveries, { display_name: "", accepted: true }],
              }))}
            >
              + Add Decision
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <h3 className="text-sm font-semibold">General Feedback</h3>
            <p className="text-xs text-muted-foreground">Free-text feedback for the Pass 2 admin refinements step.</p>
          </CardHeader>
          <CardContent>
            <Textarea
              value={refinements.general_feedback ?? ""}
              onChange={(e) => setRefinements((p) => ({ ...p, general_feedback: e.target.value }))}
              rows={5}
              className="resize-y font-mono text-sm"
              placeholder="After looking at Pass 1 results, here are adjustments..."
            />
          </CardContent>
        </Card>
      </div>
    );
  };

  const renderDemoState = () => {
    const activeState = demoStateInfo?.active_state ?? null;
    const states = demoStateInfo?.states ?? [];
    const latestCompletedRunId = demoStateInfo?.latest_completed_run_id ?? null;
    const sourceRunId = demoSourceRunId || latestCompletedRunId || "";
    const actionBusy = demoActionLoading !== null;
    const stateCounts = states.reduce(
      (acc, state) => {
        acc[state.kind] += 1;
        return acc;
      },
      { baseline: 0, workspace: 0, checkpoint: 0 },
    );
    const kindMeta: Record<DemoState["kind"], { label: string; className: string }> = {
      baseline: {
        label: "Baseline",
        className: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
      },
      workspace: {
        label: "Workspace",
        className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
      },
      checkpoint: {
        label: "Checkpoint",
        className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
      },
    };

    return (
      <ScrollArea className="flex-1">
        <div className="p-6 max-w-5xl space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Demo State</h2>
            <p className="text-xs text-muted-foreground mt-1">
              Manage baselines, workspaces, checkpoints, and reset directly from the admin UI.
            </p>
          </div>

          {demoStateLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading demo state…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <Card>
                  <CardHeader className="pb-2">
                    <div className="text-sm font-semibold">Active State</div>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {activeState ? (
                      <>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge className={kindMeta[activeState.kind].className}>
                            {kindMeta[activeState.kind].label}
                          </Badge>
                          <Badge variant="secondary">Active</Badge>
                        </div>
                        <div className="font-medium">{activeState.label}</div>
                        <div className="text-muted-foreground">
                          Base run: <span className="font-mono">{activeState.base_run_id.slice(0, 8)}</span>
                        </div>
                        <div className="text-muted-foreground">
                          Updated: {fmtDate(activeState.updated_at)}
                        </div>
                      </>
                    ) : (
                      <p className="text-muted-foreground">No active demo state found.</p>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <div className="text-sm font-semibold">Source Run</div>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    <div className="text-muted-foreground">
                      Choose which completed run to publish or clone into a fresh workspace.
                    </div>
                    {completedRuns.length === 0 ? (
                      <div className="h-9 px-3 rounded-md border flex items-center text-muted-foreground">
                        No completed runs available
                      </div>
                    ) : (
                      <Select value={sourceRunId} onValueChange={setDemoSourceRunId}>
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue placeholder="Select source run" />
                        </SelectTrigger>
                        <SelectContent>
                          {completedRuns.map((run) => (
                            <SelectItem key={run.run_id} value={run.run_id}>
                              {run.title ?? "Untitled Run"} [{run.run_id.slice(0, 8)}]
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <div className="text-muted-foreground">
                      Latest completed:{" "}
                      {latestCompletedRunId ? (
                        <span className="font-mono">{latestCompletedRunId.slice(0, 8)}</span>
                      ) : (
                        "none"
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <div className="text-sm font-semibold">State Counts</div>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span>Baselines</span>
                      <Badge variant="secondary">{stateCounts.baseline}</Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Workspaces</span>
                      <Badge variant="secondary">{stateCounts.workspace}</Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Checkpoints</span>
                      <Badge variant="secondary">{stateCounts.checkpoint}</Badge>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">Controls</div>
                      <p className="text-xs text-muted-foreground mt-1">
                        KB edits, tickets, how-to guides, and verification changes will follow the active demo state.
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={actionBusy}
                      onClick={() => fetchDemoState()}
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1">
                    <Label htmlFor="demo-state-label">Optional Label</Label>
                    <input
                      id="demo-state-label"
                      value={demoLabel}
                      onChange={(e) => setDemoLabel(e.target.value)}
                      placeholder="Used for new workspace, checkpoint, or reset names"
                      className="w-full h-9 rounded-md border bg-background px-3 text-xs"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actionBusy || !sourceRunId}
                      onClick={() => runDemoStateAction(
                        "publish_baseline",
                        { run_id: sourceRunId },
                        "Baseline published",
                      )}
                    >
                      {demoActionLoading === "publish_baseline" ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5 mr-1" />
                      )}
                      Publish Baseline
                    </Button>

                    <Button
                      size="sm"
                      disabled={actionBusy || !sourceRunId}
                      onClick={() => runDemoStateAction(
                        "start_workspace",
                        {
                          run_id: sourceRunId,
                          label: demoLabel.trim() || undefined,
                        },
                        "Fresh workspace started",
                      )}
                    >
                      {demoActionLoading === "start_workspace" ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5 mr-1" />
                      )}
                      Start Workspace
                    </Button>

                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={actionBusy || !activeState}
                      onClick={() => runDemoStateAction(
                        "save_checkpoint",
                        { label: demoLabel.trim() || undefined },
                        "Checkpoint saved",
                      )}
                    >
                      {demoActionLoading === "save_checkpoint" ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5 mr-1" />
                      )}
                      Save Checkpoint
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actionBusy || !activeState}
                      onClick={() => runDemoStateAction(
                        "reset_workspace",
                        { label: demoLabel.trim() || undefined },
                        "Workspace reset to baseline",
                      )}
                    >
                      {demoActionLoading === "reset_workspace" ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5 mr-1" />
                      )}
                      Reset Workspace
                    </Button>
                  </div>

                  <div className="text-[11px] text-muted-foreground">
                    Completed pipeline runs auto-publish reusable baselines. Reset creates a fresh workspace from the current baseline without rerunning the pipeline.
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <div className="text-sm font-semibold">Available States</div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {states.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No demo states available yet.</p>
                  ) : (
                    states.map((state) => (
                      <div
                        key={state.state_id}
                        className={`rounded-md border p-3 text-xs ${
                          state.is_active ? "border-primary bg-accent/30" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge className={kindMeta[state.kind].className}>
                                {kindMeta[state.kind].label}
                              </Badge>
                              {state.is_active && <Badge variant="secondary">Active</Badge>}
                              {state.archived_at && <Badge variant="outline">Archived</Badge>}
                            </div>
                            <div className="font-medium truncate">{state.label}</div>
                            <div className="text-muted-foreground">
                              Base run: <span className="font-mono">{state.base_run_id.slice(0, 8)}</span>
                            </div>
                            <div className="text-muted-foreground">
                              Updated: {fmtDate(state.updated_at)}
                            </div>
                            <div className="text-muted-foreground font-mono opacity-70">
                              State ID: {state.state_id.slice(0, 8)}
                            </div>
                          </div>

                          {!state.is_active && !state.archived_at ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={actionBusy}
                              onClick={() => runDemoStateAction(
                                "activate_state",
                                { state_id: state.state_id },
                                `Activated ${state.label}`,
                              )}
                            >
                              {demoActionLoading === "activate_state" ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                              )}
                              Activate
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </ScrollArea>
    );
  };

  return (
    <SplitLayout
      autoSaveId="admin"
      mainContent={
    <div className="flex h-full">
      {/* Admin left nav */}
      <div className="w-52 border-r flex flex-col shrink-0 bg-muted/20">
        <div className="p-3 border-b">
          <h1 className="text-sm font-semibold">KB Admin</h1>
        </div>
        <ScrollArea className="flex-1">
        <div className="p-2 space-y-0.5">
          {ADMIN_NAV.map((item) => (
            <button
              key={item.key}
              onClick={() => { setActiveSection(item.key); setSelectedStepName(null); }}
              className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-xs transition-colors ${
                activeSection === item.key && !selectedStepName
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}

          <div className="border-t my-2" />
          <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Step Workbench</p>

          <button
            onClick={() => { setActiveSection("input_workbench"); setSelectedStepName(null); }}
            className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-xs transition-colors ${
              activeSection === "input_workbench" && !selectedStepName
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            Step 0 — Input Data
          </button>

          {/* Pass 1 Steps */}
          <button
            onClick={() => setStepNavExpanded((p) => ({ ...p, pass1: !p.pass1 }))}
            className="w-full text-left flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {stepNavExpanded.pass1 ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Pass 1 ({pass1Steps.length})
          </button>
          {stepNavExpanded.pass1 && pass1Steps.map((s) => (
            <button
              key={`p1-${s.index}`}
              onClick={() => { setActiveSection("step_detail"); setSelectedStepName(s.name); }}
              className={`w-full text-left flex items-center gap-1.5 pl-6 pr-2 py-1 rounded-md text-[11px] transition-colors ${
                activeSection === "step_detail" && selectedStepName === s.name
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <span className="text-[9px] font-mono w-4 shrink-0 text-right opacity-50">{s.index}</span>
              <span className="truncate">{s.name}</span>
            </button>
          ))}

          {/* Pass 2 Steps */}
          <button
            onClick={() => setStepNavExpanded((p) => ({ ...p, pass2: !p.pass2 }))}
            className="w-full text-left flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {stepNavExpanded.pass2 ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Pass 2 ({pass2Steps.length})
          </button>
          {stepNavExpanded.pass2 && pass2Steps.map((s) => (
            <button
              key={`p2-${s.index}`}
              onClick={() => { setActiveSection("step_detail"); setSelectedStepName(s.name); }}
              className={`w-full text-left flex items-center gap-1.5 pl-6 pr-2 py-1 rounded-md text-[11px] transition-colors ${
                activeSection === "step_detail" && selectedStepName === s.name
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <span className="text-[9px] font-mono w-4 shrink-0 text-right opacity-50">{s.index}</span>
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
        </ScrollArea>
      </div>

      {/* Admin section content */}
      {activeSection === "demo_state" ? (
        renderDemoState()
      ) : activeSection === "context" ? (
        <ScrollArea className="flex-1">{renderSEContext()}</ScrollArea>
      ) : activeSection === "prompts" ? (
        <ScrollArea className="flex-1">{renderPromptsEditor()}</ScrollArea>
      ) : activeSection === "templates" ? (
        <ScrollArea className="flex-1">{renderTemplatesEditor()}</ScrollArea>
      ) : activeSection === "settings" ? (
        <ScrollArea className="flex-1">{renderPipelineSettings()}</ScrollArea>
      ) : activeSection === "refinements" ? (
        <ScrollArea className="flex-1">{renderRefinements()}</ScrollArea>
      ) : activeSection === "input_workbench" ? (
        <ScrollArea className="flex-1">
          <div className="p-6 max-w-4xl space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Step 0 — Input Workbench</h2>
              <p className="text-xs text-muted-foreground mt-1">
                Paste human-format text for each source and save. This data feeds Step 1 (Input Snapshot).
              </p>
            </div>
            <KB2InputWorkbench companySlug={companySlug} />
          </div>
        </ScrollArea>
      ) : activeSection === "step_detail" && selectedStepName ? (
        <ScrollArea className="flex-1">
          <div className="p-6 max-w-4xl space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{selectedStepName}</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Step Workbench — configure, run, and inspect results
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={pipelineRunning}
                  onClick={() => {
                    const allS = [...pass1Steps.map((s) => ({ ...s, pass: "pass1" as const })), ...pass2Steps.map((s) => ({ ...s, pass: "pass2" as const }))];
                    const match = allS.find((s) => s.name === selectedStepName);
                    if (match) runPipeline({ pass: match.pass, step: match.index, reuseRunId: selectedRunId || undefined });
                  }}
                >
                  <Play className="h-3.5 w-3.5 mr-1" /> Run This Step
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!pipelineRunning}
                  onClick={async () => {
                    await fetch(`/api/${companySlug}/kb2/run`, { method: "DELETE" });
                    abortRef.current?.abort();
                    setLogEntries((prev) => [...prev, { type: "error", message: "Pipeline cancelled by user" }]);
                    setPipelineRunning(false);
                    if (selectedRunId) fetchRunSteps(selectedRunId);
                    fetchRuns();
                  }}
                >
                  <XCircle className="h-3.5 w-3.5 mr-1" /> Stop
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pipelineRunning}
                  onClick={() => {
                    const allS = [...pass1Steps.map((s) => ({ ...s, pass: "pass1" as const })), ...pass2Steps.map((s) => ({ ...s, pass: "pass2" as const }))];
                    const match = allS.find((s) => s.name === selectedStepName);
                    if (match) runPipeline({ pass: match.pass, fromStep: match.index, reuseRunId: selectedRunId || undefined });
                  }}
                >
                  Run From Here
                </Button>
              </div>
            </div>

            {/* Run selector */}
            {runs.length > 0 && (
              <Card>
                <CardContent className="py-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-medium shrink-0">Viewing run:</label>
                    <Select value={selectedRunId ?? "__none__"} onValueChange={(v) => setSelectedRunId(v === "__none__" ? null : v)}>
                      <SelectTrigger className="h-8 text-xs flex-1">
                        <SelectValue placeholder="Select a run..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">No run selected</SelectItem>
                        {runs.map((r, ri) => (
                          <SelectItem key={r.run_id} value={r.run_id}>
                            #{runs.length - ri} {r.title ? `${r.title} — ` : ""}{new Date(r.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })} ({r.status}) [{r.run_id.slice(0, 8)}]
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* Sub-run selector */}
                  {(() => {
                    const allS = [...pass1Steps.map((s) => ({ ...s, pass: "pass1" as const })), ...pass2Steps.map((s) => ({ ...s, pass: "pass2" as const }))];
                    const match = allS.find((s) => s.name === selectedStepName);
                    if (!match) return null;
                    const stepKey = `${match.pass}-step-${match.index}`;
                    const execs = selectedRunId ? (stepExecutions[stepKey] ?? []) : [];
                    const currentExecId = selectedExecutions[stepKey];
                    return (
                      <div className="flex items-center gap-3">
                        <label className="text-xs font-medium shrink-0">Sub-run:</label>
                        {!selectedRunId ? (
                          <span className="text-xs text-muted-foreground">Select a run first</span>
                        ) : execs.length === 0 ? (
                          <span className="text-xs text-muted-foreground">No executions yet — run this step to create one</span>
                        ) : (
                          <>
                            <Select value={currentExecId ?? ""} onValueChange={(v) => {
                              if (v === "__new__") {
                                setSelectedExecutions((prev) => ({ ...prev, [stepKey]: "__new__" }));
                              } else {
                                selectSubRun(stepKey, v);
                              }
                            }}>
                              <SelectTrigger className="h-7 text-xs flex-1">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__new__">+ New run (no result)</SelectItem>
                                {execs.map((ex) => (
                                  <SelectItem key={ex.execution_id ?? ex.step_id} value={ex.execution_id ?? ex.step_id}>
                                    #{ex.execution_number ?? 1} — {ex.started_at ? new Date(ex.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "?"} {ex.duration_ms != null ? `(${fmtDuration(ex.duration_ms)})` : ""} {ex.status}{ex.execution_number === execs.length ? " ★ latest" : ""}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {currentExecId === "__new__" ? "new" : `${execs.findIndex((e) => (e.execution_id ?? e.step_id) === currentExecId) + 1} of ${execs.length}`}
                            </span>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>
            )}

            <Tabs defaultValue="config" className="w-full">
              <TabsList className="w-full grid grid-cols-6">
                <TabsTrigger value="config" className="text-xs">Config</TabsTrigger>
                <TabsTrigger value="prompt" className="text-xs">Prompt</TabsTrigger>
                <TabsTrigger value="template" className="text-xs">Template</TabsTrigger>
                <TabsTrigger value="run" className="text-xs">Run Info</TabsTrigger>
                <TabsTrigger value="results" className="text-xs">Results</TabsTrigger>
                <TabsTrigger value="judge" className="text-xs">Judge</TabsTrigger>
              </TabsList>

              <TabsContent value="config" className="space-y-4 mt-4">
                {(() => {
                  const settingsKey = STEP_SETTINGS_MAP[selectedStepName];
                  const usesLLM = STEP_USES_LLM.has(selectedStepName);
                  const isEntityExtraction = selectedStepName === "Entity Extraction";
                  const hasAnything = isEntityExtraction || settingsKey || usesLLM;

                  if (!hasAnything) {
                    return <p className="text-xs text-muted-foreground">This step has no configurable settings.</p>;
                  }

                  return (
                    <>
                      {isEntityExtraction && (
                        <Card>
                          <CardHeader className="pb-2">
                            <h3 className="text-sm font-semibold">Company Info</h3>
                            <p className="text-xs text-muted-foreground">Context provided to the LLM during entity extraction. Fill these in before running the pipeline.</p>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs font-medium mb-1 block">Company Name</label>
                                <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={profile.company_name ?? ""} onChange={(e) => setProfile({ ...profile, company_name: e.target.value })} />
                              </div>
                              <div>
                                <label className="text-xs font-medium mb-1 block">Business Model</label>
                                <select className="w-full h-7 px-2 text-xs border rounded bg-background" value={profile.business_model ?? "b2c"} onChange={(e) => setProfile({ ...profile, business_model: e.target.value })}>
                                  <option value="b2b">B2B</option>
                                  <option value="b2c">B2C</option>
                                  <option value="both">Both</option>
                                  <option value="internal">Internal</option>
                                </select>
                              </div>
                            </div>
                            <div>
                              <label className="text-xs font-medium mb-1 block">Company Description</label>
                              <Textarea className="text-xs resize-y min-h-[4rem]" rows={3} value={profile.company_context ?? ""} onChange={(e) => { setProfile({ ...profile, company_context: e.target.value }); setCompanyContext(e.target.value); }} />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs font-medium mb-1 block">Jira Project Prefix</label>
                                <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={profile.project_prefix ?? ""} onChange={(e) => setProfile({ ...profile, project_prefix: e.target.value })} placeholder="e.g. PAW, BRW" />
                              </div>
                              <div>
                                <label className="text-xs font-medium mb-1 block">Product Type</label>
                                <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={profile.product_type ?? ""} onChange={(e) => setProfile({ ...profile, product_type: e.target.value })} />
                              </div>
                            </div>
                            <div>
                              <label className="text-xs font-medium mb-1 block">Known Team Members</label>
                              <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={Array.isArray(profile.known_team_members) ? profile.known_team_members.join(", ") : ""} onChange={(e) => setProfile({ ...profile, known_team_members: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) })} placeholder="First names as they appear in Slack/Jira" />
                              <p className="text-[10px] text-muted-foreground mt-0.5">Comma-separated. Helps distinguish staff from customers.</p>
                            </div>
                            <div>
                              <label className="text-xs font-medium mb-1 block">Known Repos</label>
                              <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={Array.isArray(profile.known_repos) ? profile.known_repos.join(", ") : ""} onChange={(e) => setProfile({ ...profile, known_repos: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) })} placeholder="Canonical repo names" />
                              <p className="text-[10px] text-muted-foreground mt-0.5">Prevents duplicates like pawfinder-api vs PawFinder API.</p>
                            </div>
                            <div>
                              <label className="text-xs font-medium mb-1 block">Known Client Companies</label>
                              <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={Array.isArray(profile.known_client_companies) ? profile.known_client_companies.join(", ") : ""} onChange={(e) => setProfile({ ...profile, known_client_companies: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) })} placeholder="For B2B: partner and customer org names" />
                              <p className="text-[10px] text-muted-foreground mt-0.5">Names to classify as client_company entities.</p>
                            </div>
                            <div>
                              <label className="text-xs font-medium mb-1 block">Tech Stack Notes</label>
                              <Textarea className="text-xs resize-y" rows={2} value={profile.tech_stack_notes ?? ""} onChange={(e) => setProfile({ ...profile, tech_stack_notes: e.target.value })} placeholder="e.g. 'self-host Redis, use Stripe as SaaS'" />
                              <p className="text-[10px] text-muted-foreground mt-0.5">Helps classify integration vs infrastructure.</p>
                            </div>
                            <div>
                              <label className="text-xs font-medium mb-1 block">Deployment Environments</label>
                              <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={Array.isArray(profile.deployment_environments) ? profile.deployment_environments.join(", ") : ""} onChange={(e) => setProfile({ ...profile, deployment_environments: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) })} placeholder="e.g. dev, staging, prod" />
                            </div>
                            <div>
                              <label className="text-xs font-medium mb-1 block">SE Notes</label>
                              <Textarea className="text-xs resize-y" rows={2} value={profile.se_notes ?? ""} onChange={(e) => setProfile({ ...profile, se_notes: e.target.value })} placeholder="Anything else relevant — naming conventions, special terms, known quirks" />
                            </div>
                            <Button size="sm" onClick={() => saveConfigSection("Company Profile", { profile })} disabled={configSaving}>
                              {configSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                              Save Company Info
                            </Button>
                          </CardContent>
                        </Card>
                      )}

                      {settingsKey && (() => {
                        const sectionData = pipelineSettings[settingsKey] ?? {};
                        return (
                          <Card>
                            <CardHeader className="pb-2">
                              <h3 className="text-sm font-semibold">Step Settings: {settingsKey}</h3>
                            </CardHeader>
                            <CardContent className="space-y-2">
                              {Object.entries(sectionData).map(([key, val]) => (
                                <div key={key} className="flex items-center gap-3">
                                  <label className="text-xs w-48 shrink-0 text-muted-foreground">{key}</label>
                                  <input
                                    className="flex-1 h-7 px-2 text-xs border rounded bg-background"
                                    value={typeof val === "object" ? JSON.stringify(val) : String(val ?? "")}
                                    onChange={(e) => {
                                      const newSettings = { ...pipelineSettings };
                                      const section = { ...(newSettings[settingsKey] ?? {}) };
                                      const raw = e.target.value;
                                      if (typeof val === "number") section[key] = Number(raw) || 0;
                                      else if (typeof val === "boolean") section[key] = raw === "true";
                                      else section[key] = raw;
                                      newSettings[settingsKey] = section;
                                      setPipelineSettings(newSettings);
                                    }}
                                  />
                                </div>
                              ))}
                              <Button
                                size="sm"
                                className="mt-2"
                                onClick={() => saveConfigSection(`Settings: ${settingsKey}`, { pipeline_settings: pipelineSettings })}
                                disabled={configSaving}
                              >
                                {configSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                                Save Settings
                              </Button>
                            </CardContent>
                          </Card>
                        );
                      })()}

                      {usesLLM && (() => {
                        const models = pipelineSettings.models ?? {};
                        return (
                          <Card>
                            <CardHeader className="pb-2">
                              <h3 className="text-sm font-semibold">Models</h3>
                              <p className="text-xs text-muted-foreground">LLM models used by this step.</p>
                            </CardHeader>
                            <CardContent className="space-y-2">
                              {(["fast", "reasoning", "judge"] as const).map((key) => (
                                <div key={key} className="flex items-center gap-3">
                                  <label className="text-xs w-48 shrink-0 text-muted-foreground">{key === "fast" ? "Fast Model" : key === "reasoning" ? "Reasoning Model" : "Judge / Cross-Check Model"}</label>
                                  <input
                                    className="flex-1 h-7 px-2 text-xs border rounded bg-background"
                                    value={String(models[key] ?? "")}
                                    onChange={(e) => {
                                      const newSettings = { ...pipelineSettings };
                                      newSettings.models = { ...(newSettings.models ?? {}), [key]: e.target.value };
                                      setPipelineSettings(newSettings);
                                    }}
                                  />
                                </div>
                              ))}
                              <Button
                                size="sm"
                                className="mt-2"
                                onClick={() => saveConfigSection("Models", { pipeline_settings: pipelineSettings })}
                                disabled={configSaving}
                              >
                                {configSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                                Save Models
                              </Button>
                            </CardContent>
                          </Card>
                        );
                      })()}
                    </>
                  );
                })()}
              </TabsContent>

              <TabsContent value="prompt" className="mt-4">
                {(() => {
                  const promptKey = STEP_PROMPT_MAP[selectedStepName];
                  if (!promptKey) return <p className="text-xs text-muted-foreground">This step has no configurable prompt.</p>;
                  const entry = prompts[promptKey];
                  const promptSection = PROMPT_SECTIONS
                    .flatMap(s => s.keys)
                    .find(k => k.key === promptKey);
                  const subKeys = promptSection?.subKeys;
                  const fields: [string, unknown][] = subKeys && subKeys.length > 0
                    ? subKeys.map(sk => [sk, (entry as any)?.[sk] ?? ""])
                    : typeof entry === "object"
                      ? Object.entries(entry).filter(([k]) => k !== "se_notes")
                      : [];
                  if (fields.length === 0 && !entry) return <p className="text-xs text-muted-foreground">Prompt not found in config.</p>;
                  const vars: Record<string, string> = {
                    company_name: profile.company_name ?? "",
                    company_description: profile.company_context ?? "",
                    company_context: profile.company_context ?? "",
                    business_model: profile.business_model ?? "",
                    project_prefix: profile.project_prefix ?? "",
                    known_team_members: Array.isArray(profile.known_team_members) && profile.known_team_members.length ? profile.known_team_members.join(", ") : "none specified",
                    known_repos_rule: Array.isArray(profile.known_repos) && profile.known_repos.length ? `Known repos: ${profile.known_repos.join(", ")}. Prefer these canonical names over variants.` : "",
                    known_clients_rule: Array.isArray(profile.known_client_companies) && profile.known_client_companies.length ? `Known client companies: ${profile.known_client_companies.join(", ")}. Classify these as client_company.` : "",
                    tech_stack_section: profile.tech_stack_notes ? `Tech stack notes: ${profile.tech_stack_notes}` : "",
                    environments_section: Array.isArray(profile.deployment_environments) && profile.deployment_environments.length ? `Deployment environments: ${profile.deployment_environments.join(", ")}` : "",
                    se_notes_section: profile.se_notes ? `Additional SE notes: ${profile.se_notes}` : "",
                  };
                  const renderPrompt = (text: string) => {
                    let r = text;
                    for (const [k, v] of Object.entries(vars)) {
                      if (v) r = r.replace(new RegExp(`\\$\\{${k}\\}`, "g"), v);
                      else r = r.replace(new RegExp(`\\$\\{${k}\\}\\n?`, "g"), "");
                    }
                    return r;
                  };
                  return (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-semibold">Prompts: {promptKey}</h3>
                        <Button
                          size="sm"
                          onClick={() => saveConfigSection(`Prompt: ${promptKey}`, { prompts })}
                          disabled={configSaving}
                        >
                          {configSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                          Save All
                        </Button>
                      </div>
                      {fields.map(([subKey, val]) => (
                        <Card key={subKey}>
                          <CardHeader className="py-2 px-4">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{subKey}</div>
                          </CardHeader>
                          <CardContent className="px-4 pb-4 pt-0">
                            <div className="grid grid-cols-2 gap-4">
                              <div className="flex flex-col">
                                <label className="text-[10px] font-medium mb-1 text-muted-foreground">Edit Prompt</label>
                                <Textarea
                                  value={typeof val === "string" ? val : ""}
                                  onChange={(e) => {
                                    const newPrompts = { ...prompts };
                                    const newEntry = { ...(newPrompts[promptKey] ?? {}) };
                                    (newEntry as any)[subKey] = e.target.value;
                                    newPrompts[promptKey] = newEntry;
                                    setPrompts(newPrompts);
                                  }}
                                  className="flex-1 text-xs font-mono resize-y min-h-[20rem] whitespace-pre-wrap break-words leading-relaxed"
                                />
                              </div>
                              <div className="flex flex-col">
                                <label className="text-[10px] font-medium mb-1 text-muted-foreground">Rendered (what LLM receives)</label>
                                <pre className="flex-1 text-xs font-mono bg-muted/50 rounded-md border p-3 overflow-auto whitespace-pre-wrap break-words min-h-[20rem] leading-relaxed">
                                  {typeof val === "string" && val.trim() ? renderPrompt(val) : <span className="text-muted-foreground italic">No prompt configured</span>}
                                </pre>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                      {fields.length === 0 && (
                        <p className="text-xs text-muted-foreground">No prompts configured for this step.</p>
                      )}
                    </div>
                  );
                })()}
              </TabsContent>

              <TabsContent value="template" className="space-y-4 mt-4">
                {(() => {
                  if (!STEP_TEMPLATE_MAP[selectedStepName]) {
                    return <p className="text-xs text-muted-foreground">This step does not use templates. Templates are used by Generate Entity Pages and Generate Human Pages to define what sections appear on each KB page.</p>;
                  }
                  const templates = entityTemplates ?? {};
                  const templateKeys = Object.keys(templates);
                  if (templateKeys.length === 0) return <p className="text-xs text-muted-foreground">No entity page templates configured yet.</p>;
                  return (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Section templates sent to the LLM for page generation. Click to expand and edit.</p>
                        <Button size="sm" onClick={() => saveConfigSection("Entity Templates", { entity_templates: entityTemplates })} disabled={configSaving}>
                          {configSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}
                          Save Templates
                        </Button>
                      </div>
                      {templateKeys.sort().map((type) => {
                        const t = templates[type];
                        if (!t) return null;
                        const isOpen = editingTemplateType === type;
                        return (
                          <Card key={type}>
                            <CardHeader className="pb-1 cursor-pointer" onClick={() => setEditingTemplateType(isOpen ? null : type)}>
                              <div className="flex items-center gap-2">
                                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                <span className="text-xs font-semibold">{type.replace(/_/g, " ")}</span>
                                <span className="text-[10px] text-muted-foreground">{t.sections?.length ?? 0} sections</span>
                                {!t.enabled && <Badge variant="secondary" className="text-[9px]">disabled</Badge>}
                              </div>
                            </CardHeader>
                            {isOpen && (
                              <CardContent className="pt-0 space-y-2">
                                <div>
                                  <label className="text-[10px] text-muted-foreground">Description</label>
                                  <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={t.description ?? ""} onChange={(e) => { const u = { ...entityTemplates }; u[type] = { ...t, description: e.target.value }; setEntityTemplates(u); }} />
                                </div>
                                <div>
                                  <label className="text-[10px] text-muted-foreground">Include Rules</label>
                                  <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={t.includeRules ?? ""} onChange={(e) => { const u = { ...entityTemplates }; u[type] = { ...t, includeRules: e.target.value }; setEntityTemplates(u); }} />
                                </div>
                                <div>
                                  <label className="text-[10px] text-muted-foreground">Exclude Rules</label>
                                  <input className="w-full h-7 px-2 text-xs border rounded bg-background" value={t.excludeRules ?? ""} onChange={(e) => { const u = { ...entityTemplates }; u[type] = { ...t, excludeRules: e.target.value }; setEntityTemplates(u); }} />
                                </div>
                                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-2">Sections</div>
                                {(t.sections ?? []).map((s: any, si: number) => (
                                  <div key={si} className="grid grid-cols-[120px_100px_1fr] gap-2 items-center border-b border-muted pb-1">
                                    <input className="h-6 px-1.5 text-[11px] border rounded bg-background font-medium" value={s.name ?? ""} onChange={(e) => { const u = { ...entityTemplates }; const secs = [...(u[type].sections ?? [])]; secs[si] = { ...secs[si], name: e.target.value }; u[type] = { ...u[type], sections: secs }; setEntityTemplates(u); }} />
                                    <select className="h-6 px-1 text-[10px] border rounded bg-background" value={s.requirement ?? "MUST"} onChange={(e) => { const u = { ...entityTemplates }; const secs = [...(u[type].sections ?? [])]; secs[si] = { ...secs[si], requirement: e.target.value }; u[type] = { ...u[type], sections: secs }; setEntityTemplates(u); }}>
                                      <option value="MUST">MUST</option>
                                      <option value="MUST_IF_PRESENT">MUST_IF_PRESENT</option>
                                      <option value="OPTIONAL">OPTIONAL</option>
                                    </select>
                                    <input className="h-6 px-1.5 text-[11px] border rounded bg-background" value={s.intent ?? ""} onChange={(e) => { const u = { ...entityTemplates }; const secs = [...(u[type].sections ?? [])]; secs[si] = { ...secs[si], intent: e.target.value }; u[type] = { ...u[type], sections: secs }; setEntityTemplates(u); }} />
                                  </div>
                                ))}
                              </CardContent>
                            )}
                          </Card>
                        );
                      })}
                    </div>
                  );
                })()}
              </TabsContent>

              <TabsContent value="run" className="space-y-4 mt-4">
                {(() => {
                  const allS = [...pass1Steps.map((s) => ({ ...s, pass: "pass1" as const })), ...pass2Steps.map((s) => ({ ...s, pass: "pass2" as const }))];
                  const match = allS.find((s) => s.name === selectedStepName);
                  if (!match || !selectedRunId) return <p className="text-xs text-muted-foreground">Select a run above to see step execution details.</p>;
                  const stepKey = `${match.pass}-step-${match.index}`;
                  const isNewSelected = selectedExecutions[stepKey] === "__new__";
                  const runStep = getSelectedStep(stepKey);
                  return (
                    <>
                      {runStep ? (
                        <Card>
                          <CardHeader className="pb-2">
                            <div className="flex items-center gap-2">
                              {runStep.status === "completed" ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : runStep.status === "failed" ? <XCircle className="h-4 w-4 text-red-500" /> : runStep.status === "cancelled" ? <Ban className="h-4 w-4 text-orange-500" /> : <Clock className="h-4 w-4 text-yellow-500" />}
                              <h3 className="text-sm font-semibold">{runStep.name}</h3>
                              <Badge variant={runStep.status === "completed" ? "default" : runStep.status === "failed" ? "destructive" : "secondary"} className="text-[10px]">{runStep.status}</Badge>
                            </div>
                          </CardHeader>
                          <CardContent className="space-y-2 text-xs">
                            {runStep.summary && <p>{runStep.summary}</p>}
                            <p className="text-muted-foreground">
                              {runStep.completed_at
                                ? `Completed: ${new Date(runStep.completed_at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                                : runStep.started_at
                                  ? `Started: ${new Date(runStep.started_at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                                  : null}
                              {runStep.duration_ms != null && ` (${fmtDuration(runStep.duration_ms)})`}
                            </p>
                            {runStep.metrics && (
                              <div className="flex gap-4 text-muted-foreground">
                                <span><Hash className="h-3 w-3 inline mr-0.5" />{runStep.metrics.llm_calls} LLM calls</span>
                                <span><DollarSign className="h-3 w-3 inline mr-0.5" />${runStep.metrics.cost_usd.toFixed(4)}</span>
                                <span>{runStep.metrics.input_tokens.toLocaleString()} in / {runStep.metrics.output_tokens.toLocaleString()} out tokens</span>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      ) : isNewSelected ? (
                        <Card>
                          <CardContent className="py-4">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              {pipelineRunning ? (
                                <><Loader2 className="h-4 w-4 animate-spin text-blue-500" /><span>New execution starting…</span></>
                              ) : (
                                <><Clock className="h-4 w-4" /><span>Ready for a new execution. Click &quot;Run This Step&quot; to start.</span></>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      ) : (
                        <p className="text-xs text-muted-foreground">This step has not been executed in the selected run.</p>
                      )}

                      {(() => {
                        const stepLogEntries: LogEntry[] = pipelineRunning
                          ? logEntries.filter((e) => e.step_id === stepKey || e.type === "done" || e.type === "error")
                          : (runStep?.progress_log ?? []).map((p: any) => ({ type: "progress" as const, detail: p.detail, percent: p.percent, step_percent: p.step_percent }));
                        return (
                          <Card>
                            <CardHeader className="pb-1">
                              <div className="flex items-center gap-2">
                                <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                                <h3 className="text-xs font-semibold">Run Log</h3>
                                {pipelineRunning && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}
                              </div>
                            </CardHeader>
                            <CardContent>
                              {stepLogEntries.length === 0 ? (
                                <p className="text-[11px] text-muted-foreground py-2">No log entries yet. Run a step to see live output here.</p>
                              ) : (
                                <div className="max-h-64 overflow-y-auto">
                                  <div className="font-mono text-[11px] space-y-0.5">
                                    {stepLogEntries.map((entry, i) => (
                                      <div key={i} className={entry.type === "error" ? "text-red-500" : entry.type === "done" ? "text-emerald-500 font-medium" : "text-muted-foreground"}>
                                        {entry.type === "progress" && <>{entry.percent != null && <span className="text-foreground mr-2">[{entry.percent}%]</span>}{entry.step_percent != null && entry.step_percent !== entry.percent && <span className="text-blue-500 mr-2">[Step {entry.step_percent}%]</span>}{entry.detail}</>}
                                        {entry.type === "done" && <>Pipeline completed</>}
                                        {entry.type === "error" && <>Error: {entry.message}</>}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })()}
                    </>
                  );
                })()}
              </TabsContent>

              <TabsContent value="results" className="space-y-4 mt-4">
                {(() => {
                  const allS = [...pass1Steps.map((s) => ({ ...s, pass: "pass1" as const })), ...pass2Steps.map((s) => ({ ...s, pass: "pass2" as const }))];
                  const match = allS.find((s) => s.name === selectedStepName);
                  if (!match || !selectedRunId) return <p className="text-xs text-muted-foreground">Select a run above to see results.</p>;
                  const stepKey = `${match.pass}-step-${match.index}`;
                  const isNewSelected = selectedExecutions[stepKey] === "__new__";
                  const runStep = getSelectedStep(stepKey);

                  if (isNewSelected && !runStep) {
                    return pipelineRunning ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>New execution running… results will appear when complete.</span>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">Ready for a new execution. Click &quot;Run This Step&quot; to start.</p>
                    );
                  }

                  if (runStep?.status === "running") {
                    return (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Step is running… results will appear when complete.</span>
                      </div>
                    );
                  }

                  if (!runStep?.artifact) return <p className="text-xs text-muted-foreground">No results available for this step.</p>;
                  const artifact = runStep.artifact;

                  const resultHeader = (
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground mb-2 px-1">
                      {runStep.status === "completed" && <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" /> Completed</span>}
                      {runStep.status === "failed" && <span className="flex items-center gap-1"><XCircle className="h-3 w-3 text-red-500" /> Failed</span>}
                      {runStep.status === "cancelled" && <span className="flex items-center gap-1"><Ban className="h-3 w-3 text-orange-500" /> Cancelled</span>}
                      {runStep.completed_at && <span>{new Date(runStep.completed_at).toLocaleString()}</span>}
                      {runStep.duration_ms != null && <span>{fmtDuration(runStep.duration_ms)}</span>}
                      <span className="font-mono text-[9px] opacity-60">run {selectedRunId.slice(0, 8)}</span>
                      {(runStep.execution_number ?? 1) > 1 && <span className="text-[9px] bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 px-1 rounded">sub-run #{runStep.execution_number}</span>}
                    </div>
                  );

                  const isInputSnapshotStep = selectedStepName?.toLowerCase().includes("input") && selectedStepName?.toLowerCase().includes("snapshot");
                  if (isInputSnapshotStep) {
                    return <>{resultHeader}<InputSnapshotViewer companySlug={companySlug} runId={selectedRunId} executionId={runStep?.execution_id} artifact={artifact as Record<string, unknown>} /></>;
                  }

                  const isEmbedStep = selectedStepName?.toLowerCase().includes("embed");
                  if (isEmbedStep && (artifact as any)?.by_provider) {
                    return <>{resultHeader}<EmbedDocumentsViewer artifact={artifact as any} /></>;
                  }

                  const isEntityExtractionStep = selectedStepName?.toLowerCase().includes("entity") && selectedStepName?.toLowerCase().includes("extract");
                  if (isEntityExtractionStep && (artifact as any)?.entities_by_type) {
                    return <>{resultHeader}<EntityExtractionViewer artifact={artifact as any} companySlug={companySlug} runId={selectedRunId} executionId={runStep?.execution_id} stepId={runStep?.step_id} onSelectSources={(refs) => { setRightPanelSources(refs); setRightPanelRunId(selectedRunId); }} /></>;
                  }

                  const isExtractionValidationStep = selectedStepName?.toLowerCase().includes("extraction") && selectedStepName?.toLowerCase().includes("validation");
                  if (isExtractionValidationStep && (artifact as any)?.recovery_details) {
                    return <>{resultHeader}<ExtractionValidationViewer artifact={artifact as any} companySlug={companySlug} runId={selectedRunId} executionId={runStep?.execution_id} stepId={runStep?.step_id} onSelectSources={(refs) => { setRightPanelSources(refs); setRightPanelRunId(selectedRunId); }} /></>;
                  }

                  const isEntityResolutionStep = selectedStepName?.toLowerCase().includes("entity") && selectedStepName?.toLowerCase().includes("resolution");
                  if (isEntityResolutionStep && (artifact as any)?.merges) {
                    return <>{resultHeader}<EntityResolutionViewer artifact={artifact as any} companySlug={companySlug} runId={selectedRunId} executionId={runStep?.execution_id} onSelectSources={(refs) => { setRightPanelSources(refs); setRightPanelRunId(selectedRunId); }} /></>;
                  }

                  const isGraphBuildStep = selectedStepName === "Graph Build" && (artifact as any)?.total_edges != null;
                  if (isGraphBuildStep) {
                    const a = artifact as { total_edges: number; relationship_edges: number; mentioned_in_edges: number; nodes_processed: number };
                    return (
                      <>
                        {resultHeader}
                        <div className="space-y-3">
                          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Graph Build</h4>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <div className="border rounded-md p-2 text-center">
                              <div className="text-lg font-bold">{a.nodes_processed}</div>
                              <div className="text-[10px] text-muted-foreground">Nodes Processed</div>
                            </div>
                            <div className="border rounded-md p-2 text-center">
                              <div className="text-lg font-bold">{a.total_edges}</div>
                              <div className="text-[10px] text-muted-foreground">Total Edges</div>
                            </div>
                            <div className="border rounded-md p-2 text-center">
                              <div className="text-lg font-bold">{a.relationship_edges}</div>
                              <div className="text-[10px] text-muted-foreground">Relationship Edges</div>
                            </div>
                            <div className="border rounded-md p-2 text-center">
                              <div className="text-lg font-bold">{a.mentioned_in_edges}</div>
                              <div className="text-[10px] text-muted-foreground">MENTIONED_IN Edges</div>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {a.relationship_edges > 0
                              ? `Built ${a.relationship_edges} entity-to-entity relationships from embedded _relationships attributes, plus ${a.mentioned_in_edges} document mention edges.`
                              : `No embedded _relationships found on nodes. Built ${a.mentioned_in_edges} MENTIONED_IN edges by scanning document content for entity names. Relationship edges will be discovered in Step 7 (Graph Enrichment) via LLM.`}
                          </p>
                        </div>
                      </>
                    );
                  }

                  const isGraphEnrichmentStep = selectedStepName === "Graph Enrichment" && (artifact as any)?.new_edges != null;
                  if (isGraphEnrichmentStep) {
                    return <>{resultHeader}<GraphEnrichmentViewer artifact={artifact as any} /></>;
                  }

                  if (isDiscovery({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<DiscoveryViewer artifact={artifact as any} onSelectSources={(refs) => { setRightPanelSources(refs); setRightPanelRunId(selectedRunId); }} /></>;
                  }

                  if (isAttributeCompletion({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<AttributeCompletionViewer artifact={artifact as any} /></>;
                  }

                  if (isPatternSynthesis({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<PatternSynthesisViewer artifact={artifact as any} /></>;
                  }

                  if (isGraphReEnrichment({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<GraphReEnrichmentViewer artifact={artifact as any} /></>;
                  }

                  if (isPagePlan({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<PagePlanViewer artifact={artifact as any} /></>;
                  }

                  if (isGraphRAGRetrieval({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<GraphRAGRetrievalViewer artifact={artifact as any} /></>;
                  }

                  if (isEntityPagesGenerated({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<EntityPagesGeneratedViewer artifact={artifact as any} /></>;
                  }

                  if (isHumanPagesGenerated({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<HumanPagesGeneratedViewer artifact={artifact as any} /></>;
                  }

                  if (isHowtoGenerated({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<HowtoGeneratedViewer artifact={artifact as any} /></>;
                  }

                  if (isClaimsExtracted({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<ClaimsExtractedViewer artifact={artifact as any} /></>;
                  }

                  if (isVerifyCards({ name: selectedStepName } as RunStep, artifact)) {
                    return <>{resultHeader}<VerifyCardsViewer artifact={artifact as any} /></>;
                  }

                  return (
                    <>
                      {resultHeader}
                      <Card>
                        <CardHeader className="pb-2">
                          <h3 className="text-sm font-semibold">Step Results</h3>
                        </CardHeader>
                        <CardContent>
                          <pre className="text-[11px] font-mono bg-muted/50 p-3 rounded-md overflow-auto max-h-96 whitespace-pre-wrap">
                            {JSON.stringify(artifact, null, 2)}
                          </pre>
                        </CardContent>
                      </Card>
                    </>
                  );
                })()}
              </TabsContent>

              <TabsContent value="judge" className="space-y-4 mt-4">
                {(() => {
                  const allS = [...pass1Steps.map((s) => ({ ...s, pass: "pass1" as const })), ...pass2Steps.map((s) => ({ ...s, pass: "pass2" as const }))];
                  const match = allS.find((s) => s.name === selectedStepName);
                  if (!match || !selectedRunId) return <p className="text-xs text-muted-foreground">Select a run above to see judge results.</p>;
                  const stepKey = `${match.pass}-step-${match.index}`;
                  const runStep = getSelectedStep(stepKey);

                  if (!runStep) return <p className="text-xs text-muted-foreground">No run data available for this step.</p>;
                  if (runStep.status === "running") {
                    return (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Step is running… judge results will appear when complete.</span>
                      </div>
                    );
                  }

                  const rerunJudge = async () => {
                    if (!runStep.execution_id || judgeRerunning) return;
                    setJudgeRerunning(true);
                    try {
                      const res = await fetch(`/api/${companySlug}/kb2/judge`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ executionId: runStep.execution_id }),
                      });
                      const data = await res.json();
                      if (data.judge_result) {
                        setRunSteps((prev) => prev.map((s) =>
                          s.execution_id === runStep.execution_id ? { ...s, judge_result: data.judge_result } : s,
                        ));
                        toast.success("Judge evaluation complete");
                      } else {
                        toast.error(data.error ?? "Judge rerun failed");
                      }
                    } catch (err: any) {
                      toast.error(`Judge rerun failed: ${err.message}`);
                    } finally {
                      setJudgeRerunning(false);
                    }
                  };

                  const jr = runStep.judge_result;
                  if (!jr) return (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">No judge result available for this step.</p>
                      {runStep.artifact && (
                        <Button size="sm" onClick={rerunJudge} disabled={judgeRerunning || pipelineRunning}>
                          {judgeRerunning ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1" />}
                          Run Judge
                        </Button>
                      )}
                    </div>
                  );

                  return (
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className={`text-2xl font-bold ${jr.pass ? "text-emerald-600" : "text-red-600"}`}>
                          {jr.overall_score}%
                        </div>
                        <Badge variant={jr.pass ? "default" : "destructive"} className="text-xs">
                          {jr.pass ? "PASS" : "FAIL"}
                        </Badge>
                        {jr.evaluated_at && <span className="text-[10px] text-muted-foreground">{new Date(jr.evaluated_at).toLocaleString()}</span>}
                        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" onClick={rerunJudge} disabled={judgeRerunning || pipelineRunning}>
                          {judgeRerunning ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                          Rerun Judge
                        </Button>
                      </div>

                      {jr.llm_judge_error && (
                        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-md p-3">
                          <div className="text-xs font-medium text-red-700 dark:text-red-400 mb-1">LLM Judge Error</div>
                          <pre className="text-[10px] text-red-600 dark:text-red-300 whitespace-pre-wrap">{jr.llm_judge_error}</pre>
                        </div>
                      )}

                      {jr.sub_scores.length > 0 && (
                        <Card>
                          <CardHeader className="pb-2">
                            <h3 className="text-sm font-semibold">Sub-Scores</h3>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            {jr.sub_scores.map((s, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <div className="w-40 text-xs truncate" title={s.name}>{s.name}</div>
                                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${s.score >= 80 ? "bg-emerald-500" : s.score >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                                    style={{ width: `${Math.min(100, (s.score / s.max) * 100)}%` }}
                                  />
                                </div>
                                <div className="w-10 text-xs text-right font-mono">{s.score}</div>
                                <div className="w-48 text-[10px] text-muted-foreground truncate" title={s.reason}>{s.reason}</div>
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      )}

                      {jr.issues.length > 0 && (
                        <Card>
                          <CardHeader className="pb-2">
                            <h3 className="text-sm font-semibold">Issues ({jr.issues.length})</h3>
                          </CardHeader>
                          <CardContent className="space-y-1">
                            {jr.issues.map((issue, i) => (
                              <div key={i} className={`flex items-start gap-2 text-xs rounded px-2 py-1 ${issue.severity === "high" ? "bg-red-50 dark:bg-red-950/20" : issue.severity === "medium" ? "bg-amber-50 dark:bg-amber-950/20" : "bg-muted/50"}`}>
                                <Badge variant="outline" className={`text-[9px] shrink-0 ${issue.severity === "high" ? "border-red-300 text-red-700" : issue.severity === "medium" ? "border-amber-300 text-amber-700" : "border-muted"}`}>
                                  {issue.severity}
                                </Badge>
                                <span>{issue.message}</span>
                                {issue.entity && <span className="text-muted-foreground">({issue.entity})</span>}
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      )}

                      {jr.recommendations.length > 0 && (
                        <Card>
                          <CardHeader className="pb-2">
                            <h3 className="text-sm font-semibold">Recommendations</h3>
                          </CardHeader>
                          <CardContent>
                            <ul className="list-disc list-inside space-y-1">
                              {jr.recommendations.map((r, i) => (
                                <li key={i} className="text-xs text-muted-foreground">{r}</li>
                              ))}
                            </ul>
                          </CardContent>
                        </Card>
                      )}

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                        {jr.judge_model && (
                          <div className="border rounded-md p-2">
                            <div className="text-[10px] text-muted-foreground">Judge Model</div>
                            <div className="text-xs font-mono truncate" title={jr.judge_model}>{jr.judge_model}</div>
                          </div>
                        )}
                        {jr.cross_check_model && (
                          <div className="border rounded-md p-2">
                            <div className="text-[10px] text-muted-foreground">Cross-Check</div>
                            <div className="text-xs font-mono truncate" title={jr.cross_check_model}>{jr.cross_check_model}</div>
                          </div>
                        )}
                        {jr.tokens_used != null && (
                          <div className="border rounded-md p-2">
                            <div className="text-[10px] text-muted-foreground">Tokens</div>
                            <div className="text-xs font-mono">{jr.tokens_used.toLocaleString()}</div>
                          </div>
                        )}
                        {jr.cost_usd != null && (
                          <div className="border rounded-md p-2">
                            <div className="text-[10px] text-muted-foreground">Cost</div>
                            <div className="text-xs font-mono">${jr.cost_usd.toFixed(4)}</div>
                          </div>
                        )}
                      </div>

                      {jr.cross_check_details && (() => {
                        const cc = jr.cross_check_details;
                        const eff = cc.effectiveness as Record<string, unknown> | string | undefined;
                        const verdict = typeof eff === "string" ? eff : typeof eff === "object" && eff ? String((eff as Record<string, unknown>).verdict ?? "unknown") : "unknown";
                        const perScore = (cc.per_score_comparison ?? []) as { name: string; judge_score: number; cross_check_score: number; delta: number; agreed: boolean }[];
                        const agreedCount = typeof eff === "object" && eff ? Number((eff as Record<string, unknown>).agreed_count ?? 0) : (cc.agreements as number ?? 0);
                        const disagreedCount = typeof eff === "object" && eff ? Number((eff as Record<string, unknown>).disagreed_count ?? 0) : (cc.disagreements as number ?? 0);
                        const ccIssues = (cc.unique_cross_check_issues ?? []) as ({ severity?: string; message: string; entity?: string | null } | string)[];
                        const ccRecs = (cc.unique_cross_check_recommendations ?? []) as string[];

                        return (
                          <Card>
                            <CardHeader className="pb-2">
                              <h3 className="text-sm font-semibold">Cross-Check Details</h3>
                              <Badge variant="outline" className={`text-[9px] w-fit ${verdict === "high_value" || verdict === "useful" ? "border-emerald-300 text-emerald-700" : verdict === "conflicting" || verdict === "low_value" ? "border-red-300 text-red-700" : "border-muted text-muted-foreground"}`}>
                                {verdict}
                              </Badge>
                            </CardHeader>
                            <CardContent className="space-y-3">
                              <div className="flex gap-4 text-xs">
                                <span className="text-emerald-600">{agreedCount} agreements</span>
                                <span className="text-red-600">{disagreedCount} disagreements</span>
                                {jr.agreement_rate != null && <span className="text-muted-foreground">({Math.round(jr.agreement_rate * 100)}% agreement)</span>}
                              </div>

                              {perScore.length > 0 && (
                                <div>
                                  <div className="text-[10px] font-medium mb-1">Score Comparison</div>
                                  <div className="space-y-1">
                                    {perScore.map((ps, i) => (
                                      <div key={i} className="flex items-center gap-2 text-[10px]">
                                        <span className="w-32 truncate" title={ps.name}>{ps.name}</span>
                                        <span className="font-mono w-8 text-right">{ps.judge_score}</span>
                                        <span className="text-muted-foreground">vs</span>
                                        <span className="font-mono w-8 text-right">{ps.cross_check_score}</span>
                                        <span className={`w-12 text-right ${ps.agreed ? "text-emerald-600" : "text-red-600"}`}>
                                          Δ{ps.delta}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {ccIssues.length > 0 && (
                                <div>
                                  <div className="text-[10px] font-medium mb-1">Unique Cross-Check Findings ({ccIssues.length})</div>
                                  {ccIssues.map((issue, i) => {
                                    const msg = typeof issue === "string" ? issue : issue.message;
                                    const sev = typeof issue === "string" ? undefined : issue.severity;
                                    return (
                                      <div key={i} className="text-[10px] text-muted-foreground flex gap-1">
                                        {sev && <span className={`shrink-0 ${sev === "warning" ? "text-amber-600" : sev === "error" ? "text-red-600" : "text-muted-foreground"}`}>[{sev}]</span>}
                                        <span>• {msg}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}

                              {ccRecs.length > 0 && (
                                <div>
                                  <div className="text-[10px] font-medium mb-1">Cross-Check Recommendations ({ccRecs.length})</div>
                                  {ccRecs.map((r, i) => (
                                    <div key={i} className="text-[10px] text-muted-foreground">• {r}</div>
                                  ))}
                                </div>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })()}
                    </div>
                  );
                })()}
              </TabsContent>
            </Tabs>
          </div>
        </ScrollArea>
      ) : (
    <div className="flex flex-1 flex-col min-w-0">
      {/* Header + input status + pipeline controls */}
      <div className="border-b p-4 space-y-3">
        <h2 className="text-base font-semibold">Pipeline Runs</h2>

        {/* Raw input data */}
        {rawInputLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking input data…
          </div>
        ) : !rawInput?.exists ? (
          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-2 text-sm">
                <XCircle className="h-4 w-4 text-red-500" />
                <span className="text-muted-foreground">
                  No input data found. Run the Arch1 pipeline at{" "}
                  <code className="text-xs bg-muted px-1 rounded">/brewandgo</code>{" "}
                  first to generate input.
                </span>
              </div>
            </CardContent>
          </Card>
        ) : (
          <InputDataViewer rawInput={rawInput} />
        )}

        <div className="flex flex-wrap items-end gap-2">
          {/* Primary run buttons */}
          <Button
            size="sm"
            onClick={() => runPipeline({ pass: "pass1" })}
            disabled={pipelineRunning}
          >
            <Play className="h-3.5 w-3.5 mr-1" /> Run Pass 1
          </Button>
          <Button
            size="sm"
            onClick={() => runPipeline({ pass: "pass2" })}
            disabled={pipelineRunning}
          >
            <Play className="h-3.5 w-3.5 mr-1" /> Run Pass 2
          </Button>
          <Button
            size="sm"
            onClick={() => runPipeline({ pass: "all" })}
            disabled={pipelineRunning}
          >
            <Play className="h-3.5 w-3.5 mr-1" /> Run All
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => runPipeline({ pass: "pass1", toStep: 11 })}
            disabled={pipelineRunning}
          >
            <Play className="h-3.5 w-3.5 mr-1" /> Run P1 Steps 1–11
          </Button>

          <div className="w-px h-6 bg-border" />

          {/* Single step */}
          <div className="flex items-end gap-1">
            <Select value={singleStep} onValueChange={setSingleStep}>
              <SelectTrigger className="w-48 h-8 text-xs">
                <SelectValue placeholder="Select step…" />
              </SelectTrigger>
              <SelectContent>
                {allSteps.map((s) => (
                  <SelectItem
                    key={`${s.pass}-${s.index}`}
                    value={`${s.pass}-${s.index}`}
                  >
                    <span className="text-muted-foreground mr-1">
                      {s.pass === "pass1" ? "P1" : "P2"}.{s.index}
                    </span>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!singleStep || pipelineRunning}
              onClick={() => {
                const [pass, idx] = singleStep.split("-");
                runPipeline({ pass, step: Number(idx) });
              }}
            >
              Run Step
            </Button>
          </div>

          <div className="w-px h-6 bg-border" />

          {/* From step */}
          <div className="flex items-end gap-1">
            <Select value={fromStep} onValueChange={setFromStep}>
              <SelectTrigger className="w-48 h-8 text-xs">
                <SelectValue placeholder="From step…" />
              </SelectTrigger>
              <SelectContent>
                {allSteps.map((s) => (
                  <SelectItem
                    key={`from-${s.pass}-${s.index}`}
                    value={`${s.pass}-${s.index}`}
                  >
                    <span className="text-muted-foreground mr-1">
                      {s.pass === "pass1" ? "P1" : "P2"}.{s.index}
                    </span>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!fromStep || pipelineRunning}
              onClick={() => {
                const [pass, idx] = fromStep.split("-");
                runPipeline({ pass, fromStep: Number(idx) });
              }}
            >
              Run From Here
            </Button>
          </div>

          <div className="w-px h-6 bg-border" />

          {/* Run range (from → to) */}
          <div className="flex items-end gap-1">
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">
                Run Range
              </label>
              <div className="flex items-center gap-1">
                <Select value={fromStep} onValueChange={setFromStep}>
                  <SelectTrigger className="w-36 h-8 text-xs">
                    <SelectValue placeholder="From…" />
                  </SelectTrigger>
                  <SelectContent>
                    {allSteps.map((s) => (
                      <SelectItem
                        key={`range-from-${s.pass}-${s.index}`}
                        value={`${s.pass}-${s.index}`}
                      >
                        <span className="text-muted-foreground mr-1">
                          {s.pass === "pass1" ? "P1" : "P2"}.{s.index}
                        </span>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">→</span>
                <Select value={toStep} onValueChange={setToStep}>
                  <SelectTrigger className="w-36 h-8 text-xs">
                    <SelectValue placeholder="To…" />
                  </SelectTrigger>
                  <SelectContent>
                    {allSteps.map((s) => (
                      <SelectItem
                        key={`range-to-${s.pass}-${s.index}`}
                        value={`${s.pass}-${s.index}`}
                      >
                        <span className="text-muted-foreground mr-1">
                          {s.pass === "pass1" ? "P1" : "P2"}.{s.index}
                        </span>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={!fromStep || !toStep || pipelineRunning}
              onClick={() => {
                const [fPass, fIdx] = fromStep.split("-");
                const [, tIdx] = toStep.split("-");
                runPipeline({ pass: fPass, fromStep: Number(fIdx), toStep: Number(tIdx) });
              }}
            >
              Run Range
            </Button>
          </div>

          <div className="w-px h-6 bg-border" />

          {/* Reuse run ID */}
          <div className="flex items-end gap-1">
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">
                Reuse Run ID
              </label>
              <Select
              value={reuseRunId}
              onValueChange={(v) => setReuseRunId(v === "__none__" ? "" : v)}
            >
                <SelectTrigger className="w-56 h-8 text-xs">
                  <SelectValue placeholder="None (fresh run)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None (fresh run)</SelectItem>
                  {runs.map((r) => (
                    <SelectItem key={r.run_id} value={r.run_id}>
                      <span className="text-[10px]">
                        {r.title ?? "Untitled Run"}
                      </span>
                      <span className="ml-1 text-muted-foreground text-[9px]">
                        {fmtDate(r.started_at)}
                      </span>
                      <span className="ml-1 font-mono text-muted-foreground text-[9px] opacity-60">
                        {r.run_id.slice(0, 8)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {pipelineRunning && (
            <>
              <div className="w-px h-6 bg-border" />
              <Button
                size="sm"
                variant="destructive"
                onClick={async () => {
                  abortRef.current?.abort();
                  await fetch(`/api/${companySlug}/kb2/run`, { method: "DELETE" });
                  setPipelineRunning(false);
                  if (selectedRunId) fetchRunSteps(selectedRunId);
                  fetchRuns();
                }}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Body: runs list + inspector/log */}
      <div className="flex flex-1 min-h-0">
        {/* Left: runs list */}
        <div className="w-64 border-r flex flex-col">
          <div className="p-3 border-b flex items-center justify-between">
            <span className="text-xs font-medium">Runs</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={fetchRuns}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          </div>
          <ScrollArea className="flex-1">
            {runs.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">No runs yet</p>
            ) : (
              <div className="p-2 space-y-1">
                {runs.map((run) => (
                  <button
                    key={run.run_id}
                    onClick={() => setSelectedRunId(run.run_id)}
                    className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
                      selectedRunId === run.run_id
                        ? "bg-accent font-medium"
                        : "hover:bg-accent/50"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      {statusBadge(run.status)}
                    </div>
                    <div className="font-medium text-[11px] truncate mt-1">
                      {run.title ?? "Untitled Run"}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      <div className="flex items-center gap-1.5">
                        <span>{fmtDate(run.completed_at ?? run.started_at)}</span>
                        {run.completed_at && run.started_at !== run.completed_at && (
                          <span className="opacity-50">
                            ({run.status === "completed" ? "done" : run.status === "cancelled" ? "cancelled" : run.status})
                          </span>
                        )}
                      </div>
                      <div className="font-mono opacity-50 mt-0.5">{run.run_id.slice(0, 8)}</div>
                    </div>
                    {run.error && run.status !== "completed" && run.status !== "cancelled" && (
                      <div className="text-[10px] text-red-500 mt-0.5 truncate">
                        {run.error}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Right: inspector + log */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Live log (shown when pipeline is running or has entries) */}
          {(pipelineRunning || logEntries.length > 0) && (() => {
            const completedSteps = stepTracker.filter((s) => s.status === "completed");
            const runningStep = stepTracker.find((s) => s.status === "running");
            const failedStep = stepTracker.find((s) => s.status === "failed" || s.status === "cancelled");
            const totalSteps = runningStep?.step_number ? (logEntries.find((e) => e.total_steps)?.total_steps ?? stepTracker.length) : stepTracker.length;
            const totalDurationMs = stepTracker.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
            const totalCost = stepTracker.reduce((sum, s) => sum + (s.metrics?.cost_usd ?? 0), 0);
            const lastProgress = [...logEntries].reverse().find((e) => e.type === "progress" && e.percent != null);

            return (
            <div className="border-b">
              <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
                <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">Pipeline Log</span>
                {pipelineRunning && lastProgress?.percent != null && (
                  <span className="text-[10px] font-mono text-blue-500">{lastProgress.percent}%</span>
                )}
                {pipelineRunning && (
                  <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                )}
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {completedSteps.length}/{totalSteps} steps
                  {totalDurationMs > 0 && <> &middot; {(totalDurationMs / 1000).toFixed(1)}s</>}
                  {totalCost > 0 && <> &middot; ${totalCost.toFixed(4)}</>}
                </span>
                {!pipelineRunning && logEntries.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 text-[10px]"
                    onClick={() => { setLogEntries([]); setStepTracker([]); }}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {stepTracker.length > 0 && (
                <div className="px-3 py-2 border-b bg-muted/10 space-y-1">
                  {stepTracker.map((step) => (
                    <div key={`${step.pass}-${step.step_number}`} className="flex items-center gap-2 text-[11px]">
                      {step.status === "completed" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                      {step.status === "running" && <Loader2 className="h-3 w-3 animate-spin text-blue-500 shrink-0" />}
                      {step.status === "failed" && <XCircle className="h-3 w-3 text-red-500 shrink-0" />}
                      {step.status === "cancelled" && <Ban className="h-3 w-3 text-orange-500 shrink-0" />}
                      <span className="font-mono text-muted-foreground w-8 shrink-0">
                        {step.pass === "pass1" ? "P1" : "P2"}.{step.step_number}
                      </span>
                      <span className={step.status === "running" ? "text-blue-600 dark:text-blue-400 font-medium" : step.status === "failed" || step.status === "cancelled" ? "text-red-600 dark:text-red-400" : "text-foreground"}>
                        {step.step_name}
                      </span>
                      {step.duration_ms != null && (
                        <span className="text-muted-foreground font-mono">{(step.duration_ms / 1000).toFixed(1)}s</span>
                      )}
                      {step.metrics?.llm_calls != null && step.metrics.llm_calls > 0 && (
                        <span className="text-muted-foreground font-mono">{step.metrics.llm_calls} LLM</span>
                      )}
                      {step.metrics?.cost_usd != null && step.metrics.cost_usd > 0 && (
                        <span className="text-muted-foreground font-mono">${step.metrics.cost_usd.toFixed(4)}</span>
                      )}
                      {step.summary && step.status === "completed" && (
                        <span className="text-muted-foreground truncate">&mdash; {step.summary}</span>
                      )}
                      {step.error && (
                        <span className="text-red-500 truncate">&mdash; {step.error}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <ScrollArea className="h-32">
                <div className="p-3 font-mono text-[11px] space-y-0.5">
                  {logEntries.filter((e) => e.type === "progress" || e.type === "done" || e.type === "error").map((entry, i) => (
                    <div
                      key={i}
                      className={
                        entry.type === "error"
                          ? "text-red-500"
                          : entry.type === "done"
                            ? "text-emerald-500 font-medium"
                            : "text-muted-foreground"
                      }
                    >
                      {entry.type === "progress" && (
                        <>
                          {entry.percent != null && (
                            <span className="text-foreground mr-2">[{entry.percent}%]</span>
                          )}
                          {entry.detail}
                        </>
                      )}
                      {entry.type === "done" && <>Pipeline completed</>}
                      {entry.type === "error" && <>Error: {entry.message}</>}
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </ScrollArea>
            </div>
            );
          })()}

          {/* Step inspector */}
          {selectedRunId ? (
            stepsLoading ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Tabs
                value={inspectorTab}
                onValueChange={setInspectorTab}
                className="flex-1 flex flex-col min-h-0"
              >
                <div className="px-4 pt-3 flex items-center gap-3 border-b">
                  <span className="text-xs">
                    <span className="font-medium">
                      {runs.find((r) => r.run_id === selectedRunId)?.title ?? "Untitled Run"}
                    </span>
                    <span className="text-muted-foreground font-mono ml-2 text-[10px]">
                      {selectedRunId.slice(0, 8)}
                    </span>
                  </span>
                  <TabsList className="ml-auto">
                    <TabsTrigger value="pass1" className="text-xs">
                      Pass 1 Steps
                    </TabsTrigger>
                    <TabsTrigger value="pass2" className="text-xs">
                      Pass 2 Steps
                    </TabsTrigger>
                    <TabsTrigger value="graph" className="text-xs">
                      Graph
                    </TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value="pass1" className="flex-1 m-0 min-h-0">
                  <ScrollArea className="h-full">
                    <div className="p-4 space-y-2">
                      {pass1RunSteps.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No Pass 1 steps recorded for this run.
                        </p>
                      ) : (
                        pass1RunSteps.map((step) => (
                          <StepCard
                            key={step.step_id}
                            step={step}
                            companySlug={companySlug}
                            onSelectSources={(refs, runId) => {
                              setRightPanelSources(refs);
                              setRightPanelRunId(runId);
                            }}
                            onRerun={() => {
                              runPipeline({ pass: step.pass, step: step.step_number, reuseRunId: step.run_id });
                            }}
                            pipelineRunning={pipelineRunning}
                            executionCount={(stepExecutions[step.step_id] ?? []).length}
                          />
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="pass2" className="flex-1 m-0 min-h-0">
                  <ScrollArea className="h-full">
                    <div className="p-4 space-y-2">
                      {pass2RunSteps.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No Pass 2 steps recorded for this run.
                        </p>
                      ) : (
                        pass2RunSteps.map((step) => (
                          <StepCard
                            key={step.step_id}
                            step={step}
                            companySlug={companySlug}
                            onSelectSources={(refs, runId) => {
                              setRightPanelSources(refs);
                              setRightPanelRunId(runId);
                            }}
                            onRerun={() => {
                              runPipeline({ pass: step.pass, step: step.step_number, reuseRunId: step.run_id });
                            }}
                            pipelineRunning={pipelineRunning}
                            executionCount={(stepExecutions[step.step_id] ?? []).length}
                          />
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                <TabsContent value="graph" className="flex-1 m-0 min-h-0">
                  <KB2GraphExplorer
                    companySlug={companySlug}
                    runId={selectedRunId}
                  />
                </TabsContent>
              </Tabs>
            )
          ) : (
            <div className="flex items-center justify-center flex-1">
              <p className="text-sm text-muted-foreground">
                Select a run to inspect, or start a new pipeline run.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
      )}
    </div>
      }
      rightPanel={
        <KB2RightPanel
          companySlug={companySlug}
          autoContext={{ type: "admin", id: "admin", title: "KB Admin" }}
          sourceRefs={rightPanelSources}
          relatedEntityPages={[]}
          defaultTab="sources"
          runId={rightPanelRunId ?? undefined}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// StepCard — expandable step details
// ---------------------------------------------------------------------------

interface ParsedDoc {
  id: string;
  provider: string;
  sourceType: string;
  title: string;
  content: string;
}

function InputSnapshotBrowser({
  docs,
  selectedProvider,
  onProviderChange,
  selectedDocIdx,
  onDocIdxChange,
}: {
  docs: ParsedDoc[];
  selectedProvider: string;
  onProviderChange: (v: string) => void;
  selectedDocIdx: number;
  onDocIdxChange: (v: number) => void;
}) {
  const providers = Array.from(new Set(docs.map((d) => d.provider)));
  const filtered =
    selectedProvider === "all"
      ? docs
      : docs.filter((d) => d.provider === selectedProvider);
  const safeIdx = Math.min(selectedDocIdx, filtered.length - 1);
  const doc = filtered[safeIdx >= 0 ? safeIdx : 0];

  return (
    <div className="space-y-2">
      {/* Provider filter */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => { onProviderChange("all"); onDocIdxChange(0); }}
          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
            selectedProvider === "all"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          All ({docs.length})
        </button>
        {providers.map((prov) => (
          <button
            key={prov}
            onClick={() => { onProviderChange(prov); onDocIdxChange(0); }}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              selectedProvider === prov
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {SOURCE_LABELS[prov] ?? prov} ({docs.filter((d) => d.provider === prov).length})
          </button>
        ))}
      </div>

      {/* Document list + content */}
      <div className="flex gap-2 border rounded overflow-hidden" style={{ height: 320 }}>
        {/* Left: doc list */}
        <ScrollArea className="w-52 shrink-0 border-r">
          <div className="p-1">
            {filtered.map((d, i) => (
              <button
                key={d.id ?? i}
                onClick={() => onDocIdxChange(i)}
                className={`w-full text-left px-2 py-1.5 rounded text-[11px] transition-colors ${
                  i === safeIdx
                    ? "bg-accent font-medium"
                    : "hover:bg-accent/50 text-muted-foreground"
                }`}
              >
                <div className="truncate">{d.title}</div>
                <div className="text-[9px] text-muted-foreground mt-0.5">
                  {SOURCE_LABELS[d.provider] ?? d.provider}
                  {d.sourceType ? ` · ${d.sourceType}` : ""}
                </div>
              </button>
            ))}
          </div>
        </ScrollArea>

        {/* Right: document content */}
        <ScrollArea className="flex-1 min-w-0">
          {doc ? (
            <div className="p-3">
              <div className="flex items-center gap-2 mb-2">
                <h5 className="text-xs font-semibold">{doc.title}</h5>
                <Badge variant="outline" className="text-[9px]">
                  {SOURCE_LABELS[doc.provider] ?? doc.provider}
                </Badge>
              </div>
              <div className="text-xs leading-relaxed whitespace-pre-wrap font-mono">
                {doc.content}
              </div>
            </div>
          ) : (
            <p className="p-3 text-xs text-muted-foreground">Select a document</p>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Embed Documents Viewer (Step 2 results)
// ---------------------------------------------------------------------------

function EmbedDocumentsViewer({ artifact }: {
  artifact: {
    total_documents: number;
    total_chunks: number;
    chunk_size: number;
    chunk_overlap: number;
    qdrant_collection: string;
    by_provider: Record<string, { docs?: number; chunks?: number; units?: number; spans?: number }>;
    by_document: Array<{
      title?: string;
      provider?: string;
      contentLen?: number;
      content_length?: number;
      content_len?: number;
      chunks?: number;
      source_units?: number;
      sourceUnits?: number;
      spans?: number;
    }>;
  };
}) {
  const [filterProvider, setFilterProvider] = useState<string>("all");
  const providers = Object.keys(artifact.by_provider ?? {}).sort();
  const docs = (artifact.by_document ?? []).map((doc) => {
    const rawContentLen = doc.contentLen ?? doc.content_length ?? doc.content_len;
    const rawSourceUnits = doc.source_units ?? doc.sourceUnits;
    const rawChunkCount = doc.chunks ?? doc.spans;

    const contentLen = typeof rawContentLen === "number"
      ? rawContentLen
      : typeof rawContentLen === "string" && rawContentLen.trim().length > 0
        ? Number(rawContentLen)
        : null;
    const sourceUnits = typeof rawSourceUnits === "number"
      ? rawSourceUnits
      : typeof rawSourceUnits === "string" && rawSourceUnits.trim().length > 0
        ? Number(rawSourceUnits)
        : 0;
    const chunkCount = typeof rawChunkCount === "number"
      ? rawChunkCount
      : typeof rawChunkCount === "string" && rawChunkCount.trim().length > 0
        ? Number(rawChunkCount)
        : 0;

    return {
      title: doc.title ?? "Untitled",
      provider: doc.provider ?? "unknown",
      contentLen: Number.isFinite(contentLen as number) ? contentLen : null,
      sourceUnits: Number.isFinite(sourceUnits) ? sourceUnits : 0,
      chunkCount: Number.isFinite(chunkCount) ? chunkCount : 0,
    };
  });
  const hasContentLengths = docs.some((doc) => doc.contentLen != null);
  const metricLabel = hasContentLengths ? "Content (chars)" : "Source Units";
  const chunkLabel = hasContentLengths ? "Chunks" : "Evidence Spans";
  const filtered = filterProvider === "all" ? docs : docs.filter((d) => d.provider === filterProvider);

  const EMBED_PROVIDER_COLORS: Record<string, string> = {
    confluence: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    jira: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    github: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
    slack: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
    customerFeedback: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
  };

  return (
    <div className="space-y-4">
      {/* Summary */}
      <Card>
        <CardHeader className="pb-2">
          <h3 className="text-sm font-semibold">Embedding Summary</h3>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-4 gap-3">
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold">{artifact.total_documents}</div>
              <div className="text-[10px] text-muted-foreground">Documents</div>
            </div>
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold">{artifact.total_chunks}</div>
              <div className="text-[10px] text-muted-foreground">Chunks</div>
            </div>
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold">{artifact.chunk_size}</div>
              <div className="text-[10px] text-muted-foreground">Chunk Size</div>
            </div>
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold">{artifact.chunk_overlap}</div>
              <div className="text-[10px] text-muted-foreground">Overlap</div>
            </div>
          </div>

          {/* By provider */}
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left px-3 py-1.5 font-medium">Provider</th>
                  <th className="text-right px-3 py-1.5 font-medium">Documents</th>
                  <th className="text-right px-3 py-1.5 font-medium">Chunks</th>
                  <th className="text-right px-3 py-1.5 font-medium">Avg Chunks/Doc</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((prov) => {
                  const data = artifact.by_provider[prov];
                  return (
                    <tr key={prov} className="border-t">
                      <td className="px-3 py-1.5">
                        <Badge className={`text-[10px] ${EMBED_PROVIDER_COLORS[prov] ?? "bg-gray-100 text-gray-800"}`}>{prov}</Badge>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">{data.docs}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{data.chunks}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{(data.chunks / data.docs).toFixed(1)}</td>
                    </tr>
                  );
                })}
                <tr className="border-t bg-muted/30 font-medium">
                  <td className="px-3 py-1.5">Total</td>
                  <td className="px-3 py-1.5 text-right font-mono">{artifact.total_documents}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{artifact.total_chunks}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{(artifact.total_chunks / artifact.total_documents).toFixed(1)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Per-document breakdown */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Per-Document Chunks ({filtered.length})</h3>
            <Select value={filterProvider} onValueChange={setFilterProvider}>
              <SelectTrigger className="h-7 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sources</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left px-3 py-1.5 font-medium">Title</th>
                  <th className="text-left px-3 py-1.5 font-medium">Provider</th>
                  <th className="text-right px-3 py-1.5 font-medium">{metricLabel}</th>
                  <th className="text-right px-3 py-1.5 font-medium">{chunkLabel}</th>
                  <th className="text-left px-3 py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((doc, i) => {
                  const canEstimateChunks =
                    doc.contentLen != null &&
                    artifact.chunk_size > artifact.chunk_overlap;
                  const expectedChunks = canEstimateChunks
                    ? Math.max(
                        1,
                        Math.ceil((doc.contentLen - artifact.chunk_overlap) / (artifact.chunk_size - artifact.chunk_overlap)),
                      )
                    : null;
                  const chunkMismatch =
                    expectedChunks != null && Math.abs(doc.chunkCount - expectedChunks) > 1;
                  const primaryMetric = hasContentLengths
                    ? doc.contentLen ?? 0
                    : doc.sourceUnits;
                  return (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1.5 max-w-[300px] truncate">{doc.title}</td>
                      <td className="px-3 py-1.5">
                        <Badge className={`text-[10px] ${EMBED_PROVIDER_COLORS[doc.provider] ?? "bg-gray-100 text-gray-800"}`}>{doc.provider}</Badge>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono">{primaryMetric.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{doc.chunkCount.toLocaleString()}</td>
                      <td className="px-3 py-1.5">
                        {doc.chunkCount === 0 ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                            {hasContentLengths ? "0 chunks!" : "0 spans!"}
                          </span>
                        ) : chunkMismatch ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">expected ~{expectedChunks}</span>
                        ) : (
                          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entity Extraction Viewer (Step 3 results)
// ---------------------------------------------------------------------------

interface EntityEntry {
  display_name: string;
  aliases: string[];
  confidence: string;
  source_count: number;
  source_refs: { source_type: string; doc_id: string; title: string; excerpt: string; section_heading?: string }[];
  attributes?: Record<string, unknown>;
  reasoning?: string;
  batch_index?: number;
  llm_call_id?: string;
}

const ENTITY_TYPE_META: Record<string, { label: string; color: string }> = {
  team_member: { label: "Team Members", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" },
  team: { label: "Teams", color: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300" },
  client_company: { label: "Client Companies", color: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300" },
  client_person: { label: "Client Contacts", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  repository: { label: "Repositories", color: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300" },
  integration: { label: "Integrations", color: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300" },
  infrastructure: { label: "Infrastructure", color: "bg-stone-100 text-stone-800 dark:bg-stone-900/40 dark:text-stone-300" },
  cloud_resource: { label: "Cloud Resources", color: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300" },
  library: { label: "Libraries", color: "bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300" },
  database: { label: "Databases", color: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  environment: { label: "Environments", color: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300" },
  project: { label: "Projects", color: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300" },
  ticket: { label: "Tickets", color: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" },
  pull_request: { label: "Pull Requests", color: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300" },
  pipeline: { label: "Pipelines", color: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
  customer_feedback: { label: "Customer Feedback", color: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300" },
};

const CONFIDENCE_STYLE: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  low: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

function ViewLLMCallInline({ companySlug, runId, callId, batchIndex }: { companySlug?: string; runId?: string; callId: string; batchIndex?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [callData, setCallData] = useState<{ prompt: string; response: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number; duration_ms: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchCall = async () => {
    if (callData || !companySlug || !runId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/${companySlug}/kb2?type=llm_calls&run_id=${runId}&call_id=${callId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.call) setCallData(data.call);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  const inputData = (() => {
    if (!callData?.prompt) return null;
    const marker = "--- Document ";
    const idx = callData.prompt.indexOf(marker);
    return idx >= 0 ? callData.prompt.slice(idx) : callData.prompt;
  })();

  return (
    <div className="border rounded p-2 bg-muted/30">
      <button
        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
        onClick={() => { setExpanded(!expanded); if (!expanded) fetchCall(); }}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        View Input Data {batchIndex != null && `(Batch ${batchIndex})`}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {loading && <div className="text-[10px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Loading...</div>}
          {callData && (
            <>
              <div className="flex gap-3 text-[10px] text-muted-foreground">
                <span>Model: {callData.model}</span>
                <span>{callData.input_tokens} in / {callData.output_tokens} out</span>
                <span>${callData.cost_usd.toFixed(4)}</span>
                <span>{fmtDuration(callData.duration_ms)}</span>
              </div>
              <div>
                <div className="text-[10px] font-medium mb-1">Input Documents</div>
                <pre className="text-[10px] bg-background rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap break-words border">{inputData}</pre>
              </div>
              <div>
                <div className="text-[10px] font-medium mb-1">LLM Response</div>
                <pre className="text-[10px] bg-background rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap break-words border">{callData.response}</pre>
              </div>
            </>
          )}
          {!loading && !callData && <div className="text-[10px] text-muted-foreground">LLM call not found</div>}
        </div>
      )}
    </div>
  );
}

function EntityExtractionViewer({ artifact, companySlug, runId, executionId, stepId, onSelectSources }: {
  artifact: {
    total_entities: number;
    llm_calls: number;
    entities_by_type: Record<string, EntityEntry[]>;
  };
  companySlug?: string;
  runId?: string;
  executionId?: string;
  stepId?: string;
  onSelectSources?: (refs: EntityEntry["source_refs"]) => void;
}) {
  const [filterType, setFilterType] = useState<string>("all");
  const [filterConfidence, setFilterConfidence] = useState<string>("all");
  const [filterHighlightFail, setFilterHighlightFail] = useState(false);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const [graphNodes, setGraphNodes] = useState<Record<string, { attributes: Record<string, unknown>; source_refs: EntityEntry["source_refs"] }>>({});
  const [nodesLoaded, setNodesLoaded] = useState(false);

  useEffect(() => {
    if (!companySlug || !runId) return;
    const params = executionId ? `execution_id=${executionId}` : `run_id=${runId}`;
    fetch(`/api/${companySlug}/kb2?type=graph_nodes&${params}`)
      .then((r) => r.json())
      .then((data) => {
        const map: typeof graphNodes = {};
        for (const n of data.nodes ?? []) {
          map[n.display_name.toLowerCase().trim()] = {
            attributes: n.attributes ?? {},
            source_refs: n.source_refs ?? [],
          };
        }
        setGraphNodes(map);
        setNodesLoaded(true);
      })
      .catch(() => setNodesLoaded(true));
  }, [companySlug, runId]);

  // --- Highlight check: load saved results or compute + save ---
  const HIGHLIGHT_ALGO_VERSION = 4;
  const [highlightFailures, setHighlightFailures] = useState<Set<string>>(new Set());
  const [highlightChecked, setHighlightChecked] = useState(false);
  const [highlightComputing, setHighlightComputing] = useState(false);
  const highlightCancelRef = useRef(false);

  const computeHighlights = useCallback(async (forceRecompute = false) => {
    if (!companySlug || !runId) return;
    highlightCancelRef.current = false;
    setHighlightChecked(false);
    setHighlightFailures(new Set());
    setHighlightComputing(true);

    const SPEAKER_HEADER_RE = /^\s*\w[\w\s.]*\[[\d\-\/]+\]:\s*$/m;

    const excerptMatchesContent = (content: string, excerpt: string): boolean => {
      if (!excerpt || !content) return false;
      const clean = excerpt.slice(0, 300).trim();
      if (content.toLowerCase().includes(clean.toLowerCase())) return true;
      const normContent = normalizeForMatch(content);
      if (normContent.includes(normalizeForMatch(clean))) return true;
      const bodyOnly = clean.replace(/^\s*\w[\w\s.]*\[[\d\-\/]+\]:\s*\n?/, "").trim();
      if (bodyOnly !== clean && bodyOnly.length > 20) {
        if (normContent.includes(normalizeForMatch(bodyOnly))) return true;
      }
      const lines = clean.split("\n");
      const chunks: string[] = [];
      let cur: string[] = [];
      for (const line of lines) {
        if (SPEAKER_HEADER_RE.test(line)) {
          if (cur.length > 0) chunks.push(cur.join("\n").trim());
          cur = [];
        } else {
          cur.push(line);
        }
      }
      if (cur.length > 0) chunks.push(cur.join("\n").trim());
      const nonEmpty = chunks.filter((c) => c.length > 0);
      if (nonEmpty.length >= 2 && nonEmpty.every((c) => { const nc = normalizeForMatch(c); return nc.length < 10 || normContent.includes(nc); })) return true;
      const excerptWords = new Set(clean.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
      if (excerptWords.size >= 3) {
        const sentences = content.split(/(?<=[.!?\n])\s+/);
        for (const sent of sentences) {
          const sentWords = sent.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
          const overlap = sentWords.filter((w) => excerptWords.has(w)).length;
          if (excerptWords.size > 0 && overlap / excerptWords.size >= 0.5) return true;
        }
      }
      return false;
    };

    try {
      if (!forceRecompute && (executionId || stepId)) {
        try {
          const params = new URLSearchParams({ type: "highlight_check" });
          if (executionId) params.set("execution_id", executionId);
          else { params.set("run_id", runId!); params.set("step_id", stepId!); }
          const res = await fetch(`/api/${companySlug}/kb2?${params}`);
          if (res.ok) {
            const data = await res.json();
            if (data.highlight_failures && data.highlight_failures.algorithm_version === HIGHLIGHT_ALGO_VERSION) {
              if (highlightCancelRef.current) return;
              setHighlightFailures(new Set(data.highlight_failures.failures));
              setHighlightChecked(true);
              return;
            }
          }
        } catch { /* fall through to compute */ }
      }

      const allRefs: { source_type: string; doc_id: string }[] = [];
      for (const entries of Object.values(artifact.entities_by_type)) {
        for (const e of entries) {
          for (const r of e.source_refs) {
            allRefs.push({ source_type: r.source_type, doc_id: r.doc_id });
          }
        }
      }
      const uniqueKeys = new Map<string, { source_type: string; doc_id: string }>();
      for (const r of allRefs) {
        const k = `${r.source_type}:${r.doc_id}`;
        if (!uniqueKeys.has(k)) uniqueKeys.set(k, r);
      }

      const docContents = new Map<string, string>();
      const entries = [...uniqueKeys.entries()];
      const BATCH = 6;
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async ([key, ref]) => {
          try {
            const params = new URLSearchParams({ type: "parsed_doc", doc_id: ref.doc_id, run_id: runId! });
            if (ref.source_type) params.set("source_type", ref.source_type);
            const res = await fetch(`/api/${companySlug}/kb2?${params}`);
            if (!res.ok) return [key, ""] as const;
            const data = await res.json();
            const doc = data.document;
            let content = doc?.content ?? "";
            if (!content && doc?.sections?.length) {
              content = doc.sections.map((s: any) => `## ${s.heading}\n${s.content}`).join("\n\n");
            }
            return [key, content] as const;
          } catch { return [key, ""] as const; }
        }));
        for (const [key, content] of results) docContents.set(key, content);
      }
      if (highlightCancelRef.current) return;

      const failures = new Set<string>();
      const failureDetails: Array<{ entity_key: string; source_ref: { source_type: string; doc_id: string; title: string; excerpt_preview: string }; reason: string }> = [];
      let totalChecked = 0;

      for (const [type, ents] of Object.entries(artifact.entities_by_type)) {
        for (const e of ents) {
          totalChecked++;
          const entityKey = `${type}:${e.display_name}`;
          for (const ref of e.source_refs) {
            const cacheKey = `${ref.source_type}:${ref.doc_id}`;
            const content = docContents.get(cacheKey) ?? "";
            if (!content) {
              failures.add(entityKey);
              failureDetails.push({ entity_key: entityKey, source_ref: { source_type: ref.source_type, doc_id: ref.doc_id, title: ref.title, excerpt_preview: (ref.excerpt ?? "").slice(0, 120) }, reason: "no_content" });
              break;
            }
            if (ref.excerpt && !excerptMatchesContent(content, ref.excerpt)) {
              failures.add(entityKey);
              failureDetails.push({ entity_key: entityKey, source_ref: { source_type: ref.source_type, doc_id: ref.doc_id, title: ref.title, excerpt_preview: (ref.excerpt ?? "").slice(0, 120) }, reason: "no_match" });
              break;
            }
          }
        }
      }

      setHighlightFailures(failures);
      setHighlightChecked(true);

      if (executionId || stepId) {
        try {
          await fetch(`/api/${companySlug}/kb2`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "save_highlight_check",
              run_id: runId,
              step_id: stepId,
              execution_id: executionId,
              highlight_failures: {
                checked_at: new Date().toISOString(),
                algorithm_version: HIGHLIGHT_ALGO_VERSION,
                failures: [...failures],
                total_checked: totalChecked,
                failure_details: failureDetails,
              },
            }),
          });
        } catch { /* save is best-effort */ }
      }
    } finally {
      setHighlightComputing(false);
    }
  }, [companySlug, runId, executionId, stepId, artifact.entities_by_type]);

  useEffect(() => {
    computeHighlights();
    return () => { highlightCancelRef.current = true; };
  }, [computeHighlights]);

  const types = Object.keys(artifact.entities_by_type).sort();
  const typeSummary = types.map((t) => ({
    type: t,
    count: artifact.entities_by_type[t].length,
    meta: ENTITY_TYPE_META[t] ?? { label: t, color: "bg-gray-100 text-gray-800" },
  }));

  const allEntities: (EntityEntry & { type: string; possibleDuplicates: string[] })[] = [];
  for (const [type, entries] of Object.entries(artifact.entities_by_type)) {
    for (const e of entries) {
      const nodeKey = e.display_name.toLowerCase().trim();
      const node = graphNodes[nodeKey];
      const merged = { ...e, type, possibleDuplicates: [] as string[] };
      if (node) {
        if (!merged.attributes || Object.keys(merged.attributes).length === 0) merged.attributes = node.attributes;
        if (merged.source_refs.length === 0 || (merged.source_refs.length === 1 && merged.source_refs[0].source_type === "unknown")) {
          if (node.source_refs.length > 0) merged.source_refs = node.source_refs as any;
        }
      }
      allEntities.push(merged);
    }
  }

  // detect likely duplicates by shared ticket key prefix or similar names
  for (const entity of allEntities) {
    const ticketMatch = entity.display_name.match(/^(PAW-\d+)/i);
    if (ticketMatch) {
      const prefix = ticketMatch[1].toUpperCase();
      const dupes = allEntities.filter((o) => o !== entity && o.display_name.toUpperCase().startsWith(prefix));
      entity.possibleDuplicates = dupes.map((d) => d.display_name);
    }
    const nameLower = entity.display_name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const dupesByName = allEntities.filter((o) => {
      if (o === entity) return false;
      const oLower = o.display_name.toLowerCase().replace(/[^a-z0-9]/g, "");
      return oLower === nameLower || (nameLower.length > 6 && (oLower.includes(nameLower) || nameLower.includes(oLower)));
    });
    for (const d of dupesByName) {
      if (!entity.possibleDuplicates.includes(d.display_name)) entity.possibleDuplicates.push(d.display_name);
    }
  }

  const filtered = allEntities.filter((e) => {
    if (filterType !== "all" && e.type !== filterType) return false;
    if (filterConfidence !== "all" && e.confidence !== filterConfidence) return false;
    if (filterHighlightFail && !highlightFailures.has(`${e.type}:${e.display_name}`)) return false;
    return true;
  });

  const confidenceCounts = { high: 0, medium: 0, low: 0 };
  const dupeCount = allEntities.filter((e) => e.possibleDuplicates.length > 0).length;
  const highlightFailCount = allEntities.filter((e) => highlightFailures.has(`${e.type}:${e.display_name}`)).length;
  for (const e of allEntities) {
    if (e.confidence in confidenceCounts) confidenceCounts[e.confidence as keyof typeof confidenceCounts]++;
  }

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <Card>
        <CardHeader className="pb-2">
          <h3 className="text-sm font-semibold">Extraction Summary</h3>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-5 gap-3">
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold">{artifact.total_entities}</div>
              <div className="text-[10px] text-muted-foreground">Entities</div>
            </div>
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold">{types.length}</div>
              <div className="text-[10px] text-muted-foreground">Types</div>
            </div>
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold">{artifact.llm_calls}</div>
              <div className="text-[10px] text-muted-foreground">LLM Calls</div>
            </div>
            <div className={`border rounded-md p-2 text-center ${dupeCount > 0 ? "border-amber-300 dark:border-amber-700" : ""}`}>
              <div className={`text-lg font-bold ${dupeCount > 0 ? "text-amber-600" : "text-emerald-600"}`}>{dupeCount}</div>
              <div className="text-[10px] text-muted-foreground">Likely Duplicates</div>
            </div>
            <button
              onClick={() => setFilterHighlightFail(!filterHighlightFail)}
              className={`border rounded-md p-2 text-center transition-colors ${highlightFailCount > 0 ? "border-red-300 dark:border-red-700" : ""} ${filterHighlightFail ? "ring-2 ring-red-400" : ""}`}
            >
              <div className={`text-lg font-bold ${!highlightChecked ? "text-muted-foreground" : highlightFailCount > 0 ? "text-red-600" : "text-emerald-600"}`}>
                {highlightComputing ? <Loader2 className="h-4 w-4 animate-spin inline" /> : highlightChecked ? highlightFailCount : "…"}
              </div>
              <div className="text-[10px] text-muted-foreground">No Highlight</div>
            </button>
            <button
              onClick={() => computeHighlights(true)}
              disabled={highlightComputing}
              className="border rounded-md p-2 text-center transition-colors hover:bg-accent/50 disabled:opacity-50"
              title="Recompute highlight check from scratch"
            >
              <div className="text-lg font-bold text-muted-foreground"><RefreshCw className={`h-4 w-4 inline ${highlightComputing ? "animate-spin" : ""}`} /></div>
              <div className="text-[10px] text-muted-foreground">Recheck</div>
            </button>
          </div>

          {/* Type breakdown */}
          <div className="flex flex-wrap gap-1.5">
            {typeSummary.map(({ type, count, meta }) => (
              <button
                key={type}
                onClick={() => setFilterType(filterType === type ? "all" : type)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium transition-opacity ${meta.color} ${filterType !== "all" && filterType !== type ? "opacity-40" : ""}`}
              >
                {meta.label} <span className="font-mono">{count}</span>
              </button>
            ))}
          </div>

          {/* Confidence bar */}
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-muted-foreground">Confidence:</span>
            {(["high", "medium", "low"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setFilterConfidence(filterConfidence === c ? "all" : c)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${CONFIDENCE_STYLE[c]} ${filterConfidence !== "all" && filterConfidence !== c ? "opacity-40" : ""}`}
              >
                {c} ({confidenceCounts[c]})
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Entity list */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Entities ({filtered.length})</h3>
            <div className="flex gap-2">
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="h-7 w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>{ENTITY_TYPE_META[t]?.label ?? t} ({artifact.entities_by_type[t].length})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterConfidence} onValueChange={setFilterConfidence}>
                <SelectTrigger className="h-7 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Confidence</SelectItem>
                  <SelectItem value="high">High ({confidenceCounts.high})</SelectItem>
                  <SelectItem value="medium">Medium ({confidenceCounts.medium})</SelectItem>
                  <SelectItem value="low">Low ({confidenceCounts.low})</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left px-3 py-1.5 font-medium w-[280px]">Entity</th>
                  <th className="text-left px-3 py-1.5 font-medium">Type</th>
                  <th className="text-left px-3 py-1.5 font-medium">Confidence</th>
                  <th className="text-right px-3 py-1.5 font-medium">Sources</th>
                  <th className="text-left px-3 py-1.5 font-medium">Aliases</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entity) => {
                  const key = `${entity.type}:${entity.display_name}`;
                  const isExpanded = expandedEntity === key;
                  const meta = ENTITY_TYPE_META[entity.type] ?? { label: entity.type, color: "bg-gray-100 text-gray-800" };
                  const hasHighlightFail = highlightChecked && highlightFailures.has(key);
                  return (
                    <Fragment key={key}>
                      <tr
                        className={`border-t cursor-pointer hover:bg-muted/30 transition-colors ${isExpanded ? "bg-muted/20" : ""}`}
                        onClick={() => {
                          const newKey = isExpanded ? null : key;
                          setExpandedEntity(newKey);
                          if (newKey && onSelectSources) onSelectSources(entity.source_refs);
                          else if (!newKey && onSelectSources) onSelectSources([]);
                        }}
                      >
                        <td className="px-3 py-1.5 font-medium">
                          <div className="flex items-center gap-1">
                            {isExpanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
                            <span className="truncate max-w-[250px]">{entity.display_name}</span>
                            {hasHighlightFail && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 shrink-0">no highlight</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-1.5">
                          <Badge className={`text-[10px] ${meta.color}`}>{meta.label}</Badge>
                        </td>
                        <td className="px-3 py-1.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${CONFIDENCE_STYLE[entity.confidence] ?? ""}`}>{entity.confidence}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">{entity.source_count}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-1.5">
                            {entity.aliases.length > 0 ? (
                              <span className="text-muted-foreground truncate max-w-[160px]">{entity.aliases.join(", ")}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                            {entity.possibleDuplicates.length > 0 && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 shrink-0">dupe?</span>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${key}-detail`} className="border-t bg-muted/10">
                          <td colSpan={5} className="px-4 py-3">
                            <div className="space-y-3">

                              {/* Duplicate warning */}
                              {entity.possibleDuplicates.length > 0 && (
                                <div className="border border-amber-300 dark:border-amber-700 rounded p-2 bg-amber-50 dark:bg-amber-950/30">
                                  <div className="text-[10px] font-medium text-amber-700 dark:text-amber-300 mb-1">Possible duplicates (Steps 4-5 will attempt to merge):</div>
                                  <div className="flex flex-wrap gap-1">
                                    {entity.possibleDuplicates.map((d, di) => (
                                      <span key={di} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200">{d}</span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Entity JSON */}
                              <pre className="text-[11px] bg-background rounded p-3 overflow-auto whitespace-pre-wrap break-all border max-h-80 font-mono">
                                {JSON.stringify({
                                  display_name: entity.display_name,
                                  type: entity.type,
                                  reasoning: (entity as any).reasoning ?? undefined,
                                  description: (entity as any).description ?? (entity.attributes as any)?._description ?? undefined,
                                  source_documents: entity.source_refs.map((ref) => ({
                                    title: ref.title + (ref.section_heading ? ` (${ref.section_heading})` : ""),
                                    evidence_excerpt: ref.excerpt,
                                  })),
                                  aliases: entity.aliases,
                                  attributes: Object.fromEntries(
                                    Object.entries(entity.attributes ?? {}).filter(([k]) => !k.startsWith("_"))
                                  ),
                                  confidence: entity.confidence,
                                }, null, 2)}
                              </pre>

                              {(entity as any).llm_call_id && (
                                <ViewLLMCallInline companySlug={companySlug} runId={runId} callId={(entity as any).llm_call_id} batchIndex={(entity as any).batch_index} />
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Input Snapshot Viewer (Step 1 enhanced results)
// ---------------------------------------------------------------------------

const PROVIDER_COLORS: Record<string, string> = {
  confluence: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  jira: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  github: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  slack: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  customerFeedback: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
};

interface SnapshotDoc {
  id: string;
  provider: string;
  sourceType: string;
  sourceId: string;
  title: string;
  content: string;
  sections: { heading: string; content: string; start_offset?: number; end_offset?: number }[];
  metadata: Record<string, unknown>;
}

const REQUIRED_META: Record<string, string[]> = {
  jira: ["assignee", "reporter", "status", "priority"],
  confluence: ["author", "space"],
  github: ["author", "repo"],
  slack: ["channelName", "participants"],
  customerFeedback: ["name", "email", "subject"],
};

function getDocFlags(doc: SnapshotDoc): { level: "error" | "warning"; message: string }[] {
  const flags: { level: "error" | "warning"; message: string }[] = [];
  if (!doc.content || doc.content.trim().length === 0) {
    flags.push({ level: "error", message: "Empty content" });
  }
  if (!doc.sections || doc.sections.length === 0) {
    flags.push({ level: "warning", message: "Zero sections" });
  }
  const expectedMeta = REQUIRED_META[doc.provider] ?? [];
  for (const key of expectedMeta) {
    const val = doc.metadata?.[key];
    if (val === undefined || val === null || val === "") {
      flags.push({ level: "warning", message: `Missing ${key}` });
    }
  }
  return flags;
}

function InputSnapshotViewer({
  companySlug,
  runId,
  executionId,
  artifact,
}: {
  companySlug: string;
  runId: string;
  executionId?: string;
  artifact: Record<string, unknown>;
}) {
  const [snapshot, setSnapshot] = useState<{ parsed_documents: SnapshotDoc[]; raw_stats?: Record<string, { chars: number; format: string }>; stats?: Record<string, number> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [filterProvider, setFilterProvider] = useState<string>("all");
  const [rawInputTexts, setRawInputTexts] = useState<Record<string, string>>({});

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const params = executionId ? `execution_id=${executionId}` : `run_id=${runId}`;
        const [snapRes, rawRes] = await Promise.all([
          fetch(`/api/${companySlug}/kb2?type=inputs&${params}`),
          fetch(`/api/${companySlug}/kb2/input?full=true`),
        ]);
        const snapData = await snapRes.json();
        const rawData = await rawRes.json();
        setSnapshot(snapData.snapshot ?? null);
        const texts: Record<string, string> = {};
        const sources = rawData.sources ?? {};
        for (const [src, entry] of Object.entries(sources) as [string, any][]) {
          texts[src] = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2);
        }
        setRawInputTexts(texts);
      } catch {
        setSnapshot(null);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [companySlug, runId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading snapshot data...
      </div>
    );
  }

  if (!snapshot?.parsed_documents) {
    return <p className="text-xs text-muted-foreground">No parsed documents found for this run.</p>;
  }

  const docs = snapshot.parsed_documents;
  const rawStats = (snapshot.raw_stats ?? artifact.raw_stats ?? {}) as Record<string, { chars: number; format: string }>;
  const bySource = (snapshot.stats ?? artifact.by_source ?? {}) as Record<string, number>;

  const providers = [...new Set(docs.map((d) => d.provider))].sort();

  const filteredDocs = filterProvider === "all" ? docs : docs.filter((d) => d.provider === filterProvider);

  return (
    <div className="space-y-4">
      {/* Source Summary Table */}
      <Card>
        <CardHeader className="pb-2">
          <h3 className="text-sm font-semibold">Source Summary</h3>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left px-3 py-1.5 font-medium">Source</th>
                  <th className="text-left px-3 py-1.5 font-medium">Format</th>
                  <th className="text-right px-3 py-1.5 font-medium">Raw Size</th>
                  <th className="text-right px-3 py-1.5 font-medium">Parsed Docs</th>
                  <th className="text-left px-3 py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((prov) => {
                  const raw = rawStats[prov];
                  const count = bySource[prov] ?? 0;
                  const hasRaw = raw && raw.chars > 0;
                  const mismatch = hasRaw && count === 0;
                  return (
                    <tr key={prov} className="border-t">
                      <td className="px-3 py-1.5">
                        <Badge className={`text-[10px] ${PROVIDER_COLORS[prov] ?? "bg-gray-100 text-gray-800"}`}>
                          {prov}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{raw?.format ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{raw ? `${(raw.chars / 1024).toFixed(1)}KB` : "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{count}</td>
                      <td className="px-3 py-1.5">
                        {mismatch ? (
                          <span className="text-amber-600 font-medium">⚠ 0 parsed from {(raw.chars / 1024).toFixed(1)}KB input</span>
                        ) : count > 0 ? (
                          <span className="text-emerald-600">✓</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t bg-muted/30 font-medium">
                  <td className="px-3 py-1.5">Total</td>
                  <td className="px-3 py-1.5" />
                  <td className="px-3 py-1.5 text-right font-mono">
                    {Object.values(rawStats).reduce((acc, r) => acc + (r?.chars ?? 0), 0) > 0
                      ? `${(Object.values(rawStats).reduce((acc, r) => acc + (r?.chars ?? 0), 0) / 1024).toFixed(1)}KB`
                      : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">{docs.length}</td>
                  <td className="px-3 py-1.5" />
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Document List */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Parsed Documents ({filteredDocs.length})</h3>
            <div className="flex items-center gap-2">
              <Select value={filterProvider} onValueChange={setFilterProvider}>
                <SelectTrigger className="h-7 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left px-3 py-1.5 font-medium w-8" />
                  <th className="text-left px-3 py-1.5 font-medium">Title</th>
                  <th className="text-left px-3 py-1.5 font-medium">Provider</th>
                  <th className="text-right px-3 py-1.5 font-medium">Chars</th>
                  <th className="text-right px-3 py-1.5 font-medium">Sections</th>
                  <th className="text-left px-3 py-1.5 font-medium">Flags</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocs.map((doc) => {
                  const flags = getDocFlags(doc);
                  const isExpanded = expandedDocId === doc.id;
                  return (
                    <DocRow
                      key={doc.id}
                      doc={doc}
                      flags={flags}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedDocId(isExpanded ? null : doc.id)}
                      rawText={rawInputTexts[doc.provider] ?? ""}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DocRow({
  doc,
  flags,
  isExpanded,
  onToggle,
  rawText,
}: {
  doc: SnapshotDoc;
  flags: { level: "error" | "warning"; message: string }[];
  isExpanded: boolean;
  onToggle: () => void;
  rawText: string;
}) {
  const rawExcerpt = (() => {
    if (!rawText) return "";
    const rawLower = rawText.toLowerCase();
    const titleNorm = doc.title.toLowerCase();
    const sourceIdNorm = (doc.sourceId ?? "").toLowerCase();

    let idx = rawLower.indexOf(titleNorm);
    if (idx === -1 && sourceIdNorm) idx = rawLower.indexOf(sourceIdNorm);
    if (idx === -1) return "";

    const start = Math.max(0, idx - 50);
    const end = Math.min(rawText.length, idx + 800);
    return rawText.slice(start, end);
  })();

  return (
    <>
      <tr className={`border-t cursor-pointer hover:bg-muted/30 ${isExpanded ? "bg-muted/20" : ""}`} onClick={onToggle}>
        <td className="px-3 py-1.5">
          {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </td>
        <td className="px-3 py-1.5 font-medium max-w-[300px] truncate">{doc.title}</td>
        <td className="px-3 py-1.5">
          <Badge className={`text-[10px] ${PROVIDER_COLORS[doc.provider] ?? "bg-gray-100 text-gray-800"}`}>
            {doc.provider}
          </Badge>
        </td>
        <td className="px-3 py-1.5 text-right font-mono">{doc.content.length.toLocaleString()}</td>
        <td className="px-3 py-1.5 text-right font-mono">{doc.sections?.length ?? 0}</td>
        <td className="px-3 py-1.5">
          {flags.length > 0 ? (
            <div className="flex gap-1 flex-wrap">
              {flags.map((f, i) => (
                <span
                  key={i}
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    f.level === "error"
                      ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                  }`}
                >
                  {f.message}
                </span>
              ))}
            </div>
          ) : (
            <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          )}
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={6} className="px-3 py-3 bg-muted/10">
            <div className="space-y-3">
              {/* Sections */}
              {doc.sections && doc.sections.length > 0 && (
                <div>
                  <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                    Sections ({doc.sections.length})
                  </h5>
                  <div className="border rounded-md overflow-hidden">
                    {doc.sections.map((sec, i) => (
                      <div key={i} className={`px-3 py-1.5 text-xs ${i > 0 ? "border-t" : ""}`}>
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{sec.heading || `Section ${i + 1}`}</span>
                          <span className="text-muted-foreground font-mono text-[10px]">{sec.content.length.toLocaleString()} chars</span>
                        </div>
                        <pre className="text-[10px] text-muted-foreground mt-1 whitespace-pre-wrap">{sec.content}</pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Metadata */}
              {doc.metadata && Object.keys(doc.metadata).length > 0 && (
                <div>
                  <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                    Metadata
                  </h5>
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-xs">
                      <tbody>
                        {Object.entries(doc.metadata).map(([key, val]) => (
                          <tr key={key} className="border-t first:border-t-0">
                            <td className="px-3 py-1 font-medium w-40 text-muted-foreground">{key}</td>
                            <td className="px-3 py-1 font-mono">
                              {val === null || val === undefined ? (
                                <span className="text-amber-600 italic">null</span>
                              ) : Array.isArray(val) ? (
                                val.join(", ") || <span className="text-muted-foreground italic">empty array</span>
                              ) : typeof val === "object" ? (
                                JSON.stringify(val)
                              ) : (
                                String(val)
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Raw Source Excerpt */}
              {rawExcerpt && (
                <div>
                  <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                    Raw Source Excerpt
                  </h5>
                  <pre className="text-[10px] font-mono bg-muted/50 p-2 rounded-md overflow-auto max-h-40 whitespace-pre-wrap">{rawExcerpt}</pre>
                </div>
              )}

              {/* Full Parsed Content */}
              <div>
                <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                  Full Parsed Content
                </h5>
                <pre className="text-[10px] font-mono bg-muted/50 p-2 rounded-md overflow-auto max-h-60 whitespace-pre-wrap">{doc.content}</pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Entity Extraction artifact viewer
// ---------------------------------------------------------------------------

function isEntityExtraction(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("entity extraction") &&
    "entities_by_type" in (artifact as Record<string, unknown>)
  );
}

const TYPE_COLORS: Record<string, string> = {
  team_member: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  team: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
  client_company: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
  client_person: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  repository: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  integration: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  infrastructure: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
  cloud_resource: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  library: "bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-300",
  database: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  environment: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  project: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300",
  ticket: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  pull_request: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  pipeline: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  customer_feedback: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-emerald-600",
  medium: "text-amber-600",
  low: "text-red-500",
};

function confidenceReason(refs: EntityEntry["source_refs"] | undefined, confidence: string): string {
  if (!refs || refs.length === 0) return confidence;
  const providers = [...new Set(refs.map((r) => r.source_type))];
  if (confidence === "high") return `high: confirmed in ${refs.length} source${refs.length > 1 ? "s" : ""} (${providers.join(", ")})`;
  if (confidence === "medium") return `medium: single clear mention (${providers.join(", ")})`;
  return `low: inferred from ${providers.join(", ")}`;
}

const PROVIDER_ICONS: Record<string, string> = {
  confluence: "📄", jira: "🎫", slack: "💬", github: "🔧", customerFeedback: "📣",
};

// ---------------------------------------------------------------------------
// Extraction Validation artifact viewer
// ---------------------------------------------------------------------------

type ExtractionValidationRecoveryDetail = {
  display_name: string;
  type?: string;
  recovery_source?: string;
  reason?: string;
};

type ExtractionValidationRecoveryDetails =
  | ExtractionValidationRecoveryDetail[]
  | {
      deterministic_actions?: Array<Record<string, unknown>>;
      kept?: Array<Record<string, unknown>>;
      rejected?: Array<Record<string, unknown>>;
      retyped?: Array<Record<string, unknown>>;
    };

function normalizeExtractionValidationRecoveryDetails(
  recoveryDetails: ExtractionValidationRecoveryDetails | undefined,
): ExtractionValidationRecoveryDetail[] {
  if (!Array.isArray(recoveryDetails)) return [];
  return recoveryDetails
    .filter((detail): detail is ExtractionValidationRecoveryDetail => Boolean(detail && typeof detail === "object"))
    .map((detail) => ({
      display_name: String(detail.display_name ?? "").trim(),
      type: detail.type ? String(detail.type) : undefined,
      recovery_source: detail.recovery_source ? String(detail.recovery_source) : undefined,
      reason: detail.reason ? String(detail.reason) : undefined,
    }))
    .filter((detail) => detail.display_name.length > 0);
}

function isExtractionValidation(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("extraction validation") === true &&
    "recovery_details" in (artifact as Record<string, unknown>)
  );
}

function ExtractionValidationViewer({ artifact, companySlug, runId, executionId, stepId, onSelectSources }: {
  artifact: {
    original_count: number;
    programmatic_candidates: number;
    crossllm_candidates: number;
    opus_confirmed: number;
    opus_rejected: number;
    opus_retyped?: number;
    final_count: number;
    source_coverage?: { total_documents: number; documents_with_zero_entities: string[] };
    recovery_details: ExtractionValidationRecoveryDetails;
    attribute_validation?: {
      total_checked: number;
      backfilled: number;
      flagged: number;
      issues: Array<{
        node_id: string;
        display_name: string;
        field: string;
        action: "backfilled" | "flagged";
        value?: string;
        reason: string;
      }>;
    };
    duplicate_clusters?: { count: number; pairs: [string, string][] };
    decision_enrichment?: { decisions_enriched: number; scope_filled: number; decided_by_filled: number };
  };
  companySlug?: string;
  runId?: string;
  executionId?: string;
  stepId?: string;
  onSelectSources?: (refs: EntityEntry["source_refs"]) => void;
}) {
  const [showCoverage, setShowCoverage] = useState(false);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterConfidence, setFilterConfidence] = useState<string>("all");
  const [filterChangesOnly, setFilterChangesOnly] = useState(false);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const [nodesLoaded, setNodesLoaded] = useState(false);
  const [allNodes, setAllNodes] = useState<Array<{
    node_id: string; display_name: string; type: string; confidence: string;
    aliases: string[]; attributes: Record<string, any>; source_refs: EntityEntry["source_refs"];
  }>>([]);

  const gap = artifact.final_count - artifact.original_count;
  const av = artifact.attribute_validation;
  const totalCandidates = artifact.programmatic_candidates + artifact.crossllm_candidates;
  const recoveryDetails = useMemo(
    () => normalizeExtractionValidationRecoveryDetails(artifact.recovery_details),
    [artifact.recovery_details],
  );

  // --- Fetch graph nodes ---
  useEffect(() => {
    if (!companySlug || !runId) return;
    setNodesLoaded(false);
    const params = executionId ? `execution_id=${executionId}` : `run_id=${runId}`;
    fetch(`/api/${companySlug}/kb2?type=graph_nodes&${params}`)
      .then((r) => r.json())
      .then((data) => {
        setAllNodes(data.nodes ?? []);
        setNodesLoaded(true);
      })
      .catch(() => setNodesLoaded(true));
  }, [companySlug, runId]);

  // --- Highlight check ---
  const HIGHLIGHT_ALGO_VERSION = 4;
  const [highlightFailures, setHighlightFailures] = useState<Set<string>>(new Set());
  const [highlightChecked, setHighlightChecked] = useState(false);
  const [highlightComputing, setHighlightComputing] = useState(false);
  const [filterHighlightFail, setFilterHighlightFail] = useState(false);
  const highlightCancelRef = useRef(false);

  const computeHighlights = useCallback(async (forceRecompute = false) => {
    if (!companySlug || !runId || allNodes.length === 0) return;
    highlightCancelRef.current = false;
    setHighlightChecked(false);
    setHighlightFailures(new Set());
    setHighlightComputing(true);

    const SPEAKER_HEADER_RE = /^\s*\w[\w\s.]*\[[\d\-\/]+\]:\s*$/m;
    const excerptMatchesContent = (content: string, excerpt: string): boolean => {
      if (!excerpt || !content) return false;
      const clean = excerpt.slice(0, 300).trim();
      if (content.toLowerCase().includes(clean.toLowerCase())) return true;
      const normContent = normalizeForMatch(content);
      if (normContent.includes(normalizeForMatch(clean))) return true;
      const bodyOnly = clean.replace(/^\s*\w[\w\s.]*\[[\d\-\/]+\]:\s*\n?/, "").trim();
      if (bodyOnly !== clean && bodyOnly.length > 20) {
        if (normContent.includes(normalizeForMatch(bodyOnly))) return true;
      }
      const lines = clean.split("\n");
      const chunks: string[] = [];
      let cur: string[] = [];
      for (const line of lines) {
        if (SPEAKER_HEADER_RE.test(line)) {
          if (cur.length > 0) chunks.push(cur.join("\n").trim());
          cur = [];
        } else { cur.push(line); }
      }
      if (cur.length > 0) chunks.push(cur.join("\n").trim());
      const nonEmpty = chunks.filter((c) => c.length > 0);
      if (nonEmpty.length >= 2 && nonEmpty.every((c) => { const nc = normalizeForMatch(c); return nc.length < 10 || normContent.includes(nc); })) return true;
      const excerptWords = new Set(clean.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
      if (excerptWords.size >= 3) {
        const sentences = content.split(/(?<=[.!?\n])\s+/);
        for (const sent of sentences) {
          const sentWords = sent.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
          const overlap = sentWords.filter((w) => excerptWords.has(w)).length;
          if (excerptWords.size > 0 && overlap / excerptWords.size >= 0.5) return true;
        }
      }
      return false;
    };

    try {
      if (!forceRecompute && (executionId || stepId)) {
        try {
          const params = new URLSearchParams({ type: "highlight_check" });
          if (executionId) params.set("execution_id", executionId);
          else { params.set("run_id", runId!); params.set("step_id", stepId!); }
          const res = await fetch(`/api/${companySlug}/kb2?${params}`);
          if (res.ok) {
            const data = await res.json();
            if (data.highlight_failures && data.highlight_failures.algorithm_version === HIGHLIGHT_ALGO_VERSION) {
              if (highlightCancelRef.current) return;
              setHighlightFailures(new Set(data.highlight_failures.failures));
              setHighlightChecked(true);
              return;
            }
          }
        } catch { /* fall through */ }
      }

      const allRefs: { source_type: string; doc_id: string }[] = [];
      for (const n of allNodes) {
        for (const r of (n.source_refs ?? [])) {
          allRefs.push({ source_type: r.source_type, doc_id: r.doc_id });
        }
      }
      const uniqueKeys = new Map<string, { source_type: string; doc_id: string }>();
      for (const r of allRefs) {
        const k = `${r.source_type}:${r.doc_id}`;
        if (!uniqueKeys.has(k)) uniqueKeys.set(k, r);
      }

      const docContents = new Map<string, string>();
      const entries = [...uniqueKeys.entries()];
      const BATCH = 6;
      for (let bi = 0; bi < entries.length; bi += BATCH) {
        const batch = entries.slice(bi, bi + BATCH);
        const results = await Promise.all(batch.map(async ([key, ref]) => {
          try {
            const params = new URLSearchParams({ type: "parsed_doc", doc_id: ref.doc_id, run_id: runId! });
            if (ref.source_type) params.set("source_type", ref.source_type);
            const res = await fetch(`/api/${companySlug}/kb2?${params}`);
            if (!res.ok) return [key, ""] as const;
            const data = await res.json();
            const doc = data.document;
            let content = doc?.content ?? "";
            if (!content && doc?.sections?.length) {
              content = doc.sections.map((s: any) => `## ${s.heading}\n${s.content}`).join("\n\n");
            }
            return [key, content] as const;
          } catch { return [key, ""] as const; }
        }));
        for (const [key, content] of results) docContents.set(key, content);
      }
      if (highlightCancelRef.current) return;

      const failures = new Set<string>();
      const failureDetails: Array<{ entity_key: string; source_ref: { source_type: string; doc_id: string; title: string; excerpt_preview: string }; reason: string }> = [];
      let totalChecked = 0;

      for (const n of allNodes) {
        totalChecked++;
        const entityKey = `${n.type}:${n.display_name}`;
        for (const ref of (n.source_refs ?? [])) {
          const cacheKey = `${ref.source_type}:${ref.doc_id}`;
          const content = docContents.get(cacheKey) ?? "";
          if (!content) {
            failures.add(entityKey);
            failureDetails.push({ entity_key: entityKey, source_ref: { source_type: ref.source_type, doc_id: ref.doc_id, title: ref.title, excerpt_preview: (ref.excerpt ?? "").slice(0, 120) }, reason: "no_content" });
            break;
          }
          if (ref.excerpt && !excerptMatchesContent(content, ref.excerpt)) {
            failures.add(entityKey);
            failureDetails.push({ entity_key: entityKey, source_ref: { source_type: ref.source_type, doc_id: ref.doc_id, title: ref.title, excerpt_preview: (ref.excerpt ?? "").slice(0, 120) }, reason: "no_match" });
            break;
          }
        }
      }

      setHighlightFailures(failures);
      setHighlightChecked(true);

      if (executionId || stepId) {
        try {
          await fetch(`/api/${companySlug}/kb2`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "save_highlight_check",
              run_id: runId,
              step_id: stepId,
              execution_id: executionId,
              highlight_failures: {
                checked_at: new Date().toISOString(),
                algorithm_version: HIGHLIGHT_ALGO_VERSION,
                failures: [...failures],
                total_checked: totalChecked,
                failure_details: failureDetails,
              },
            }),
          });
        } catch { /* best-effort */ }
      }
    } finally {
      setHighlightComputing(false);
    }
  }, [companySlug, runId, executionId, stepId, allNodes]);

  useEffect(() => {
    if (nodesLoaded && allNodes.length > 0) computeHighlights();
    return () => { highlightCancelRef.current = true; };
  }, [nodesLoaded, computeHighlights]);

  const highlightFailCount = allNodes.filter((n) => highlightFailures.has(`${n.type}:${n.display_name}`)).length;

  // --- Build change-tracking lookup maps ---
  const { issuesByName, recoveredNames } = useMemo(() => {
    const issuesByName = new Map<string, typeof av extends undefined ? never : NonNullable<typeof av>["issues"]>();
    if (av?.issues) {
      for (const issue of av.issues) {
        const key = issue.display_name.toLowerCase().trim();
        const existing = issuesByName.get(key) ?? [];
        existing.push(issue);
        issuesByName.set(key, existing);
      }
    }
    const recoveredNames = new Set<string>(
      recoveryDetails.map((r) => r.display_name.toLowerCase().trim()),
    );
    return { issuesByName, recoveredNames };
  }, [av?.issues, recoveryDetails]);

  // --- Build type counts and filtered list ---
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of allNodes) {
      counts[n.type] = (counts[n.type] ?? 0) + 1;
    }
    return counts;
  }, [allNodes]);

  const [filterProcessStatus, setFilterProcessStatus] = useState<string>("all");
  const [filterDocLevel, setFilterDocLevel] = useState<string>("all");

  const filtered = useMemo(() => {
    const result = allNodes.filter((n) => {
      if (filterType !== "all" && n.type !== filterType) return false;
      if (filterConfidence !== "all" && n.confidence !== filterConfidence) return false;
      if (filterProcessStatus !== "all" && (n.attributes?.status ?? "") !== filterProcessStatus) return false;
      if (filterDocLevel !== "all" && (n.attributes?.documentation_level ?? "") !== filterDocLevel) return false;
      if (filterHighlightFail && !highlightFailures.has(`${n.type}:${n.display_name}`)) return false;
      if (filterChangesOnly) {
        const nameKey = n.display_name.toLowerCase().trim();
        const hasIssues = issuesByName.has(nameKey);
        const isRecovered = recoveredNames.has(nameKey) || !!(n.attributes as any)?._recovery_source;
        if (!hasIssues && !isRecovered) return false;
      }
      return true;
    });
    result.sort((a, b) => {
      const aIsProject = a.type === "project" ? 0 : 1;
      const bIsProject = b.type === "project" ? 0 : 1;
      if (aIsProject !== bIsProject) return aIsProject - bIsProject;
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.display_name.localeCompare(b.display_name);
    });
    return result;
  }, [allNodes, filterType, filterConfidence, filterProcessStatus, filterDocLevel, filterHighlightFail, highlightFailures, filterChangesOnly, issuesByName, recoveredNames]);

  const types = useMemo(() => Object.keys(typeCounts).sort(), [typeCounts]);

  // --- Count changed entities ---
  const changedCount = useMemo(() => {
    let count = 0;
    for (const n of allNodes) {
      const nameKey = n.display_name.toLowerCase().trim();
      if (issuesByName.has(nameKey) || recoveredNames.has(nameKey) || (n.attributes as any)?._recovery_source) count++;
    }
    return count;
  }, [allNodes, issuesByName, recoveredNames]);

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Extraction Validation
      </h4>

      {/* Summary grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.original_count}</div>
          <div className="text-[10px] text-muted-foreground">Entities Before</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className={`text-lg font-bold ${gap > 0 ? "text-emerald-600" : ""}`}>{artifact.final_count}</div>
          <div className="text-[10px] text-muted-foreground">Entities After {gap > 0 && <span className="text-emerald-600">(+{gap})</span>}</div>
        </div>
        {av && (
          <>
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold text-blue-600">{av.backfilled}</div>
              <div className="text-[10px] text-muted-foreground">Attrs Backfilled</div>
            </div>
            <div className="border rounded-md p-2 text-center">
              <div className={`text-lg font-bold ${av.flagged > 0 ? "text-amber-600" : "text-muted-foreground"}`}>{av.flagged}</div>
              <div className="text-[10px] text-muted-foreground">Attrs Flagged</div>
            </div>
          </>
        )}
        {!av && (
          <>
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold">{totalCandidates}</div>
              <div className="text-[10px] text-muted-foreground">Candidates</div>
            </div>
            <div className="border rounded-md p-2 text-center">
              <div className="text-lg font-bold text-emerald-600">{artifact.opus_confirmed}</div>
              <div className="text-[10px] text-muted-foreground">Confirmed</div>
            </div>
          </>
        )}
        <button
          onClick={() => setFilterHighlightFail(!filterHighlightFail)}
          className={`border rounded-md p-2 text-center transition-colors ${highlightFailCount > 0 ? "border-red-300 dark:border-red-700" : ""} ${filterHighlightFail ? "ring-2 ring-red-400" : ""}`}
        >
          <div className={`text-lg font-bold ${!highlightChecked ? "text-muted-foreground" : highlightFailCount > 0 ? "text-red-600" : "text-emerald-600"}`}>
            {highlightComputing ? <Loader2 className="h-4 w-4 animate-spin inline" /> : highlightChecked ? highlightFailCount : "…"}
          </div>
          <div className="text-[10px] text-muted-foreground">No Highlight</div>
        </button>
        <button
          onClick={() => computeHighlights(true)}
          disabled={highlightComputing}
          className="border rounded-md p-2 text-center transition-colors hover:bg-accent/50 disabled:opacity-50"
          title="Recompute highlight check from scratch"
        >
          <div className="text-lg font-bold text-muted-foreground"><RefreshCw className={`h-4 w-4 inline ${highlightComputing ? "animate-spin" : ""}`} /></div>
          <div className="text-[10px] text-muted-foreground">Recheck</div>
        </button>
        {nodesLoaded && (() => {
          const brokenSourceCount = allNodes.filter((n) => {
            if (!n.source_refs || n.source_refs.length === 0) return true;
            return n.source_refs.every((r: any) => !r.doc_id && !r.title);
          }).length;
          return (
            <div className={`border rounded-md p-2 text-center ${brokenSourceCount > 0 ? "border-orange-300 dark:border-orange-700" : ""}`}>
              <div className={`text-lg font-bold ${brokenSourceCount > 0 ? "text-orange-600" : "text-emerald-600"}`}>{brokenSourceCount}</div>
              <div className="text-[10px] text-muted-foreground">Broken Sources</div>
            </div>
          );
        })()}
      </div>

      {/* Recovery pipeline stats */}
      <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        <span>Programmatic: {artifact.programmatic_candidates}</span>
        <span>|</span>
        <span>GPT cross-check: {artifact.crossllm_candidates}</span>
        <span>|</span>
        <span className="text-emerald-600">Confirmed: {artifact.opus_confirmed}</span>
        <span className="text-red-500">Rejected: {artifact.opus_rejected}</span>
        {artifact.opus_retyped != null && artifact.opus_retyped > 0 && (
          <span className="text-amber-600">Retyped: {artifact.opus_retyped}</span>
        )}
        {artifact.duplicate_clusters && artifact.duplicate_clusters.count > 0 && (
          <>
            <span>|</span>
            <span className="text-orange-600">{artifact.duplicate_clusters.count} Duplicate Pairs</span>
          </>
        )}
        {artifact.decision_enrichment && artifact.decision_enrichment.decisions_enriched > 0 && (
          <>
            <span>|</span>
            <span className="text-purple-600">{artifact.decision_enrichment.decisions_enriched} Decisions Linked</span>
          </>
        )}
      </div>

      {/* Source Coverage */}
      {artifact.source_coverage && (
        <div>
          <button
            onClick={() => setShowCoverage(!showCoverage)}
            className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1 hover:text-foreground"
          >
            {showCoverage ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Source Coverage ({artifact.source_coverage.total_documents} docs, {artifact.source_coverage.documents_with_zero_entities.length} uncovered)
          </button>
          {showCoverage && artifact.source_coverage.documents_with_zero_entities.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {artifact.source_coverage.documents_with_zero_entities.map((title, i) => (
                <div key={i} className="text-[10px] text-amber-600 dark:text-amber-400 px-2 py-0.5 bg-amber-50 dark:bg-amber-950/30 rounded">
                  {title}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* --- Entity Table --- */}
      {nodesLoaded && allNodes.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
                All Entities ({filtered.length}{filtered.length !== allNodes.length ? ` / ${allNodes.length}` : ""})
                {changedCount > 0 && <span className="ml-2 text-blue-600">{changedCount} changed by Step 4</span>}
              </h4>
              <div className="flex items-center gap-2">
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger className="h-7 text-[11px] w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {types.map((t) => (
                      <SelectItem key={t} value={t}>{(ENTITY_TYPE_META[t]?.label ?? t.replace(/_/g, " "))} ({typeCounts[t]})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={filterConfidence} onValueChange={setFilterConfidence}>
                  <SelectTrigger className="h-7 text-[11px] w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Confidence</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={filterProcessStatus} onValueChange={setFilterProcessStatus}>
                  <SelectTrigger className="h-7 text-[11px] w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="proposed">Proposed</SelectItem>
                    <SelectItem value="planned">Planned</SelectItem>
                    <SelectItem value="deprecated">Deprecated</SelectItem>
                    <SelectItem value="informal">Informal</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={filterDocLevel} onValueChange={setFilterDocLevel}>
                  <SelectTrigger className="h-7 text-[11px] w-[130px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Doc Level</SelectItem>
                    <SelectItem value="documented">Documented</SelectItem>
                    <SelectItem value="undocumented">Undocumented</SelectItem>
                  </SelectContent>
                </Select>
                <button
                  onClick={() => setFilterChangesOnly(!filterChangesOnly)}
                  className={`text-[10px] px-2 py-1 rounded border transition-colors ${filterChangesOnly ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700" : "text-muted-foreground border-border hover:bg-muted/50"}`}
                >
                  Step 4 changes only
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left px-3 py-1.5 font-medium">Name</th>
                    <th className="text-left px-3 py-1.5 font-medium">Type</th>
                    <th className="text-left px-3 py-1.5 font-medium">Confidence</th>
                    <th className="text-right px-3 py-1.5 font-medium">Sources</th>
                    <th className="text-left px-3 py-1.5 font-medium">Step 4</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((node) => {
                    const nameKey = node.display_name.toLowerCase().trim();
                    const issues = issuesByName.get(nameKey);
                    const isRecovered = recoveredNames.has(nameKey) || !!(node.attributes as any)?._recovery_source;
                    const hasBackfill = issues?.some((i) => i.action === "backfilled");
                    const hasFlagged = issues?.some((i) => i.action === "flagged");
                    const key = `${node.type}:${node.display_name}`;
                    const isExpanded = expandedEntity === key;
                    const meta = ENTITY_TYPE_META[node.type] ?? { label: node.type, color: "bg-gray-100 text-gray-800" };
                    const hasHighlightFail = highlightChecked && highlightFailures.has(key);

                    return (
                      <Fragment key={key}>
                        <tr
                          className={`border-t cursor-pointer hover:bg-muted/30 transition-colors ${isExpanded ? "bg-muted/20" : ""}`}
                          onClick={() => {
                            const newKey = isExpanded ? null : key;
                            setExpandedEntity(newKey);
                            if (newKey && onSelectSources) onSelectSources(node.source_refs);
                            else if (!newKey && onSelectSources) onSelectSources([]);
                          }}
                        >
                          <td className="px-3 py-1.5 font-medium">
                            <div className="flex items-center gap-1">
                              {isExpanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
                              <span className="truncate max-w-[250px]">{node.display_name}</span>
                              {hasHighlightFail && (
                                <span className="text-[9px] px-1 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 shrink-0">no highlight</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-1.5">
                            <Badge className={`text-[10px] ${meta.color}`}>{meta.label}</Badge>
                          </td>
                          <td className="px-3 py-1.5">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${CONFIDENCE_STYLE[node.confidence] ?? ""}`}>{node.confidence}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">{node.source_refs?.length ?? 0}</td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-1 flex-wrap">
                              {isRecovered && (
                                <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">+NEW</span>
                              )}
                              {hasBackfill && (
                                <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">BACKFILLED</span>
                              )}
                              {hasFlagged && (
                                <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">FLAGGED</span>
                              )}
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${key}-detail`} className="border-t bg-muted/10">
                            <td colSpan={5} className="px-4 py-3">
                              <div className="space-y-3">
                                {/* Attribute changes from Step 4 */}
                                {issues && issues.length > 0 && (
                                  <div className="border rounded-md overflow-hidden">
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 py-1.5 bg-muted/30 border-b font-medium">
                                      Step 4 Attribute Changes
                                    </div>
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="border-b text-muted-foreground bg-muted/10">
                                          <th className="text-left px-3 py-1 font-medium">Field</th>
                                          <th className="text-left px-3 py-1 font-medium">Before</th>
                                          <th className="text-left px-3 py-1 font-medium">After</th>
                                          <th className="text-left px-3 py-1 font-medium">Reason</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {issues.map((issue, ii) => (
                                          <tr key={ii} className={`border-t ${issue.action === "backfilled" ? "bg-blue-50/50 dark:bg-blue-950/20" : "bg-amber-50/50 dark:bg-amber-950/20"}`}>
                                            <td className="px-3 py-1.5 font-mono">{issue.field}</td>
                                            <td className="px-3 py-1.5 text-muted-foreground italic">
                                              {issue.action === "backfilled" ? <span className="text-red-500/70">missing</span> : <span className="text-red-500/70">missing</span>}
                                            </td>
                                            <td className="px-3 py-1.5">
                                              {issue.action === "backfilled" ? (
                                                <span className="font-mono text-blue-700 dark:text-blue-300">&quot;{issue.value}&quot;</span>
                                              ) : (
                                                <span className="text-amber-600 dark:text-amber-400 italic">still missing</span>
                                              )}
                                            </td>
                                            <td className="px-3 py-1.5 text-[10px] text-muted-foreground max-w-[200px]">{issue.reason}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}

                                {/* LLM reasoning for inferred attributes */}
                                {(node.attributes as any)?._status_reasoning && (
                                  <div className="flex items-start gap-2 text-xs bg-blue-50 dark:bg-blue-950/30 rounded px-3 py-2 border border-blue-200 dark:border-blue-800">
                                    <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 shrink-0">LLM</span>
                                    <div className="text-[10px] text-muted-foreground">
                                      {(node.attributes as any)._status_reasoning}
                                    </div>
                                  </div>
                                )}

                                {/* Recovery info for +NEW entities */}
                                {isRecovered && (() => {
                                  const recoverySource = (node.attributes as any)?._recovery_source;
                                  const recoveryDetail = recoveryDetails.find((r) => r.display_name.toLowerCase().trim() === nameKey);
                                  return (
                                    <div className="flex items-start gap-2 text-xs bg-emerald-50 dark:bg-emerald-950/30 rounded px-3 py-2 border border-emerald-200 dark:border-emerald-800">
                                      <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 shrink-0">+NEW</span>
                                      <div className="min-w-0">
                                        <div className="font-medium">Added by Step 4 via {(recoverySource ?? recoveryDetail?.recovery_source ?? "unknown").replace(/_/g, " ")}</div>
                                        {recoveryDetail?.reason && (
                                          <div className="text-[10px] text-muted-foreground mt-0.5">{recoveryDetail.reason}</div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })()}

                                {/* Source coverage badges */}
                                {(node.attributes as any)?._source_coverage && (() => {
                                  const sc = (node.attributes as any)._source_coverage as Record<string, boolean>;
                                  const pills: { key: string; label: string; active: boolean }[] = [
                                    { key: "has_confluence", label: "Confluence", active: sc.has_confluence },
                                    { key: "has_jira", label: "Jira", active: sc.has_jira },
                                    { key: "has_github", label: "GitHub", active: sc.has_github },
                                    { key: "has_slack", label: "Slack", active: sc.has_slack },
                                    { key: "has_feedback", label: "Feedback", active: sc.has_feedback },
                                  ];
                                  return (
                                    <div className="flex items-center gap-1 flex-wrap">
                                      <span className="text-[9px] text-muted-foreground uppercase tracking-wider mr-1">Sources:</span>
                                      {pills.map((p) => (
                                        <span key={p.key} className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${p.active ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300" : "bg-muted/40 text-muted-foreground/50 line-through"}`}>
                                          {p.label}
                                        </span>
                                      ))}
                                    </div>
                                  );
                                })()}

                                {/* Duplicate warning */}
                                {(node.attributes as any)?._likely_duplicates && (node.attributes as any)._likely_duplicates.length > 0 && (
                                  <div className="flex items-start gap-2 text-xs bg-orange-50 dark:bg-orange-950/30 rounded px-3 py-2 border border-orange-200 dark:border-orange-800">
                                    <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 shrink-0">DUPE?</span>
                                    <div className="min-w-0">
                                      <div className="font-medium">Possible duplicate of:</div>
                                      <div className="text-[10px] text-muted-foreground mt-0.5">
                                        {((node.attributes as any)._likely_duplicates as string[]).join(", ")}
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {/* Related entities for decisions */}
                                {(node.attributes as any)?._related_entities && (node.attributes as any)._related_entities.length > 0 && (
                                  <div className="border rounded-md overflow-hidden">
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 py-1.5 bg-muted/30 border-b font-medium">
                                      Related Entities
                                    </div>
                                    <div className="px-3 py-2 flex flex-wrap gap-1.5">
                                      {((node.attributes as any)._related_entities as Array<{ name: string; type: string }>).map((rel, ri) => {
                                        const relMeta = ENTITY_TYPE_META[rel.type] ?? { label: rel.type, color: "bg-gray-100 text-gray-800" };
                                        return (
                                          <span key={ri} className="text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border">
                                            <Badge className={`text-[8px] ${relMeta.color}`}>{relMeta.label}</Badge>
                                            <span>{rel.name}</span>
                                          </span>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}

                                {/* Entity JSON */}
                                <pre className="text-[11px] bg-background rounded p-3 overflow-auto whitespace-pre-wrap break-all border max-h-80 font-mono">
                                  {JSON.stringify({
                                    display_name: node.display_name,
                                    type: node.type,
                                    source_documents: node.source_refs?.map((ref) => ({
                                      title: ref.title + (ref.section_heading ? ` (${ref.section_heading})` : ""),
                                      evidence_excerpt: ref.excerpt,
                                    })),
                                    aliases: node.aliases,
                                    attributes: Object.fromEntries(
                                      Object.entries(node.attributes ?? {}).filter(([k]) => !k.startsWith("_"))
                                    ),
                                    confidence: node.confidence,
                                  }, null, 2)}
                                </pre>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {!nodesLoaded && companySlug && runId && (
        <div className="text-xs text-muted-foreground italic px-1">Loading entities...</div>
      )}

      {nodesLoaded && allNodes.length === 0 && artifact.final_count > 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 italic px-1">
          No entity data found for this run (expected {artifact.final_count}). The graph nodes may have been cleared.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entity Resolution artifact viewer
// ---------------------------------------------------------------------------

function isEntityResolution(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("entity resolution") === true &&
    "merges" in (artifact as Record<string, unknown>)
  );
}

function EntityResolutionViewer({ artifact, companySlug, runId, executionId, onSelectSources }: {
  artifact: {
    total_entities_before: number;
    total_entities_after: number;
    candidates_found: number;
    merges_performed: number;
    merges: { from: string; into: string; canonicalName: string; reason: string }[];
  };
  companySlug?: string;
  runId?: string;
  executionId?: string;
  onSelectSources?: (refs: EntityEntry["source_refs"]) => void;
}) {
  const [showMerges, setShowMerges] = useState(true);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterConfidence, setFilterConfidence] = useState<string>("all");
  const [filterMergedOnly, setFilterMergedOnly] = useState(false);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const [nodesLoaded, setNodesLoaded] = useState(false);
  const [allNodes, setAllNodes] = useState<Array<{
    node_id: string; display_name: string; type: string; confidence: string;
    aliases: string[]; attributes: Record<string, any>; source_refs: EntityEntry["source_refs"];
  }>>([]);

  useEffect(() => {
    if (!companySlug || !runId) return;
    setNodesLoaded(false);
    const params = executionId ? `execution_id=${executionId}` : `run_id=${runId}`;
    fetch(`/api/${companySlug}/kb2?type=graph_nodes&${params}`)
      .then((r) => r.json())
      .then((data) => { setAllNodes(data.nodes ?? []); setNodesLoaded(true); })
      .catch(() => setNodesLoaded(true));
  }, [companySlug, runId, executionId]);

  const mergedNames = useMemo(() => {
    const s = new Set<string>();
    for (const m of artifact.merges) {
      s.add(m.from.toLowerCase().trim());
      s.add(m.into.toLowerCase().trim());
      s.add(m.canonicalName.toLowerCase().trim());
    }
    return s;
  }, [artifact.merges]);

  const mergeInfoMap = useMemo(() => {
    const map = new Map<string, { from: string[]; reason: string }>();
    for (const m of artifact.merges) {
      const key = m.canonicalName.toLowerCase().trim();
      const existing = map.get(key);
      if (existing) { existing.from.push(m.from); }
      else { map.set(key, { from: [m.from], reason: m.reason }); }
    }
    return map;
  }, [artifact.merges]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of allNodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
    return counts;
  }, [allNodes]);

  const types = useMemo(() => Object.keys(typeCounts).sort(), [typeCounts]);

  const filtered = useMemo(() => {
    const result = allNodes.filter((n) => {
      if (filterType !== "all" && n.type !== filterType) return false;
      if (filterConfidence !== "all" && n.confidence !== filterConfidence) return false;
      if (filterMergedOnly) {
        if (!mergedNames.has(n.display_name.toLowerCase().trim())) return false;
      }
      return true;
    });
    result.sort((a, b) => {
      const aIsProject = a.type === "project" ? 0 : 1;
      const bIsProject = b.type === "project" ? 0 : 1;
      if (aIsProject !== bIsProject) return aIsProject - bIsProject;
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.display_name.localeCompare(b.display_name);
    });
    return result;
  }, [allNodes, filterType, filterConfidence, filterMergedOnly, mergedNames]);

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Entity Resolution
      </h4>
      <div className="flex flex-wrap gap-3 text-xs">
        <span className="bg-muted/50 rounded px-2 py-1">Before: <strong>{artifact.total_entities_before}</strong></span>
        <span className="text-blue-600 font-medium">-{artifact.merges_performed} merged</span>
        <span className="bg-muted/50 rounded px-2 py-1">After: <strong>{artifact.total_entities_after}</strong></span>
      </div>
      <div className="text-[10px] text-muted-foreground">
        {artifact.candidates_found} candidate pairs reviewed
      </div>

      {artifact.merges.length > 0 && (
        <div>
          <button
            onClick={() => setShowMerges(!showMerges)}
            className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1 hover:text-foreground"
          >
            {showMerges ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Merges ({artifact.merges.length})
          </button>
          {showMerges && (
            <div className="space-y-1 mt-1">
              {artifact.merges.map((m, i) => (
                <div key={i} className="flex items-center gap-2 text-xs bg-blue-50 dark:bg-blue-950/30 rounded px-2 py-1 border border-blue-200 dark:border-blue-800">
                  <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                    MERGE
                  </span>
                  <span className="text-red-500 line-through">{m.from}</span>
                  <span className="text-muted-foreground">&rarr;</span>
                  <span className="font-medium text-emerald-600">{m.canonicalName}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[40%]">{m.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {nodesLoaded && allNodes.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Post-Resolution Entities ({filtered.length}{filtered.length !== allNodes.length ? ` / ${allNodes.length}` : ""})
              </h4>
              <div className="flex items-center gap-2">
                <Select value={filterType} onValueChange={setFilterType}>
                  <SelectTrigger className="h-7 text-[11px] w-[140px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {types.map((t) => (
                      <SelectItem key={t} value={t}>{(ENTITY_TYPE_META[t]?.label ?? t.replace(/_/g, " "))} ({typeCounts[t]})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={filterConfidence} onValueChange={setFilterConfidence}>
                  <SelectTrigger className="h-7 text-[11px] w-[110px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Confidence</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
                <button
                  onClick={() => setFilterMergedOnly(!filterMergedOnly)}
                  className={`text-[10px] px-2 py-1 rounded border transition-colors ${filterMergedOnly ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700" : "text-muted-foreground border-border hover:bg-muted/50"}`}
                >
                  Merged only
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left px-3 py-1.5 font-medium">Name</th>
                    <th className="text-left px-3 py-1.5 font-medium">Type</th>
                    <th className="text-left px-3 py-1.5 font-medium">Confidence</th>
                    <th className="text-right px-3 py-1.5 font-medium">Sources</th>
                    <th className="text-left px-3 py-1.5 font-medium">Step 5</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((node) => {
                    const nameKey = node.display_name.toLowerCase().trim();
                    const isMerged = mergedNames.has(nameKey);
                    const mergeInfo = mergeInfoMap.get(nameKey);
                    const key = `${node.type}:${node.display_name}`;
                    const isExpanded = expandedEntity === key;
                    const meta = ENTITY_TYPE_META[node.type] ?? { label: node.type, color: "bg-gray-100 text-gray-800" };

                    return (
                      <Fragment key={key}>
                        <tr
                          className={`border-t cursor-pointer hover:bg-muted/30 transition-colors ${isExpanded ? "bg-muted/20" : ""}`}
                          onClick={() => {
                            const newKey = isExpanded ? null : key;
                            setExpandedEntity(newKey);
                            if (newKey && onSelectSources) onSelectSources(node.source_refs);
                            else if (!newKey && onSelectSources) onSelectSources([]);
                          }}
                        >
                          <td className="px-3 py-1.5 font-medium">
                            <div className="flex items-center gap-1">
                              {isExpanded ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
                              <span className="truncate max-w-[250px]">{node.display_name}</span>
                            </div>
                          </td>
                          <td className="px-3 py-1.5">
                            <Badge className={`text-[10px] ${meta.color}`}>{meta.label}</Badge>
                          </td>
                          <td className="px-3 py-1.5">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${CONFIDENCE_STYLE[node.confidence] ?? ""}`}>{node.confidence}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">{node.source_refs?.length ?? 0}</td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-1 flex-wrap">
                              {isMerged && (
                                <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">MERGED</span>
                              )}
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${key}-detail`} className="border-t bg-muted/10">
                            <td colSpan={5} className="px-4 py-3">
                              <div className="space-y-3">
                                {mergeInfo && (
                                  <div className="flex items-start gap-2 text-xs bg-blue-50 dark:bg-blue-950/30 rounded px-3 py-2 border border-blue-200 dark:border-blue-800">
                                    <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 shrink-0">MERGED</span>
                                    <div className="min-w-0">
                                      <div className="font-medium">Absorbed: <span className="text-red-500 line-through">{mergeInfo.from.join(", ")}</span></div>
                                      <div className="text-[10px] text-muted-foreground mt-0.5">{mergeInfo.reason}</div>
                                    </div>
                                  </div>
                                )}

                                {(node.attributes as any)?._status_reasoning && (
                                  <div className="flex items-start gap-2 text-xs bg-blue-50 dark:bg-blue-950/30 rounded px-3 py-2 border border-blue-200 dark:border-blue-800">
                                    <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 shrink-0">LLM</span>
                                    <div className="text-[10px] text-muted-foreground">
                                      {(node.attributes as any)._status_reasoning}
                                    </div>
                                  </div>
                                )}

                                {(node.attributes as any)?._source_coverage && (() => {
                                  const sc = (node.attributes as any)._source_coverage as Record<string, boolean>;
                                  const pills: { key: string; label: string; active: boolean }[] = [
                                    { key: "has_confluence", label: "Confluence", active: sc.has_confluence },
                                    { key: "has_jira", label: "Jira", active: sc.has_jira },
                                    { key: "has_github", label: "GitHub", active: sc.has_github },
                                    { key: "has_slack", label: "Slack", active: sc.has_slack },
                                    { key: "has_feedback", label: "Feedback", active: sc.has_feedback },
                                  ];
                                  return (
                                    <div className="flex items-center gap-1 flex-wrap">
                                      <span className="text-[9px] text-muted-foreground uppercase tracking-wider mr-1">Sources:</span>
                                      {pills.map((p) => (
                                        <span key={p.key} className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${p.active ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300" : "bg-muted/40 text-muted-foreground/50 line-through"}`}>
                                          {p.label}
                                        </span>
                                      ))}
                                    </div>
                                  );
                                })()}

                                {(node.attributes as any)?._likely_duplicates && (node.attributes as any)._likely_duplicates.length > 0 && (
                                  <div className="flex items-start gap-2 text-xs bg-orange-50 dark:bg-orange-950/30 rounded px-3 py-2 border border-orange-200 dark:border-orange-800">
                                    <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 shrink-0">DUPE?</span>
                                    <div className="min-w-0">
                                      <div className="font-medium">Possible duplicate of:</div>
                                      <div className="text-[10px] text-muted-foreground mt-0.5">
                                        {((node.attributes as any)._likely_duplicates as string[]).join(", ")}
                                      </div>
                                    </div>
                                  </div>
                                )}

                                {(node.attributes as any)?._related_entities && (node.attributes as any)._related_entities.length > 0 && (
                                  <div className="border rounded-md overflow-hidden">
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 py-1.5 bg-muted/30 border-b font-medium">
                                      Related Entities
                                    </div>
                                    <div className="px-3 py-2 flex flex-wrap gap-1.5">
                                      {((node.attributes as any)._related_entities as Array<{ name: string; type: string }>).map((rel, ri) => {
                                        const relMeta = ENTITY_TYPE_META[rel.type] ?? { label: rel.type, color: "bg-gray-100 text-gray-800" };
                                        return (
                                          <span key={ri} className="text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border">
                                            <Badge className={`text-[8px] ${relMeta.color}`}>{relMeta.label}</Badge>
                                            <span>{rel.name}</span>
                                          </span>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}

                                <pre className="text-[11px] bg-background rounded p-3 overflow-auto whitespace-pre-wrap break-all border max-h-80 font-mono">
                                  {JSON.stringify({
                                    display_name: node.display_name,
                                    type: node.type,
                                    source_documents: node.source_refs?.map((ref) => ({
                                      title: ref.title + (ref.section_heading ? ` (${ref.section_heading})` : ""),
                                      evidence_excerpt: ref.excerpt,
                                    })),
                                    aliases: node.aliases,
                                    attributes: Object.fromEntries(
                                      Object.entries(node.attributes ?? {}).filter(([k]) => !k.startsWith("_"))
                                    ),
                                    confidence: node.confidence,
                                  }, null, 2)}
                                </pre>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {!nodesLoaded && companySlug && runId && (
        <div className="text-xs text-muted-foreground italic px-1">Loading entities...</div>
      )}

      {nodesLoaded && allNodes.length === 0 && artifact.total_entities_after > 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 italic px-1">
          No entity data found for this run (expected {artifact.total_entities_after}). The graph nodes may have been cleared.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph Enrichment artifact viewer
// ---------------------------------------------------------------------------

function isGraphEnrichment(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("graph enrichment") === true &&
    "new_edges" in (artifact as Record<string, unknown>)
  );
}

function GraphEnrichmentViewer({ artifact }: {
  artifact: {
    new_edges: number;
    total_nodes: number;
    llm_calls?: number;
    added_edges?: { source: string; target: string; type: string; evidence: string }[];
  };
}) {
  const [filterType, setFilterType] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const EDGE_TYPE_COLORS: Record<string, string> = {
    OWNED_BY: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    DEPENDS_ON: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    USES: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
    STORES_IN: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    DEPLOYED_TO: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
    MEMBER_OF: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
    WORKS_ON: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300",
    LEADS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    CONTAINS: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
    RUNS_ON: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    BUILT_BY: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
    RESOLVES: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    RELATED_TO: "bg-gray-100 text-gray-700 dark:bg-gray-800/40 dark:text-gray-300",
    BLOCKED_BY: "bg-red-200 text-red-900 dark:bg-red-900/50 dark:text-red-200",
    COMMUNICATES_VIA: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
    FEEDBACK_FROM: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  };

  const typeCounts = useMemo(() => {
    if (!artifact.added_edges) return {};
    const map: Record<string, number> = {};
    for (const e of artifact.added_edges) map[e.type] = (map[e.type] || 0) + 1;
    return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]));
  }, [artifact.added_edges]);

  const displayedEdges = useMemo(() => {
    if (!artifact.added_edges) return [];
    return filterType ? artifact.added_edges.filter(e => e.type === filterType) : artifact.added_edges;
  }, [artifact.added_edges, filterType]);

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Graph Enrichment</h4>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.total_nodes}</div>
          <div className="text-[10px] text-muted-foreground">Nodes</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-blue-600">+{artifact.new_edges}</div>
          <div className="text-[10px] text-muted-foreground">New Relationships</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{Object.keys(typeCounts).length}</div>
          <div className="text-[10px] text-muted-foreground">Edge Types</div>
        </div>
        {artifact.llm_calls != null && (
          <div className="border rounded-md p-2 text-center">
            <div className="text-lg font-bold">{artifact.llm_calls}</div>
            <div className="text-[10px] text-muted-foreground">LLM Calls</div>
          </div>
        )}
      </div>

      {Object.keys(typeCounts).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => { setFilterType(null); setExpandedIdx(null); }}
            className={`text-[10px] rounded px-2 py-0.5 border transition-colors ${!filterType ? "bg-foreground text-background border-foreground" : "bg-muted/50 border-transparent hover:border-muted-foreground/30"}`}>
            All ({artifact.new_edges})
          </button>
          {Object.entries(typeCounts).map(([type, count]) => (
            <button key={type}
              onClick={() => { setFilterType(filterType === type ? null : type); setExpandedIdx(null); }}
              className={`text-[10px] rounded px-2 py-0.5 border transition-colors ${filterType === type ? "bg-foreground text-background border-foreground" : "bg-muted/50 border-transparent hover:border-muted-foreground/30"}`}>
              {type} ({count})
            </button>
          ))}
        </div>
      )}

      {displayedEdges.length > 0 && (
        <div className="max-h-[500px] overflow-y-auto space-y-1 mt-1">
          {displayedEdges.map((e, i) => {
            const isOpen = expandedIdx === i;
            const typeColor = EDGE_TYPE_COLORS[e.type] ?? "bg-gray-100 text-gray-700";
            return (
              <div key={i} className="border rounded-md overflow-hidden">
                <button
                  onClick={() => setExpandedIdx(isOpen ? null : i)}
                  className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-muted/30 transition-colors ${isOpen ? "bg-muted/20" : ""}`}
                >
                  {isOpen ? <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
                  <span className="font-medium">{e.source}</span>
                  <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${typeColor}`}>{e.type}</span>
                  <span className="font-medium">{e.target}</span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 pt-1 border-t bg-muted/10">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Why are they related?</div>
                    <p className="text-xs leading-relaxed">{e.evidence}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!artifact.added_edges && (
        <p className="text-xs text-muted-foreground italic">
          Detailed breakdown not available for this run. Rerun Graph Enrichment to see full details.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page Plan artifact viewer
// ---------------------------------------------------------------------------

function isPagePlan(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("page plan") === true &&
    "entity_pages" in (artifact as Record<string, unknown>)
  );
}

function PagePlanViewer({ artifact }: {
  artifact: {
    entity_pages: { page_id: string; node_type: string; display_name: string; has_template: boolean }[];
    human_pages: { category: string; layer: string; title: string; description: string }[];
    total_pages: number;
  };
}) {
  const [showEntity, setShowEntity] = useState(true);
  const [showHuman, setShowHuman] = useState(true);

  const grouped = artifact.entity_pages.reduce((acc, p) => {
    if (!acc[p.node_type]) acc[p.node_type] = [];
    acc[p.node_type].push(p);
    return acc;
  }, {} as Record<string, typeof artifact.entity_pages>);

  const sortedTypes = Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length);

  const LAYER_COLORS: Record<string, string> = {
    company: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    engineering: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    marketing: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
    legal: "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300",
  };

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Page Plan
      </h4>
      <div className="flex flex-wrap gap-3 text-xs">
        <span className="bg-muted/50 rounded px-2 py-1">Total: <strong>{artifact.total_pages}</strong> pages</span>
        <span className="text-blue-600">{artifact.entity_pages.length} entity pages</span>
        <span className="text-emerald-600">{artifact.human_pages.length} human pages</span>
      </div>

      <div>
        <button
          onClick={() => setShowEntity(!showEntity)}
          className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1 hover:text-foreground"
        >
          {showEntity ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Entity Pages ({artifact.entity_pages.length})
        </button>
        {showEntity && (
          <div className="mt-1 space-y-2">
            {sortedTypes.map((type) => (
              <div key={type}>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${TYPE_COLORS[type] ?? "bg-gray-100 text-gray-800"}`}>
                    {type.replace(/_/g, " ")}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{grouped[type].length} pages</span>
                </div>
                <div className="ml-3 flex flex-wrap gap-1">
                  {grouped[type].map((p) => (
                    <span key={p.page_id} className="text-[10px] bg-muted/50 rounded px-1.5 py-0.5 border border-border/30">
                      {p.display_name}
                      {!p.has_template && <span className="text-amber-500 ml-1" title="No template defined">*</span>}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <button
          onClick={() => setShowHuman(!showHuman)}
          className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1 hover:text-foreground"
        >
          {showHuman ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Human Pages ({artifact.human_pages.length})
        </button>
        {showHuman && (
          <div className="mt-1 space-y-1">
            {artifact.human_pages.map((hp, i) => (
              <div key={i} className="flex items-center gap-2 text-xs bg-muted/30 rounded px-2 py-1 border border-border/30">
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${LAYER_COLORS[hp.layer] ?? "bg-gray-100 text-gray-800"}`}>
                  {hp.layer}
                </span>
                <span className="font-medium">{hp.title}</span>
                <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[40%]">{hp.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discovery artifact viewer
// ---------------------------------------------------------------------------

function isDiscovery(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("discovery") === true &&
    "total_discoveries" in (artifact as Record<string, unknown>)
  );
}

interface DiscoveryItem {
  display_name: string;
  type: string;
  category: string;
  confidence: string;
  description?: string;
  evidence?: string;
  evidence_preview?: string;
  source_document?: string;
  related_entities?: string[];
}

function DiscoveryViewer({ artifact, onSelectSources }: {
  artifact: {
    total_discoveries: number;
    llm_calls?: number;
    by_category: Record<string, number>;
    discoveries?: DiscoveryItem[];
  };
  onSelectSources?: (refs: { source_type: string; doc_id: string; title: string; excerpt: string }[]) => void;
}) {
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const CATEGORY_META: Record<string, { label: string; color: string; description: string }> = {
    past_undocumented: { label: "Past Undocumented", color: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300", description: "Work that happened in the past but was never formally documented" },
    ongoing_undocumented: { label: "Ongoing Undocumented", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300", description: "Active work patterns with no formal project tracking" },
    proposed_project: { label: "Proposed Project", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300", description: "New project suggested from feedback or conversations" },
    proposed_ticket: { label: "Proposed Ticket", color: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300", description: "Bug, task, or improvement mentioned but not tracked" },
    proposed_from_feedback: { label: "From Feedback", color: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300", description: "Recurring customer request or complaint that deserves tracking" },
  };

  const CONFIDENCE_STYLE: Record<string, string> = {
    high: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
    low: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  };

  const discoveries = artifact.discoveries ?? [];

  const typeCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const d of discoveries) map[d.type] = (map[d.type] || 0) + 1;
    return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]));
  }, [discoveries]);

  const filtered = useMemo(() => {
    let result = discoveries;
    if (filterCategory) result = result.filter(d => d.category === filterCategory);
    if (filterType) result = result.filter(d => d.type === filterType);
    return result;
  }, [discoveries, filterCategory, filterType]);

  const handleExpand = (idx: number, disc: DiscoveryItem) => {
    if (expandedIdx === idx) {
      setExpandedIdx(null);
      onSelectSources?.([]);
    } else {
      setExpandedIdx(idx);
      if (disc.source_document) {
        onSelectSources?.([{
          source_type: "slack",
          doc_id: disc.source_document,
          title: disc.source_document,
          excerpt: (disc.evidence ?? disc.evidence_preview ?? "").slice(0, 300),
        }]);
      }
    }
  };

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Project & Ticket Discovery</h4>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.total_discoveries}</div>
          <div className="text-[10px] text-muted-foreground">Discovered Items</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{Object.keys(artifact.by_category).length}</div>
          <div className="text-[10px] text-muted-foreground">Categories</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{Object.keys(typeCounts).length}</div>
          <div className="text-[10px] text-muted-foreground">Entity Types</div>
        </div>
        {artifact.llm_calls != null && (
          <div className="border rounded-md p-2 text-center">
            <div className="text-lg font-bold">{artifact.llm_calls}</div>
            <div className="text-[10px] text-muted-foreground">LLM Calls</div>
          </div>
        )}
      </div>

      {/* Category filter pills */}
      {Object.keys(artifact.by_category).length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Category</div>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => { setFilterCategory(null); setExpandedIdx(null); }}
              className={`text-[10px] rounded px-2 py-0.5 border transition-colors ${!filterCategory ? "bg-foreground text-background border-foreground" : "bg-muted/50 border-transparent hover:border-muted-foreground/30"}`}>
              All ({artifact.total_discoveries})
            </button>
            {Object.entries(artifact.by_category).map(([cat, count]) => {
              const meta = CATEGORY_META[cat];
              return (
                <button key={cat}
                  onClick={() => { setFilterCategory(filterCategory === cat ? null : cat); setExpandedIdx(null); }}
                  title={meta?.description}
                  className={`text-[10px] rounded px-2 py-0.5 border transition-colors ${filterCategory === cat ? "bg-foreground text-background border-foreground" : `${meta?.color ?? "bg-gray-100 text-gray-800"} border-transparent hover:border-muted-foreground/30`}`}>
                  {meta?.label ?? cat.replace(/_/g, " ")} ({count})
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Type filter pills */}
      {Object.keys(typeCounts).length > 1 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Type</div>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => { setFilterType(null); setExpandedIdx(null); }}
              className={`text-[10px] rounded px-2 py-0.5 border transition-colors ${!filterType ? "bg-foreground text-background border-foreground" : "bg-muted/50 border-transparent hover:border-muted-foreground/30"}`}>
              All
            </button>
            {Object.entries(typeCounts).map(([type, count]) => (
              <button key={type}
                onClick={() => { setFilterType(filterType === type ? null : type); setExpandedIdx(null); }}
                className={`text-[10px] rounded px-2 py-0.5 border transition-colors ${filterType === type ? "bg-foreground text-background border-foreground" : `${TYPE_COLORS[type] ?? "bg-gray-100 text-gray-800"} border-transparent hover:border-muted-foreground/30`}`}>
                {type} ({count})
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Discovery cards */}
      {filtered.length > 0 && (
        <div className="max-h-[500px] overflow-y-auto space-y-1">
          {filtered.map((d, i) => {
            const isOpen = expandedIdx === i;
            const catMeta = CATEGORY_META[d.category];
            return (
              <div key={i} className="border rounded-md overflow-hidden">
                <button
                  onClick={() => handleExpand(i, d)}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs hover:bg-muted/30 transition-colors ${isOpen ? "bg-muted/20" : ""}`}
                >
                  {isOpen ? <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
                  <span className="font-medium truncate">{d.display_name}</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${TYPE_COLORS[d.type] ?? "bg-gray-100 text-gray-800"}`}>{d.type}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${catMeta?.color ?? "bg-gray-100 text-gray-800"}`}>{catMeta?.label ?? d.category.replace(/_/g, " ")}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ml-auto ${CONFIDENCE_STYLE[d.confidence] ?? ""}`}>{d.confidence}</span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 pt-1 border-t bg-muted/10 space-y-2">
                    {d.description && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Description</div>
                        <p className="text-xs leading-relaxed">{d.description}</p>
                      </div>
                    )}
                    {(d.evidence || d.evidence_preview) && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Evidence</div>
                        <p className="text-xs leading-relaxed bg-muted/30 rounded p-2 italic">{d.evidence ?? d.evidence_preview}</p>
                      </div>
                    )}
                    {d.source_document && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Source Document</div>
                        <span className="text-xs font-medium bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">{d.source_document}</span>
                      </div>
                    )}
                    {d.related_entities && d.related_entities.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Related Entities</div>
                        <div className="flex flex-wrap gap-1">
                          {d.related_entities.map((re, ri) => (
                            <span key={ri} className="text-[10px] px-1.5 py-0.5 rounded bg-muted/50 border border-border/50">{re}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {filtered.length === 0 && discoveries.length > 0 && (
        <p className="text-xs text-muted-foreground italic">No discoveries match the current filters.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attribute Completion Viewer (Step 9)
// ---------------------------------------------------------------------------

function isAttributeCompletion(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("attribute completion") === true &&
    "descriptions_promoted" in (artifact as Record<string, unknown>)
  );
}

function AttributeCompletionViewer({ artifact }: {
  artifact: {
    total_entities_processed: number;
    descriptions_promoted: number;
    statuses_filled: number;
    doc_levels_filled: number;
    decided_by_fixed: number;
    rationales_filled: number;
    uniform_fills?: number;
    llm_calls: number;
  };
}) {
  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Attribute Completion</h4>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.total_entities_processed}</div>
          <div className="text-[10px] text-muted-foreground">Entities Processed</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-blue-600">{artifact.descriptions_promoted}</div>
          <div className="text-[10px] text-muted-foreground">Descriptions Promoted</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-emerald-600">{artifact.statuses_filled}</div>
          <div className="text-[10px] text-muted-foreground">Statuses Filled</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-purple-600">{artifact.doc_levels_filled}</div>
          <div className="text-[10px] text-muted-foreground">Doc Levels Filled</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-amber-600">{artifact.decided_by_fixed}</div>
          <div className="text-[10px] text-muted-foreground">Decided-By Fixed</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-teal-600">{artifact.rationales_filled}</div>
          <div className="text-[10px] text-muted-foreground">Rationales Filled</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.llm_calls}</div>
          <div className="text-[10px] text-muted-foreground">LLM Calls</div>
        </div>
        {artifact.uniform_fills != null && (
          <div className="border rounded-md p-2 text-center">
            <div className="text-lg font-bold text-muted-foreground">{artifact.uniform_fills}</div>
            <div className="text-[10px] text-muted-foreground">Uniform Fills</div>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Promoted internal _description to public description on {artifact.descriptions_promoted} entities.
        Filled missing status on {artifact.statuses_filled} entities and documentation_level on {artifact.doc_levels_filled} entities.
        Fixed decided_by on {artifact.decided_by_fixed} decisions and filled {artifact.rationales_filled} rationales via LLM.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pattern Synthesis Viewer (Step 10)
// ---------------------------------------------------------------------------

function isPatternSynthesis(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("pattern synthesis") === true &&
    "conventions_found" in (artifact as Record<string, unknown>)
  );
}

function PatternSynthesisViewer({ artifact }: {
  artifact: {
    conventions_found: number;
    total_decisions_analyzed: number;
    llm_calls: number;
    conventions: Array<{
      convention_name: string;
      established_by: string;
      constituent_decisions: string[];
      confidence: string;
    }>;
  };
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const CONFIDENCE_STYLE: Record<string, string> = {
    high: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
    low: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  };

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Pattern Synthesis — Cross-Cutting Conventions</h4>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-purple-600">{artifact.conventions_found}</div>
          <div className="text-[10px] text-muted-foreground">Conventions Found</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.total_decisions_analyzed}</div>
          <div className="text-[10px] text-muted-foreground">Decisions Analyzed</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.llm_calls}</div>
          <div className="text-[10px] text-muted-foreground">LLM Calls</div>
        </div>
      </div>

      {artifact.conventions.length > 0 && (
        <div className="space-y-2">
          {artifact.conventions.map((conv, i) => {
            const isOpen = expandedIdx === i;
            return (
              <div key={i} className="border rounded-md overflow-hidden">
                <button
                  onClick={() => setExpandedIdx(isOpen ? null : i)}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs hover:bg-muted/30 transition-colors ${isOpen ? "bg-muted/20" : ""}`}
                >
                  {isOpen ? <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
                  <span className="font-medium truncate">{conv.convention_name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${CONFIDENCE_STYLE[conv.confidence] ?? ""}`}>{conv.confidence}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto shrink-0">by {conv.established_by}</span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 pt-1 border-t bg-muted/10 space-y-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Established By</div>
                      <span className="text-xs font-medium bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">{conv.established_by}</span>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Constituent Decisions ({conv.constituent_decisions.length})</div>
                      <div className="flex flex-wrap gap-1">
                        {conv.constituent_decisions.map((d, di) => (
                          <span key={di} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800">{d}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {artifact.conventions.length === 0 && (
        <p className="text-xs text-muted-foreground italic">No cross-cutting conventions were identified from the analyzed decisions.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph Re-enrichment Viewer (Step 11)
// ---------------------------------------------------------------------------

function isGraphReEnrichment(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("re-enrichment") === true &&
    "total_new_edges" in (artifact as Record<string, unknown>)
  );
}

function GraphReEnrichmentViewer({ artifact }: {
  artifact: {
    discovery_edges_added: number;
    convention_edges_added: number;
    applies_to_edges_added: number;
    total_new_edges: number;
    llm_calls: number;
  };
}) {
  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Graph Re-enrichment</h4>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-emerald-600">{artifact.total_new_edges}</div>
          <div className="text-[10px] text-muted-foreground">Total New Edges</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-blue-600">{artifact.discovery_edges_added}</div>
          <div className="text-[10px] text-muted-foreground">Discovery Edges</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-purple-600">{artifact.convention_edges_added}</div>
          <div className="text-[10px] text-muted-foreground">Convention Edges</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-amber-600">{artifact.applies_to_edges_added}</div>
          <div className="text-[10px] text-muted-foreground">APPLIES_TO Edges</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.llm_calls}</div>
          <div className="text-[10px] text-muted-foreground">LLM Calls</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Connected {artifact.discovery_edges_added} discovery nodes to existing entities via RELATED_TO edges.
        Created {artifact.convention_edges_added} CONTAINS and PROPOSED_BY edges for convention entities.
        {artifact.applies_to_edges_added > 0 && ` Linked ${artifact.applies_to_edges_added} conventions to proposed features via APPLIES_TO.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GraphRAG Retrieval Viewer (Step 13)
// ---------------------------------------------------------------------------

function isGraphRAGRetrieval(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("graphrag") === true &&
    "retrieval_packs" in (artifact as Record<string, unknown>)
  );
}

function GraphRAGRetrievalViewer({ artifact }: {
  artifact: {
    total_packs: number;
    entity_packs: number;
    human_packs: number;
    retrieval_packs: { page_id: string; page_type: string; title: string; graph_context: string[]; doc_snippets: string[]; vector_snippets: string[] }[];
  };
}) {
  const [expandedPack, setExpandedPack] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">GraphRAG Retrieval</h4>
      <div className="grid grid-cols-3 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-blue-600">{artifact.total_packs}</div>
          <div className="text-[10px] text-muted-foreground">Total Packs</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-emerald-600">{artifact.entity_packs}</div>
          <div className="text-[10px] text-muted-foreground">Entity Packs</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-purple-600">{artifact.human_packs}</div>
          <div className="text-[10px] text-muted-foreground">Human Packs</div>
        </div>
      </div>
      <div className="space-y-1 max-h-80 overflow-y-auto">
        {artifact.retrieval_packs.map((pack) => (
          <div key={pack.page_id} className="border rounded-md">
            <button
              className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-[11px] hover:bg-muted/30"
              onClick={() => setExpandedPack(expandedPack === pack.page_id ? null : pack.page_id)}
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${expandedPack === pack.page_id ? "rotate-90" : ""}`} />
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${pack.page_type === "entity" ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300" : "bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300"}`}>
                {pack.page_type}
              </span>
              <span className="font-medium truncate">{pack.title}</span>
              <span className="text-muted-foreground ml-auto shrink-0">{pack.graph_context.length} ctx, {pack.doc_snippets.length} docs, {pack.vector_snippets.length} vec</span>
            </button>
            {expandedPack === pack.page_id && (
              <div className="px-3 pb-2 space-y-2 text-[11px]">
                {pack.graph_context.length > 0 && (
                  <div>
                    <div className="font-medium text-muted-foreground mb-0.5">Graph Context</div>
                    <div className="bg-muted/30 rounded p-1.5 max-h-24 overflow-y-auto font-mono text-[10px] whitespace-pre-wrap">{pack.graph_context.join("\n")}</div>
                  </div>
                )}
                {pack.doc_snippets.length > 0 && (
                  <div>
                    <div className="font-medium text-muted-foreground mb-0.5">Doc Snippets ({pack.doc_snippets.length})</div>
                    <div className="bg-muted/30 rounded p-1.5 max-h-24 overflow-y-auto font-mono text-[10px] whitespace-pre-wrap">{pack.doc_snippets.slice(0, 5).join("\n---\n")}{pack.doc_snippets.length > 5 ? `\n... +${pack.doc_snippets.length - 5} more` : ""}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generate Entity Pages Viewer (Step 14)
// ---------------------------------------------------------------------------

function isEntityPagesGenerated(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("entity pages") === true &&
    "by_type" in (artifact as Record<string, unknown>) &&
    "total_pages" in (artifact as Record<string, unknown>) &&
    !("by_layer" in (artifact as Record<string, unknown>))
  );
}

function EntityPagesGeneratedViewer({ artifact }: {
  artifact: { total_pages: number; llm_calls: number; by_type: Record<string, number> };
}) {
  const typeEntries = Object.entries(artifact.by_type).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Generated Entity Pages</h4>
      <div className="grid grid-cols-2 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-blue-600">{artifact.total_pages}</div>
          <div className="text-[10px] text-muted-foreground">Entity Pages</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.llm_calls}</div>
          <div className="text-[10px] text-muted-foreground">LLM Calls</div>
        </div>
      </div>
      {typeEntries.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Pages by Entity Type</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {typeEntries.map(([type, count]) => (
              <div key={type} className="border rounded-md px-2 py-1.5 flex items-center justify-between text-[11px]">
                <span className="font-medium">{type.replace(/_/g, " ")}</span>
                <span className="font-mono text-muted-foreground">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generate Human Pages Viewer (Step 15)
// ---------------------------------------------------------------------------

function isHumanPagesGenerated(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("human pages") === true &&
    "by_layer" in (artifact as Record<string, unknown>)
  );
}

function HumanPagesGeneratedViewer({ artifact }: {
  artifact: { total_pages: number; llm_calls: number; by_layer: Record<string, number> };
}) {
  const layerEntries = Object.entries(artifact.by_layer).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Generated Human Pages</h4>
      <div className="grid grid-cols-2 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-purple-600">{artifact.total_pages}</div>
          <div className="text-[10px] text-muted-foreground">Human Pages</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.llm_calls}</div>
          <div className="text-[10px] text-muted-foreground">LLM Calls</div>
        </div>
      </div>
      {layerEntries.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Pages by Layer</div>
          <div className="grid grid-cols-2 gap-1.5">
            {layerEntries.map(([layer, count]) => (
              <div key={layer} className="border rounded-md px-2 py-1.5 flex items-center justify-between text-[11px]">
                <span className="font-medium capitalize">{layer}</span>
                <span className="font-mono text-muted-foreground">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generate How-To Guides Viewer (Step 16)
// ---------------------------------------------------------------------------

function isHowtoGenerated(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("how-to") === true &&
    "total_howtos" in (artifact as Record<string, unknown>)
  );
}

function HowtoGeneratedViewer({ artifact }: {
  artifact: { total_howtos: number; llm_calls: number };
}) {
  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Generated How-To Guides</h4>
      <div className="grid grid-cols-2 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-amber-600">{artifact.total_howtos}</div>
          <div className="text-[10px] text-muted-foreground">How-To Guides</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.llm_calls}</div>
          <div className="text-[10px] text-muted-foreground">LLM Calls</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {artifact.total_howtos === 0
          ? "No proposed tickets found — no how-to guides generated."
          : `Generated ${artifact.total_howtos} implementation guide${artifact.total_howtos !== 1 ? "s" : ""} for proposed tickets discovered in Step 8.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extract Claims Viewer (Step 17)
// ---------------------------------------------------------------------------

function isClaimsExtracted(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("claim") === true &&
    "total_claims" in (artifact as Record<string, unknown>)
  );
}

function ClaimsExtractedViewer({ artifact }: {
  artifact: { total_claims: number; entity_page_claims: number; human_page_claims: number; llm_calls: number };
}) {
  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Extracted Claims</h4>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-blue-600">{artifact.total_claims}</div>
          <div className="text-[10px] text-muted-foreground">Total Claims</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-emerald-600">{artifact.entity_page_claims}</div>
          <div className="text-[10px] text-muted-foreground">From Entity Pages</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-purple-600">{artifact.human_page_claims}</div>
          <div className="text-[10px] text-muted-foreground">From Human Pages</div>
        </div>
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.llm_calls}</div>
          <div className="text-[10px] text-muted-foreground">LLM Calls</div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Entity page claims are extracted structurally (1 claim per bullet item). Human page claims are extracted via LLM from narrative paragraphs.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Verify Cards Viewer (Step 18)
// ---------------------------------------------------------------------------

function isVerifyCards(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("verify") === true &&
    "by_severity" in (artifact as Record<string, unknown>) &&
    "by_type" in (artifact as Record<string, unknown>)
  );
}

function VerifyCardsViewer({ artifact }: {
  artifact: {
    total_cards: number;
    candidates_gathered?: number;
    filtered_out?: number;
    by_type: Record<string, number>;
    by_severity: Record<string, number>;
    llm_calls: number;
  };
}) {
  const typeEntries = Object.entries(artifact.by_type).sort((a, b) => b[1] - a[1]);
  const severityEntries = Object.entries(artifact.by_severity).sort((a, b) => {
    const order: Record<string, number> = { S1: 0, S2: 1, S3: 2, S4: 3 };
    return (order[a[0]] ?? 4) - (order[b[0]] ?? 4);
  });
  const severityColors: Record<string, string> = {
    S1: "text-red-600", S2: "text-orange-600", S3: "text-amber-600", S4: "text-muted-foreground",
  };
  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">Verification Cards</h4>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold text-blue-600">{artifact.total_cards}</div>
          <div className="text-[10px] text-muted-foreground">Total Cards</div>
        </div>
        {artifact.candidates_gathered != null && (
          <div className="border rounded-md p-2 text-center">
            <div className="text-lg font-bold text-muted-foreground">{artifact.candidates_gathered}</div>
            <div className="text-[10px] text-muted-foreground">Candidates</div>
          </div>
        )}
        {artifact.filtered_out != null && (
          <div className="border rounded-md p-2 text-center">
            <div className="text-lg font-bold text-emerald-600">{artifact.filtered_out}</div>
            <div className="text-[10px] text-muted-foreground">Filtered Out</div>
          </div>
        )}
        <div className="border rounded-md p-2 text-center">
          <div className="text-lg font-bold">{artifact.llm_calls}</div>
          <div className="text-[10px] text-muted-foreground">LLM Calls</div>
        </div>
      </div>
      {severityEntries.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">By Severity</div>
          <div className="flex gap-2">
            {severityEntries.map(([sev, count]) => (
              <div key={sev} className="border rounded-md px-3 py-1.5 text-center">
                <div className={`text-base font-bold ${severityColors[sev] ?? ""}`}>{count}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{sev}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {typeEntries.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">By Card Type</div>
          <div className="grid grid-cols-2 gap-1.5">
            {typeEntries.map(([type, count]) => (
              <div key={type} className="border rounded-md px-2 py-1.5 flex items-center justify-between text-[11px]">
                <span className="font-medium">{type.replace(/_/g, " ")}</span>
                <span className="font-mono text-muted-foreground">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepCard — expandable step details
// ---------------------------------------------------------------------------

function StepCard({
  step,
  companySlug,
  onSelectSources,
  onRerun,
  pipelineRunning,
  executionCount,
}: {
  step: RunStep;
  companySlug: string;
  onSelectSources?: (refs: any[], runId: string) => void;
  onRerun?: () => void;
  pipelineRunning?: boolean;
  executionCount?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [llmCalls, setLlmCalls] = useState<LLMCall[] | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [parsedDocs, setParsedDocs] = useState<ParsedDoc[] | null>(null);
  const [parsedDocsLoading, setParsedDocsLoading] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>("all");
  const [selectedDocIdx, setSelectedDocIdx] = useState(0);
  const [llmCallsVisible, setLlmCallsVisible] = useState(true);

  const isInputSnapshot =
    step.name?.toLowerCase().includes("input") ||
    step.name?.toLowerCase().includes("snapshot");

  const fetchLlmCalls = async () => {
    if (llmCalls !== null) return;
    setLlmLoading(true);
    try {
      const res = await fetch(
        `/api/${companySlug}/kb2?type=llm_calls&run_id=${step.run_id}&step_id=${step.step_id}${step.execution_id ? `&execution_id=${step.execution_id}` : ""}`,
      );
      const data = await res.json();
      setLlmCalls(data.calls ?? []);
    } catch {
      setLlmCalls([]);
    } finally {
      setLlmLoading(false);
    }
  };

  const fetchParsedDocs = async () => {
    if (parsedDocs !== null) return;
    setParsedDocsLoading(true);
    try {
      const inputParams = step.execution_id ? `execution_id=${step.execution_id}` : `run_id=${step.run_id}`;
      const res = await fetch(
        `/api/${companySlug}/kb2?type=inputs&${inputParams}`,
      );
      const data = await res.json();
      const docs = data.snapshot?.parsed_documents ?? [];
      setParsedDocs(docs);
    } catch {
      setParsedDocs([]);
    } finally {
      setParsedDocsLoading(false);
    }
  };

  const handleToggle = () => {
    const willExpand = !expanded;
    setExpanded(willExpand);
    if (willExpand) {
      fetchLlmCalls();
      if (isInputSnapshot) fetchParsedDocs();
    }
  };

  const artifactPreview = step.artifact
    ? JSON.stringify(step.artifact, null, 2).slice(0, 500)
    : null;

  const statusIcon = () => {
    switch (step.status) {
      case "running":
        return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
      case "completed":
        return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
      case "failed":
        return <XCircle className="h-3.5 w-3.5 text-red-500" />;
      case "cancelled":
        return <Ban className="h-3.5 w-3.5 text-orange-500" />;
      default:
        return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-accent/30 transition-colors">
        <button onClick={handleToggle} className="flex items-center gap-3 flex-1 min-w-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {statusIcon()}
          <span className="text-xs font-medium flex-1 truncate text-left">
            <span className="text-muted-foreground mr-1.5">
              {step.pass === "pass1" ? "P1" : "P2"}.{step.step_number}
            </span>
            {step.name}
            {executionCount != null && executionCount > 1 && (
              <span className="ml-1.5 text-[9px] bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 px-1.5 py-0.5 rounded-full font-normal">
                {step.execution_number ?? 1}/{executionCount}
              </span>
            )}
          </span>
          {step.completed_at && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              {step.status === "completed" ? "Completed" : step.status === "failed" ? "Failed" : step.status === "cancelled" ? "Cancelled" : ""}{" "}
              {fmtDate(step.completed_at)}
            </span>
          )}
          {step.status === "running" && (
            <span className="text-[10px] text-blue-500 shrink-0">Running…</span>
          )}
          {step.status === "cancelled" && !step.completed_at && (
            <span className="text-[10px] text-orange-500 shrink-0">Cancelled</span>
          )}
          {step.duration_ms != null && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1 shrink-0">
              <Clock className="h-3 w-3" />
              {fmtDuration(step.duration_ms)}
            </span>
          )}
          {step.metrics && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1 shrink-0">
              <DollarSign className="h-3 w-3" />
              {fmtCost(step.metrics.cost_usd)}
            </span>
          )}
        </button>
        {onRerun && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[10px] shrink-0 border-blue-300 text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-950"
            disabled={pipelineRunning}
            onClick={onRerun}
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            Rerun
          </Button>
        )}
      </div>

      {expanded && (
        <CardContent className="pt-0 pb-4 px-4 space-y-3 border-t">
          {/* Summary */}
          {step.summary && (
            <div>
              <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Summary
              </h4>
              <p className="text-xs">{step.summary}</p>
            </div>
          )}

          {/* Metrics */}
          {step.metrics && (
            <div>
              <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Metrics
              </h4>
              <div className="flex flex-wrap gap-3 text-xs">
                <span className="flex items-center gap-1">
                  <Zap className="h-3 w-3 text-muted-foreground" />
                  {step.metrics.llm_calls} LLM calls
                </span>
                <span className="flex items-center gap-1">
                  <Hash className="h-3 w-3 text-muted-foreground" />
                  {(step.metrics.input_tokens + step.metrics.output_tokens).toLocaleString()}{" "}
                  tokens
                </span>
                <span className="flex items-center gap-1">
                  <DollarSign className="h-3 w-3 text-muted-foreground" />
                  {fmtCost(step.metrics.cost_usd)}
                </span>
                {step.duration_ms != null && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    {fmtDuration(step.duration_ms)}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Parsed documents browser (Input Snapshot step) */}
          {isInputSnapshot && (
            <div>
              <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                Parsed Documents
              </h4>
              {parsedDocsLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading parsed documents…
                </div>
              ) : parsedDocs && parsedDocs.length > 0 ? (
                <InputSnapshotBrowser
                  docs={parsedDocs}
                  selectedProvider={selectedProvider}
                  onProviderChange={setSelectedProvider}
                  selectedDocIdx={selectedDocIdx}
                  onDocIdxChange={setSelectedDocIdx}
                />
              ) : (
                <p className="text-xs text-muted-foreground">No parsed documents found.</p>
              )}
            </div>
          )}

          {/* Entity extraction results */}
          {!isInputSnapshot && isEntityExtraction(step, step.artifact) && (
            <EntityExtractionViewer artifact={step.artifact as any} companySlug={companySlug} runId={step.run_id} executionId={step.execution_id} stepId={step.step_id} onSelectSources={(refs) => onSelectSources?.(refs, step.run_id)} />
          )}

          {/* Extraction validation results */}
          {!isInputSnapshot && isExtractionValidation(step, step.artifact) && (
            <ExtractionValidationViewer artifact={step.artifact as any} companySlug={companySlug} runId={step.run_id} executionId={step.execution_id} stepId={step.step_id} onSelectSources={(refs) => onSelectSources?.(refs, step.run_id)} />
          )}

          {/* Entity resolution results */}
          {!isInputSnapshot && isEntityResolution(step, step.artifact) && (
            <EntityResolutionViewer artifact={step.artifact as any} companySlug={companySlug} runId={step.run_id} executionId={step.execution_id} onSelectSources={(refs) => onSelectSources?.(refs, step.run_id)} />
          )}

          {/* Graph enrichment results */}
          {!isInputSnapshot && isGraphEnrichment(step, step.artifact) && (
            <GraphEnrichmentViewer artifact={step.artifact as any} />
          )}

          {/* Page plan results */}
          {!isInputSnapshot && isPagePlan(step, step.artifact) && (
            <PagePlanViewer artifact={step.artifact as any} />
          )}

          {/* Discovery results */}
          {!isInputSnapshot && isDiscovery(step, step.artifact) && (
            <DiscoveryViewer artifact={step.artifact as any} onSelectSources={(refs) => onSelectSources?.(refs, step.run_id)} />
          )}

          {/* Attribute Completion results */}
          {!isInputSnapshot && isAttributeCompletion(step, step.artifact) && (
            <AttributeCompletionViewer artifact={step.artifact as any} />
          )}

          {/* Pattern Synthesis results */}
          {!isInputSnapshot && isPatternSynthesis(step, step.artifact) && (
            <PatternSynthesisViewer artifact={step.artifact as any} />
          )}

          {/* Graph Re-enrichment results */}
          {!isInputSnapshot && isGraphReEnrichment(step, step.artifact) && (
            <GraphReEnrichmentViewer artifact={step.artifact as any} />
          )}

          {/* GraphRAG Retrieval results */}
          {!isInputSnapshot && isGraphRAGRetrieval(step, step.artifact) && (
            <GraphRAGRetrievalViewer artifact={step.artifact as any} />
          )}

          {/* Entity Pages Generated results */}
          {!isInputSnapshot && isEntityPagesGenerated(step, step.artifact) && (
            <EntityPagesGeneratedViewer artifact={step.artifact as any} />
          )}

          {/* Human Pages Generated results */}
          {!isInputSnapshot && isHumanPagesGenerated(step, step.artifact) && (
            <HumanPagesGeneratedViewer artifact={step.artifact as any} />
          )}

          {/* How-To Guides results */}
          {!isInputSnapshot && isHowtoGenerated(step, step.artifact) && (
            <HowtoGeneratedViewer artifact={step.artifact as any} />
          )}

          {/* Claims Extracted results */}
          {!isInputSnapshot && isClaimsExtracted(step, step.artifact) && (
            <ClaimsExtractedViewer artifact={step.artifact as any} />
          )}

          {/* Verify Cards results */}
          {!isInputSnapshot && isVerifyCards(step, step.artifact) && (
            <VerifyCardsViewer artifact={step.artifact as any} />
          )}

          {/* Artifact preview (other steps) */}
          {!isInputSnapshot && !isEntityExtraction(step, step.artifact) && !isExtractionValidation(step, step.artifact) && !isEntityResolution(step, step.artifact) && !isGraphEnrichment(step, step.artifact) && !isPagePlan(step, step.artifact) && !isDiscovery(step, step.artifact) && !isAttributeCompletion(step, step.artifact) && !isPatternSynthesis(step, step.artifact) && !isGraphReEnrichment(step, step.artifact) && !isGraphRAGRetrieval(step, step.artifact) && !isEntityPagesGenerated(step, step.artifact) && !isHumanPagesGenerated(step, step.artifact) && !isHowtoGenerated(step, step.artifact) && !isClaimsExtracted(step, step.artifact) && !isVerifyCards(step, step.artifact) && artifactPreview && (
            <div>
              <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                <Braces className="h-3 w-3" /> Artifact Preview
              </h4>
              <pre className="text-[11px] bg-muted/50 rounded p-2 overflow-x-auto max-h-[32rem] whitespace-pre-wrap break-all">
                {artifactPreview}
                {artifactPreview.length >= 500 && (
                  <span className="text-muted-foreground">…truncated</span>
                )}
              </pre>
            </div>
          )}

          {/* LLM Calls */}
          <div>
            <button
              onClick={() => setLlmCallsVisible(!llmCallsVisible)}
              className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1 hover:text-foreground transition-colors"
            >
              {llmCallsVisible ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              LLM Calls{llmCalls ? ` (${llmCalls.length})` : ""}
            </button>
            {llmCallsVisible && (
              <>
                {llmLoading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading…
                  </div>
                ) : llmCalls && llmCalls.length > 0 ? (
                  <>
                    <div className="space-y-2">
                      {llmCalls.map((call) => (
                        <LLMCallCard key={call.call_id} call={call} />
                      ))}
                    </div>
                    {llmCalls.length > 3 && (
                      <button
                        onClick={() => setLlmCallsVisible(false)}
                        className="mt-2 w-full text-center text-[10px] text-muted-foreground hover:text-foreground transition-colors py-1 rounded hover:bg-muted/50"
                      >
                        Hide LLM Calls
                      </button>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No LLM calls.</p>
                )}
              </>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// LLMCallCard — individual LLM call detail
// ---------------------------------------------------------------------------

function LLMCallCard({ call }: { call: LLMCall }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [showResponse, setShowResponse] = useState(false);

  return (
    <Card className="bg-muted/30">
      <CardHeader className="p-2 pb-1">
        <div className="flex items-center gap-2 text-[11px]">
          <Badge variant="outline" className="text-[9px]">
            {call.model}
          </Badge>
          <span className="text-muted-foreground">
            {call.input_tokens + call.output_tokens} tokens
          </span>
          <span className="text-muted-foreground">
            {fmtDuration(call.duration_ms)}
          </span>
          <span className="text-muted-foreground">{fmtCost(call.cost_usd)}</span>
        </div>
      </CardHeader>
      <CardContent className="p-2 pt-0 space-y-1">
        <button
          onClick={() => setShowPrompt(!showPrompt)}
          className="text-[10px] text-blue-500 hover:underline"
        >
          {showPrompt ? "Hide prompt" : "Show prompt"}
        </button>
        {showPrompt && (
          <pre className="text-[10px] bg-background rounded p-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-all">
            {call.prompt}
          </pre>
        )}

        <button
          onClick={() => setShowResponse(!showResponse)}
          className="text-[10px] text-blue-500 hover:underline"
        >
          {showResponse ? "Hide response" : "Show response"}
        </button>
        {showResponse && (
          <pre className="text-[10px] bg-background rounded p-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-all">
            {call.response}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers used in subcomponents
// ---------------------------------------------------------------------------

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = Math.round(totalSec % 60);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function fmtCost(usd: number) {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
