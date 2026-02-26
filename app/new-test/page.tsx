"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import {
  MessageSquare, Upload, Sparkles, BarChart3,
  Play, Loader2, FileText, Bug, Wrench, AlertTriangle, Clock,
  GitBranch, Users, BookOpen, FolderOpen, Send, Hash,
  Plus, Trash2, ChevronRight, ChevronDown,
  Table2, Columns2, Terminal, Save, Check, ListTree, X, Pencil,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  KB_CATEGORY_LABELS,
  KB_BASIC_CATEGORIES,
  KB_PROJECT_CATEGORIES,
  LAYER_A_CATEGORIES,
  LAYER_B_CATEGORIES,
  type KBCategory,
  type ScoreFormatPageType,
  type PMTicketType,
  type AtomicItemType,
  type ScoreFormatOutputType,
  type TicketAuditItemType,
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
  { id: "kb_basic", label: "KB Basic", icon: BookOpen },
  { id: "kb_projects", label: "KB Projects", icon: FolderOpen },
  { id: "gaps", label: "Gaps", icon: FileText },
  { id: "conflicts", label: "Conflicts", icon: AlertTriangle },
  { id: "outdated", label: "Outdated", icon: Clock },
  { id: "tickets", label: "Tickets", icon: Hash },
  { id: "new_projects", label: "New Projects", icon: Wrench },
] as const;

const MENU_ITEMS = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "input_gt", label: "Input & Ground Truth", icon: Upload },
  { id: "compare", label: "Generated vs GT", icon: Columns2 },
  { id: "results_score", label: "Results — Score Format", icon: Table2 },
  { id: "gt_score", label: "GT — Score Format", icon: Table2 },
  { id: "analysis", label: "Analysis Results", icon: BarChart3 },
  { id: "pidrax_kb", label: "Pidrax KB", icon: Sparkles },
  { id: "pidrax_kb2", label: "Pidrax KB 2", icon: ListTree },
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
  const [pagePlan, setPagePlan] = useState<any>(null); // legacy, may be removed
  const [analysis, setAnalysis] = useState<any>(null);
  const [loadingResults, setLoadingResults] = useState(false);

  // Pidrax KB pipeline state
  const [pidraxResult, setPidraxResult] = useState<ScoreFormatOutputType | null>(null);
  const [pidraxPlan, setPidraxPlan] = useState<any[] | null>(null);
  const [pidraxTicketAudit, setPidraxTicketAudit] = useState<TicketAuditItemType[] | null>(null);
  const [pidraxCrossValidation, setPidraxCrossValidation] = useState<any>(null);
  const [pidraxRunning, setPidraxRunning] = useState(false);
  const [pidraxProgress, setPidraxProgress] = useState<ProgressEvent | null>(null);
  const [pidraxLog, setPidraxLog] = useState<ProgressEvent[]>([]);
  const [pidraxCheckpoint, setPidraxCheckpoint] = useState<{ runId: string; completedStep: number; stepMetrics: any[]; updatedAt: string } | null>(null);
  const [pidraxMetrics, setPidraxMetrics] = useState<any>(null);
  const [pidraxStepMetrics, setPidraxStepMetrics] = useState<any[]>([]);

  // Pidrax KB Pass 2 state
  const [pass2Result, setPass2Result] = useState<ScoreFormatOutputType | null>(null);
  const [pass2Groups, setPass2Groups] = useState<any[] | null>(null);
  const [pass2Metrics, setPass2Metrics] = useState<any>(null);
  const [pass2Running, setPass2Running] = useState(false);
  const [pass2Progress, setPass2Progress] = useState<ProgressEvent | null>(null);
  const [pass2Log, setPass2Log] = useState<ProgressEvent[]>([]);

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
        setPidraxResult(null);
        setPidraxPlan(null);
        setPidraxTicketAudit(null);
        setPidraxCrossValidation(null);
        setPidraxLog([]);
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
    setPidraxResult(null);
    setPidraxPlan(null);
    setPidraxTicketAudit(null);
    setPidraxCrossValidation(null);
    setPidraxLog([]);
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
                const base = prev || { kb_pages: [], conversation_tickets: [], customer_tickets: [], howto_pages: [] };
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
      const [inputsRes, resultsRes, gtRes, planRes, analysisRes, pidraxRes, checkpointRes, pass2Res] = await Promise.all([
        fetch(`/api/new-test/results?type=inputs&session=${sessionSlug}`),
        fetch(`/api/new-test/results?type=generated&session=${sessionSlug}`),
        fetch(`/api/new-test/results?type=ground_truth&session=${sessionSlug}`),
        fetch(`/api/new-test/results?type=page_plan&session=${sessionSlug}`),
        fetch(`/api/new-test/analysis?session=${sessionSlug}`),
        fetch(`/api/new-test/results?type=pidrax&session=${sessionSlug}`),
        fetch(`/api/new-test/results?type=pidrax_checkpoint&session=${sessionSlug}`),
        fetch(`/api/new-test/results?type=pidrax_pass2&session=${sessionSlug}`),
      ]);
      if (inputsRes.ok) { const d = await inputsRes.json(); if (d.inputs) setInputs(d.inputs); }
      if (resultsRes.ok) { const d = await resultsRes.json(); if (d.data) setGeneratedResults(d.data); }
      if (gtRes.ok) { const d = await gtRes.json(); if (d.data) setGroundTruth(d.data); }
      if (planRes.ok) { const d = await planRes.json(); if (d.plan) setPagePlan(d.plan); }
      if (analysisRes.ok) { const d = await analysisRes.json(); if (d.metrics) setAnalysis(d); }
      if (pidraxRes.ok) {
        const d = await pidraxRes.json();
        if (d.data) setPidraxResult(d.data);
        if (d.ticketAudit) setPidraxTicketAudit(d.ticketAudit);
        if (d.crossValidation) setPidraxCrossValidation(d.crossValidation);
        if (d.pagePlan) setPidraxPlan(d.pagePlan);
        if (d.metrics) setPidraxMetrics(d.metrics);
        if (d.metrics?.steps) setPidraxStepMetrics(d.metrics.steps);
      }
      if (checkpointRes.ok) {
        const d = await checkpointRes.json();
        setPidraxCheckpoint(d.checkpoint || null);
      }
      if (pass2Res.ok) {
        const d = await pass2Res.json();
        if (d.data) setPass2Result(d.data);
        if (d.verificationGroups) setPass2Groups(d.verificationGroups);
        if (d.metrics) setPass2Metrics(d.metrics);
      }
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

  // Pidrax KB pipeline
  const handleRunPidrax = useCallback(async (resumeRunId?: string) => {
    if (!sessionSlug || pidraxRunning) return;

    // Save inputs first
    await fetch("/api/new-test/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionSlug, inputs }),
    });

    setPidraxRunning(true);
    setPidraxLog([]);
    setPidraxProgress(null);
    if (!resumeRunId) {
      setPidraxResult(null);
      setPidraxPlan(null);
      setPidraxTicketAudit(null);
      setPidraxCrossValidation(null);
      setPidraxStepMetrics([]);
      setPidraxMetrics(null);
    }

    const livePages: ScoreFormatPageType[] = [];
    const liveHowtoPages: ScoreFormatPageType[] = [];
    const liveConvTickets: PMTicketType[] = [];
    const liveCustTickets: PMTicketType[] = [];

    try {
      const res = await fetch("/api/new-test/pidrax-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, resumeRunId }),
      });
      if (!res.ok) {
        const errEvt: ProgressEvent = { phase: "error", detail: `Pipeline failed (${res.status})`, percent: -1 };
        setPidraxProgress(errEvt);
        setPidraxLog(prev => [...prev, errEvt]);
        setPidraxRunning(false);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) { setPidraxRunning(false); return; }
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

            if (raw.phase === "plan" && raw.plan) {
              setPidraxPlan(raw.plan);
            }

            if (raw.phase === "pidrax_page" && raw.page) {
              const page = raw.page as ScoreFormatPageType;
              if (page.category === "howto_implementation") {
                liveHowtoPages.push(page);
              } else {
                livePages.push(page);
              }
              setPidraxResult({
                kb_pages: [...livePages],
                conversation_tickets: [...liveConvTickets],
                customer_tickets: [...liveCustTickets],
                howto_pages: [...liveHowtoPages],
                ticket_audit: [],
              });
            }

            if (raw.phase === "step_metric" && raw.stepMetric) {
              setPidraxStepMetrics(prev => [...prev, raw.stepMetric]);
            }

            const evt: ProgressEvent = {
              phase: raw.phase,
              detail: raw.detail || "",
              percent: raw.percent ?? -1,
              elapsed: raw.elapsed,
              done: raw.done,
              success: raw.success,
              error: raw.error,
            };
            setPidraxProgress(evt);
            if (evt.percent >= 0 || evt.done || evt.phase === "error") {
              setPidraxLog(prev => [...prev, evt]);
            }

            if (evt.done) {
              setPidraxRunning(false);
              setPidraxCheckpoint(null);
              if (raw.metrics) setPidraxMetrics(raw.metrics);
              try {
                const finalRes = await fetch(`/api/new-test/results?type=pidrax&session=${sessionSlug}`);
                if (finalRes.ok) {
                  const finalData = await finalRes.json();
                  if (finalData.data) setPidraxResult(finalData.data);
                  if (finalData.ticketAudit) setPidraxTicketAudit(finalData.ticketAudit);
                  if (finalData.crossValidation) setPidraxCrossValidation(finalData.crossValidation);
                  if (finalData.pagePlan) setPidraxPlan(finalData.pagePlan);
                  if (finalData.metrics) { setPidraxMetrics(finalData.metrics); setPidraxStepMetrics(finalData.metrics.steps || []); }
                }
              } catch { /* use live data */ }
            }
          } catch { /* ignore parse errors */ }
        }
      }
      setPidraxRunning(false);
    } catch (err: any) {
      const errEvt: ProgressEvent = { phase: "error", detail: err.message || "Connection failed", percent: -1 };
      setPidraxProgress(errEvt);
      setPidraxLog(prev => [...prev, errEvt]);
      setPidraxRunning(false);
    }
  }, [sessionSlug, pidraxRunning, inputs]);

  useEffect(() => {
    if (!sessionSlug) return;
    if (["compare", "input_gt", "results_score", "gt_score", "analysis", "pidrax_kb"].includes(activeSection)) {
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
                onGenerateGTOnly={handleGenerateGTOnly} />
            )}
            {activeSection === "compare" && (
              <CompareSection generated={generatedResults} groundTruth={groundTruth}
                loading={loadingResults} onRefresh={loadAllData}
                running={running} />
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
            {activeSection === "pidrax_kb" && (
              <PidraxKBSection
                result={pidraxResult}
                plan={pidraxPlan}
                ticketAudit={pidraxTicketAudit}
                crossValidation={pidraxCrossValidation}
                running={pidraxRunning}
                progress={pidraxProgress}
                progressLog={pidraxLog}
                onRunPidrax={handleRunPidrax}
                hasInputs={Object.values(inputs).some(v => v.trim())}
                checkpoint={pidraxCheckpoint}
                stepMetrics={pidraxStepMetrics}
                metrics={pidraxMetrics}
              />
            )}
            {activeSection === "pidrax_kb2" && (
              <PidraxKB2Section
                pass2Result={pass2Result}
                pass2Groups={pass2Groups}
                pass2Metrics={pass2Metrics}
                pass2Running={pass2Running}
                pass2Progress={pass2Progress}
                pass2Log={pass2Log}
                onSetPass2Running={setPass2Running}
                onSetPass2Progress={setPass2Progress}
                onSetPass2Log={setPass2Log}
                onSetPass2Result={setPass2Result}
                onSetPass2Groups={setPass2Groups}
                onSetPass2Metrics={setPass2Metrics}
                sessionSlug={sessionSlug || ""}
                onRefresh={loadAllData}
                hasFirstPass={!!pidraxResult}
                firstPassItemCount={(pidraxResult?.kb_pages || []).reduce((s, p) => s + (p.sections || []).reduce((ss, sec) => ss + (sec.bullets?.length || 0), 0), 0)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pidrax KB Section
// ---------------------------------------------------------------------------

function PidraxKBSection({ result, plan, ticketAudit, crossValidation, running, progress, progressLog, onRunPidrax, hasInputs, checkpoint, stepMetrics, metrics }: {
  result: ScoreFormatOutputType | null;
  plan: any[] | null;
  ticketAudit: TicketAuditItemType[] | null;
  crossValidation: any;
  running: boolean;
  progress: ProgressEvent | null;
  progressLog: ProgressEvent[];
  onRunPidrax: (resumeRunId?: string) => void;
  hasInputs: boolean;
  checkpoint: { runId: string; completedStep: number; stepMetrics: any[]; updatedAt: string } | null;
  stepMetrics: any[];
  metrics: any;
}) {
  const [subTab, setSubTab] = useState("run");

  const kbPages = result?.kb_pages || [];
  const layerAPages = kbPages.filter(p => (LAYER_A_CATEGORIES as readonly string[]).includes(p.category));
  const projectPages = kbPages.filter(p =>
    ["past_documented", "past_undocumented", "ongoing_documented", "ongoing_undocumented", "proposed_project"].includes(p.category)
  );
  const ticketPages = kbPages.filter(p => p.category === "ticket");
  const howtoPages = result?.howto_pages || [];
  const convTickets = result?.conversation_tickets || [];
  const custTickets = result?.customer_tickets || [];

  const allActionItems = kbPages.flatMap(p =>
    p.sections.flatMap(s =>
      s.bullets.filter(b =>
        b.item_type === "outdated" || b.item_type === "conflict" || b.item_type === "gap" ||
        (b.action_routing?.action === "verify_task")
      ).map(b => ({ item: b, pageName: p.title, sectionName: s.section_name }))
    )
  );

  const SUB_TABS = [
    { id: "run", label: "Run" },
    { id: "kb_pages", label: `KB Pages (${layerAPages.length})` },
    { id: "projects", label: `Projects (${projectPages.length})` },
    { id: "tickets", label: `Tickets (${ticketPages.length + convTickets.length + custTickets.length})` },
    { id: "action_items", label: `Action Items (${allActionItems.length})` },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b shrink-0">
        <h2 className="text-xl font-semibold">Pidrax KB</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Full knowledge base generation from company data — 8-step pipeline
        </p>
      </div>

      <div className="px-4 pt-2 shrink-0">
        <div className="flex gap-1 border-b">
          {SUB_TABS.map(tab => (
            <button key={tab.id} onClick={() => setSubTab(tab.id)}
              className={cn(
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                subTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {subTab === "run" && (
          <div className="space-y-4 max-w-3xl">
            <div className="flex gap-2">
              <Button onClick={() => onRunPidrax()} disabled={running || !hasInputs} size="lg" className="flex-1 gap-2">
                {running ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Running Pidrax Pipeline...</>
                ) : (
                  <><Play className="h-4 w-4" /> {result ? "Re-run Pipeline (Fresh)" : "Run Pidrax KB Pipeline"}</>
                )}
              </Button>
              {checkpoint && !running && (
                <Button onClick={() => onRunPidrax(checkpoint.runId)} variant="outline" size="lg" className="gap-2">
                  <Play className="h-4 w-4" /> Resume from Step {checkpoint.completedStep + 1}
                </Button>
              )}
            </div>
            {!hasInputs && (
              <p className="text-sm text-muted-foreground text-center">
                No input data found. Go to &ldquo;Input &amp; Ground Truth&rdquo; to add or generate data first.
              </p>
            )}
            {checkpoint && !running && (
              <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg p-3">
                <p className="text-sm font-medium text-amber-600">Incomplete run detected</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Step {checkpoint.completedStep}/8 completed &middot; Last updated {new Date(checkpoint.updatedAt).toLocaleString()}
                </p>
              </div>
            )}
            {(stepMetrics.length > 0 || metrics) && (
              <StepMetricsTable stepMetrics={stepMetrics} metrics={metrics} />
            )}
            {plan && (
              <div className="border rounded-lg p-3">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide mb-2">
                  Page Plan ({plan.length} pages)
                </h3>
                <div className="space-y-1 max-h-[200px] overflow-y-auto">
                  {plan.map((p: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                      <span className="text-muted-foreground font-mono">{p.template}</span>
                      <span className="flex-1 truncate">{p.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <ProgressLogPanel log={progressLog} running={running} />
          </div>
        )}

        {subTab === "kb_pages" && (
          <div>
            {layerAPages.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-8 text-center">No KB pages generated yet. Run the pipeline first.</p>
            ) : (
              <KBPagesView pages={layerAPages} categories={LAYER_A_CATEGORIES as unknown as KBCategory[]} showSources />
            )}
          </div>
        )}

        {subTab === "projects" && (
          <div className="space-y-4">
            {projectPages.length === 0 && howtoPages.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-8 text-center">No project pages generated yet.</p>
            ) : (
              <>
                <KBPagesView
                  pages={projectPages}
                  categories={["past_documented", "past_undocumented", "ongoing_documented", "ongoing_undocumented", "proposed_project"] as KBCategory[]}
                  showSources
                />
                {howtoPages.length > 0 && (
                  <div className="mt-4">
                    <h3 className="text-xs font-semibold uppercase text-violet-600 tracking-wide mb-2">
                      How-to Implementation Guides ({howtoPages.length})
                    </h3>
                    <KBPagesView pages={howtoPages} categories={["howto_implementation" as KBCategory]} showSources />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {subTab === "tickets" && (
          <PidraxTicketsTab
            ticketPages={ticketPages}
            ticketAudit={ticketAudit}
            convTickets={convTickets}
            custTickets={custTickets}
          />
        )}

        {subTab === "action_items" && (
          <PidraxActionItemsTab
            kbPages={kbPages}
            crossValidation={crossValidation}
          />
        )}

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pidrax Tickets Tab
// ---------------------------------------------------------------------------

function PidraxTicketsTab({ ticketPages, ticketAudit, convTickets, custTickets }: {
  ticketPages: ScoreFormatPageType[];
  ticketAudit: TicketAuditItemType[] | null;
  convTickets: PMTicketType[];
  custTickets: PMTicketType[];
}) {
  const [ticketSubTab, setTicketSubTab] = useState("active");
  const auditIssues = (ticketAudit || []).filter(t => t.overall_assessment !== "ok");

  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b mb-3">
        {[
          { id: "active", label: `Active Tickets (${ticketPages.length})` },
          { id: "audit", label: `Ticket Audit (${ticketAudit?.length || 0})` },
          { id: "new_conv", label: `New from Conversations (${convTickets.length})` },
          { id: "new_cust", label: `New from Customers (${custTickets.length})` },
        ].map(tab => (
          <button key={tab.id} onClick={() => setTicketSubTab(tab.id)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium border-b-2 -mb-px",
              ticketSubTab === tab.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            )}>
            {tab.label}
          </button>
        ))}
      </div>

      {ticketSubTab === "active" && (
        ticketPages.length === 0
          ? <p className="text-sm text-muted-foreground italic py-4 text-center">No active ticket pages.</p>
          : <KBPagesView pages={ticketPages} categories={["ticket" as KBCategory]} showSources />
      )}

      {ticketSubTab === "audit" && (
        !ticketAudit || ticketAudit.length === 0
          ? <p className="text-sm text-muted-foreground italic py-4 text-center">No ticket audit results.</p>
          : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {ticketAudit.length} tickets audited &middot; {auditIssues.length} with issues
              </p>
              {ticketAudit.map((audit, i) => (
                <div key={i} className={cn("border rounded-lg p-3",
                  audit.overall_assessment === "ok" ? "bg-green-50/50 dark:bg-green-950/10" : "bg-yellow-50/50 dark:bg-yellow-950/10"
                )}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-medium">{audit.ticket_key}</span>
                      <span className="text-sm">{audit.title}</span>
                    </div>
                    <span className={cn("text-[10px] px-2 py-0.5 rounded-full font-medium",
                      audit.overall_assessment === "ok" ? "bg-green-100 text-green-700 dark:bg-green-900/30" :
                      audit.overall_assessment === "needs_update" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30" :
                      audit.overall_assessment === "stale" ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30" :
                      "bg-red-100 text-red-700 dark:bg-red-900/30"
                    )}>
                      {audit.overall_assessment}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mb-1">Status: {audit.current_status}</p>
                  {audit.issues.length > 0 && (
                    <div className="space-y-1 mt-2">
                      {audit.issues.map((issue, j) => (
                        <div key={j} className="text-xs border-l-2 border-yellow-400 pl-2 py-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{issue.field}:</span>
                            <span className="text-red-600 line-through">{issue.current_value}</span>
                            <span>&rarr;</span>
                            <span className="text-green-600">{issue.suggested_value}</span>
                            <span className={cn("text-[9px] px-1 py-0.5 rounded font-medium",
                              issue.severity === "S1" ? "bg-red-100 text-red-700" :
                              issue.severity === "S2" ? "bg-orange-100 text-orange-700" :
                              "bg-gray-100 text-gray-600"
                            )}>{issue.severity}</span>
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{issue.evidence}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
      )}

      {ticketSubTab === "new_conv" && (
        <TicketsView tickets={convTickets} label="Conversation Tickets" />
      )}

      {ticketSubTab === "new_cust" && (
        <TicketsView tickets={custTickets} label="Customer Tickets" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pidrax Action Items Tab
// ---------------------------------------------------------------------------
// Pass 2 Tab (KB 2 — Refined)
// ---------------------------------------------------------------------------

function PidraxKB2Section({
  pass2Result, pass2Groups, pass2Metrics, pass2Running, pass2Progress, pass2Log,
  onSetPass2Running, onSetPass2Progress, onSetPass2Log, onSetPass2Result, onSetPass2Groups, onSetPass2Metrics,
  sessionSlug, onRefresh, hasFirstPass, firstPassItemCount,
}: {
  pass2Result: ScoreFormatOutputType | null;
  pass2Groups: any[] | null;
  pass2Metrics: any;
  pass2Running: boolean;
  pass2Progress: ProgressEvent | null;
  pass2Log: ProgressEvent[];
  onSetPass2Running: (v: boolean) => void;
  onSetPass2Progress: (v: ProgressEvent | null) => void;
  onSetPass2Log: (v: ProgressEvent[] | ((prev: ProgressEvent[]) => ProgressEvent[])) => void;
  onSetPass2Result: (v: ScoreFormatOutputType | null) => void;
  onSetPass2Groups: (v: any[] | null) => void;
  onSetPass2Metrics: (v: any) => void;
  sessionSlug: string;
  onRefresh: () => void;
  hasFirstPass: boolean;
  firstPassItemCount: number;
}) {
  const handleRunPass2 = useCallback(async () => {
    if (!sessionSlug || pass2Running) return;
    onSetPass2Running(true);
    onSetPass2Log([]);
    onSetPass2Progress(null);
    try {
      const res = await fetch("/api/new-test/pidrax-pass2-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug }),
      });
      if (!res.ok) {
        onSetPass2Running(false);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) { onSetPass2Running(false); return; }
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
            const evt: ProgressEvent = {
              phase: raw.phase,
              detail: raw.detail || "",
              percent: raw.percent ?? -1,
              done: raw.done,
              success: raw.success,
            };
            onSetPass2Progress(evt);
            if (evt.percent >= 0 || evt.done || evt.phase === "error") {
              onSetPass2Log((prev: ProgressEvent[]) => [...prev, evt]);
            }
            if (evt.done) {
              onSetPass2Running(false);
              if (raw.metrics) onSetPass2Metrics(raw.metrics);
              try {
                const finalRes = await fetch(`/api/new-test/results?type=pidrax_pass2&session=${sessionSlug}`);
                if (finalRes.ok) {
                  const d = await finalRes.json();
                  if (d.data) onSetPass2Result(d.data);
                  if (d.verificationGroups) onSetPass2Groups(d.verificationGroups);
                  if (d.metrics) onSetPass2Metrics(d.metrics);
                }
              } catch { /* use streamed data */ }
            }
          } catch { /* parse error */ }
        }
      }
      onSetPass2Running(false);
    } catch {
      onSetPass2Running(false);
    }
  }, [sessionSlug, pass2Running, onSetPass2Running, onSetPass2Log, onSetPass2Progress, onSetPass2Result, onSetPass2Groups, onSetPass2Metrics]);

  const handleVerifyGroup = useCallback(async (groupId: string, action: "verify" | "reject") => {
    if (!sessionSlug) return;
    try {
      const res = await fetch("/api/new-test/pidrax-pass2-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, group_id: groupId, action }),
      });
      if (res.ok) {
        const data = await res.json();
        onRefresh();
        return data;
      }
    } catch { /* ignore */ }
  }, [sessionSlug, onRefresh]);

  const handleEditGroup = useCallback(async (groupId: string, instruction: string) => {
    if (!sessionSlug) return;
    const previewRes = await fetch("/api/new-test/pidrax-pass2-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionSlug, group_id: groupId, user_instruction: instruction }),
    });
    if (!previewRes.ok) return;
    const { rewrites } = await previewRes.json();
    if (!rewrites?.length) return;

    await fetch("/api/new-test/pidrax-pass2-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionSlug, group_id: groupId, action: "edit", rewrites }),
    });
    onRefresh();
  }, [sessionSlug, onRefresh]);

  const [replicating, setReplicating] = useState(false);
  const [replicateMsg, setReplicateMsg] = useState<string | null>(null);

  const handleReplicate = useCallback(async () => {
    if (!sessionSlug || replicating) return;
    setReplicating(true);
    setReplicateMsg(null);
    try {
      const res = await fetch("/api/new-test/replicate-to-company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, companySlug: "brewandgo" }),
      });
      if (res.ok) {
        const data = await res.json();
        const parts = [];
        if (data.replicated?.inputs) parts.push("inputs");
        if (data.replicated?.pass1) parts.push("pass 1");
        if (data.replicated?.pass2) parts.push("pass 2");
        setReplicateMsg(`Replicated ${parts.join(", ")} to /brewandgo`);
      } else {
        setReplicateMsg("Replication failed");
      }
    } catch {
      setReplicateMsg("Replication failed");
    }
    setReplicating(false);
  }, [sessionSlug, replicating]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Pidrax KB 2 (Refined)</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Second-pass refinement — deduplication, citation repair, verification grouping
            </p>
          </div>
          <div className="flex items-center gap-2">
            {replicateMsg && <span className="text-xs text-muted-foreground">{replicateMsg}</span>}
            <Button size="sm" variant="outline" className="gap-1.5 text-xs" disabled={replicating || !pass2Result} onClick={handleReplicate}>
              {replicating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
              Replicate to Company
            </Button>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <Pass2Tab
          result={pass2Result}
          groups={pass2Groups}
          metrics={pass2Metrics}
          running={pass2Running}
          progress={pass2Progress}
          progressLog={pass2Log}
          hasFirstPass={hasFirstPass}
          firstPassItemCount={firstPassItemCount}
          onRunPass2={handleRunPass2}
          onVerifyGroup={handleVerifyGroup}
          onEditGroup={handleEditGroup}
          sessionSlug={sessionSlug}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pass 2 Tab Content
// ---------------------------------------------------------------------------

function Pass2Tab({ result, groups, metrics, running, progress, progressLog, hasFirstPass, firstPassItemCount, onRunPass2, onVerifyGroup, onEditGroup, sessionSlug }: {
  result: ScoreFormatOutputType | null;
  groups: any[] | null;
  metrics: any;
  running: boolean;
  progress: ProgressEvent | null;
  progressLog: ProgressEvent[];
  hasFirstPass: boolean;
  firstPassItemCount: number;
  onRunPass2: () => void;
  onVerifyGroup: (groupId: string, action: "verify" | "reject") => Promise<any>;
  onEditGroup: (groupId: string, instruction: string) => Promise<void>;
  sessionSlug: string;
}) {
  const [pass2SubTab, setPass2SubTab] = useState<"overview" | "pages" | "verify">("overview");
  const [verifyFilter, setVerifyFilter] = useState<string>("all");
  const [verifyingGroup, setVerifyingGroup] = useState<string | null>(null);

  const allPages = [...(result?.kb_pages || []), ...(result?.howto_pages || [])];
  const allCategories = [...new Set(allPages.map(p => p.category))] as KBCategory[];
  const totalItems = allPages.reduce((s, p) => s + (p.sections || []).reduce((ss, sec) => ss + (sec.bullets?.length || 0), 0), 0);

  const verifiers = groups
    ? [...new Set(groups.map(g => g.verifier).filter(Boolean))]
    : [];

  const filteredGroups = (groups || []).filter(g =>
    verifyFilter === "all" || g.verifier === verifyFilter
  );

  const groupsBySeverity: Record<string, any[]> = {};
  for (const g of filteredGroups) {
    const sev = g.severity || "S4";
    if (!groupsBySeverity[sev]) groupsBySeverity[sev] = [];
    groupsBySeverity[sev].push(g);
  }

  const handleVerify = async (groupId: string, action: "verify" | "reject") => {
    setVerifyingGroup(groupId);
    try {
      await onVerifyGroup(groupId, action);
    } finally {
      setVerifyingGroup(null);
    }
  };

  const PASS2_SUB_TABS = [
    { id: "overview" as const, label: "Overview" },
    { id: "pages" as const, label: `Pages (${allPages.length})` },
    { id: "verify" as const, label: `Verification (${groups?.length || 0})` },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <Button onClick={onRunPass2} disabled={running || !hasFirstPass} size="lg" className="gap-2">
          {running ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Running Second Pass...</>
          ) : (
            <><Play className="h-4 w-4" /> {result ? "Re-run Second Pass" : "Run Second Pass"}</>
          )}
        </Button>
        {!hasFirstPass && (
          <p className="text-sm text-muted-foreground">Run the first pass pipeline before running the second pass.</p>
        )}
      </div>

      <ProgressLogPanel log={progressLog} running={running} />

      {metrics && (
        <div className="border rounded-lg p-3 grid grid-cols-4 gap-3 text-center">
          <div>
            <div className="text-lg font-bold">{metrics.itemsBefore}</div>
            <div className="text-[10px] text-muted-foreground">Items Before</div>
          </div>
          <div>
            <div className="text-lg font-bold text-primary">{metrics.itemsAfter}</div>
            <div className="text-[10px] text-muted-foreground">Items After</div>
          </div>
          <div>
            <div className="text-lg font-bold text-orange-600">{metrics.mergedCount}</div>
            <div className="text-[10px] text-muted-foreground">Merged/Removed</div>
          </div>
          <div>
            <div className="text-lg font-bold text-green-600">{metrics.citationsRepaired}</div>
            <div className="text-[10px] text-muted-foreground">Citations Fixed</div>
          </div>
          <div>
            <div className="text-lg font-bold text-indigo-600">{metrics.verificationGroupCount}</div>
            <div className="text-[10px] text-muted-foreground">Verification Groups</div>
          </div>
          <div>
            <div className="text-lg font-bold">{(metrics.durationMs / 1000).toFixed(1)}s</div>
            <div className="text-[10px] text-muted-foreground">Duration</div>
          </div>
          <div>
            <div className="text-lg font-bold">${metrics.estimatedCostUsd?.toFixed(3)}</div>
            <div className="text-[10px] text-muted-foreground">Cost</div>
          </div>
          <div>
            <div className="text-lg font-bold">{metrics.llmCalls}</div>
            <div className="text-[10px] text-muted-foreground">LLM Calls</div>
          </div>
        </div>
      )}

      {result && (
        <>
          <div className="flex gap-1 border-b">
            {PASS2_SUB_TABS.map(tab => (
              <button key={tab.id} onClick={() => setPass2SubTab(tab.id)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium border-b-2 -mb-px",
                  pass2SubTab === tab.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                )}>
                {tab.label}
              </button>
            ))}
          </div>

          {pass2SubTab === "overview" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Second pass refined {firstPassItemCount} items down to {totalItems} items across {allPages.length} pages.
                {groups && groups.length > 0 && ` ${groups.length} verification groups created for cascading updates.`}
              </p>
              {groups && groups.length > 0 && (
                <div className="border rounded-lg p-3">
                  <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Grouped verification items</h4>
                  <div className="flex gap-3 text-xs">
                    {["S1", "S2", "S3", "S4"].map(sev => {
                      const count = groups.filter(g => g.severity === sev).length;
                      return count > 0 ? (
                        <span key={sev} className={cn("px-2 py-1 rounded font-medium",
                          sev === "S1" ? "bg-red-100 text-red-700" :
                          sev === "S2" ? "bg-orange-100 text-orange-700" :
                          sev === "S3" ? "bg-yellow-100 text-yellow-700" :
                          "bg-gray-100 text-gray-600"
                        )}>{sev}: {count} groups</span>
                      ) : null;
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {pass2SubTab === "pages" && (
            <KBPagesView pages={allPages} categories={allCategories} showSources />
          )}

          {pass2SubTab === "verify" && (
            <Pass2VerificationPanel
              groups={groups || []}
              allPages={allPages}
              verifiers={verifiers}
              verifyFilter={verifyFilter}
              onFilterChange={setVerifyFilter}
              groupsBySeverity={groupsBySeverity}
              verifyingGroup={verifyingGroup}
              onVerify={handleVerify}
              onEdit={onEditGroup}
              sessionSlug={sessionSlug}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pass 2 Verification Panel
// ---------------------------------------------------------------------------

function Pass2VerificationPanel({ groups, allPages, verifiers, verifyFilter, onFilterChange, groupsBySeverity, verifyingGroup, onVerify, onEdit, sessionSlug }: {
  groups: any[];
  allPages: ScoreFormatPageType[];
  verifiers: string[];
  verifyFilter: string;
  onFilterChange: (v: string) => void;
  groupsBySeverity: Record<string, any[]>;
  verifyingGroup: string | null;
  onVerify: (groupId: string, action: "verify" | "reject") => void;
  onEdit: (groupId: string, instruction: string) => Promise<void>;
  sessionSlug: string;
}) {
  const [expandedSev, setExpandedSev] = useState<Set<string>>(new Set(["S1", "S2"]));
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editInstruction, setEditInstruction] = useState("");
  const [editPreviews, setEditPreviews] = useState<{ item_id: string; page_id: string; page_title: string; section: string; old_text: string; new_text: string }[] | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  const selectedGroup = groups.find(g => g.group_id === selectedGroupId);

  const pagesForGroup = (groupId: string) => {
    const group = groups.find(g => g.group_id === groupId);
    if (!group) return [];
    return allPages.filter(p => group.page_ids.includes(p.page_id)).map(p => {
      const matchingItems = p.sections.flatMap(s =>
        s.bullets.filter(b => b.group_id === groupId).map(b => ({ item: b, section: s.section_name }))
      );
      return { page: p, items: matchingItems };
    }).filter(x => x.items.length > 0);
  };

  const handleEditPreview = async (groupId: string) => {
    if (!editInstruction.trim()) return;
    setEditLoading(true);
    try {
      const res = await fetch("/api/new-test/pidrax-pass2-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionSlug, group_id: groupId, user_instruction: editInstruction }),
      });
      if (res.ok) {
        const data = await res.json();
        setEditPreviews(data.rewrites || []);
      }
    } catch { /* ignore */ }
    setEditLoading(false);
  };

  const handleEditConfirm = async (groupId: string) => {
    if (!editPreviews) return;
    setEditLoading(true);
    try {
      await onEdit(groupId, editInstruction);
    } finally {
      setEditLoading(false);
      setEditingGroupId(null);
      setEditInstruction("");
      setEditPreviews(null);
    }
  };

  const itemTypeBadge: Record<string, { label: string; cls: string }> = {
    fact: { label: "Fact", cls: "bg-blue-100 text-blue-700" },
    gap: { label: "Gap", cls: "bg-amber-100 text-amber-700" },
    conflict: { label: "Conflict", cls: "bg-red-100 text-red-700" },
    decision: { label: "Decision", cls: "bg-purple-100 text-purple-700" },
    ticket: { label: "Ticket", cls: "bg-cyan-100 text-cyan-700" },
    owner: { label: "Owner", cls: "bg-emerald-100 text-emerald-700" },
    dependency: { label: "Dependency", cls: "bg-orange-100 text-orange-700" },
    risk: { label: "Risk", cls: "bg-rose-100 text-rose-700" },
    step: { label: "Step", cls: "bg-teal-100 text-teal-700" },
    metric: { label: "Metric", cls: "bg-violet-100 text-violet-700" },
  };

  const sevLabels: Record<string, { label: string; color: string }> = {
    S1: { label: "S1 — Urgent", color: "bg-red-100 text-red-800 border-red-200" },
    S2: { label: "S2 — This Week", color: "bg-orange-100 text-orange-800 border-orange-200" },
    S3: { label: "S3 — When Possible", color: "bg-yellow-100 text-yellow-800 border-yellow-200" },
    S4: { label: "S4 — Trivial", color: "bg-gray-100 text-gray-700 border-gray-200" },
  };

  return (
    <div className="flex gap-0 items-start">
      <div className={cn("min-w-0 space-y-3", selectedGroup ? "flex-1" : "w-full")}>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filter by verifier:</span>
          <select
            value={verifyFilter}
            onChange={e => onFilterChange(e.target.value)}
            className="text-xs border rounded px-2 py-1 bg-background"
          >
            <option value="all">All ({groups.length})</option>
            {verifiers.map(v => (
              <option key={v} value={v}>@{v} ({groups.filter(g => g.verifier === v).length})</option>
            ))}
          </select>
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground italic py-4 text-center">No verification groups. Run the second pass first.</p>
        ) : (
          <div className="space-y-2">
            {["S1", "S2", "S3", "S4"].map(sev => {
              const sevGroups = groupsBySeverity[sev] || [];
              if (sevGroups.length === 0) return null;
              const isExpanded = expandedSev.has(sev);
              const info = sevLabels[sev] || sevLabels.S4;

              return (
                <div key={sev} className={cn("border rounded-lg", info.color)}>
                  <button
                    onClick={() => setExpandedSev(prev => {
                      const next = new Set(prev);
                      next.has(sev) ? next.delete(sev) : next.add(sev);
                      return next;
                    })}
                    className="w-full px-3 py-2 flex items-center justify-between text-left"
                  >
                    <div className="flex items-center gap-2">
                      {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      <span className="text-xs font-semibold">{info.label}</span>
                    </div>
                    <span className="text-xs font-medium">{sevGroups.length} groups</span>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-2 space-y-1.5">
                      {sevGroups.map(g => {
                        const badge = itemTypeBadge[g.item_type] || { label: g.item_type || "fact", cls: "bg-gray-100 text-gray-600" };
                        const isEditing = editingGroupId === g.group_id;
                        return (
                          <div
                            key={g.group_id}
                            onClick={() => {
                              if (!isEditing) setSelectedGroupId(selectedGroupId === g.group_id ? null : g.group_id);
                            }}
                            className={cn(
                              "border rounded bg-card p-2 cursor-pointer hover:bg-accent/30 transition-colors",
                              selectedGroupId === g.group_id && "ring-1 ring-primary",
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 mb-1">
                                  <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-medium", badge.cls)}>
                                    {badge.label}
                                  </span>
                                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium">
                                    {g.instance_count} pages
                                  </span>
                                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                                    @{g.verifier}
                                  </span>
                                </div>
                                <p className="text-xs">{g.canonical_text}</p>
                                {g.reason && (
                                  <p className="text-[10px] text-muted-foreground mt-1 italic border-l-2 border-muted pl-2">
                                    {g.reason}
                                  </p>
                                )}
                              </div>
                            </div>

                            {selectedGroupId === g.group_id && !isEditing && (
                              <div className="mt-2 pt-2 border-t flex gap-1.5" onClick={e => e.stopPropagation()}>
                                <Button
                                  size="sm"
                                  variant="default"
                                  className="h-6 text-[10px] gap-1"
                                  disabled={verifyingGroup === g.group_id}
                                  onClick={() => onVerify(g.group_id, "verify")}
                                >
                                  {verifyingGroup === g.group_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                  Verify All ({g.instance_count})
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-[10px] gap-1"
                                  onClick={() => { setEditingGroupId(g.group_id); setEditInstruction(""); setEditPreviews(null); }}
                                >
                                  <Pencil className="h-3 w-3" /> Edit
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-[10px] gap-1 text-red-600"
                                  disabled={verifyingGroup === g.group_id}
                                  onClick={() => onVerify(g.group_id, "reject")}
                                >
                                  Reject
                                </Button>
                              </div>
                            )}

                            {isEditing && (
                              <div className="mt-2 pt-2 border-t space-y-2" onClick={e => e.stopPropagation()}>
                                {!editPreviews ? (
                                  <>
                                    <p className="text-[10px] text-muted-foreground">What should be changed? Describe the correction:</p>
                                    <textarea
                                      value={editInstruction}
                                      onChange={e => setEditInstruction(e.target.value)}
                                      placeholder="e.g., It's actually PostgreSQL, not MySQL"
                                      className="w-full text-xs border rounded px-2 py-1.5 bg-background resize-none min-h-[48px] focus:outline-none focus:ring-1 focus:ring-ring"
                                      onKeyDown={e => { if (e.key === "Enter" && e.ctrlKey) handleEditPreview(g.group_id); }}
                                    />
                                    <div className="flex gap-1.5">
                                      <Button size="sm" className="h-6 text-[10px] gap-1" disabled={editLoading || !editInstruction.trim()} onClick={() => handleEditPreview(g.group_id)}>
                                        {editLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                                        Preview Changes
                                      </Button>
                                      <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => { setEditingGroupId(null); setEditInstruction(""); }}>
                                        Cancel
                                      </Button>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <p className="text-[10px] font-medium">Proposed changes across {editPreviews.length} item(s):</p>
                                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                      {editPreviews.map((rw, i) => (
                                        <div key={i} className="text-[10px] border rounded p-1.5 bg-muted/30">
                                          <p className="font-medium text-muted-foreground">{rw.page_title} / {rw.section}</p>
                                          <p className="line-through text-red-600/70 mt-0.5">{rw.old_text}</p>
                                          <p className="text-green-700 mt-0.5">{rw.new_text}</p>
                                        </div>
                                      ))}
                                    </div>
                                    <div className="flex gap-1.5">
                                      <Button size="sm" className="h-6 text-[10px] gap-1" disabled={editLoading} onClick={() => handleEditConfirm(g.group_id)}>
                                        {editLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                        Apply Changes
                                      </Button>
                                      <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => { setEditPreviews(null); }}>
                                        Back
                                      </Button>
                                      <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => { setEditingGroupId(null); setEditInstruction(""); setEditPreviews(null); }}>
                                        Cancel
                                      </Button>
                                    </div>
                                  </>
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
        )}
      </div>

      {selectedGroup && (
        <div className="w-[400px] shrink-0 ml-4 sticky top-0 space-y-3">
          <div className="border rounded-lg bg-card shadow-sm p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Group Detail</h4>
              <button onClick={() => setSelectedGroupId(null)} className="text-muted-foreground hover:text-foreground rounded p-0.5 hover:bg-muted">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {selectedGroup.item_type && (
              <div className="flex items-center gap-1.5 mb-2">
                <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-medium", (itemTypeBadge[selectedGroup.item_type] || { cls: "bg-gray-100 text-gray-600" }).cls)}>
                  {(itemTypeBadge[selectedGroup.item_type] || { label: selectedGroup.item_type }).label}
                </span>
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
                  @{selectedGroup.verifier}
                </span>
              </div>
            )}
            <p className="text-xs mb-2 bg-muted/50 rounded p-2">{selectedGroup.canonical_text}</p>
            {selectedGroup.reason && (
              <p className="text-[10px] text-muted-foreground mb-3 italic border-l-2 border-muted pl-2">
                {selectedGroup.reason}
              </p>
            )}
            <h5 className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">
              Appears on {selectedGroup.page_ids.length} pages
            </h5>
            <div className="space-y-2">
              {pagesForGroup(selectedGroup.group_id).map(({ page, items }) => (
                <div key={page.page_id} className="border rounded p-2">
                  <p className="text-[10px] font-medium mb-1">{page.title}</p>
                  {items.map(({ item, section }, i) => (
                    <div key={i} className="text-[10px] pl-2 border-l-2 border-muted mb-1">
                      <span className="text-muted-foreground">{section}:</span>
                      <span className="ml-1">{item.item_text}</span>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className={cn("px-1 py-0.5 rounded text-[8px] font-medium",
                          item.verification?.status === "verified_human" ? "bg-green-100 text-green-700" :
                          item.verification?.status === "needs_verification" ? "bg-yellow-100 text-yellow-700" :
                          "bg-gray-100 text-gray-600"
                        )}>
                          {item.verification?.status?.replace(/_/g, " ")}
                        </span>
                        {item.source_refs?.length > 0 && (
                          <span className="text-[8px] text-muted-foreground">{item.source_refs.length} source(s)</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PidraxActionItemsTab({ kbPages, crossValidation }: {
  kbPages: ScoreFormatPageType[];
  crossValidation: any;
}) {
  const [actionSubTab, setActionSubTab] = useState("outdated");

  const outdated: { item: AtomicItemType; pageName: string; sectionName: string }[] = [];
  const conflicts: { item: AtomicItemType; pageName: string; sectionName: string }[] = [];
  const gaps: { item: AtomicItemType; pageName: string; sectionName: string }[] = [];
  const verifyS1: { item: AtomicItemType; pageName: string; sectionName: string }[] = [];
  const verifyS2: { item: AtomicItemType; pageName: string; sectionName: string }[] = [];
  const verifyS3: { item: AtomicItemType; pageName: string; sectionName: string }[] = [];
  const verifyS4: { item: AtomicItemType; pageName: string; sectionName: string }[] = [];

  for (const page of kbPages) {
    for (const section of page.sections) {
      for (const bullet of section.bullets) {
        const entry = { item: bullet, pageName: page.title, sectionName: section.section_name };
        if (bullet.item_type === "outdated") outdated.push(entry);
        if (bullet.item_type === "conflict") conflicts.push(entry);
        if (bullet.item_type === "gap") gaps.push(entry);
        if (bullet.action_routing?.action === "verify_task") {
          if (bullet.action_routing.severity === "S1") verifyS1.push(entry);
          else if (bullet.action_routing.severity === "S2") verifyS2.push(entry);
          else if (bullet.action_routing.severity === "S3") verifyS3.push(entry);
          else verifyS4.push(entry);
        }
      }
    }
  }

  const verifyTotal = verifyS1.length + verifyS2.length + verifyS3.length + verifyS4.length;

  return (
    <div>
      <div className="flex gap-1 border-b mb-3">
        {[
          { id: "outdated", label: `Outdated (${outdated.length})` },
          { id: "conflicts", label: `Conflicts (${conflicts.length})` },
          { id: "gaps", label: `Gaps (${gaps.length})` },
          { id: "verify", label: `Verification (${verifyTotal})` },
          ...(crossValidation ? [{ id: "quality", label: "Quality Check" }] : []),
        ].map(tab => (
          <button key={tab.id} onClick={() => setActionSubTab(tab.id)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium border-b-2 -mb-px",
              actionSubTab === tab.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            )}>
            {tab.label}
          </button>
        ))}
      </div>

      {actionSubTab === "outdated" && <ActionItemList items={outdated} emptyText="No outdated items found." />}
      {actionSubTab === "conflicts" && <ActionItemList items={conflicts} emptyText="No conflicts found." />}
      {actionSubTab === "gaps" && <ActionItemList items={gaps} emptyText="No knowledge gaps found." />}
      {actionSubTab === "verify" && (
        <div className="space-y-3">
          {verifyTotal === 0 ? (
            <p className="text-sm text-muted-foreground italic py-4 text-center">No items requiring verification.</p>
          ) : (
            <>
              {verifyS1.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-1">
                    S1 — Urgent ({verifyS1.length})
                  </h4>
                  <ActionItemList items={verifyS1} emptyText="" />
                </div>
              )}
              {verifyS2.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-orange-600 uppercase tracking-wide mb-1">
                    S2 — Important ({verifyS2.length})
                  </h4>
                  <ActionItemList items={verifyS2} emptyText="" />
                </div>
              )}
              {verifyS3.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-yellow-600 uppercase tracking-wide mb-1">
                    S3 — Nice to verify ({verifyS3.length})
                  </h4>
                  <ActionItemList items={verifyS3} emptyText="" />
                </div>
              )}
              {verifyS4.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                    S4 — Low priority ({verifyS4.length})
                  </h4>
                  <ActionItemList items={verifyS4} emptyText="" />
                </div>
              )}
            </>
          )}
        </div>
      )}
      {actionSubTab === "quality" && crossValidation && (
        <div className="space-y-3">
          {crossValidation.duplicate_content?.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-1">
                Duplicate Content ({crossValidation.duplicate_content.length})
              </h4>
              {crossValidation.duplicate_content.map((d: any, i: number) => (
                <div key={i} className="border rounded-lg p-2 text-xs mb-1">
                  <span className="font-medium">{d.page_a}</span> &harr; <span className="font-medium">{d.page_b}</span>
                  <span className="text-muted-foreground ml-2">{d.overlapping_topic}</span>
                </div>
              ))}
            </div>
          )}
          {crossValidation.category_errors?.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-orange-600 uppercase tracking-wide mb-1">
                Category Errors ({crossValidation.category_errors.length})
              </h4>
              {crossValidation.category_errors.map((e: any, i: number) => (
                <div key={i} className="border rounded-lg p-2 text-xs mb-1">
                  <span className="font-medium">{e.page_id}</span>: {e.current_category} &rarr; {e.suggested_category}
                  <span className="text-muted-foreground ml-2">{e.reason}</span>
                </div>
              ))}
            </div>
          )}
          {crossValidation.missing_cross_refs?.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-yellow-600 uppercase tracking-wide mb-1">
                Missing Cross-References ({crossValidation.missing_cross_refs.length})
              </h4>
              {crossValidation.missing_cross_refs.map((r: any, i: number) => (
                <div key={i} className="border rounded-lg p-2 text-xs mb-1">
                  <span className="font-medium">{r.from_page}</span> should link to <span className="font-medium">{r.should_reference}</span>
                  <span className="text-muted-foreground ml-2">{r.reason}</span>
                </div>
              ))}
            </div>
          )}
          {!crossValidation.duplicate_content?.length && !crossValidation.category_errors?.length && !crossValidation.missing_cross_refs?.length && (
            <p className="text-sm text-green-600 py-4 text-center">No quality issues found!</p>
          )}
        </div>
      )}
    </div>
  );
}

function ActionItemList({ items, emptyText }: {
  items: { item: AtomicItemType; pageName: string; sectionName: string }[];
  emptyText: string;
}) {
  if (items.length === 0 && emptyText) {
    return <p className="text-sm text-muted-foreground italic py-4 text-center">{emptyText}</p>;
  }
  return (
    <div className="space-y-1">
      {items.map((entry, i) => (
        <div key={i} className="border rounded-lg p-2 bg-card">
          <div className="flex items-center gap-1 mb-0.5 text-[10px] text-muted-foreground">
            <span>{entry.pageName}</span>
            <ChevronRight className="h-2.5 w-2.5" />
            <span>{entry.sectionName}</span>
            {entry.item.verification?.verifier && (
              <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30">
                @{entry.item.verification.verifier}
              </span>
            )}
          </div>
          <AtomicItemRow item={entry.item} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step Metrics Table
// ---------------------------------------------------------------------------

const STEP_NAMES = ["Parse & Embed", "Summarize", "Global Triage", "Page Plan", "Generate Pages", "Ticket Audit", "Extract Tickets", "Proposed Projects", "Cross-validation"];

function StepMetricsTable({ stepMetrics, metrics }: { stepMetrics: any[]; metrics: any }) {
  if (stepMetrics.length === 0) return null;

  const fmtDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  };
  const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-muted/50 border-b">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide flex items-center gap-2">
          <Clock className="h-3.5 w-3.5" /> Pipeline Metrics
          {metrics && (
            <span className="ml-auto text-[11px] font-normal normal-case text-foreground">
              Total: {fmtDuration(metrics.totalDurationMs)} &middot; ${metrics.totalEstimatedCostUsd?.toFixed(2)} &middot; {fmtTokens(metrics.totalInputTokens)} in / {fmtTokens(metrics.totalOutputTokens)} out
            </span>
          )}
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-3 py-1.5 font-medium">Step</th>
              <th className="px-3 py-1.5 font-medium">Name</th>
              <th className="px-3 py-1.5 font-medium text-right">Duration</th>
              <th className="px-3 py-1.5 font-medium text-right">LLM Calls</th>
              <th className="px-3 py-1.5 font-medium text-right">Input Tokens</th>
              <th className="px-3 py-1.5 font-medium text-right">Output Tokens</th>
              <th className="px-3 py-1.5 font-medium text-right">Cost</th>
              <th className="px-3 py-1.5 font-medium text-right">Items</th>
            </tr>
          </thead>
          <tbody>
            {stepMetrics.map((m: any, i: number) => (
              <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                <td className="px-3 py-1.5 font-mono text-muted-foreground">{m.step}</td>
                <td className="px-3 py-1.5">{m.name || STEP_NAMES[m.step] || `Step ${m.step}`}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmtDuration(m.durationMs)}</td>
                <td className="px-3 py-1.5 text-right font-mono">{m.llmCalls}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmtTokens(m.inputTokens)}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmtTokens(m.outputTokens)}</td>
                <td className="px-3 py-1.5 text-right font-mono text-amber-600">${m.estimatedCostUsd?.toFixed(3)}</td>
                <td className="px-3 py-1.5 text-right font-mono">{m.itemsProcessed ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

function InputAndGroundTruthSection({ inputs, groundTruth, running, onRunPidrax, loading, progress, progressLog, onInputChange, onSave, saveStatus, onGenerateGTOnly }: {
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
  onGenerateGTOnly: () => void;
}) {
  const hasData = Object.values(inputs).some(v => v.trim()) || groundTruth !== null;
  const hasInputs = Object.values(inputs).some(v => v.trim());
  const [selectedGTTab, setSelectedGTTab] = useState("kb_basic");

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

              {/* All tabs use ResultTabContent */}
              {RESULT_TABS.map(tab => (
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
          <Button variant="outline" onClick={onGenerateGTOnly}
            disabled={running || !hasInputs}
            size="lg" className="gap-2">
            <Sparkles className="h-4 w-4" /> Generate GT (7 phases)
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
          Generate GT runs 7 phases from input. Pidrax processes inputs blindly and compares.
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

function sortSectionsEmptyLast(sections: ScoreFormatPageType["sections"]) {
  const populated = sections.filter(s => s.bullets.length > 0);
  const empty = sections.filter(s => s.bullets.length === 0);
  return [...populated, ...empty];
}

function PageDetailView({ page }: { page: ScoreFormatPageType }) {
  const totalItems = page.sections.reduce((s, sec) => s + sec.bullets.length, 0);
  const sortedSections = sortSectionsEmptyLast(page.sections);
  return (
    <div>
      <div className="mb-3">
        <h3 className="font-semibold text-sm">{page.title}</h3>
        <p className="text-[10px] text-muted-foreground">
          {KB_CATEGORY_LABELS[page.category as KBCategory] || page.category} &middot; {totalItems} items &middot; {page.sections.length} sections
        </p>
      </div>
      <div className="space-y-3">
        {sortedSections.map((section, si) => (
          <div key={si}>
            <h4 className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">{section.section_name}</h4>
            <div className="space-y-0.5">
              {section.bullets.map((item, ii) => <AtomicItemRow key={item.item_id || ii} item={item} />)}
              {section.bullets.length === 0 && <p className="text-[10px] text-muted-foreground/50 italic">No data</p>}
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

function CompareSection({ generated, groundTruth, loading, onRefresh, running }: {
  generated: ScoreFormatOutputType | null;
  groundTruth: ScoreFormatOutputType | null;
  loading: boolean;
  onRefresh: () => void;
  running?: boolean;
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
        <Tabs defaultValue="kb_basic" className="h-full flex flex-col">
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
  const basicCats = new Set(KB_BASIC_CATEGORIES as readonly string[]);
  const projCats = new Set([...KB_PROJECT_CATEGORIES as readonly string[]]);
  switch (tabId) {
    case "kb_basic": {
      const basicPages = (data.kb_pages || []).filter(p => basicCats.has(p.category) || p.category === "processes");
      return <KBPagesView pages={basicPages} categories={[...KB_BASIC_CATEGORIES, "processes" as KBCategory]} />;
    }
    case "kb_projects": {
      const projPages = (data.kb_pages || []).filter(p => projCats.has(p.category));
      return <KBPagesView pages={projPages} categories={KB_PROJECT_CATEGORIES as unknown as KBCategory[]} />;
    }
    case "gaps": return <FilteredItemsView pages={data.kb_pages || []} itemType="gap" label="Gaps" />;
    case "conflicts": return <FilteredItemsView pages={data.kb_pages || []} itemType="conflict" label="Conflicts" />;
    case "outdated": return <FilteredItemsView pages={data.kb_pages || []} itemType="outdated" label="Outdated" />;
    case "tickets": return <TicketsGroupedView data={data} />;
    case "new_projects": return <NewProjectsWithHowToView data={data} />;
    default: return null;
  }
}

function getResultTabCount(data: ScoreFormatOutputType | null, tabId: string): number {
  if (!data) return 0;
  const basicCats = new Set([...KB_BASIC_CATEGORIES as readonly string[], "processes"]);
  const projCats = new Set(KB_PROJECT_CATEGORIES as readonly string[]);
  switch (tabId) {
    case "kb_basic": return (data.kb_pages || []).filter(p => basicCats.has(p.category)).length;
    case "kb_projects": return (data.kb_pages || []).filter(p => projCats.has(p.category)).length;
    case "gaps": return countItemsByType(data.kb_pages || [], "gap");
    case "conflicts": return countItemsByType(data.kb_pages || [], "conflict");
    case "outdated": return countItemsByType(data.kb_pages || [], "outdated");
    case "tickets": return (data.conversation_tickets?.length || 0) + (data.customer_tickets?.length || 0);
    case "new_projects": return (data.kb_pages?.filter(p => p.category === "new_projects").length || 0) + (data.howto_pages?.length || 0);
    default: return 0;
  }
}

function countItemsByType(pages: ScoreFormatPageType[], type: string): number {
  let count = 0;
  for (const page of pages) for (const section of page.sections) count += section.bullets.filter(b => b.item_type === type).length;
  return count;
}

// ---------------------------------------------------------------------------
// New Projects + How-to View (combined for the howto tab)
// ---------------------------------------------------------------------------

function NewProjectsWithHowToView({ data }: { data: ScoreFormatOutputType }) {
  const newProjectPages = (data.kb_pages || []).filter(p => p.category === "new_projects");
  const howtoPages = data.howto_pages || [];
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [expandedHowto, setExpandedHowto] = useState<Set<string>>(new Set());

  const totalPages = newProjectPages.length + howtoPages.length;
  const orphanHowtos = howtoPages.filter(h => {
    const titleLower = h.title.toLowerCase();
    return !newProjectPages.some(np => titleLower.includes(np.title.toLowerCase().slice(0, 20)));
  });

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted-foreground mb-2">
        {newProjectPages.length} new project pages &middot; {howtoPages.length} how-to docs
      </div>
      {newProjectPages.length === 0 && howtoPages.length === 0 && (
        <p className="text-sm text-muted-foreground italic py-4">No new project or how-to pages yet.</p>
      )}
      {newProjectPages.map(page => {
        const totalItems = (page.sections || []).reduce((s, sec) => s + (sec.bullets || []).length, 0);
        const isExpanded = expandedPage === page.page_id;
        const linkedHowto = howtoPages.find(h => {
          const hLower = h.title.toLowerCase();
          const pLower = page.title.toLowerCase();
          const pWords = pLower.replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 3);
          return pWords.some(w => hLower.includes(w));
        });
        const howtoExpanded = linkedHowto ? expandedHowto.has(linkedHowto.page_id) : false;

        return (
          <div key={page.page_id} className="border rounded-lg bg-card">
            <button onClick={() => setExpandedPage(isExpanded ? null : page.page_id)}
              className="w-full p-2.5 flex items-center justify-between text-left">
              <div className="flex items-center gap-2">
                {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <span className="font-medium text-sm">{page.title}</span>
              </div>
              <div className="flex items-center gap-2">
                {linkedHowto && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/30 font-medium">+ how-to</span>}
                <span className="text-xs text-muted-foreground">{totalItems} items</span>
              </div>
            </button>
            {isExpanded && (
              <div className="border-t">
                <div className="p-2.5 space-y-2">
                  {(page.sections || []).map((section, si) => (
                    <div key={si}>
                      <h4 className="text-[10px] font-semibold text-muted-foreground uppercase mb-0.5">{section.section_name}</h4>
                      <div className="space-y-0.5">
                        {(section.bullets || []).map((item, ii) => <AtomicItemRow key={item.item_id || ii} item={item} />)}
                        {(section.bullets || []).length === 0 && <p className="text-[10px] text-muted-foreground italic">No items</p>}
                      </div>
                    </div>
                  ))}
                </div>
                {linkedHowto && (
                  <div className="border-t">
                    <button
                      onClick={() => setExpandedHowto(prev => {
                        const next = new Set(prev);
                        next.has(linkedHowto.page_id) ? next.delete(linkedHowto.page_id) : next.add(linkedHowto.page_id);
                        return next;
                      })}
                      className="w-full px-2.5 py-2 flex items-center justify-between text-left bg-violet-50 dark:bg-violet-950/20 hover:bg-violet-100 dark:hover:bg-violet-950/30">
                      <div className="flex items-center gap-2">
                        {howtoExpanded ? <ChevronDown className="h-3.5 w-3.5 text-violet-600" /> : <ChevronRight className="h-3.5 w-3.5 text-violet-600" />}
                        <Wrench className="h-3 w-3 text-violet-600" />
                        <span className="font-medium text-xs text-violet-700 dark:text-violet-400">{linkedHowto.title}</span>
                      </div>
                      <span className="text-[10px] text-violet-500">
                        {(linkedHowto.sections || []).reduce((s, sec) => s + (sec.bullets || []).length, 0)} items
                      </span>
                    </button>
                    {howtoExpanded && (
                      <div className="p-2.5 space-y-2 bg-violet-50/50 dark:bg-violet-950/10">
                        {(linkedHowto.sections || []).map((section, si) => (
                          <div key={si}>
                            <h4 className="text-[10px] font-semibold text-violet-600 uppercase mb-0.5">{section.section_name}</h4>
                            <div className="space-y-0.5">
                              {(section.bullets || []).map((item, ii) => <AtomicItemRow key={item.item_id || ii} item={item} />)}
                              {(section.bullets || []).length === 0 && <p className="text-[10px] text-muted-foreground italic">No items</p>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {orphanHowtos.length > 0 && (
        <>
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mt-4 mb-1">
            Standalone How-to Pages
          </div>
          {orphanHowtos.map(page => {
            const totalItems = (page.sections || []).reduce((s, sec) => s + (sec.bullets || []).length, 0);
            const isExp = expandedPage === page.page_id;
            return (
              <div key={page.page_id} className="border rounded-lg bg-violet-50/50 dark:bg-violet-950/10">
                <button onClick={() => setExpandedPage(isExp ? null : page.page_id)}
                  className="w-full p-2.5 flex items-center justify-between text-left">
                  <div className="flex items-center gap-2">
                    {isExp ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <Wrench className="h-3 w-3 text-violet-600" />
                    <span className="font-medium text-sm text-violet-700 dark:text-violet-400">{page.title}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{totalItems} items</span>
                </button>
                {isExp && (
                  <div className="border-t p-2.5 space-y-2">
                    {(page.sections || []).map((section, si) => (
                      <div key={si}>
                        <h4 className="text-[10px] font-semibold text-violet-600 uppercase mb-0.5">{section.section_name}</h4>
                        <div className="space-y-0.5">
                          {(section.bullets || []).map((item, ii) => <AtomicItemRow key={item.item_id || ii} item={item} />)}
                          {(section.bullets || []).length === 0 && <p className="text-[10px] text-muted-foreground italic">No items</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tickets Grouped View (conv + customer, with Jira match sub-groups)
// ---------------------------------------------------------------------------

function TicketsGroupedView({ data }: { data: ScoreFormatOutputType }) {
  const convTickets = data.conversation_tickets || [];
  const custTickets = data.customer_tickets || [];
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const convMatchJira = convTickets.filter(t => (t as any).jira_match?.exists);
  const convNew = convTickets.filter(t => !(t as any).jira_match?.exists);
  const custMatchJira = custTickets.filter(t => (t as any).jira_match?.exists);
  const custNew = custTickets.filter(t => !(t as any).jira_match?.exists);

  const renderGroup = (label: string, tickets: PMTicketType[], color: string) => {
    if (tickets.length === 0) return null;
    return (
      <div className="mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${color}`} />
          {label} ({tickets.length})
        </div>
        <div className="space-y-1">
          {tickets.map(t => {
            const isExp = expandedId === t.ticket_id;
            return (
              <div key={t.ticket_id} className="border rounded-lg bg-card">
                <button onClick={() => setExpandedId(isExp ? null : t.ticket_id)}
                  className="w-full p-2 flex items-center justify-between text-left">
                  <div className="flex items-center gap-2">
                    {isExp ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <span className="text-xs font-medium">{t.title}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{t.type}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{t.priority}</span>
                  </div>
                  {(t as any).jira_match?.exists && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30">{(t as any).jira_match.matching_jira_key}</span>
                  )}
                </button>
                {isExp && (
                  <div className="border-t p-2.5 text-xs space-y-1.5">
                    <p>{t.description}</p>
                    {t.acceptance_criteria?.length > 0 && (
                      <div><span className="font-medium">Acceptance:</span> {t.acceptance_criteria.join("; ")}</div>
                    )}
                    {t.affected_systems?.length > 0 && (
                      <div><span className="font-medium">Systems:</span> {t.affected_systems.join(", ")}</div>
                    )}
                    <div><span className="font-medium">Assigned:</span> {t.assigned_to} — {t.assignment_rationale}</div>
                    <div><span className="font-medium">Complexity:</span> {t.complexity}</div>
                    {(t as any).jira_match && (
                      <div className="text-[10px] text-muted-foreground">
                        <span className="font-medium">Jira match:</span> {(t as any).jira_match.exists ? `YES (${(t as any).jira_match.matching_jira_key}) — ${(t as any).jira_match.reason}` : `NO — ${(t as any).jira_match.reason}`}
                      </div>
                    )}
                    {t.source_refs?.length > 0 && (
                      <div className="text-[10px] text-muted-foreground">
                        <span className="font-medium">Sources:</span> {t.source_refs.map(r => `${r.source_type}: "${r.title}" — "${r.excerpt}"${(r as any).location ? ` (${(r as any).location})` : ""}`).join("; ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted-foreground mb-2">
        {convTickets.length} conversation &middot; {custTickets.length} customer tickets
      </div>
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b pb-1 mb-2">Conversation Tickets</div>
      {renderGroup("Matches Existing Jira", convMatchJira, "bg-blue-500")}
      {renderGroup("New from Conversations", convNew, "bg-green-500")}
      {convTickets.length === 0 && <p className="text-xs text-muted-foreground italic">No conversation tickets.</p>}

      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b pb-1 mb-2 mt-4">Customer Tickets</div>
      {renderGroup("Matches Existing Jira", custMatchJira, "bg-blue-500")}
      {renderGroup("New from Customers", custNew, "bg-orange-500")}
      {custTickets.length === 0 && <p className="text-xs text-muted-foreground italic">No customer tickets.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KB Pages View
// ---------------------------------------------------------------------------

function KBPagesView({ pages, categories, showSources }: {
  pages: ScoreFormatPageType[];
  categories?: KBCategory[];
  showSources?: boolean;
}) {
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const [selectedItem, setSelectedItem] = useState<AtomicItemType | null>(null);

  const byCategory = new Map<string, ScoreFormatPageType[]>();
  for (const page of pages) {
    const list = byCategory.get(page.category) || [];
    list.push(page);
    byCategory.set(page.category, list);
  }
  const totalItems = pages.reduce((s, p) => s + (p.sections || []).reduce((ss, sec) => ss + (sec.bullets || []).length, 0), 0);
  const catsToShow = categories || (Object.keys(KB_CATEGORY_LABELS) as KBCategory[]);

  const handleItemClick = showSources
    ? (item: AtomicItemType) => setSelectedItem(prev => prev?.item_id === item.item_id ? null : item)
    : undefined;

  const categoryList = (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground mb-2">
        {pages.length} pages &middot; {totalItems} items
        {showSources && <span className="ml-2 text-muted-foreground/50">&middot; click an item to see sources</span>}
      </div>
      {catsToShow.map(cat => {
        const label = KB_CATEGORY_LABELS[cat] || cat;
        const catPages = byCategory.get(cat) || [];
        const catItems = catPages.reduce((s, p) => s + (p.sections || []).reduce((ss, sec) => ss + (sec.bullets || []).length, 0), 0);
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
                  <span className="text-[10px] text-muted-foreground/50 italic">0 pages</span>
                )}
              </div>
            </button>
            {!collapsed && catPages.length > 0 && (
              <div className="px-2.5 pb-2 space-y-1">
                {catPages.map(page => (
                  <PageCard key={page.page_id} page={page}
                    expanded={expandedPage === page.page_id}
                    onToggle={() => setExpandedPage(expandedPage === page.page_id ? null : page.page_id)}
                    onItemClick={handleItemClick}
                    selectedItemId={selectedItem?.item_id || undefined}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  if (!showSources) return categoryList;

  return (
    <div className="flex gap-0 items-start">
      <div className={cn("min-w-0 transition-all", selectedItem ? "flex-1" : "w-full")}>
        {categoryList}
      </div>
      {selectedItem && (
        <div className="w-[380px] shrink-0 ml-4 sticky top-0">
          <SourcePanel item={selectedItem} onClose={() => setSelectedItem(null)} />
        </div>
      )}
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
      {severity && severity !== "none" && (
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

// ---------------------------------------------------------------------------
// Source Panel (right side when item is clicked)
// ---------------------------------------------------------------------------

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
        {/* Selected item summary */}
        <div className="rounded bg-muted/50 p-2">
          <div className="flex items-center gap-1.5 mb-1">
            <span className={cn("px-1 py-0.5 rounded text-[9px] font-medium uppercase leading-none", ITEM_TYPE_COLORS[item.item_type] || "bg-gray-100 text-gray-600")}>
              {item.item_type}
            </span>
          </div>
          <p className="text-xs leading-relaxed">{item.item_text}</p>
        </div>

        {/* Source references */}
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
                      <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0", style.color)}>
                        {style.label}
                      </span>
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

        {/* Verification & Confidence metadata */}
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
            {item.action_routing?.severity && item.action_routing.severity !== "none" && (
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
