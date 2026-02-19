"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
    Upload, Sparkles, CheckCircle, BarChart3,
    Play, Loader2, FileText, Bug, Wrench, AlertTriangle, Clock,
    MessageSquare, GitBranch, Users, BookOpen,
    Plus, Trash2, FolderOpen, Save
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const INPUT_TABS = [
    { id: "confluence", label: "Confluence", icon: BookOpen },
    { id: "jira", label: "Jira", icon: FileText },
    { id: "slack", label: "Slack", icon: MessageSquare },
    { id: "github", label: "GitHub", icon: GitBranch },
    { id: "customerFeedback", label: "Customer Feedback", icon: Users },
] as const;

const RESULT_TABS = [
    { id: "gaps", label: "Gaps", icon: FileText },
    { id: "tickets", label: "Features & Bugs", icon: Bug },
    { id: "howto", label: "How-to-Implement", icon: Wrench },
    { id: "conflicts", label: "Conflicts", icon: AlertTriangle },
    { id: "outdated", label: "Outdated Docs", icon: Clock },
] as const;

const MENU_ITEMS = [
    { id: "input", label: "Input Data", icon: Upload },
    { id: "results", label: "Generated Results", icon: Sparkles },
    { id: "groundtruth", label: "Ground Truth", icon: CheckCircle },
    { id: "analysis", label: "Analysis Results", icon: BarChart3 },
] as const;

type MenuSection = typeof MENU_ITEMS[number]["id"];

interface Session {
    name: string;
    slug: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
}

function toSlug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

interface ProgressEvent {
    phase: string;
    detail: string;
    percent: number;
    done?: boolean;
    success?: boolean;
    error?: string;
}

function useLocalStorage<T>(key: string, initial: T): [T, (val: T | ((prev: T) => T)) => void] {
    const [value, setValue] = useState<T>(initial);
    const [hydrated, setHydrated] = useState(false);
    const keyRef = useRef(key);

    useEffect(() => {
        if (!hydrated) {
            try {
                const stored = localStorage.getItem(key);
                if (stored) setValue(JSON.parse(stored));
            } catch {}
            setHydrated(true);
            keyRef.current = key;
            return;
        }

        if (keyRef.current !== key) {
            keyRef.current = key;
            try {
                const stored = localStorage.getItem(key);
                setValue(stored ? JSON.parse(stored) : initial);
            } catch {
                setValue(initial);
            }
        }
    }, [key, hydrated]);

    const set = useCallback((val: T | ((prev: T) => T)) => {
        setValue(prev => {
            const next = typeof val === "function" ? (val as (p: T) => T)(prev) : val;
            try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
            return next;
        });
    }, [key]);
    return [value, set];
}

export default function TestPage() {
    const [activeSection, setActiveSection] = useState<MenuSection>("input");

    // Session management
    const [sessions, setSessions] = useState<Session[]>([]);
    const [currentSession, setCurrentSession] = useLocalStorage<string>("pidrax-current-session", "");
    const [newSessionName, setNewSessionName] = useState("");
    const [loadingSessions, setLoadingSessions] = useState(false);

    const sessionSlug = currentSession || "";
    const inputsKey = sessionSlug ? `pidrax-inputs:${sessionSlug}` : "pidrax-test-inputs";
    const gtKey = sessionSlug ? `pidrax-gt:${sessionSlug}` : "pidrax-test-gt";

    const [inputs, setInputs] = useLocalStorage(inputsKey, {
        confluence: "", jira: "", slack: "", github: "", customerFeedback: "",
    });
    const [groundTruth, setGroundTruth] = useLocalStorage(gtKey, {
        gaps: "", tickets: "", howto: "", conflicts: "", outdated: "",
    });

    const [results, setResults] = useState<Record<string, any[]>>({});
    const [analysis, setAnalysis] = useState<any>(null);
    const [running, setRunning] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);
    const [progress, setProgress] = useState<ProgressEvent | null>(null);
    const [loadingResults, setLoadingResults] = useState(false);

    const abortRef = useRef<AbortController | null>(null);

    const fetchSessions = useCallback(async () => {
        setLoadingSessions(true);
        try {
            const res = await fetch("/api/test/sessions");
            if (res.ok) {
                const data = await res.json();
                setSessions(data.sessions || []);
            }
        } catch {}
        setLoadingSessions(false);
    }, []);

    useEffect(() => { fetchSessions(); }, []);

    const handleSaveSession = useCallback(async () => {
        const name = newSessionName.trim();
        if (!name) return;
        try {
            const res = await fetch("/api/test/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            });
            if (res.ok) {
                const data = await res.json();
                const slug = data.session.slug;

                const currentInputsRaw = localStorage.getItem(inputsKey);
                const currentGtRaw = localStorage.getItem(gtKey);
                const targetInputsKey = `pidrax-inputs:${slug}`;
                const targetGtKey = `pidrax-gt:${slug}`;

                if (currentInputsRaw) {
                    localStorage.setItem(targetInputsKey, currentInputsRaw);
                }
                if (currentGtRaw) {
                    localStorage.setItem(targetGtKey, currentGtRaw);
                }

                setCurrentSession(slug);
                setNewSessionName("");
                await fetchSessions();
                setResults({});
                setAnalysis(null);
            }
        } catch {}
    }, [newSessionName, inputsKey, gtKey]);

    const handleNewBlankSession = useCallback(async () => {
        const name = newSessionName.trim();
        if (!name) return;
        try {
            const res = await fetch("/api/test/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            });
            if (res.ok) {
                const data = await res.json();
                const slug = data.session.slug;

                const blankInputs = { confluence: "", jira: "", slack: "", github: "", customerFeedback: "" };
                const blankGt = { gaps: "", tickets: "", howto: "", conflicts: "", outdated: "" };
                localStorage.setItem(`pidrax-inputs:${slug}`, JSON.stringify(blankInputs));
                localStorage.setItem(`pidrax-gt:${slug}`, JSON.stringify(blankGt));

                setCurrentSession(slug);
                setNewSessionName("");
                await fetchSessions();
                setResults({});
                setAnalysis(null);
            }
        } catch {}
    }, [newSessionName]);

    const handleSwitchSession = useCallback((slug: string) => {
        setCurrentSession(slug);
        setResults({});
        setAnalysis(null);
    }, []);

    const handleDeleteSession = useCallback(async (slug: string) => {
        if (!confirm(`Delete session "${slug}" and all its data?`)) return;
        try {
            await fetch(`/api/test/sessions?slug=${slug}`, { method: "DELETE" });
            if (currentSession === slug) {
                setCurrentSession("");
                setResults({});
                setAnalysis(null);
            }
            await fetchSessions();
        } catch {}
    }, [currentSession]);

    const handleRunPipeline = useCallback(async () => {
        if (!sessionSlug) { alert("Please create or select a session first."); return; }
        const hasData = Object.values(inputs).some(v => v.trim().length > 0);
        if (!hasData) return;

        setRunning(true);
        setProgress({ phase: "starting", detail: "Connecting...", percent: 0 });
        abortRef.current = new AbortController();

        try {
            const res = await fetch("/api/test/ingest", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...inputs, session: sessionSlug }),
                signal: abortRef.current.signal,
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: "Request failed" }));
                setProgress({ phase: "error", detail: err.error || "Request failed", percent: -1 });
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
                        const evt = JSON.parse(line.slice(6)) as ProgressEvent;
                        setProgress(evt);
                        if (evt.done) {
                            setRunning(false);
                            if (evt.success) {
                                await loadAllResults();
                                setActiveSection("results");
                            }
                        }
                    } catch {}
                }
            }
            setRunning(false);
        } catch (err: any) {
            if (err.name !== "AbortError") {
                setProgress({ phase: "error", detail: err.message, percent: -1 });
            }
            setRunning(false);
        }
    }, [inputs, sessionSlug]);

    const loadAllResults = useCallback(async () => {
        if (!sessionSlug) return;
        setLoadingResults(true);
        const types = ["gaps", "tickets", "howto", "conflicts", "outdated"];
        const fetched: Record<string, any[]> = {};
        for (const type of types) {
            try {
                const res = await fetch(`/api/test/results?type=${type}&session=${sessionSlug}`);
                if (res.ok) {
                    const data = await res.json();
                    fetched[type] = data.results || [];
                }
            } catch {}
        }
        setResults(fetched);
        setLoadingResults(false);
    }, [sessionSlug]);

    const handleRunAnalysis = useCallback(async () => {
        if (!sessionSlug) return;
        setAnalyzing(true);
        try {
            const res = await fetch("/api/test/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...groundTruth, session: sessionSlug }),
            });
            if (res.ok) {
                const data = await res.json();
                setAnalysis(data);
                setActiveSection("analysis");
            }
        } catch {}
        setAnalyzing(false);
    }, [groundTruth, sessionSlug]);

    useEffect(() => {
        if (!sessionSlug) return;
        if (activeSection === "results" && Object.keys(results).length === 0) {
            loadAllResults();
        }
        if (activeSection === "analysis" && !analysis) {
            fetch(`/api/test/analysis?session=${sessionSlug}`).then(r => r.ok ? r.json() : null).then(d => {
                if (d && d.categories?.length > 0) setAnalysis(d);
            }).catch(() => {});
        }
    }, [activeSection, sessionSlug]);

    const currentSessionObj = sessions.find(s => s.slug === currentSession);

    return (
        <div className="flex h-screen bg-background">
            {/* Left sidebar */}
            <div className="w-64 border-r bg-muted/30 flex flex-col">
                <div className="p-4 border-b">
                    <h1 className="text-lg font-bold">Pidrax Test</h1>
                    <p className="text-xs text-muted-foreground mt-1">Evaluation Harness</p>
                </div>

                {/* Session selector */}
                <div className="p-3 border-b space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Session</div>
                    {sessions.length > 0 && (
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                            {sessions.map(s => (
                                <div key={s.slug} className={cn(
                                    "flex items-center justify-between px-2 py-1.5 rounded text-sm cursor-pointer group",
                                    s.slug === currentSession
                                        ? "bg-primary/10 text-primary font-medium"
                                        : "text-muted-foreground hover:bg-muted"
                                )}>
                                    <button
                                        onClick={() => handleSwitchSession(s.slug)}
                                        className="flex items-center gap-2 flex-1 text-left truncate"
                                    >
                                        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                                        <span className="truncate">{s.name}</span>
                                    </button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.slug); }}
                                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive transition-opacity"
                                        title="Delete session"
                                    >
                                        <Trash2 className="h-3 w-3" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="space-y-1.5">
                        <Input
                            value={newSessionName}
                            onChange={e => setNewSessionName(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && handleSaveSession()}
                            placeholder="Company name..."
                            className="h-8 text-xs"
                        />
                        <div className="flex gap-1">
                            <Button
                                size="sm"
                                variant="default"
                                onClick={handleSaveSession}
                                disabled={!newSessionName.trim()}
                                className="h-7 text-xs flex-1 gap-1.5"
                            >
                                <Save className="h-3 w-3" />
                                Save
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleNewBlankSession}
                                disabled={!newSessionName.trim()}
                                className="h-7 text-xs flex-1 gap-1.5"
                            >
                                <Plus className="h-3 w-3" />
                                New Blank
                            </Button>
                        </div>
                    </div>
                    {!currentSession && sessions.length > 0 && (
                        <p className="text-xs text-amber-600">Select a session to begin.</p>
                    )}
                    {!currentSession && sessions.length === 0 && !loadingSessions && (
                        <p className="text-xs text-muted-foreground">Type a name and click Save or New Blank.</p>
                    )}
                </div>

                <nav className="flex-1 p-2 space-y-1">
                    {MENU_ITEMS.map(item => {
                        const Icon = item.icon;
                        return (
                            <button
                                key={item.id}
                                onClick={() => setActiveSection(item.id)}
                                disabled={!currentSession}
                                className={cn(
                                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors",
                                    activeSection === item.id
                                        ? "bg-primary text-primary-foreground"
                                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                    !currentSession && "opacity-40 cursor-not-allowed"
                                )}
                            >
                                <Icon className="h-4 w-4" />
                                {item.label}
                            </button>
                        );
                    })}
                </nav>
                {progress && running && (
                    <div className="p-3 border-t">
                        <div className="flex items-center gap-2 text-xs">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            <span className="truncate">{progress.detail}</span>
                        </div>
                        {progress.percent >= 0 && (
                            <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-primary transition-all duration-500"
                                    style={{ width: `${progress.percent}%` }}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Main content */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {!currentSession ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                        <div className="text-center">
                            <FolderOpen className="h-12 w-12 mx-auto mb-4 opacity-30" />
                            <p className="text-lg font-medium">No session selected</p>
                            <p className="text-sm mt-1">Create a new session or select an existing one from the sidebar.</p>
                        </div>
                    </div>
                ) : (
                    <>
                        {activeSection === "input" && (
                            <InputSection
                                inputs={inputs}
                                setInputs={setInputs}
                                running={running}
                                onRun={handleRunPipeline}
                                progress={progress}
                                sessionName={currentSessionObj?.name || currentSession}
                            />
                        )}
                        {activeSection === "results" && (
                            <ResultsSection results={results} loading={loadingResults} onRefresh={loadAllResults} />
                        )}
                        {activeSection === "groundtruth" && (
                            <GroundTruthSection
                                groundTruth={groundTruth}
                                setGroundTruth={setGroundTruth}
                                analyzing={analyzing}
                                onAnalyze={handleRunAnalysis}
                            />
                        )}
                        {activeSection === "analysis" && (
                            <AnalysisSection analysis={analysis} />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/* ===== INPUT SECTION ===== */
function InputSection({ inputs, setInputs, running, onRun, progress, sessionName }: {
    inputs: Record<string, string>;
    setInputs: (val: any) => void;
    running: boolean;
    onRun: () => void;
    progress: ProgressEvent | null;
    sessionName: string;
}) {
    return (
        <div className="flex flex-col h-full">
            <div className="p-4 border-b">
                <h2 className="text-xl font-semibold">Input Data &mdash; {sessionName}</h2>
                <p className="text-sm text-muted-foreground mt-1">
                    Paste your 5 bundle documents below. Each tab accepts one source type.
                </p>
            </div>
            <div className="flex-1 overflow-hidden">
                <Tabs defaultValue="confluence" className="h-full flex flex-col">
                    <div className="px-4 pt-2">
                        <TabsList className="w-full justify-start">
                            {INPUT_TABS.map(tab => {
                                const Icon = tab.icon;
                                return (
                                    <TabsTrigger key={tab.id} value={tab.id} className="gap-2">
                                        <Icon className="h-3.5 w-3.5" />
                                        {tab.label}
                                    </TabsTrigger>
                                );
                            })}
                        </TabsList>
                    </div>
                    {INPUT_TABS.map(tab => (
                        <TabsContent key={tab.id} value={tab.id} className="flex-1 px-4 pb-4 mt-0 overflow-auto">
                            <textarea
                                value={inputs[tab.id] || ""}
                                onChange={e => setInputs((prev: any) => ({ ...prev, [tab.id]: e.target.value }))}
                                placeholder={`Paste your ${tab.label} bundle document here...\n\nThis should contain all ${tab.label} data formatted as a single document with section markers.`}
                                className="w-full h-full min-h-[500px] p-4 rounded-lg border bg-background font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
                            />
                        </TabsContent>
                    ))}
                </Tabs>
            </div>
            <div className="p-4 border-t flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                    {Object.values(inputs).filter(v => v.trim().length > 0).length}/5 bundles provided
                </div>
                <Button onClick={onRun} disabled={running} size="lg" className="gap-2">
                    {running ? (
                        <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Running... {progress?.percent != null && progress.percent >= 0 ? `${progress.percent}%` : ""}
                        </>
                    ) : (
                        <>
                            <Play className="h-4 w-4" />
                            Run Pidrax Pipeline
                        </>
                    )}
                </Button>
            </div>
        </div>
    );
}

/* ===== RESULTS SECTION ===== */
function ResultsSection({ results, loading, onRefresh }: {
    results: Record<string, any[]>;
    loading: boolean;
    onRefresh: () => void;
}) {
    return (
        <div className="flex flex-col h-full">
            <div className="p-4 border-b flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-semibold">Generated Results</h2>
                    <p className="text-sm text-muted-foreground mt-1">What Pidrax produced from your input data.</p>
                </div>
                <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refresh"}
                </Button>
            </div>
            <div className="flex-1 overflow-hidden">
                <Tabs defaultValue="gaps" className="h-full flex flex-col">
                    <div className="px-4 pt-2">
                        <TabsList className="w-full justify-start">
                            {RESULT_TABS.map(tab => {
                                const Icon = tab.icon;
                                const count = results[tab.id]?.length || 0;
                                return (
                                    <TabsTrigger key={tab.id} value={tab.id} className="gap-2">
                                        <Icon className="h-3.5 w-3.5" />
                                        {tab.label}
                                        {count > 0 && (
                                            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">
                                                {count}
                                            </span>
                                        )}
                                    </TabsTrigger>
                                );
                            })}
                        </TabsList>
                    </div>
                    {RESULT_TABS.map(tab => (
                        <TabsContent key={tab.id} value={tab.id} className="flex-1 px-4 pb-4 mt-0 overflow-auto">
                            <ResultsList items={results[tab.id] || []} type={tab.id} />
                        </TabsContent>
                    ))}
                </Tabs>
            </div>
        </div>
    );
}

function ResultsList({ items, type }: { items: any[]; type: string }) {
    if (items.length === 0) {
        return (
            <div className="flex items-center justify-center h-full text-muted-foreground">
                <p>No results yet. Run the pipeline first.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4 py-2">
            {items.map((item, i) => (
                <div key={i} className="border rounded-lg p-4 bg-card">
                    <ResultItem item={item} type={type} index={i} />
                </div>
            ))}
        </div>
    );
}

function ResultItem({ item, type, index }: { item: any; type: string; index: number }) {
    const title = item.projectTitle || item.title || item.ticketTitle || item.conflictTitle || item.documentTitle || `Item ${index + 1}`;
    const [expanded, setExpanded] = useState(false);

    return (
        <div>
            <button onClick={() => setExpanded(!expanded)} className="w-full text-left">
                <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm">{title}</h3>
                    <span className="text-xs text-muted-foreground">{expanded ? "Collapse" : "Expand"}</span>
                </div>
                {item.severity && (
                    <span className={cn(
                        "inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium",
                        item.severity === "critical" || item.severity === "high" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
                        item.severity === "medium" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400" :
                        "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                    )}>
                        {item.severity}
                    </span>
                )}
            </button>
            {expanded && (
                <pre className="mt-3 p-3 bg-muted/50 rounded text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap">
                    {JSON.stringify(item, null, 2)}
                </pre>
            )}
        </div>
    );
}

/* ===== GROUND TRUTH SECTION ===== */
function GroundTruthSection({ groundTruth, setGroundTruth, analyzing, onAnalyze }: {
    groundTruth: Record<string, string>;
    setGroundTruth: (val: any) => void;
    analyzing: boolean;
    onAnalyze: () => void;
}) {
    return (
        <div className="flex flex-col h-full">
            <div className="p-4 border-b">
                <h2 className="text-xl font-semibold">Ground Truth</h2>
                <p className="text-sm text-muted-foreground mt-1">
                    Paste the expected correct answers for comparison.
                </p>
            </div>
            <div className="flex-1 overflow-hidden">
                <Tabs defaultValue="gaps" className="h-full flex flex-col">
                    <div className="px-4 pt-2">
                        <TabsList className="w-full justify-start">
                            {RESULT_TABS.map(tab => {
                                const Icon = tab.icon;
                                return (
                                    <TabsTrigger key={tab.id} value={tab.id} className="gap-2">
                                        <Icon className="h-3.5 w-3.5" />
                                        {tab.label}
                                    </TabsTrigger>
                                );
                            })}
                        </TabsList>
                    </div>
                    {RESULT_TABS.map(tab => (
                        <TabsContent key={tab.id} value={tab.id} className="flex-1 px-4 pb-4 mt-0 overflow-auto">
                            <textarea
                                value={groundTruth[tab.id] || ""}
                                onChange={e => setGroundTruth((prev: any) => ({ ...prev, [tab.id]: e.target.value }))}
                                placeholder={`Paste your ground truth for "${tab.label}" here...\n\nThis should contain the expected correct ${tab.label.toLowerCase()} that Pidrax should have found.`}
                                className="w-full h-full min-h-[500px] p-4 rounded-lg border bg-background font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/20"
                            />
                        </TabsContent>
                    ))}
                </Tabs>
            </div>
            <div className="p-4 border-t flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                    {Object.values(groundTruth).filter(v => v.trim().length > 0).length}/5 ground truth docs provided
                </div>
                <Button onClick={onAnalyze} disabled={analyzing} size="lg" className="gap-2">
                    {analyzing ? (
                        <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Analyzing...
                        </>
                    ) : (
                        <>
                            <BarChart3 className="h-4 w-4" />
                            Run Analysis
                        </>
                    )}
                </Button>
            </div>
        </div>
    );
}

/* ===== ANALYSIS SECTION ===== */
function AnalysisSection({ analysis }: { analysis: any }) {
    if (!analysis || !analysis.categories?.length) {
        return (
            <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center">
                    <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-30" />
                    <p className="text-lg font-medium">No analysis results yet</p>
                    <p className="text-sm mt-1">Run the pipeline and then provide ground truth to see metrics.</p>
                </div>
            </div>
        );
    }

    const cats: any[] = analysis.categories;

    return (
        <div className="flex flex-col h-full overflow-auto">
            <div className="p-4 border-b">
                <h2 className="text-xl font-semibold">Analysis Results</h2>
                <p className="text-sm text-muted-foreground mt-1">
                    How Pidrax performed compared to ground truth.
                    {analysis.analyzedAt && <span className="ml-2">Analyzed: {new Date(analysis.analyzedAt).toLocaleString()}</span>}
                </p>
            </div>

            {/* Overall metrics */}
            <div className="p-4 grid grid-cols-3 gap-4">
                <MetricCard label="Overall Precision" value={analysis.overallPrecision} />
                <MetricCard label="Overall Recall" value={analysis.overallRecall} />
                <MetricCard label="Overall F1 Score" value={analysis.overallF1} />
            </div>

            {/* Per-category table */}
            <div className="px-4 pb-4">
                <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                            <tr>
                                <th className="text-left p-3 font-medium">Category</th>
                                <th className="text-center p-3 font-medium">Generated</th>
                                <th className="text-center p-3 font-medium">Ground Truth</th>
                                <th className="text-center p-3 font-medium text-green-600">TP</th>
                                <th className="text-center p-3 font-medium text-red-600">FP</th>
                                <th className="text-center p-3 font-medium text-orange-600">FN</th>
                                <th className="text-center p-3 font-medium">Precision</th>
                                <th className="text-center p-3 font-medium">Recall</th>
                                <th className="text-center p-3 font-medium">F1</th>
                            </tr>
                        </thead>
                        <tbody>
                            {cats.map((cat: any) => (
                                <tr key={cat.category} className="border-t">
                                    <td className="p-3 font-medium capitalize">{cat.category}</td>
                                    <td className="p-3 text-center">{cat.totalGenerated}</td>
                                    <td className="p-3 text-center">{cat.totalGroundTruth}</td>
                                    <td className="p-3 text-center text-green-600 font-semibold">{cat.truePositives}</td>
                                    <td className="p-3 text-center text-red-600 font-semibold">{cat.falsePositives}</td>
                                    <td className="p-3 text-center text-orange-600 font-semibold">{cat.falseNegatives}</td>
                                    <td className="p-3 text-center">{pct(cat.precision)}</td>
                                    <td className="p-3 text-center">{pct(cat.recall)}</td>
                                    <td className="p-3 text-center font-semibold">{pct(cat.f1Score)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Match details per category */}
            <div className="px-4 pb-8 space-y-4">
                {cats.map((cat: any) => (
                    <MatchDetailsPanel key={cat.category} category={cat} />
                ))}
            </div>
        </div>
    );
}

function MetricCard({ label, value }: { label: string; value: number }) {
    const color = value >= 0.8 ? "text-green-600" : value >= 0.5 ? "text-yellow-600" : "text-red-600";
    return (
        <div className="border rounded-lg p-4 text-center">
            <div className={cn("text-3xl font-bold", color)}>{pct(value)}</div>
            <div className="text-sm text-muted-foreground mt-1">{label}</div>
        </div>
    );
}

function MatchDetailsPanel({ category }: { category: any }) {
    const [expanded, setExpanded] = useState(false);
    const details: any[] = category.matchDetails || [];
    if (details.length === 0) return null;

    return (
        <div className="border rounded-lg">
            <button onClick={() => setExpanded(!expanded)} className="w-full p-3 flex items-center justify-between text-left">
                <span className="font-medium capitalize">{category.category} Match Details</span>
                <span className="text-xs text-muted-foreground">{details.length} items - {expanded ? "Hide" : "Show"}</span>
            </button>
            {expanded && (
                <div className="border-t p-3 space-y-2 max-h-96 overflow-auto">
                    {details.map((d: any, i: number) => (
                        <div key={i} className={cn(
                            "p-2 rounded text-xs",
                            d.classification === "TP" ? "bg-green-50 dark:bg-green-900/20" :
                            d.classification === "FP" ? "bg-red-50 dark:bg-red-900/20" :
                            "bg-orange-50 dark:bg-orange-900/20"
                        )}>
                            <div className="flex items-center justify-between">
                                <span className="font-semibold">{d.classification}</span>
                                <span>Similarity: {(d.similarityScore * 100).toFixed(0)}%</span>
                            </div>
                            <p className="mt-1 text-muted-foreground">{d.matchReason}</p>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function pct(n: number | null | undefined): string {
    if (n == null || isNaN(n)) return "N/A";
    return `${(n * 100).toFixed(1)}%`;
}
