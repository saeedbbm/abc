"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
} from "lucide-react";

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
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string;
  current_step?: number;
  total_steps?: number;
  error?: string;
}

interface RunStep {
  step_id: string;
  run_id: string;
  pass: "pass1" | "pass2";
  step_number: number;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  summary?: string;
  artifact?: unknown;
  metrics?: {
    llm_calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
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
  message?: string;
  runId?: string;
  status?: string;
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

export function KB2AdminPage({ companySlug }: { companySlug: string }) {
  const [pass1Steps, setPass1Steps] = useState<StepDef[]>([]);
  const [pass2Steps, setPass2Steps] = useState<StepDef[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [inspectorTab, setInspectorTab] = useState("pass1");

  // Raw input data
  const [rawInput, setRawInput] = useState<RawInputInfo | null>(null);
  const [rawInputLoading, setRawInputLoading] = useState(true);

  // Pipeline controls
  const [singleStep, setSingleStep] = useState<string>("");
  const [fromStep, setFromStep] = useState<string>("");
  const [reuseRunId, setReuseRunId] = useState("");
  const [pipelineRunning, setPipelineRunning] = useState(false);

  // Live log
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
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

  useEffect(() => {
    fetchStepDefs();
    fetchRuns();
    fetchRawInput();
  }, [fetchStepDefs, fetchRuns, fetchRawInput]);

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

      const ctrl = new AbortController();
      abortRef.current = ctrl;

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

              if (entry.type === "done" || entry.type === "error") {
                fetchRuns();
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
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLogEntries((prev) => [
          ...prev,
          {
            type: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          },
        ]);
      } finally {
        setPipelineRunning(false);
        abortRef.current = null;
      }
    },
    [companySlug, pipelineRunning, reuseRunId, fetchRuns, fetchRunSteps],
  );

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logEntries]);

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

  const pass1RunSteps = runSteps.filter((s) => s.pass === "pass1");
  const pass2RunSteps = runSteps.filter((s) => s.pass === "pass2");

  return (
    <div className="flex h-full flex-col">
      {/* Header + input status + pipeline controls */}
      <div className="border-b p-4 space-y-3">
        <h1 className="text-lg font-semibold">KB Admin</h1>

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
                onClick={() => abortRef.current?.abort()}
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
                            ({run.status === "completed" ? "done" : run.status})
                          </span>
                        )}
                      </div>
                      <div className="font-mono opacity-50 mt-0.5">{run.run_id.slice(0, 8)}</div>
                    </div>
                    {run.error && run.status !== "completed" && (
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
          {(pipelineRunning || logEntries.length > 0) && (
            <div className="border-b">
              <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
                <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">Live Log</span>
                {pipelineRunning && (
                  <Loader2 className="h-3 w-3 animate-spin text-blue-500 ml-auto" />
                )}
                {!pipelineRunning && logEntries.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-5 text-[10px]"
                    onClick={() => setLogEntries([])}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <ScrollArea className="h-40">
                <div className="p-3 font-mono text-[11px] space-y-0.5">
                  {logEntries.map((entry, i) => (
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
                            <span className="text-foreground mr-2">
                              [{entry.percent}%]
                            </span>
                          )}
                          {entry.detail}
                        </>
                      )}
                      {entry.type === "done" && (
                        <>
                          Pipeline completed — run{" "}
                          <span className="font-mono">{entry.runId}</span>
                        </>
                      )}
                      {entry.type === "error" && (
                        <>Error: {entry.message}</>
                      )}
                    </div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </ScrollArea>
            </div>
          )}

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
                            onRerun={() => {
                              runPipeline({ pass: step.pass, step: step.step_number, reuseRunId: step.run_id });
                            }}
                            pipelineRunning={pipelineRunning}
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
                            onRerun={() => {
                              runPipeline({ pass: step.pass, step: step.step_number, reuseRunId: step.run_id });
                            }}
                            pipelineRunning={pipelineRunning}
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
// Entity Extraction artifact viewer
// ---------------------------------------------------------------------------

interface SourceRef {
  source_type: string;
  doc_id: string;
  title: string;
  excerpt: string;
}

interface EntityEntry {
  display_name: string;
  aliases: string[];
  confidence: string;
  source_count: number;
  source_refs?: SourceRef[];
}

function isEntityExtraction(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("entity extraction") &&
    "entities_by_type" in (artifact as Record<string, unknown>)
  );
}

const TYPE_COLORS: Record<string, string> = {
  person: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  team: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
  client: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
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

function confidenceReason(refs: SourceRef[] | undefined, confidence: string): string {
  if (!refs || refs.length === 0) return confidence;
  const providers = [...new Set(refs.map((r) => r.source_type))];
  if (confidence === "high") return `high: confirmed in ${refs.length} source${refs.length > 1 ? "s" : ""} (${providers.join(", ")})`;
  if (confidence === "medium") return `medium: single clear mention (${providers.join(", ")})`;
  return `low: inferred from ${providers.join(", ")}`;
}

const PROVIDER_ICONS: Record<string, string> = {
  confluence: "📄", jira: "🎫", slack: "💬", github: "🔧", customerFeedback: "📣",
};

function EntityExtractionViewer({ artifact }: { artifact: { total_entities: number; llm_calls: number; entities_by_type: Record<string, EntityEntry[]> } }) {
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const types = Object.keys(artifact.entities_by_type).sort(
    (a, b) => artifact.entities_by_type[b].length - artifact.entities_by_type[a].length,
  );

  return (
    <div>
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        Extracted Entities ({artifact.total_entities})
      </h4>
      <div className="space-y-1">
        {types.map((type) => {
          const entities = artifact.entities_by_type[type];
          const isOpen = expandedType === type;
          return (
            <div key={type} className="border rounded overflow-hidden">
              <button
                onClick={() => setExpandedType(isOpen ? null : type)}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-accent/30 transition-colors"
              >
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${TYPE_COLORS[type] ?? "bg-gray-100 text-gray-800"}`}>
                  {type.replace(/_/g, " ")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {entities.length} entit{entities.length === 1 ? "y" : "ies"}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[50%]">
                  {entities.slice(0, 5).map((e) => e.display_name).join(", ")}
                  {entities.length > 5 && `, +${entities.length - 5} more`}
                </span>
              </button>
              {isOpen && (
                <div className="border-t bg-muted/20 px-3 py-2 space-y-0.5">
                  {entities.map((entity, idx) => {
                    const entityKey = `${type}-${idx}`;
                    const isEntityOpen = expandedEntity === entityKey;
                    return (
                      <div key={idx} className="border-b border-border/40 last:border-0">
                        <button
                          onClick={() => setExpandedEntity(isEntityOpen ? null : entityKey)}
                          className="w-full text-left flex items-center gap-2 text-xs py-1 hover:bg-accent/20 transition-colors"
                        >
                          {isEntityOpen ? <ChevronDown className="h-2.5 w-2.5 shrink-0" /> : <ChevronRight className="h-2.5 w-2.5 shrink-0" />}
                          <span className="font-medium min-w-[140px]">{entity.display_name}</span>
                          <span className={`text-[10px] ${CONFIDENCE_COLORS[entity.confidence] ?? ""}`}>
                            {entity.confidence}
                          </span>
                          {entity.aliases.length > 0 && (
                            <span className="text-[10px] text-muted-foreground truncate">
                              aka {entity.aliases.join(", ")}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                            {entity.source_count} source{entity.source_count !== 1 ? "s" : ""}
                          </span>
                        </button>
                        {isEntityOpen && (
                          <div className="ml-5 pb-2 space-y-1.5">
                            <div className="text-[10px] text-muted-foreground italic">
                              {confidenceReason(entity.source_refs, entity.confidence)}
                            </div>
                            {entity.source_refs && entity.source_refs.length > 0 && (
                              <div className="space-y-1">
                                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Sources</div>
                                {entity.source_refs.map((ref, ri) => (
                                  <div key={ri} className="text-[10px] bg-background/60 rounded px-2 py-1 border border-border/30">
                                    <div className="flex items-center gap-1.5">
                                      <span>{PROVIDER_ICONS[ref.source_type] ?? "📎"}</span>
                                      <span className="font-medium">{ref.title}</span>
                                      <span className="text-muted-foreground">({ref.source_type})</span>
                                    </div>
                                    {ref.excerpt && (
                                      <div className="text-muted-foreground mt-0.5 line-clamp-2">{ref.excerpt}</div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extraction Validation artifact viewer
// ---------------------------------------------------------------------------

function isExtractionValidation(step: RunStep, artifact: unknown): boolean {
  if (!artifact || typeof artifact !== "object") return false;
  return (
    step.name?.toLowerCase().includes("extraction validation") === true &&
    "recovery_details" in (artifact as Record<string, unknown>)
  );
}

function ExtractionValidationViewer({ artifact }: {
  artifact: {
    original_count: number;
    programmatic_candidates: number;
    crossllm_candidates: number;
    opus_confirmed: number;
    opus_rejected: number;
    opus_retyped?: number;
    final_count: number;
    source_coverage?: { total_documents: number; documents_with_zero_entities: string[] };
    recovery_details: { display_name: string; type: string; recovery_source: string; reason: string }[];
  };
}) {
  const [showCoverage, setShowCoverage] = useState(false);
  const gap = artifact.final_count - artifact.original_count;

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Extraction Validation
      </h4>
      <div className="flex flex-wrap gap-3 text-xs">
        <span className="bg-muted/50 rounded px-2 py-1">Before: <strong>{artifact.original_count}</strong></span>
        <span className="text-emerald-600 font-medium">+{gap} recovered</span>
        <span className="bg-muted/50 rounded px-2 py-1">After: <strong>{artifact.final_count}</strong></span>
      </div>
      <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        <span>Programmatic: {artifact.programmatic_candidates} candidates</span>
        <span>|</span>
        <span>GPT cross-check: {artifact.crossllm_candidates} candidates</span>
        <span>|</span>
        <span className="text-emerald-600">Opus confirmed: {artifact.opus_confirmed}</span>
        <span className="text-red-500">Rejected: {artifact.opus_rejected}</span>
        {artifact.opus_retyped != null && artifact.opus_retyped > 0 && (
          <span className="text-amber-600">Retyped: {artifact.opus_retyped}</span>
        )}
      </div>

      {artifact.recovery_details.length > 0 && (
        <div>
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Recovered Entities (+{artifact.recovery_details.length})
          </h4>
          <div className="space-y-1">
            {artifact.recovery_details.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-xs bg-emerald-50 dark:bg-emerald-950/30 rounded px-2 py-1 border border-emerald-200 dark:border-emerald-800">
                <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300">
                  +ADD
                </span>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${TYPE_COLORS[r.type] ?? "bg-gray-100 text-gray-800"}`}>
                  {r.type.replace(/_/g, " ")}
                </span>
                <span className="font-medium">{r.display_name}</span>
                <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[40%]">{r.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

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

function EntityResolutionViewer({ artifact }: {
  artifact: {
    total_entities_before: number;
    total_entities_after: number;
    candidates_found: number;
    merges_performed: number;
    merges: { from: string; into: string; canonicalName: string; reason: string }[];
  };
}) {
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
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Merges ({artifact.merges.length})
          </h4>
          <div className="space-y-1">
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
    added_edges?: { source: string; target: string; type: string; evidence: string }[];
  };
}) {
  const [showEdges, setShowEdges] = useState(true);

  const EDGE_TYPE_COLORS: Record<string, string> = {
    OWNED_BY: "text-blue-600", DEPENDS_ON: "text-red-500", USES: "text-purple-600",
    STORES_IN: "text-amber-600", DEPLOYED_TO: "text-teal-600", MEMBER_OF: "text-indigo-600",
    WORKS_ON: "text-cyan-600", LEADS: "text-emerald-600", CONTAINS: "text-orange-600",
    RUNS_ON: "text-sky-600", BUILT_BY: "text-violet-600", RESOLVES: "text-green-600",
    RELATED_TO: "text-gray-500", BLOCKED_BY: "text-red-700", COMMUNICATES_VIA: "text-pink-600",
    FEEDBACK_FROM: "text-rose-600",
  };

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Graph Enrichment
      </h4>
      <div className="flex flex-wrap gap-3 text-xs">
        <span className="bg-muted/50 rounded px-2 py-1">Nodes: <strong>{artifact.total_nodes}</strong></span>
        <span className="text-blue-600 font-medium">+{artifact.new_edges} relationships discovered</span>
      </div>

      {artifact.added_edges && artifact.added_edges.length > 0 && (
        <div>
          <button
            onClick={() => setShowEdges(!showEdges)}
            className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1 hover:text-foreground"
          >
            {showEdges ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            New Relationships ({artifact.added_edges.length})
          </button>
          {showEdges && (
            <div className="mt-1 space-y-1">
              {artifact.added_edges.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-xs bg-blue-50 dark:bg-blue-950/30 rounded px-2 py-1 border border-blue-200 dark:border-blue-800">
                  <span className="font-medium">{e.source}</span>
                  <span className={`text-[10px] font-mono font-bold ${EDGE_TYPE_COLORS[e.type] ?? "text-gray-600"}`}>
                    {e.type}
                  </span>
                  <span className="font-medium">{e.target}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[35%]">{e.evidence}</span>
                </div>
              ))}
            </div>
          )}
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

function DiscoveryViewer({ artifact }: {
  artifact: {
    total_discoveries: number;
    llm_calls?: number;
    by_category: Record<string, number>;
    discoveries?: { display_name: string; type: string; category: string; confidence: string; evidence_preview: string }[];
  };
}) {
  const CATEGORY_COLORS: Record<string, string> = {
    past_undocumented: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    ongoing_undocumented: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    proposed_project: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    proposed_ticket: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
    proposed_from_feedback: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
  };

  return (
    <div className="space-y-3">
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Project & Ticket Discovery
      </h4>
      <div className="flex flex-wrap gap-3 text-xs">
        <span className="bg-muted/50 rounded px-2 py-1">Discovered: <strong>{artifact.total_discoveries}</strong> items</span>
        {artifact.llm_calls != null && <span className="text-muted-foreground">{artifact.llm_calls} LLM calls</span>}
      </div>
      {Object.entries(artifact.by_category).length > 0 && (
        <div className="flex flex-wrap gap-2 text-[10px]">
          {Object.entries(artifact.by_category).map(([cat, count]) => (
            <span key={cat} className={`px-1.5 py-0.5 rounded ${CATEGORY_COLORS[cat] ?? "bg-gray-100 text-gray-800"}`}>
              {cat.replace(/_/g, " ")}: {count}
            </span>
          ))}
        </div>
      )}
      {artifact.discoveries && artifact.discoveries.length > 0 && (
        <div className="space-y-1">
          {artifact.discoveries.map((d, i) => (
            <div key={i} className="flex items-center gap-2 text-xs bg-muted/30 rounded px-2 py-1 border border-border/30">
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${CATEGORY_COLORS[d.category] ?? "bg-gray-100 text-gray-800"}`}>
                {d.category.replace(/_/g, " ")}
              </span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${TYPE_COLORS[d.type] ?? "bg-gray-100 text-gray-800"}`}>
                {d.type}
              </span>
              <span className="font-medium">{d.display_name}</span>
              <Badge variant="secondary" className="text-[9px]">{d.confidence}</Badge>
              {d.evidence_preview && <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[30%]">{d.evidence_preview}</span>}
            </div>
          ))}
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
  onRerun,
  pipelineRunning,
}: {
  step: RunStep;
  companySlug: string;
  onRerun?: () => void;
  pipelineRunning?: boolean;
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
        `/api/${companySlug}/kb2?type=llm_calls&run_id=${step.run_id}&step_id=${step.step_id}`,
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
      const res = await fetch(
        `/api/${companySlug}/kb2?type=inputs&run_id=${step.run_id}`,
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
          </span>
          {step.completed_at && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              {step.status === "completed" ? "Completed" : step.status === "failed" ? "Failed" : ""}{" "}
              {fmtDate(step.completed_at)}
            </span>
          )}
          {step.status === "running" && (
            <span className="text-[10px] text-blue-500 shrink-0">Running…</span>
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
            <EntityExtractionViewer artifact={step.artifact as any} />
          )}

          {/* Extraction validation results */}
          {!isInputSnapshot && isExtractionValidation(step, step.artifact) && (
            <ExtractionValidationViewer artifact={step.artifact as any} />
          )}

          {/* Entity resolution results */}
          {!isInputSnapshot && isEntityResolution(step, step.artifact) && (
            <EntityResolutionViewer artifact={step.artifact as any} />
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
            <DiscoveryViewer artifact={step.artifact as any} />
          )}

          {/* Artifact preview (other steps) */}
          {!isInputSnapshot && !isEntityExtraction(step, step.artifact) && !isExtractionValidation(step, step.artifact) && !isEntityResolution(step, step.artifact) && !isGraphEnrichment(step, step.artifact) && !isPagePlan(step, step.artifact) && !isDiscovery(step, step.artifact) && artifactPreview && (
            <div>
              <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                <Braces className="h-3 w-3" /> Artifact Preview
              </h4>
              <pre className="text-[11px] bg-muted/50 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
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
          <pre className="text-[10px] bg-background rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
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
          <pre className="text-[10px] bg-background rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
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
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtCost(usd: number) {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
