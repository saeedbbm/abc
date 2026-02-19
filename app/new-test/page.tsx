"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import {
  MessageSquare, Upload, Sparkles, BarChart3,
  Play, Loader2, FileText, Bug, Wrench, AlertTriangle, Clock,
  GitBranch, Users, BookOpen, FolderOpen, Send, Hash,
  Plus, Trash2, ChevronRight, ChevronDown,
  Table2, Columns2, Terminal, Save, Check, ListTree,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  KB_CATEGORY_LABELS,
  type KBCategory,
  type ScoreFormatPageType,
  type PMTicketType,
  type AtomicItemType,
  type ScoreFormatOutputType,
} from "@/src/entities/models/score-format";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INPUT_TABS = [
  { id: "confluence", label: "Confluence", icon: BookOpen },
  { id: "jira", label: "Jira", icon: FileText },
  { id: "slack", label: "Slack", icon: MessageSquare },
  { id: "github", label: "GitHub", icon: GitBranch },
  { id: "customerFeedback", label: "Customer Feedback", icon: Users },
] as const;

const RESULT_TABS = [
  { id: "kb", label: "KB", icon: BookOpen },
  { id: "gaps", label: "Gaps", icon: FileText },
  { id: "conflicts", label: "Conflicts", icon: AlertTriangle },
  { id: "outdated", label: "Outdated", icon: Clock },
  { id: "conv_tickets", label: "Conv. Tickets", icon: Hash },
  { id: "feedback_tickets", label: "New Features/Bugs", icon: Bug },
  { id: "howto", label: "How-to-Implement", icon: Wrench },
] as const;

const MENU_ITEMS = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "input_gt", label: "Input & Ground Truth", icon: Upload },
  { id: "compare", label: "Generated vs GT", icon: Columns2 },
  { id: "results_score", label: "Results — Score Format", icon: Table2 },
  { id: "gt_score", label: "GT — Score Format", icon: Table2 },
  { id: "analysis", label: "Analysis Results", icon: BarChart3 },
] as const;

type MenuSection = (typeof MENU_ITEMS)[number]["id"];

interface Session {
  name: string;
  slug: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ProgressEvent {
  phase: string;
  detail: string;
  percent: number;
  elapsed?: string;
  done?: boolean;
  success?: boolean;
  error?: string;
}

const NewTestPageInner = dynamic(() => Promise.resolve(NewTestPageClient), { ssr: false });

export default function NewTestPage() {
  return <NewTestPageInner />;
}

// ---------------------------------------------------------------------------
// Main Page (client-only)
// ---------------------------------------------------------------------------

function NewTestPageClient() {
  const [activeSection, setActiveSection] = useState<MenuSection>("chat");

  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSession, setCurrentSession] = useState("");
  const [newSessionName, setNewSessionName] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);

  const sessionSlug = currentSession || "";

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [progressLog, setProgressLog] = useState<ProgressEvent[]>([]);

  const dataFetchedForSession = useRef<string | null>(null);

  const [inputs, setInputs] = useState<Record<string, string>>({
    confluence: "", jira: "", slack: "", github: "", customerFeedback: "",
  });
  const [generatedResults, setGeneratedResults] = useState<ScoreFormatOutputType | null>(null);
  const [groundTruth, setGroundTruth] = useState<ScoreFormatOutputType | null>(null);
  const [pagePlan, setPagePlan] = useState<{ category: string; title: string; description: string }[] | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [loadingResults, setLoadingResults] = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const res = await fetch("/api/new-test/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch { /* ignore */ }
    setLoadingSessions(false);
  }, []);

  useEffect(() => { fetchSessions(); }, []);

  const handleCreateSession = useCallback(async () => {
    const name = newSessionName.trim();
    if (!name) return;
    try {
      const res = await fetch("/api/new-test/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const data = await res.json();
        setCurrentSession(data.session.slug);
        setNewSessionName("");
        setChatMessages([]);
        setInputs({ confluence: "", jira: "", slack: "", github: "", customerFeedback: "" });
        setGeneratedResults(null);
        setGroundTruth(null);
        setPagePlan(null);
        setAnalysis(null);
        setProgressLog([]);
        dataFetchedForSession.current = data.session.slug;
        await fetchSessions();
      }
    } catch { /* ignore */ }
  }, [newSessionName, fetchSessions]);

  const handleSwitchSession = useCallback((slug: string) => {
    setCurrentSession(slug);
    setChatMessages([]);
    setInputs({ confluence: "", jira: "", slack: "", github: "", customerFeedback: "" });
    setGeneratedResults(null);
    setGroundTruth(null);
    setPagePlan(null);
    setAnalysis(null);
    setProgressLog([]);
    dataFetchedForSession.current = null;
  }, []);

  const handleDeleteSession = useCallback(async (slug: string) => {
    if (!confirm(`Delete session "${slug}" and all its data?`)) return;
    try {
      await fetch(`/api/new-test/sessions?slug=${slug}`, { method: "DELETE" });
      if (currentSession === slug) {
        setCurrentSession("");
        setChatMessages([]);
        setGeneratedResults(null);
        setGroundTruth(null);
        setAnalysis(null);
        setProgressLog([]);
      }
      await fetchSessions();
    } catch { /* ignore */ }
  }, [currentSession, fetchSessions]);

  // Chat
  const handleSendChat = useCallback(async () => {
    if (!chatInput.trim() || chatLoading || !sessionSlug) return;
    const userMsg: ChatMessage = { role: "user", content: chatInput.trim() };
    setChatMessages(prev => [...prev, userMsg]);
    setChatInput("");
    setChatLoading(true);
    try {
      const res = await fetch("/api/new-test/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, messages: [...chatMessages, userMsg] }),
      });
      if (!res.ok) {
        setChatMessages(prev => [...prev, { role: "assistant", content: "Error: failed to get response." }]);
        setChatLoading(false);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) { setChatLoading(false); return; }
      const decoder = new TextDecoder();
      let assistantContent = "";
      setChatMessages(prev => [...prev, { role: "assistant", content: "" }]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantContent += decoder.decode(value, { stream: true });
        setChatMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: assistantContent };
          return updated;
        });
      }
    } catch {
      setChatMessages(prev => [...prev, { role: "assistant", content: "Error: connection failed." }]);
    }
    setChatLoading(false);
  }, [chatInput, chatLoading, sessionSlug, chatMessages]);

  // Throttle ref for input_stream events (avoid overwhelming React)
  const inputStreamThrottle = useRef<Record<string, number>>({});
  const inputStreamLatest = useRef<Record<string, string>>({});

  // Shared SSE stream reader
  const runStreamedPipeline = useCallback(async (body: Record<string, unknown>, onDone: () => Promise<void>) => {
    if (!sessionSlug || running) return;
    setRunning(true);
    setProgressLog([]);
    setProgress(null);

    try {
      const res = await fetch("/api/new-test/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, messages: chatMessages, ...body }),
      });
      if (!res.ok) {
        const errEvt: ProgressEvent = { phase: "error", detail: "Pipeline failed to start (server returned " + res.status + ")", percent: -1 };
        setProgress(errEvt);
        setProgressLog(prev => [...prev, errEvt]);
        setRunning(false);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) { setRunning(false); return; }
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const raw = JSON.parse(line.slice(6));

            // Live-stream input text into the relevant tab
            if (raw.phase === "input_stream") {
              const src = raw.source as string;
              const txt = raw.text as string;
              inputStreamLatest.current[src] = txt;
              const now = Date.now();
              const last = inputStreamThrottle.current[src] || 0;
              if (now - last > 80 || txt.length < 20) {
                inputStreamThrottle.current[src] = now;
                setInputs(prev => ({ ...prev, [src]: txt }));
              }
              continue;
            }

            // Flush all pending input text on mock_done or any pipeline progress event
            if ((raw.phase === "mock_done" || raw.phase === "pipeline") && Object.keys(inputStreamLatest.current).length > 0) {
              setInputs(prev => ({ ...prev, ...inputStreamLatest.current }));
            }

            // Page plan received
            if (raw.phase === "page_plan" && raw.plan) {
              setPagePlan(raw.plan);
              const planEvt: ProgressEvent = { phase: "page_plan", detail: `Page plan ready: ${raw.plan.length} pages`, percent: 98, elapsed: raw.elapsed };
              setProgressLog(prev => [...prev, planEvt]);
              continue;
            }

            // Ground-truth part completed — merge into state
            if (raw.phase === "gt_part") {
              const part = raw.gtPart as keyof ScoreFormatOutputType;
              const data = raw.gtData;
              setGroundTruth(prev => {
                const base = prev || { kb_pages: [], conversation_tickets: [], feedback_tickets: [], howto_pages: [] };
                return { ...base, [part]: data };
              });
              continue;
            }

            const evt = raw as ProgressEvent;
            setProgress(evt);
            if (evt.percent >= 0 || evt.done || evt.phase === "error") {
              setProgressLog(prev => [...prev, evt]);
            }
            if (evt.done) {
              setRunning(false);
              if (evt.success) await onDone();
            }
          } catch { /* ignore */ }
        }
      }
      setRunning(false);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        const errEvt: ProgressEvent = { phase: "error", detail: err.message, percent: -1 };
        setProgress(errEvt);
        setProgressLog(prev => [...prev, errEvt]);
      }
      setRunning(false);
    }
  }, [sessionSlug, running, chatMessages]);

  // Save state
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  const loadAllData = useCallback(async () => {
    if (!sessionSlug) return;
    setLoadingResults(true);
    try {
      const [inputsRes, resultsRes, gtRes, planRes, analysisRes] = await Promise.all([
        fetch(`/api/new-test/results?type=inputs&session=${sessionSlug}`),
        fetch(`/api/new-test/results?type=generated&session=${sessionSlug}`),
        fetch(`/api/new-test/results?type=ground_truth&session=${sessionSlug}`),
        fetch(`/api/new-test/results?type=page_plan&session=${sessionSlug}`),
        fetch(`/api/new-test/analysis?session=${sessionSlug}`),
      ]);
      if (inputsRes.ok) { const d = await inputsRes.json(); if (d.inputs) setInputs(d.inputs); }
      if (resultsRes.ok) { const d = await resultsRes.json(); if (d.data) setGeneratedResults(d.data); }
      if (gtRes.ok) { const d = await gtRes.json(); if (d.data) setGroundTruth(d.data); }
      if (planRes.ok) { const d = await planRes.json(); if (d.plan) setPagePlan(d.plan); }
      if (analysisRes.ok) { const d = await analysisRes.json(); if (d.metrics) setAnalysis(d); }
    } catch { /* ignore */ }
    setLoadingResults(false);
    setSaveStatus("idle");
  }, [sessionSlug]);

  const handleSaveInputsAndGT = useCallback(async () => {
    if (!sessionSlug) return;
    setSaveStatus("saving");
    try {
      const res = await fetch("/api/new-test/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, inputs, groundTruth }),
      });
      if (res.ok) {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 3000);
      } else {
        setSaveStatus("idle");
      }
    } catch {
      setSaveStatus("idle");
    }
  }, [sessionSlug, inputs, groundTruth]);

  const handleInputChange = useCallback((source: string, value: string) => {
    setInputs(prev => ({ ...prev, [source]: value }));
    setSaveStatus("idle");
  }, []);

  // Chat button: generate mock data + ground truth ONLY
  const handleGenerateData = useCallback(async () => {
    setInputs({ confluence: "", jira: "", slack: "", github: "", customerFeedback: "" });
    setGroundTruth(null);
    setGeneratedResults(null);
    setAnalysis(null);
    dataFetchedForSession.current = sessionSlug;
    setActiveSection("input_gt");
    await runStreamedPipeline({ generateOnly: true }, async () => {
      // data already streamed into state
    });
  }, [runStreamedPipeline, sessionSlug]);

  // Plan KB pages only (9 categories → page titles)
  const handlePlanPages = useCallback(async () => {
    if (sessionSlug) {
      await fetch("/api/new-test/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, inputs }),
      });
    }
    setPagePlan(null);
    await runStreamedPipeline({ planOnly: true }, async () => {
      // plan received via page_plan event
    });
  }, [runStreamedPipeline, sessionSlug, inputs]);

  // Generate GT only (keep existing inputs, regenerate ground truth)
  const handleGenerateGTOnly = useCallback(async () => {
    if (sessionSlug) {
      await fetch("/api/new-test/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, inputs }),
      });
    }
    setGroundTruth(null);
    await runStreamedPipeline({ gtOnly: true }, async () => {
      // GT streamed via gt_part events
    });
  }, [runStreamedPipeline, sessionSlug, inputs]);

  // Input & GT button: save first, then run Pidrax + analysis
  const handleRunPidraxAndAnalyze = useCallback(async () => {
    if (sessionSlug) {
      await fetch("/api/new-test/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, inputs, groundTruth }),
      });
    }
    await runStreamedPipeline({ runPidraxOnly: true }, async () => {
      await loadAllData();
      setActiveSection("compare");
    });
  }, [runStreamedPipeline, sessionSlug, inputs, groundTruth, loadAllData]);

  const handleRunAnalysisOnly = useCallback(async () => {
    await runStreamedPipeline({ analyzeOnly: true }, async () => {
      await loadAllData();
    });
  }, [runStreamedPipeline, loadAllData]);

  useEffect(() => {
    if (!sessionSlug) return;
    if (["compare", "input_gt", "results_score", "gt_score", "analysis"].includes(activeSection)) {
      if (dataFetchedForSession.current !== sessionSlug && !loadingResults) {
        dataFetchedForSession.current = sessionSlug;
        loadAllData();
      }
    }
  }, [activeSection, sessionSlug]);

  const currentSessionObj = sessions.find(s => s.slug === currentSession);

  return (
    <div className="flex h-screen bg-background">
      {/* Left sidebar */}
      <div className="w-64 border-r bg-muted/30 flex flex-col">
        <div className="p-4 border-b">
          <h1 className="text-lg font-bold">Pidrax New Test</h1>
          <p className="text-xs text-muted-foreground mt-1">Structured Evaluation</p>
        </div>

        {/* Session selector */}
        <div className="p-3 border-b space-y-2">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Session</div>
          {sessions.length > 0 && (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {sessions.map(s => (
                <div key={s.slug} className={cn(
                  "flex items-center justify-between px-2 py-1.5 rounded text-sm cursor-pointer group",
                  s.slug === currentSession ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted"
                )}>
                  <button onClick={() => handleSwitchSession(s.slug)}
                    className="flex items-center gap-2 flex-1 text-left truncate">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{s.name}</span>
                  </button>
                  <button onClick={e => { e.stopPropagation(); handleDeleteSession(s.slug); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive transition-opacity">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            <input value={newSessionName} onChange={e => setNewSessionName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleCreateSession()}
              placeholder="Session name..."
              className="flex-1 h-8 text-xs rounded-md border bg-background px-2" />
            <Button size="sm" onClick={handleCreateSession} disabled={!newSessionName.trim()} className="h-8 text-xs px-3">
              <Plus className="h-3 w-3" />
            </Button>
          </div>
        </div>

        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {MENU_ITEMS.map(item => {
            const Icon = item.icon;
            return (
              <button key={item.id} onClick={() => setActiveSection(item.id)}
                disabled={!currentSession}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  activeSection === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  !currentSession && "opacity-40 cursor-not-allowed"
                )}>
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Sidebar progress indicator */}
        {progress && (running || progress.phase === "error") && (
          <div className="p-3 border-t">
            <div className="flex items-center gap-2 text-xs">
              {running ? <Loader2 className="h-3 w-3 animate-spin shrink-0" /> : <AlertTriangle className="h-3 w-3 text-red-500 shrink-0" />}
              <span className="truncate">{progress.detail}</span>
            </div>
            {progress.elapsed && <div className="text-[10px] text-muted-foreground mt-1">Elapsed: {progress.elapsed}</div>}
            {progress.percent >= 0 && (
              <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all duration-500" style={{ width: `${progress.percent}%` }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!currentSession ? (
          <EmptyState />
        ) : (
          <>
            {activeSection === "chat" && (
              <ChatSection messages={chatMessages} input={chatInput} setInput={setChatInput}
                onSend={handleSendChat} loading={chatLoading} running={running}
                onGenerate={handleGenerateData}
                progress={progress} progressLog={progressLog}
                sessionName={currentSessionObj?.name || currentSession} />
            )}
            {activeSection === "input_gt" && (
              <InputAndGroundTruthSection inputs={inputs} groundTruth={groundTruth}
                running={running} onRunPidrax={handleRunPidraxAndAnalyze} loading={loadingResults}
                progress={progress} progressLog={progressLog}
                onInputChange={handleInputChange}
                onSave={handleSaveInputsAndGT} saveStatus={saveStatus}
                onPlanPages={handlePlanPages}
                onGenerateGTOnly={handleGenerateGTOnly}
                pagePlan={pagePlan} />
            )}
            {activeSection === "compare" && (
              <CompareSection generated={generatedResults} groundTruth={groundTruth}
                loading={loadingResults} onRefresh={loadAllData} />
            )}
            {activeSection === "results_score" && (
              <ScoreFormatTableView data={generatedResults} label="Generated Results — Score Format" />
            )}
            {activeSection === "gt_score" && (
              <ScoreFormatTableView data={groundTruth} label="Ground Truth — Score Format" />
            )}
            {activeSection === "analysis" && (
              <AnalysisSection analysis={analysis} running={running} onRunAnalysis={handleRunAnalysisOnly} progressLog={progressLog} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress Log Panel (reusable)
// ---------------------------------------------------------------------------

function ProgressLogPanel({ log, running }: { log: ProgressEvent[]; running: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  if (log.length === 0 && !running) return null;

  return (
    <div className="border rounded-lg bg-zinc-950 text-zinc-300 font-mono text-xs">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800">
        <Terminal className="h-3.5 w-3.5 text-zinc-500" />
        <span className="text-zinc-400 text-[11px] font-semibold uppercase tracking-wide">Pipeline Log</span>
        {running && <Loader2 className="h-3 w-3 animate-spin text-blue-400 ml-auto" />}
      </div>
      <div ref={scrollRef} className="max-h-[200px] overflow-y-auto p-2 space-y-0.5">
        {log.map((evt, i) => (
          <div key={i} className={cn("flex gap-2 leading-snug py-0.5",
            evt.phase === "error" ? "text-red-400" :
            evt.done && evt.success ? "text-green-400" :
            "text-zinc-300"
          )}>
            <span className="text-zinc-600 shrink-0 w-12 text-right">{evt.elapsed || ""}</span>
            <span className="text-zinc-500 shrink-0 w-8 text-right">{evt.percent >= 0 ? `${evt.percent}%` : "ERR"}</span>
            <span className="flex-1">{evt.detail}</span>
          </div>
        ))}
        {running && log.length === 0 && (
          <div className="text-zinc-500 py-2">Waiting for pipeline events...</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      <div className="text-center">
        <FolderOpen className="h-12 w-12 mx-auto mb-4 opacity-30" />
        <p className="text-lg font-medium">No session selected</p>
        <p className="text-sm mt-1">Create a new session to begin.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat Section
// ---------------------------------------------------------------------------

function ChatSection({ messages, input, setInput, onSend, loading, running, onGenerate, progress, progressLog, sessionName }: {
  messages: ChatMessage[]; input: string; setInput: (v: string) => void;
  onSend: () => void; loading: boolean; running: boolean;
  onGenerate: () => void;
  progress: ProgressEvent | null; progressLog: ProgressEvent[];
  sessionName: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b">
        <h2 className="text-xl font-semibold">Scenario Chat &mdash; {sessionName}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Describe what mock company data you want. Agree on domain, stack, team size, difficulty, then click Generate.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground py-12 max-w-xl mx-auto">
            <MessageSquare className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium mb-3">Describe your test scenario</p>
            <p className="text-sm text-left bg-muted/50 rounded-lg p-4 leading-relaxed">
              A coffee shop app with React + Python, 3 engineers, 3 conflicts, 3 outdated items, 3 past documented projects, 3 ongoing projects, 3 new projects, 3 customer feedback entries (1 new feature request, 1 bug report) that become generated tickets, 2 new project docs from the new feature and bug that include how-to-implement sections. Do not give the input data any hints like &quot;this is a conflict&quot; — make the inputs read like real human-written data. Make sure input formats match what you&apos;d get from each source&apos;s API. Keep each input source under 200 words.
            </p>
            <p className="text-xs mt-3 opacity-60">Copy or edit the example above, or type your own scenario.</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[75%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap",
              msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
            )}>
              {msg.content || (loading && i === messages.length - 1 ? <Loader2 className="h-4 w-4 animate-spin" /> : "")}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Progress log (visible during/after generation) */}
      {progressLog.length > 0 && (
        <div className="px-4 pb-2">
          <ProgressLogPanel log={progressLog} running={running} />
        </div>
      )}

      <div className="p-4 border-t space-y-3">
        <div className="flex gap-2">
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !e.shiftKey && onSend()}
            placeholder="Describe what you want to test..."
            className="flex-1 h-10 rounded-md border bg-background px-3 text-sm" disabled={loading || running} />
          <Button onClick={onSend} disabled={loading || running || !input.trim()} size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <Button onClick={onGenerate} disabled={running || messages.length === 0} size="lg" className="w-full gap-2">
          {running ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</>
          ) : (
            <><Play className="h-4 w-4" /> Generate Mock Data + Ground Truth</>
          )}
        </Button>
        <p className="text-[11px] text-muted-foreground text-center">
          This only generates input data and the answer key. You will review them before running Pidrax.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Input & Ground Truth Section (merged)
// ---------------------------------------------------------------------------

function InputAndGroundTruthSection({ inputs, groundTruth, running, onRunPidrax, loading, progress, progressLog, onInputChange, onSave, saveStatus, onPlanPages, onGenerateGTOnly, pagePlan }: {
  inputs: Record<string, string>;
  groundTruth: ScoreFormatOutputType | null;
  running: boolean;
  onRunPidrax: () => void;
  loading: boolean;
  progress: ProgressEvent | null;
  progressLog: ProgressEvent[];
  onInputChange: (source: string, value: string) => void;
  onSave: () => void;
  saveStatus: "idle" | "saving" | "saved";
  onPlanPages: () => void;
  onGenerateGTOnly: () => void;
  pagePlan: { category: string; title: string; description: string }[] | null;
}) {
  const hasData = Object.values(inputs).some(v => v.trim()) || groundTruth !== null;
  const hasInputs = Object.values(inputs).some(v => v.trim());
  const [selectedGTTab, setSelectedGTTab] = useState("kb");
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);

  const selectedPage = groundTruth?.kb_pages?.find(p => p.page_id === selectedPageId)
    || groundTruth?.howto_pages?.find(p => p.page_id === selectedPageId)
    || null;
  const selectedPlanPage = !selectedPage && selectedPageId?.startsWith("plan::")
    ? pagePlan?.find(p => `plan::${p.category}::${p.title}` === selectedPageId) || null
    : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-xl font-semibold">Input Data & Ground Truth</h2>
          <p className="text-sm text-muted-foreground mt-1">
            1. Edit inputs &rarr; 2. Plan KB pages &rarr; 3. Generate GT &rarr; 4. Run Pidrax
          </p>
        </div>
        <Button variant={saveStatus === "saved" ? "outline" : "default"} size="sm"
          onClick={onSave} disabled={saveStatus === "saving" || !hasData || running}
          className="gap-2 shrink-0">
          {saveStatus === "saving" ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...</>
          ) : saveStatus === "saved" ? (
            <><Check className="h-3.5 w-3.5 text-green-600" /> Saved</>
          ) : (
            <><Save className="h-3.5 w-3.5" /> Save All</>
          )}
        </Button>
      </div>

      <div className="flex-1 overflow-hidden min-h-0">
        <div className="flex h-full">
          {/* Left column: Input Source Data (editable) */}
          <div className="flex-1 border-r flex flex-col min-w-0">
            <div className="p-3 pb-1">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">Input Source Data</h3>
            </div>
            <Tabs defaultValue="confluence" className="flex-1 flex flex-col px-3 pb-3">
              <TabsList className="justify-start">
                {INPUT_TABS.map(tab => {
                  const Icon = tab.icon;
                  const hasTabData = (inputs[tab.id] || "").trim().length > 0;
                  return (
                    <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5 text-xs px-2 py-1">
                      <Icon className="h-3 w-3" /> {tab.label}
                      {hasTabData && <span className="ml-0.5 w-1.5 h-1.5 rounded-full bg-green-500" />}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
              {INPUT_TABS.map(tab => (
                <TabsContent key={tab.id} value={tab.id} className="flex-1 mt-2">
                  <textarea
                    value={inputs[tab.id] || ""}
                    onChange={e => onInputChange(tab.id, e.target.value)}
                    placeholder={`(no ${tab.label} data — generate from Chat or paste here)`}
                    className="w-full h-full max-h-[calc(100vh-280px)] min-h-[200px] p-3 rounded-lg border bg-muted/30 font-mono text-xs whitespace-pre-wrap resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                    disabled={running}
                  />
                </TabsContent>
              ))}
            </Tabs>
          </div>

          {/* Right column: Ground Truth */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="p-3 pb-1">
              <h3 className="text-xs font-semibold uppercase text-green-600 tracking-wide">Ground Truth (Answer Key)</h3>
            </div>
            <Tabs value={selectedGTTab} onValueChange={v => { setSelectedGTTab(v); setSelectedPageId(null); }} className="flex-1 flex flex-col px-3 pb-3">
              <TabsList className="justify-start flex-wrap">
                {RESULT_TABS.map(tab => {
                  const Icon = tab.icon;
                  const count = getResultTabCount(groundTruth, tab.id);
                  return (
                    <TabsTrigger key={tab.id} value={tab.id} className="gap-1.5 text-xs px-2 py-1">
                      <Icon className="h-3 w-3" /> {tab.label}
                      {count > 0 && <span className="ml-0.5 px-1 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-medium">{count}</span>}
                    </TabsTrigger>
                  );
                })}
              </TabsList>

              {/* KB tab: tree + page viewer */}
              <TabsContent value="kb" className="flex-1 mt-2 overflow-hidden">
                <div className="flex h-full max-h-[calc(100vh-300px)] gap-0">
                  {/* Tree navigator */}
                  <div className="w-56 shrink-0 border-r overflow-y-auto pr-1">
                    <KBTreeNav
                      pagePlan={pagePlan}
                      pages={groundTruth?.kb_pages || []}
                      selectedPageId={selectedPageId}
                      onSelectPage={setSelectedPageId}
                    />
                  </div>
                  {/* Page content viewer */}
                  <div className="flex-1 overflow-y-auto pl-3">
                    {selectedPage ? (
                      <PageDetailView page={selectedPage} />
                    ) : selectedPlanPage ? (
                      <div className="py-4">
                        <h3 className="font-semibold text-sm">{selectedPlanPage.title}</h3>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {KB_CATEGORY_LABELS[selectedPlanPage.category as KBCategory] || selectedPlanPage.category}
                        </p>
                        <p className="text-xs text-muted-foreground mt-2">{selectedPlanPage.description}</p>
                        <div className="mt-4 p-3 rounded-md bg-muted/50 border border-dashed text-xs text-muted-foreground italic">
                          Content not generated yet. Click &ldquo;Generate GT&rdquo; to populate this page.
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground italic py-8 text-center">
                        {pagePlan ? "Select a page from the tree." : "Click \"Plan KB Pages\" to create the page structure."}
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              {/* How-to tab: same tree approach */}
              <TabsContent value="howto" className="flex-1 mt-2 overflow-hidden">
                <div className="flex h-full max-h-[calc(100vh-300px)] gap-0">
                  <div className="w-56 shrink-0 border-r overflow-y-auto pr-1">
                    {(groundTruth?.howto_pages || []).length === 0 ? (
                      <p className="text-xs text-muted-foreground italic p-2">No how-to pages yet.</p>
                    ) : (
                      <div className="space-y-0.5">
                        {(groundTruth?.howto_pages || []).map(p => (
                          <button key={p.page_id} onClick={() => setSelectedPageId(p.page_id)}
                            className={cn("w-full text-left px-2 py-1.5 rounded text-xs truncate",
                              selectedPageId === p.page_id ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-muted-foreground"
                            )}>
                            {p.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 overflow-y-auto pl-3">
                    {selectedPage ? <PageDetailView page={selectedPage} /> : (
                      <p className="text-sm text-muted-foreground italic py-8 text-center">(select a page)</p>
                    )}
                  </div>
                </div>
              </TabsContent>

              {/* Other tabs: use existing renderers */}
              {RESULT_TABS.filter(t => t.id !== "kb" && t.id !== "howto").map(tab => (
                <TabsContent key={tab.id} value={tab.id} className="flex-1 mt-2 max-h-[calc(100vh-300px)] overflow-auto">
                  <ResultTabContent data={groundTruth} tabId={tab.id} />
                </TabsContent>
              ))}
            </Tabs>
          </div>
        </div>

        {progressLog.length > 0 && (
          <div className="px-4 py-3 border-t shrink-0">
            <ProgressLogPanel log={progressLog} running={running} />
          </div>
        )}
      </div>

      {/* Bottom action bar */}
      <div className="p-4 border-t space-y-2 shrink-0">
        <div className="flex gap-2">
          <Button variant="outline" onClick={onPlanPages}
            disabled={running || !hasInputs}
            size="lg" className="gap-2">
            <ListTree className="h-4 w-4" /> Plan KB Pages
          </Button>
          <Button variant="outline" onClick={onGenerateGTOnly}
            disabled={running || !hasInputs || !pagePlan}
            size="lg" className="gap-2">
            <Sparkles className="h-4 w-4" /> Generate GT
          </Button>
          <Button onClick={onRunPidrax} disabled={running || !hasInputs}
            size="lg" className="flex-1 gap-2">
            {running ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Running...</>
            ) : (
              <><Play className="h-4 w-4" /> Run Pidrax + Analyze</>
            )}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground text-center">
          Plan creates the page tree. Generate GT fills in each page. Run Pidrax processes inputs blindly and compares.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KB Tree Navigator (for GT side)
// ---------------------------------------------------------------------------

function KBTreeNav({ pagePlan, pages, selectedPageId, onSelectPage }: {
  pagePlan: { category: string; title: string; description: string }[] | null;
  pages: ScoreFormatPageType[];
  selectedPageId: string | null;
  onSelectPage: (id: string) => void;
}) {
  const pagesByTitle = new Map<string, ScoreFormatPageType>();
  for (const p of pages) pagesByTitle.set(`${p.category}::${p.title}`, p);

  return (
    <div className="space-y-1">
      {Object.entries(KB_CATEGORY_LABELS).map(([cat, label]) => {
        const plannedForCat = pagePlan?.filter(p => p.category === cat) || [];
        const generatedForCat = pages.filter(p => p.category === cat);
        const hasAny = plannedForCat.length > 0 || generatedForCat.length > 0;

        const pageList = plannedForCat.length > 0 ? plannedForCat : generatedForCat.map(p => ({ category: p.category, title: p.title, description: "" }));

        return (
          <div key={cat}>
            <div className="flex items-center gap-1 px-1 py-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground truncate">{label}</span>
              {hasAny && (
                <span className="text-[9px] text-muted-foreground/60 ml-auto shrink-0">
                  {generatedForCat.length}/{pageList.length}
                </span>
              )}
            </div>
            {pageList.length > 0 ? (
              <div className="space-y-0.5 ml-1">
                {pageList.map((spec, i) => {
                  const generated = pagesByTitle.get(`${spec.category}::${spec.title}`) || generatedForCat.find(p => p.title === spec.title);
                  const pageId = generated ? generated.page_id : `plan::${spec.category}::${spec.title}`;
                  const items = generated ? generated.sections.reduce((s, sec) => s + sec.bullets.length, 0) : 0;
                  const isSelected = selectedPageId === pageId;

                  return (
                    <button
                      key={`${cat}-${i}`}
                      onClick={() => onSelectPage(pageId)}
                      className={cn(
                        "w-full text-left px-2 py-1 rounded text-[11px] truncate flex items-center gap-1",
                        isSelected ? "bg-primary/10 text-primary font-medium" :
                        "hover:bg-muted cursor-pointer",
                        generated ? "text-foreground" : "text-muted-foreground"
                      )}>
                      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                        generated ? "bg-green-500" : "bg-zinc-400"
                      )} />
                      <span className="truncate">{spec.title}</span>
                      {generated ? (
                        <span className="text-[9px] text-muted-foreground ml-auto shrink-0">{items}</span>
                      ) : (
                        <span className="text-[9px] text-muted-foreground/50 ml-auto shrink-0 italic">planned</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground/40 italic ml-2 py-0.5">no pages planned</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page Detail View (shows sections + atomic items for a single page)
// ---------------------------------------------------------------------------

function PageDetailView({ page }: { page: ScoreFormatPageType }) {
  const totalItems = page.sections.reduce((s, sec) => s + sec.bullets.length, 0);
  return (
    <div>
      <div className="mb-3">
        <h3 className="font-semibold text-sm">{page.title}</h3>
        <p className="text-[10px] text-muted-foreground">
          {KB_CATEGORY_LABELS[page.category as KBCategory] || page.category} &middot; {totalItems} items &middot; {page.sections.length} sections
        </p>
      </div>
      <div className="space-y-3">
        {page.sections.map((section, si) => (
          <div key={si}>
            <h4 className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">{section.section_name}</h4>
            <div className="space-y-0.5">
              {section.bullets.map((item, ii) => <AtomicItemRow key={item.item_id || ii} item={item} />)}
              {section.bullets.length === 0 && <p className="text-[10px] text-muted-foreground italic">No items</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compare Section (Generated vs GT side-by-side)
// ---------------------------------------------------------------------------

function CompareSection({ generated, groundTruth, loading, onRefresh }: {
  generated: ScoreFormatOutputType | null;
  groundTruth: ScoreFormatOutputType | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Generated vs Ground Truth</h2>
          <p className="text-sm text-muted-foreground mt-1">Side-by-side comparison per tab</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refresh"}
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="kb" className="h-full flex flex-col">
          <div className="px-4 pt-2">
            <TabsList className="w-full justify-start flex-wrap">
              {RESULT_TABS.map(tab => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger key={tab.id} value={tab.id} className="gap-2">
                    <Icon className="h-3.5 w-3.5" /> {tab.label}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
          {RESULT_TABS.map(tab => (
            <TabsContent key={tab.id} value={tab.id} className="flex-1 overflow-auto">
              <div className="flex gap-0 h-full">
                <div className="flex-1 border-r overflow-auto p-4">
                  <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">Generated</h3>
                  <ResultTabContent data={generated} tabId={tab.id} />
                </div>
                <div className="flex-1 overflow-auto p-4">
                  <h3 className="text-xs font-semibold uppercase text-green-600 tracking-wide mb-2">Ground Truth</h3>
                  <ResultTabContent data={groundTruth} tabId={tab.id} />
                </div>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared: render content for a result tab
// ---------------------------------------------------------------------------

function ResultTabContent({ data, tabId }: { data: ScoreFormatOutputType | null; tabId: string }) {
  if (!data) return <p className="text-sm text-muted-foreground italic py-4">(not generated yet)</p>;
  switch (tabId) {
    case "kb": return <KBPagesView pages={data.kb_pages || []} />;
    case "gaps": return <FilteredItemsView pages={data.kb_pages || []} itemType="gap" label="Gaps" />;
    case "conflicts": return <FilteredItemsView pages={data.kb_pages || []} itemType="conflict" label="Conflicts" />;
    case "outdated": return <FilteredItemsView pages={data.kb_pages || []} itemType="outdated" label="Outdated" />;
    case "conv_tickets": return <TicketsView tickets={data.conversation_tickets || []} label="Conversation Tickets" />;
    case "feedback_tickets": return <TicketsView tickets={data.feedback_tickets || []} label="Feedback Tickets" />;
    case "howto": return <KBPagesView pages={data.howto_pages || []} />;
    default: return null;
  }
}

function getResultTabCount(data: ScoreFormatOutputType | null, tabId: string): number {
  if (!data) return 0;
  switch (tabId) {
    case "kb": return data.kb_pages?.length || 0;
    case "gaps": return countItemsByType(data.kb_pages || [], "gap");
    case "conflicts": return countItemsByType(data.kb_pages || [], "conflict");
    case "outdated": return countItemsByType(data.kb_pages || [], "outdated");
    case "conv_tickets": return data.conversation_tickets?.length || 0;
    case "feedback_tickets": return data.feedback_tickets?.length || 0;
    case "howto": return data.howto_pages?.length || 0;
    default: return 0;
  }
}

function countItemsByType(pages: ScoreFormatPageType[], type: string): number {
  let count = 0;
  for (const page of pages) for (const section of page.sections) count += section.bullets.filter(b => b.item_type === type).length;
  return count;
}

// ---------------------------------------------------------------------------
// KB Pages View
// ---------------------------------------------------------------------------

function KBPagesView({ pages }: { pages: ScoreFormatPageType[] }) {
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const byCategory = new Map<string, ScoreFormatPageType[]>();
  for (const page of pages) {
    const list = byCategory.get(page.category) || [];
    list.push(page);
    byCategory.set(page.category, list);
  }
  const totalItems = pages.reduce((s, p) => s + p.sections.reduce((ss, sec) => ss + sec.bullets.length, 0), 0);

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground mb-2">
        {pages.length} pages &middot; {totalItems} items
      </div>
      {Object.entries(KB_CATEGORY_LABELS).map(([cat, label]) => {
        const catPages = byCategory.get(cat) || [];
        const catItems = catPages.reduce((s, p) => s + p.sections.reduce((ss, sec) => ss + sec.bullets.length, 0), 0);
        const collapsed = collapsedCats.has(cat);

        return (
          <div key={cat} className="border rounded-lg bg-card/50">
            <button
              onClick={() => setCollapsedCats(prev => {
                const next = new Set(prev);
                next.has(cat) ? next.delete(cat) : next.add(cat);
                return next;
              })}
              className="w-full px-2.5 py-1.5 flex items-center justify-between text-left hover:bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                {collapsed ? <ChevronRight className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
              </div>
              <div className="flex items-center gap-1.5">
                {catPages.length > 0 ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                    {catPages.length} {catPages.length === 1 ? "page" : "pages"} &middot; {catItems} items
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground/50 italic">waiting...</span>
                )}
              </div>
            </button>
            {!collapsed && catPages.length > 0 && (
              <div className="px-2.5 pb-2 space-y-1">
                {catPages.map(page => (
                  <PageCard key={page.page_id} page={page}
                    expanded={expandedPage === page.page_id}
                    onToggle={() => setExpandedPage(expandedPage === page.page_id ? null : page.page_id)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PageCard({ page, expanded, onToggle }: { page: ScoreFormatPageType; expanded: boolean; onToggle: () => void }) {
  const totalItems = page.sections.reduce((s, sec) => s + sec.bullets.length, 0);
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
          {page.sections.map((section, si) => (
            <div key={si}>
              <h4 className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">{section.section_name}</h4>
              <div className="space-y-0.5">
                {section.bullets.map((item, ii) => <AtomicItemRow key={item.item_id || ii} item={item} />)}
                {section.bullets.length === 0 && <p className="text-[10px] text-muted-foreground italic">No items</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AtomicItemRow({ item }: { item: AtomicItemType }) {
  const typeColors: Record<string, string> = {
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
  return (
    <div className={cn("flex items-start gap-1.5 px-1.5 py-1 rounded text-xs",
      item.verification?.status === "needs_verification" && "bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800"
    )}>
      <span className={cn("shrink-0 px-1 py-0.5 rounded text-[9px] font-medium uppercase leading-none", typeColors[item.item_type] || "bg-gray-100 text-gray-600")}>
        {item.item_type}
      </span>
      <span className="flex-1">{item.item_text}</span>
      {item.action_routing?.action !== "none" && (
        <span className={cn("shrink-0 text-[9px] px-1 py-0.5 rounded font-medium",
          item.action_routing.action === "create_jira_ticket" ? "bg-pink-100 text-pink-700 dark:bg-pink-900/30" :
          item.action_routing.action === "verify_task" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30" :
          "bg-blue-100 text-blue-700 dark:bg-blue-900/30"
        )}>{item.action_routing.action.replace(/_/g, " ")}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filtered Items View
// ---------------------------------------------------------------------------

function FilteredItemsView({ pages, itemType, label }: { pages: ScoreFormatPageType[]; itemType: string; label: string }) {
  const items: { item: AtomicItemType; pageName: string; sectionName: string }[] = [];
  for (const page of pages) for (const section of page.sections) for (const bullet of section.bullets) {
    if (bullet.item_type === itemType) items.push({ item: bullet, pageName: page.title, sectionName: section.section_name });
  }
  if (items.length === 0) return <div className="text-muted-foreground text-center py-4 text-sm">No {label.toLowerCase()}.</div>;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground mb-2">{items.length} {label.toLowerCase()}</p>
      {items.map((entry, i) => (
        <div key={i} className="border rounded-lg p-2 bg-card">
          <div className="flex items-center gap-1 mb-0.5 text-[10px] text-muted-foreground">
            <span>{entry.pageName}</span>
            <ChevronRight className="h-2.5 w-2.5" />
            <span>{entry.sectionName}</span>
          </div>
          <AtomicItemRow item={entry.item} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tickets View
// ---------------------------------------------------------------------------

function TicketsView({ tickets, label }: { tickets: PMTicketType[]; label: string }) {
  const [expandedTicket, setExpandedTicket] = useState<string | null>(null);
  if (tickets.length === 0) return <div className="text-muted-foreground text-center py-4 text-sm">No {label.toLowerCase()}.</div>;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground mb-2">{tickets.length} tickets</p>
      {tickets.map((ticket, i) => {
        const expanded = expandedTicket === ticket.ticket_id;
        return (
          <div key={ticket.ticket_id || i} className="border rounded-lg bg-card">
            <button onClick={() => setExpandedTicket(expanded ? null : ticket.ticket_id)} className="w-full p-2.5 text-left">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={cn("px-1 py-0.5 rounded text-[9px] font-medium uppercase",
                    ticket.type === "bug" ? "bg-red-100 text-red-700" : ticket.type === "feature" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"
                  )}>{ticket.type}</span>
                  <span className="font-medium text-sm">{ticket.title}</span>
                </div>
                <span className={cn("text-xs font-medium",
                  ticket.priority === "P0" ? "text-red-600" : ticket.priority === "P1" ? "text-orange-600" : "text-gray-500"
                )}>{ticket.priority}</span>
              </div>
            </button>
            {expanded && (
              <div className="border-t p-2.5 space-y-1 text-xs">
                <p>{ticket.description}</p>
                <p><span className="font-medium">Assigned:</span> {ticket.assigned_to}</p>
                {ticket.acceptance_criteria.length > 0 && (
                  <ul className="list-disc ml-4">{ticket.acceptance_criteria.map((ac, j) => <li key={j}>{ac}</li>)}</ul>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score-Format Table View
// ---------------------------------------------------------------------------

function ScoreFormatTableView({ data, label }: { data: ScoreFormatOutputType | null; label: string }) {
  const allItems: { item: AtomicItemType; page: string; category: string; section: string }[] = [];
  if (data) {
    for (const page of [...(data.kb_pages || []), ...(data.howto_pages || [])]) {
      for (const section of page.sections) for (const bullet of section.bullets) {
        allItems.push({ item: bullet, page: page.title, category: page.category, section: section.section_name });
      }
    }
  }
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b">
        <h2 className="text-xl font-semibold">{label}</h2>
        <p className="text-sm text-muted-foreground mt-1">{allItems.length} atomic items{!data && " — not generated yet"}</p>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th className="text-left p-2 font-medium">Category</th>
              <th className="text-left p-2 font-medium">Page</th>
              <th className="text-left p-2 font-medium">Section</th>
              <th className="text-left p-2 font-medium w-[30%]">Item</th>
              <th className="text-center p-2 font-medium">Type</th>
              <th className="text-center p-2 font-medium">Confidence</th>
              <th className="text-center p-2 font-medium">Action</th>
              <th className="text-center p-2 font-medium">Refs</th>
            </tr>
          </thead>
          <tbody>
            {allItems.length === 0 && (
              <tr><td colSpan={8} className="p-8 text-center text-muted-foreground italic">No items yet — run the pipeline to populate.</td></tr>
            )}
            {allItems.map((entry, i) => (
              <tr key={i} className="border-b hover:bg-muted/30">
                <td className="p-2">{KB_CATEGORY_LABELS[entry.category as KBCategory] || entry.category}</td>
                <td className="p-2 font-medium">{entry.page}</td>
                <td className="p-2">{entry.section}</td>
                <td className="p-2">{entry.item.item_text}</td>
                <td className="p-2 text-center"><span className="px-1 py-0.5 rounded bg-muted font-medium">{entry.item.item_type}</span></td>
                <td className={cn("p-2 text-center font-medium",
                  entry.item.confidence_bucket === "high" ? "text-green-600" : entry.item.confidence_bucket === "medium" ? "text-yellow-600" : "text-red-600"
                )}>{entry.item.confidence_bucket}</td>
                <td className="p-2 text-center">{entry.item.action_routing?.action === "none" ? "-" : entry.item.action_routing?.action?.replace(/_/g, " ")}</td>
                <td className="p-2 text-center">{entry.item.source_refs?.length || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analysis Section
// ---------------------------------------------------------------------------

function AnalysisSection({ analysis, running, onRunAnalysis, progressLog }: { analysis: any; running: boolean; onRunAnalysis: () => void; progressLog: ProgressEvent[] }) {
  const m = analysis?.metrics;
  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="p-4 border-b flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Analysis Results</h2>
          {analysis?.analyzedAt ? (
            <p className="text-sm text-muted-foreground mt-1">Analyzed: {new Date(analysis.analyzedAt).toLocaleString()}</p>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">Not analyzed yet.</p>
          )}
        </div>
        <button
          onClick={onRunAnalysis}
          disabled={running}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {running ? "Running..." : m ? "Re-run Analysis" : "Run Analysis"}
        </button>
      </div>
      {running && progressLog.length > 0 && (
        <div className="px-4 pt-3">
          <ProgressLogPanel log={progressLog} running={running} />
        </div>
      )}
      {!m ? (
        <div className="p-8 text-center text-muted-foreground italic">
          <p>No analysis metrics available.</p>
          <p className="text-xs mt-1">Click &ldquo;Run Analysis&rdquo; above to generate metrics from the existing GT and Pidrax results.</p>
        </div>
      ) : <>
      <div className="p-4 grid grid-cols-5 gap-3">
        <MetricCard label="Groundedness" value={m.groundedness?.overall} />
        <MetricCard label="Completeness" value={m.completeness?.overall} />
        <MetricCard label="Coherence" value={m.coherence?.overall} />
        <MetricCard label="Decision Quality" value={m.decision_quality?.overall} />
        <MetricCard label="Reviewer Burden" value={m.reviewer_burden?.overall} />
      </div>
      {m?.groundedness && <MetricDetail title="1. Groundedness" fields={[
        { label: "Citation Coverage", value: m.groundedness.citation_coverage },
        { label: "Evidence Sufficiency", value: m.groundedness.evidence_sufficiency },
      ]} />}
      {m?.completeness && <MetricDetail title="2. Completeness" fields={[
        { label: "Schema Compliance", value: m.completeness.schema_compliance },
        { label: "Atom Coverage", value: m.completeness.atom_coverage },
      ]} />}
      {m?.coherence && (
        <div className="px-4 pb-4">
          <h3 className="text-lg font-semibold mb-2">3. Coherence</h3>
          <div className="border rounded-lg p-3 space-y-2 text-sm">
            {m.coherence.duplicate_pages?.length > 0 && <div><span className="font-medium text-red-600">Duplicates:</span><ul className="list-disc ml-5 mt-1">{m.coherence.duplicate_pages.map((d: string, i: number) => <li key={i}>{d}</li>)}</ul></div>}
            {m.coherence.consistency_violations?.length > 0 && <div><span className="font-medium text-orange-600">Violations:</span><ul className="list-disc ml-5 mt-1">{m.coherence.consistency_violations.map((v: string, i: number) => <li key={i}>{v}</li>)}</ul></div>}
            {m.coherence.category_errors?.length > 0 && <div><span className="font-medium text-yellow-600">Category errors:</span><ul className="list-disc ml-5 mt-1">{m.coherence.category_errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul></div>}
            {!m.coherence.duplicate_pages?.length && !m.coherence.consistency_violations?.length && !m.coherence.category_errors?.length && <p className="text-green-600">No issues.</p>}
          </div>
        </div>
      )}
      {m?.decision_quality && (
        <div className="px-4 pb-4">
          <h3 className="text-lg font-semibold mb-2">4. Decision Quality</h3>
          <div className="border rounded-lg p-3 text-sm">
            <div className="grid grid-cols-4 gap-3 mb-3">
              <div className="text-center"><div className="font-bold text-lg">{m.decision_quality.correct ?? "-"}</div><div className="text-xs text-muted-foreground">Correct</div></div>
              <div className="text-center"><div className="font-bold text-lg text-red-600">{m.decision_quality.mismatches ?? "-"}</div><div className="text-xs text-muted-foreground">Mismatches</div></div>
              <div className="text-center"><div className="font-bold text-lg">{pct(m.decision_quality.overall)}</div><div className="text-xs text-muted-foreground">Accuracy</div></div>
              <div className="text-center"><div className="font-bold text-lg text-orange-600">{m.decision_quality.severity_penalty?.toFixed(1) ?? "-"}</div><div className="text-xs text-muted-foreground">Penalty</div></div>
            </div>
            {m.decision_quality.top_mismatches?.length > 0 && (
              <ul className="list-disc ml-5 space-y-1">{m.decision_quality.top_mismatches.slice(0, 10).map((mm: any, i: number) => (
                <li key={i}><span className="font-medium">{mm.item_text?.slice(0, 60)}...</span> expected: {mm.expected}, got: {mm.actual} ({mm.severity})</li>
              ))}</ul>
            )}
          </div>
        </div>
      )}
      {m?.reviewer_burden && (
        <div className="px-4 pb-8">
          <h3 className="text-lg font-semibold mb-2">5. Reviewer Burden</h3>
          <div className="border rounded-lg p-3 text-sm">
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="text-center"><div className="font-bold text-lg">{m.reviewer_burden.total_verify_items ?? "-"}</div><div className="text-xs text-muted-foreground">Verify items</div></div>
              <div className="text-center"><div className="font-bold text-lg">{m.reviewer_burden.verify_rate ?? "-"}%</div><div className="text-xs text-muted-foreground">Per 100 items</div></div>
              <div className="text-center"><div className="font-bold text-lg">{m.reviewer_burden.people_count ?? "-"}</div><div className="text-xs text-muted-foreground">People</div></div>
            </div>
            {m.reviewer_burden.per_person?.length > 0 && (
              <table className="w-full text-xs"><thead><tr className="border-b"><th className="text-left p-1">Person</th><th className="text-center p-1">Count</th><th className="text-center p-1">%</th><th className="text-center p-1">Hotspot</th></tr></thead>
              <tbody>{m.reviewer_burden.per_person.map((pp: any, i: number) => (
                <tr key={i} className="border-b"><td className="p-1 font-medium">{pp.person}</td><td className="p-1 text-center">{pp.count}</td><td className="p-1 text-center">{pp.percent}%</td><td className={cn("p-1 text-center font-medium", pp.hotspot ? "text-red-600" : "text-green-600")}>{pp.hotspot ? "YES" : "No"}</td></tr>
              ))}</tbody></table>
            )}
          </div>
        </div>
      )}
      {m?.completeness?.atom_diff && (
        <div className="px-4 pb-8">
          <h3 className="text-lg font-semibold mb-2">Atom Coverage Diff</h3>
          <div className="space-y-3">
            {m.completeness.atom_diff.missing?.length > 0 && (
              <div className="border rounded-lg p-3"><span className="font-medium text-orange-600">Missing ({m.completeness.atom_diff.missing.length}):</span>
              <ul className="list-disc ml-5 mt-1 text-sm">{m.completeness.atom_diff.missing.slice(0, 20).map((item: any, i: number) => <li key={i}>{item.text} ({item.severity})</li>)}</ul></div>
            )}
            {m.completeness.atom_diff.extra?.length > 0 && (
              <div className="border rounded-lg p-3"><span className="font-medium text-blue-600">Extra ({m.completeness.atom_diff.extra.length}):</span>
              <ul className="list-disc ml-5 mt-1 text-sm">{m.completeness.atom_diff.extra.slice(0, 20).map((item: any, i: number) => <li key={i}>{item.text}</li>)}</ul></div>
            )}
            {m.completeness.atom_diff.conflicting?.length > 0 && (
              <div className="border rounded-lg p-3"><span className="font-medium text-red-600">Conflicting ({m.completeness.atom_diff.conflicting.length}):</span>
              <ul className="list-disc ml-5 mt-1 text-sm">{m.completeness.atom_diff.conflicting.slice(0, 20).map((item: any, i: number) => <li key={i}>GT: {item.gt_text} vs Gen: {item.gen_text}</li>)}</ul></div>
            )}
          </div>
        </div>
      )}
      </>}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number | undefined }) {
  const v = value ?? 0;
  const color = v >= 0.8 ? "text-green-600" : v >= 0.5 ? "text-yellow-600" : "text-red-600";
  return (
    <div className="border rounded-lg p-3 text-center">
      <div className={cn("text-2xl font-bold", color)}>{pct(v)}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

function MetricDetail({ title, fields }: { title: string; fields: { label: string; value: number | undefined }[] }) {
  return (
    <div className="px-4 pb-4">
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <div className="border rounded-lg p-3 grid grid-cols-2 gap-3">
        {fields.map(f => (
          <div key={f.label} className="text-center">
            <div className={cn("text-xl font-bold",
              (f.value ?? 0) >= 0.8 ? "text-green-600" : (f.value ?? 0) >= 0.5 ? "text-yellow-600" : "text-red-600"
            )}>{pct(f.value)}</div>
            <div className="text-xs text-muted-foreground">{f.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function pct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "N/A";
  return `${(n * 100).toFixed(1)}%`;
}
