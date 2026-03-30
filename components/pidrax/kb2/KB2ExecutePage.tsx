"use client";

import { useState, useRef, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Play,
  Bot,
  MessageSquare,
  User,
  GitPullRequest,
  Search,
  Code,
  Scale,
  Megaphone,
  Zap,
  Star,
  Download,
  CheckCircle2,
  Store,
  Settings2,
  Terminal,
  Square,
  Circle,
  Loader2,
  FileText,
  FolderKanban,
  TicketCheck,
} from "lucide-react";
import { KB2RightPanel, SourceRef } from "./KB2RightPanel";
import { SplitLayout } from "./SplitLayout";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Agent {
  id: string;
  name: string;
  author: string;
  icon: typeof Bot;
  iconColor: string;
  iconBg: string;
  category: "engineering" | "marketing" | "legal";
  description: string;
  longDescription: string;
  capabilities: string[];
  stars: number;
  installs: string;
  tags: string[];
  configFields: { key: string; label: string; placeholder: string; type: "text" | "textarea" | "select"; options?: string[] }[];
  runCommand: string;
}

interface AgentRun {
  id: string;
  agentId: string;
  agentName: string;
  agentIcon: typeof Bot;
  agentIconColor: string;
  agentIconBg: string;
  status: "running" | "completed" | "failed";
  startedAt: Date;
  endedAt?: Date;
  config: Record<string, string>;
  output: string[];
}

interface HowtoSummary {
  howto_id: string;
  title: string;
  ticket_id?: string;
  project_node_id?: string;
  created_at?: string;
  sections?: { section_name: string; content: string }[];
}

interface TicketSummary {
  ticket_id: string;
  title: string;
  description: string;
  priority: string;
  workflow_state: string;
  source: string;
  status?: string;
  source_refs?: SourceRef[];
}

interface ProjectSummary {
  node_id: string;
  display_name: string;
  type: string;
  attributes?: Record<string, any>;
  source_refs?: SourceRef[];
}

type SidebarTab = "store" | "installed" | "ready" | "runs";

function classifyReadyItemKind(howto: HowtoSummary): "ticket" | "project" | "standalone" {
  if (howto.ticket_id) return "ticket";
  if (howto.project_node_id) return "project";
  return "standalone";
}

function dedupeSourceRefs(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const ref of sourceRefs) {
    const key = `${ref.source_type}::${ref.doc_id}::${ref.title}::${ref.excerpt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agent catalog
// ---------------------------------------------------------------------------

const AGENTS: Agent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    author: "Anthropic",
    icon: Code,
    iconColor: "text-orange-600",
    iconBg: "bg-orange-500/10",
    category: "engineering",
    description: "Autonomous coding agent that reads your KB, plans implementations, writes code, and opens PRs.",
    longDescription:
      "Claude Code integrates deeply with your knowledge base to understand your codebase architecture, coding conventions, and team decisions. It can autonomously plan multi-file changes, write production-quality code, run tests, and open pull requests — all while following your documented standards and asking for human approval on ambiguous decisions.",
    capabilities: [
      "Read and understand KB pages, entity pages, and how-to guides",
      "Plan multi-step implementations from tickets",
      "Write code following your team's documented conventions",
      "Run tests and fix failures autonomously",
      "Open PRs with detailed descriptions linked to KB context",
      "Ask human-in-the-loop questions when uncertain",
    ],
    stars: 4.9,
    installs: "128k",
    tags: ["coding", "PR automation", "refactoring"],
    configFields: [
      { key: "task", label: "Task / Ticket", placeholder: "Describe the task or paste a ticket ID...", type: "textarea" },
      { key: "repo", label: "Repository", placeholder: "e.g. github.com/org/repo", type: "text" },
      { key: "branch", label: "Branch", placeholder: "e.g. feature/rate-limiting", type: "text" },
      { key: "mode", label: "Mode", placeholder: "Select mode", type: "select", options: ["autonomous", "interactive", "plan-only"] },
    ],
    runCommand: "claude --dangerously-skip-permissions -p",
  },
  {
    id: "codex",
    name: "Codex",
    author: "OpenAI",
    icon: Zap,
    iconColor: "text-emerald-600",
    iconBg: "bg-emerald-500/10",
    category: "engineering",
    description: "Cloud-based coding agent that executes tasks in a sandbox, powered by your knowledge base context.",
    longDescription:
      "Codex runs in a secure cloud sandbox and leverages your knowledge base to understand project structure and requirements. It excels at executing well-defined tasks: bug fixes, feature scaffolding, test generation, and dependency upgrades. Each run produces a detailed diff with full traceability back to the KB sources that informed the changes.",
    capabilities: [
      "Execute coding tasks in isolated cloud sandbox",
      "Reference KB sources for architecture decisions",
      "Generate comprehensive test suites",
      "Perform dependency upgrades with impact analysis",
      "Produce detailed diffs with KB source traceability",
      "Parallel execution of independent subtasks",
    ],
    stars: 4.7,
    installs: "95k",
    tags: ["sandbox", "testing", "automation"],
    configFields: [
      { key: "task", label: "Task Description", placeholder: "What should Codex do?", type: "textarea" },
      { key: "repo", label: "Repository", placeholder: "e.g. github.com/org/repo", type: "text" },
      { key: "sandbox", label: "Sandbox", placeholder: "Select sandbox", type: "select", options: ["default", "isolated", "gpu-enabled"] },
    ],
    runCommand: "codex --full-auto",
  },
  {
    id: "content-strategist",
    name: "Content Strategist",
    author: "Pidrax",
    icon: Megaphone,
    iconColor: "text-pink-600",
    iconBg: "bg-pink-500/10",
    category: "marketing",
    description: "Generates marketing content, blog posts, and campaigns grounded in your product knowledge base.",
    longDescription:
      "Content Strategist reads your product KB, customer feedback, and feature documentation to generate on-brand marketing content. It understands your product positioning, target audience, and competitive landscape from the knowledge graph.",
    capabilities: [
      "Generate blog posts from product KB pages",
      "Create launch announcements from ticket/project data",
      "Draft social media campaigns grounded in features",
      "Analyze customer feedback for content opportunities",
      "Maintain brand voice consistency across outputs",
      "Cross-reference claims against verified KB sources",
    ],
    stars: 4.5,
    installs: "31k",
    tags: ["content", "campaigns", "brand"],
    configFields: [
      { key: "content_type", label: "Content Type", placeholder: "Select type", type: "select", options: ["blog post", "launch announcement", "social campaign", "newsletter"] },
      { key: "topic", label: "Topic / Product Area", placeholder: "e.g. Checkout API, Mobile App", type: "text" },
      { key: "audience", label: "Target Audience", placeholder: "e.g. developers, enterprise buyers", type: "text" },
      { key: "tone", label: "Tone", placeholder: "Select tone", type: "select", options: ["professional", "casual", "technical", "friendly"] },
    ],
    runCommand: "pidrax-agent content-strategist --run",
  },
  {
    id: "legal-reviewer",
    name: "Compliance Reviewer",
    author: "Pidrax",
    icon: Scale,
    iconColor: "text-blue-600",
    iconBg: "bg-blue-500/10",
    category: "legal",
    description: "Reviews code changes and documentation against your compliance policies and legal KB pages.",
    longDescription:
      "Compliance Reviewer monitors PRs, documentation changes, and new features against your legal and compliance knowledge base. It flags potential regulatory issues, checks data handling practices against documented policies, and generates compliance reports.",
    capabilities: [
      "Scan PRs for compliance policy violations",
      "Check data handling against documented GDPR/SOC 2 policies",
      "Flag licensing issues in dependency changes",
      "Generate compliance reports for audits",
      "Monitor KB changes for regulatory impact",
      "Cross-reference with legal entity pages",
    ],
    stars: 4.6,
    installs: "18k",
    tags: ["compliance", "GDPR", "audit"],
    configFields: [
      { key: "scope", label: "Review Scope", placeholder: "Select scope", type: "select", options: ["full codebase", "recent PRs", "specific files"] },
      { key: "frameworks", label: "Compliance Frameworks", placeholder: "e.g. GDPR, SOC 2, HIPAA", type: "text" },
      { key: "pr_url", label: "PR URL (optional)", placeholder: "https://github.com/org/repo/pull/123", type: "text" },
    ],
    runCommand: "pidrax-agent compliance-reviewer --scan",
  },
  {
    id: "customer-voice",
    name: "Customer Voice Analyst",
    author: "Pidrax",
    icon: MessageSquare,
    iconColor: "text-violet-600",
    iconBg: "bg-violet-500/10",
    category: "marketing",
    description: "Analyzes customer feedback and support data to surface insights linked to your product KB.",
    longDescription:
      "Customer Voice Analyst continuously processes customer feedback, support tickets, and NPS data, linking insights back to specific features and entities in your knowledge base.",
    capabilities: [
      "Aggregate feedback across support channels",
      "Link customer pain points to KB entities",
      "Track sentiment trends per feature/product area",
      "Auto-generate ticket proposals from feedback patterns",
      "Surface upsell and churn risk signals",
      "Generate customer insight reports",
    ],
    stars: 4.4,
    installs: "12k",
    tags: ["feedback", "NPS", "insights"],
    configFields: [
      { key: "sources", label: "Data Sources", placeholder: "Select sources", type: "select", options: ["all channels", "support tickets", "NPS surveys", "app reviews"] },
      { key: "timeframe", label: "Timeframe", placeholder: "Select timeframe", type: "select", options: ["last 7 days", "last 30 days", "last 90 days", "all time"] },
      { key: "focus", label: "Focus Area (optional)", placeholder: "e.g. mobile app, checkout, onboarding", type: "text" },
    ],
    runCommand: "pidrax-agent customer-voice --analyze",
  },
];

const CATEGORY_LABELS: Record<string, string> = {
  engineering: "Engineering",
  marketing: "Marketing",
  legal: "Legal",
};

const CATEGORY_ORDER = ["engineering", "marketing", "legal"];

// ---------------------------------------------------------------------------
// Simulated terminal output lines per agent
// ---------------------------------------------------------------------------

function getSimulatedOutput(agent: Agent, config: Record<string, string>): string[] {
  const task = config.task || config.topic || config.scope || "default task";
  if (agent.id === "claude-code") {
    return [
      `$ ${agent.runCommand} "${task}"`,
      "",
      "\x1b[36m╭─────────────────────────────────────────╮\x1b[0m",
      "\x1b[36m│\x1b[0m  Claude Code v1.12.0                    \x1b[36m│\x1b[0m",
      "\x1b[36m│\x1b[0m  Mode: " + (config.mode || "autonomous") + "                       \x1b[36m│\x1b[0m",
      "\x1b[36m╰─────────────────────────────────────────╯\x1b[0m",
      "",
      "\x1b[90m[12:04:01]\x1b[0m Reading knowledge base context...",
      "\x1b[90m[12:04:03]\x1b[0m Found 14 relevant KB pages, 8 entity pages",
      "\x1b[90m[12:04:03]\x1b[0m Loading how-to guide for linked ticket...",
      "\x1b[90m[12:04:05]\x1b[0m \x1b[32m✓\x1b[0m KB context loaded (23 sources)",
      "",
      "\x1b[90m[12:04:05]\x1b[0m Planning implementation...",
      "\x1b[90m[12:04:08]\x1b[0m Plan: 3 files to modify, 1 new file",
      "\x1b[90m[12:04:08]\x1b[0m   → src/middleware/rateLimiter.ts (new)",
      "\x1b[90m[12:04:08]\x1b[0m   → src/routes/checkout.ts (modify)",
      "\x1b[90m[12:04:08]\x1b[0m   → src/config/redis.ts (modify)",
      "\x1b[90m[12:04:08]\x1b[0m   → tests/rateLimiter.test.ts (new)",
      "",
      "\x1b[90m[12:04:10]\x1b[0m \x1b[33m?\x1b[0m Should I use token bucket or sliding window?",
      "\x1b[90m[12:04:10]\x1b[0m   KB says: Decision 'Rate Limiting Strategy' → token bucket",
      "\x1b[90m[12:04:10]\x1b[0m   Using token bucket (from KB decision)",
      "",
      "\x1b[90m[12:04:12]\x1b[0m Writing src/middleware/rateLimiter.ts...",
      "\x1b[90m[12:04:15]\x1b[0m Writing tests/rateLimiter.test.ts...",
      "\x1b[90m[12:04:18]\x1b[0m Modifying src/routes/checkout.ts...",
      "\x1b[90m[12:04:20]\x1b[0m Modifying src/config/redis.ts...",
      "",
      "\x1b[90m[12:04:22]\x1b[0m Running tests...",
      "\x1b[90m[12:04:28]\x1b[0m \x1b[32m✓\x1b[0m 12 tests passed, 0 failed",
      "",
      "\x1b[90m[12:04:30]\x1b[0m Opening PR #142...",
      "\x1b[90m[12:04:32]\x1b[0m \x1b[32m✓\x1b[0m PR created: Add token bucket rate limiting to Checkout API",
      "\x1b[90m[12:04:32]\x1b[0m   https://github.com/org/repo/pull/142",
      "",
      "\x1b[32m✓ Done in 31s\x1b[0m — 4 files changed, 142 insertions, 3 deletions",
    ];
  }
  if (agent.id === "codex") {
    return [
      `$ ${agent.runCommand} "${task}"`,
      "",
      "\x1b[32m⚡ Codex\x1b[0m — Spinning up sandbox...",
      "\x1b[90m[sandbox]\x1b[0m Environment: " + (config.sandbox || "default"),
      "\x1b[90m[sandbox]\x1b[0m Cloning repository...",
      "\x1b[90m[sandbox]\x1b[0m \x1b[32m✓\x1b[0m Repository ready",
      "",
      "\x1b[90m[codex]\x1b[0m Analyzing task against KB context...",
      "\x1b[90m[codex]\x1b[0m Found 6 relevant architecture decisions",
      "\x1b[90m[codex]\x1b[0m Executing changes...",
      "",
      "\x1b[90m[codex]\x1b[0m \x1b[32m+\x1b[0m Created tests/integration/api.test.ts",
      "\x1b[90m[codex]\x1b[0m \x1b[33m~\x1b[0m Modified src/api/handlers.ts",
      "\x1b[90m[codex]\x1b[0m Running test suite...",
      "\x1b[90m[codex]\x1b[0m \x1b[32m✓\x1b[0m All checks passed",
      "",
      "\x1b[32m✓ Task completed\x1b[0m — sandbox will auto-destroy in 30m",
    ];
  }
  return [
    `$ ${agent.runCommand}`,
    "",
    `\x1b[36m${agent.name}\x1b[0m starting...`,
    "\x1b[90m[agent]\x1b[0m Loading KB context...",
    "\x1b[90m[agent]\x1b[0m \x1b[32m✓\x1b[0m Context loaded",
    "\x1b[90m[agent]\x1b[0m Processing with config: " + JSON.stringify(config).slice(0, 60) + "...",
    "\x1b[90m[agent]\x1b[0m Generating output...",
    "\x1b[90m[agent]\x1b[0m \x1b[32m✓\x1b[0m Output ready",
    "",
    "\x1b[32m✓ Done\x1b[0m",
  ];
}

// ---------------------------------------------------------------------------
// Terminal component
// ---------------------------------------------------------------------------

function TerminalOutput({ lines, isRunning }: { lines: string[]; isRunning: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  const renderLine = (raw: string) => {
    const parts: { text: string; className: string }[] = [];
    let remaining = raw;
    const ansiRegex = /\x1b\[(\d+)m/g;
    let lastIndex = 0;
    let currentClass = "";
    let match;

    const colorMap: Record<string, string> = {
      "0": "",
      "32": "text-green-400",
      "33": "text-yellow-400",
      "36": "text-cyan-400",
      "90": "text-zinc-500",
    };

    while ((match = ansiRegex.exec(raw)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: raw.slice(lastIndex, match.index), className: currentClass });
      }
      currentClass = colorMap[match[1]] ?? "";
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < raw.length) {
      parts.push({ text: raw.slice(lastIndex), className: currentClass });
    }
    if (parts.length === 0) return <span>&nbsp;</span>;

    return (
      <>
        {parts.map((p, i) => (
          <span key={i} className={p.className}>{p.text}</span>
        ))}
      </>
    );
  };

  return (
    <div className="h-full bg-zinc-950 text-zinc-200 font-mono text-xs overflow-auto p-4">
      {lines.map((line, i) => (
        <div key={i} className="leading-5 whitespace-pre-wrap">{renderLine(line)}</div>
      ))}
      {isRunning && (
        <div className="leading-5 mt-1">
          <span className="inline-block w-2 h-3.5 bg-zinc-400 animate-pulse" />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// Pre-built fake runs so the page looks populated on load
function buildFakeRuns(): AgentRun[] {
  const claude = AGENTS.find((a) => a.id === "claude-code")!;
  const codex = AGENTS.find((a) => a.id === "codex")!;
  const content = AGENTS.find((a) => a.id === "content-strategist")!;
  const now = new Date();

  return [
    {
      id: "run-fake-1",
      agentId: claude.id,
      agentName: claude.name,
      agentIcon: claude.icon,
      agentIconColor: claude.iconColor,
      agentIconBg: claude.iconBg,
      status: "completed",
      startedAt: new Date(now.getTime() - 12 * 60_000),
      endedAt: new Date(now.getTime() - 11.5 * 60_000),
      config: { task: "Add rate limiting to Checkout API", repo: "github.com/brewandgo/backend", branch: "feature/rate-limiting", mode: "autonomous" },
      output: getSimulatedOutput(claude, { task: "Add rate limiting to Checkout API", mode: "autonomous" }),
    },
    {
      id: "run-fake-2",
      agentId: codex.id,
      agentName: codex.name,
      agentIcon: codex.icon,
      agentIconColor: codex.iconColor,
      agentIconBg: codex.iconBg,
      status: "completed",
      startedAt: new Date(now.getTime() - 45 * 60_000),
      endedAt: new Date(now.getTime() - 44 * 60_000),
      config: { task: "Generate integration tests for Orders API", sandbox: "isolated" },
      output: getSimulatedOutput(codex, { task: "Generate integration tests for Orders API", sandbox: "isolated" }),
    },
    {
      id: "run-fake-3",
      agentId: content.id,
      agentName: content.name,
      agentIcon: content.icon,
      agentIconColor: content.iconColor,
      agentIconBg: content.iconBg,
      status: "completed",
      startedAt: new Date(now.getTime() - 2 * 3600_000),
      endedAt: new Date(now.getTime() - 2 * 3600_000 + 18_000),
      config: { content_type: "blog post", topic: "Mobile App v2.0 Launch" },
      output: getSimulatedOutput(content, { content_type: "blog post", topic: "Mobile App v2.0 Launch" }),
    },
  ];
}

const INITIAL_INSTALLED = new Set(["claude-code", "codex", "content-strategist"]);

const INITIAL_CONFIGS: Record<string, Record<string, string>> = {
  "claude-code": { task: "Refactor authentication middleware to use JWT rotation", repo: "github.com/brewandgo/backend", branch: "feature/jwt-rotation", mode: "interactive" },
  "codex": { task: "Add missing unit tests for payment processing module", repo: "github.com/brewandgo/backend", sandbox: "default" },
  "content-strategist": { content_type: "launch announcement", topic: "Pickup-Ready Notifications", audience: "restaurant partners", tone: "professional" },
};

export function KB2ExecutePage({ companySlug }: { companySlug: string }) {
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("ready");
  const [installedIds, setInstalledIds] = useState<Set<string>>(INITIAL_INSTALLED);
  const [searchQuery, setSearchQuery] = useState("");

  const [selectedStoreAgentId, setSelectedStoreAgentId] = useState<string | null>(null);
  const [selectedInstalledAgentId, setSelectedInstalledAgentId] = useState<string | null>(null);
  const [selectedReadyHowtoId, setSelectedReadyHowtoId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>("run-fake-1");

  const [runs, setRuns] = useState<AgentRun[]>(buildFakeRuns);
  const [agentConfigs, setAgentConfigs] = useState<Record<string, Record<string, string>>>(INITIAL_CONFIGS);
  const [howtos, setHowtos] = useState<HowtoSummary[]>([]);
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    Promise.all([
      fetch(`/api/${companySlug}/kb2?type=howto`).then((r) => r.json()),
      fetch(`/api/${companySlug}/kb2/tickets`).then((r) => r.json()),
      fetch(`/api/${companySlug}/kb2?type=graph_nodes`).then((r) => r.json()),
    ])
      .then(([howtoData, ticketData, graphData]) => {
        const nextHowtos = howtoData.howtos ?? [];
        setHowtos(nextHowtos);
        setTickets(ticketData.tickets ?? []);
        setProjects((graphData.nodes ?? []).filter((node: ProjectSummary) => node.type === "project"));
        setSelectedReadyHowtoId((prev) => prev ?? nextHowtos[0]?.howto_id ?? null);
      })
      .catch(() => {});
  }, [companySlug]);

  const installedAgents = AGENTS.filter((a) => installedIds.has(a.id));
  const installedExecutionAgents = installedAgents.filter((agent) => agent.category === "engineering");
  const ticketById = new Map(tickets.map((ticket) => [ticket.ticket_id, ticket]));
  const projectById = new Map(projects.map((project) => [project.node_id, project]));
  const selectedReadyHowto = howtos.find((howto) => howto.howto_id === selectedReadyHowtoId) ?? null;

  const getReadyItemSourceRefs = (howto: HowtoSummary | null): SourceRef[] => {
    if (!howto) return [];
    const linkedTicket = howto.ticket_id ? ticketById.get(howto.ticket_id) : null;
    const linkedProject = howto.project_node_id ? projectById.get(howto.project_node_id) : null;
    const ticketRefs = linkedTicket?.source_refs ?? [];
    const projectRefs = linkedProject?.source_refs ?? [];
    return dedupeSourceRefs([...ticketRefs, ...projectRefs]);
  };

  const openHowtoInAgent = (agentId: string, howto: HowtoSummary) => {
    const linkedTicket = howto.ticket_id ? ticketById.get(howto.ticket_id) : null;
    const linkedProject = howto.project_node_id ? projectById.get(howto.project_node_id) : null;
    const taskTitle = linkedTicket
      ? linkedTicket.title
      : linkedProject
        ? linkedProject.display_name
        : howto.title;
    updateConfig(agentId, "task", `Implement: ${taskTitle}`);
    updateConfig(agentId, "_howtoId", howto.howto_id);
    if (howto.ticket_id) updateConfig(agentId, "_ticketId", howto.ticket_id);
    setSelectedInstalledAgentId(agentId);
    setSidebarTab("installed");
  };

  const handleInstall = (id: string) => {
    setInstalledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateConfig = (agentId: string, key: string, value: string) => {
    setAgentConfigs((prev) => ({
      ...prev,
      [agentId]: { ...prev[agentId], [key]: value },
    }));
  };

  const startRun = async (agent: Agent) => {
    const config = agentConfigs[agent.id] ?? {};
    const runId = `run-${Date.now()}`;

    const newRun: AgentRun = {
      id: runId,
      agentId: agent.id,
      agentName: agent.name,
      agentIcon: agent.icon,
      agentIconColor: agent.iconColor,
      agentIconBg: agent.iconBg,
      status: "running",
      startedAt: new Date(),
      config,
      output: [],
    };

    setRuns((prev) => [newRun, ...prev]);
    setSidebarTab("runs");
    setSelectedRunId(runId);

    try {
      const res = await fetch(`/api/${companySlug}/kb2/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          task: config.task || config.topic || config.scope || "",
          repo: config.repo,
          branch: config.branch,
          mode: config.mode,
          howtoId: config._howtoId || undefined,
          ticketId: config._ticketId || undefined,
        }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

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
            const event = JSON.parse(line.slice(6));
            if (event.type === "output" || event.type === "progress") {
              const displayLine = event.line ?? event.detail ?? "";
              if (displayLine) {
                setRuns((prev) =>
                  prev.map((r) =>
                    r.id === runId ? { ...r, output: [...r.output, displayLine] } : r,
                  ),
                );
              }
            } else if (event.type === "done") {
              setRuns((prev) =>
                prev.map((r) =>
                  r.id === runId ? { ...r, status: "completed", endedAt: new Date() } : r,
                ),
              );
            } else if (event.type === "error") {
              setRuns((prev) =>
                prev.map((r) =>
                  r.id === runId
                    ? { ...r, status: "failed", endedAt: new Date(), output: [...r.output, `Error: ${event.message}`] }
                    : r,
                ),
              );
            }
          } catch { /* skip unparseable lines */ }
        }
      }
    } catch (err: any) {
      setRuns((prev) =>
        prev.map((r) =>
          r.id === runId
            ? { ...r, status: "failed", endedAt: new Date(), output: [...r.output, `Error: ${err.message}`] }
            : r,
        ),
      );
    }
  };

  const selectedStoreAgent = AGENTS.find((a) => a.id === selectedStoreAgentId) ?? null;
  const selectedInstalledAgent = AGENTS.find((a) => a.id === selectedInstalledAgentId) ?? null;
  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;

  // --- Filter for store ---
  const filtered = AGENTS.filter((a) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return a.name.toLowerCase().includes(q) || a.author.toLowerCase().includes(q) || a.tags.some((t) => t.toLowerCase().includes(q));
  });
  const agentsByCategory = CATEGORY_ORDER.reduce((acc, cat) => {
    const items = filtered.filter((a) => a.category === cat);
    if (items.length > 0) acc[cat] = items;
    return acc;
  }, {} as Record<string, Agent[]>);

  const readyGroups = (["ticket", "project", "standalone"] as const)
    .map((kind) => ({
      kind,
      label:
        kind === "ticket"
          ? "Ticket Guides"
          : kind === "project"
            ? "Project Guides"
            : "Other Guides",
      items: howtos.filter((howto) => classifyReadyItemKind(howto) === kind),
    }))
    .filter((group) => group.items.length > 0);

  // ---------------------------------------------------------------------------
  // Sidebar content per tab
  // ---------------------------------------------------------------------------

  const sidebarContent = (() => {
    switch (sidebarTab) {
      case "store":
        return (
          <>
            <div className="p-3 border-b">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search agents..."
                  className="h-7 text-xs pl-7"
                />
              </div>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2">
                {Object.entries(agentsByCategory).map(([cat, agents]) => (
                  <div key={cat} className="mb-3">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 mb-1">
                      {CATEGORY_LABELS[cat] ?? cat}
                    </p>
                    <div className="space-y-0.5">
                      {agents.map((agent) => {
                        const isInstalled = installedIds.has(agent.id);
                        return (
                          <button
                            key={agent.id}
                            onClick={() => setSelectedStoreAgentId(agent.id)}
                            className={`w-full text-left px-2 py-2 rounded-md transition-colors ${
                              selectedStoreAgentId === agent.id && sidebarTab === "store" ? "bg-accent" : "hover:bg-accent/50"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${agent.iconBg}`}>
                                <agent.icon className={`h-3.5 w-3.5 ${agent.iconColor}`} />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1">
                                  <span className="text-xs font-medium truncate">{agent.name}</span>
                                  {isInstalled && <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />}
                                </div>
                                <p className="text-[10px] text-muted-foreground truncate">{agent.author}</p>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {Object.keys(agentsByCategory).length === 0 && (
                  <p className="text-xs text-muted-foreground p-2">No agents match your search.</p>
                )}
              </div>
            </ScrollArea>
          </>
        );

      case "installed":
        return (
          <ScrollArea className="flex-1">
            <div className="p-2">
              {installedAgents.length === 0 ? (
                <div className="p-4 text-center">
                  <Bot className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
                  <p className="text-xs text-muted-foreground">No agents installed yet.</p>
                  <Button size="sm" variant="link" className="text-xs mt-1" onClick={() => setSidebarTab("store")}>
                    Browse Agent Store
                  </Button>
                </div>
              ) : (
                installedAgents.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedInstalledAgentId(agent.id)}
                    className={`w-full text-left px-2 py-2 rounded-md mb-0.5 transition-colors ${
                      selectedInstalledAgentId === agent.id && sidebarTab === "installed" ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${agent.iconBg}`}>
                        <agent.icon className={`h-3.5 w-3.5 ${agent.iconColor}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium truncate block">{agent.name}</span>
                        <p className="text-[10px] text-muted-foreground truncate">{agent.author}</p>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        );

      case "ready":
        return (
          <ScrollArea className="flex-1">
            <div className="p-2">
              {readyGroups.length === 0 ? (
                <div className="p-4 text-center">
                  <FileText className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
                  <p className="text-xs text-muted-foreground">No ready-to-implement guides yet.</p>
                  <p className="text-[10px] text-muted-foreground/70 mt-1">
                    Generate a how-to guide first, then it will show up here.
                  </p>
                </div>
              ) : (
                readyGroups.map((group) => (
                  <div key={group.kind} className="mb-3">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 mb-1 flex items-center gap-1.5">
                      <span className="flex-1">{group.label}</span>
                      <Badge variant="secondary" className="text-[8px] h-3.5 px-1">
                        {group.items.length}
                      </Badge>
                    </p>
                    <div className="space-y-0.5">
                      {group.items.map((howto) => {
                        const linkedTicket = howto.ticket_id ? ticketById.get(howto.ticket_id) : null;
                        const linkedProject = howto.project_node_id ? projectById.get(howto.project_node_id) : null;
                        return (
                          <button
                            key={howto.howto_id}
                            onClick={() => setSelectedReadyHowtoId(howto.howto_id)}
                            className={`w-full text-left px-2 py-2 rounded-md transition-colors ${
                              selectedReadyHowtoId === howto.howto_id && sidebarTab === "ready"
                                ? "bg-accent"
                                : "hover:bg-accent/50"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              {group.kind === "ticket" ? (
                                <TicketCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              ) : group.kind === "project" ? (
                                <FolderKanban className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              ) : (
                                <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              )}
                              <div className="min-w-0 flex-1">
                                <span className="text-xs font-medium truncate block">{howto.title}</span>
                                <p className="text-[10px] text-muted-foreground truncate">
                                  {linkedTicket?.title ?? linkedProject?.display_name ?? "Standalone how-to"}
                                </p>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        );

      case "runs":
        return (
          <ScrollArea className="flex-1">
            <div className="p-2">
              {runs.length === 0 ? (
                <div className="p-4 text-center">
                  <Terminal className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
                  <p className="text-xs text-muted-foreground">No runs yet.</p>
                  <p className="text-[10px] text-muted-foreground/70 mt-1">Install an agent and start a run.</p>
                </div>
              ) : (
                runs.map((run) => (
                  <button
                    key={run.id}
                    onClick={() => setSelectedRunId(run.id)}
                    className={`w-full text-left px-2 py-2 rounded-md mb-0.5 transition-colors ${
                      selectedRunId === run.id && sidebarTab === "runs" ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${run.agentIconBg}`}>
                        <run.agentIcon className={`h-3.5 w-3.5 ${run.agentIconColor}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium truncate block">{run.agentName}</span>
                        <div className="flex items-center gap-1.5">
                          {run.status === "running" && <Circle className="h-2 w-2 fill-yellow-400 text-yellow-400 shrink-0 animate-pulse" />}
                          {run.status === "completed" && <Circle className="h-2 w-2 fill-green-400 text-green-400 shrink-0" />}
                          {run.status === "failed" && <Circle className="h-2 w-2 fill-red-400 text-red-400 shrink-0" />}
                          <span className="text-[10px] text-muted-foreground">
                            {run.startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        );
    }
  })();

  // ---------------------------------------------------------------------------
  // Main content per tab
  // ---------------------------------------------------------------------------

  const mainContent = (() => {
    switch (sidebarTab) {
      // --- Store: agent detail ---
      case "store":
        if (!selectedStoreAgent) {
          return (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-2">
                <Store className="h-10 w-10 mx-auto text-muted-foreground/40" />
                <p className="text-muted-foreground text-sm">Select an agent to view details.</p>
                <p className="text-xs text-muted-foreground/70">Browse and install agents from the store.</p>
              </div>
            </div>
          );
        }
        return (
          <ScrollArea className="h-full">
            <div className="p-6 max-w-2xl">
              <div className="flex items-start gap-4 mb-6">
                <div className={`h-14 w-14 rounded-xl flex items-center justify-center shrink-0 ${selectedStoreAgent.iconBg}`}>
                  <selectedStoreAgent.icon className={`h-7 w-7 ${selectedStoreAgent.iconColor}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <h1 className="text-xl font-semibold">{selectedStoreAgent.name}</h1>
                  <p className="text-sm text-muted-foreground">{selectedStoreAgent.author}</p>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                      {selectedStoreAgent.stars}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Download className="h-3 w-3" />
                      {selectedStoreAgent.installs}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {CATEGORY_LABELS[selectedStoreAgent.category]}
                    </Badge>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={installedIds.has(selectedStoreAgent.id) ? "outline" : "default"}
                  onClick={() => handleInstall(selectedStoreAgent.id)}
                  className="shrink-0"
                >
                  {installedIds.has(selectedStoreAgent.id) ? (
                    <><CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-green-500" />Installed</>
                  ) : (
                    <><Download className="h-3.5 w-3.5 mr-1.5" />Install</>
                  )}
                </Button>
              </div>

              <div className="flex gap-1.5 mb-6 flex-wrap">
                {selectedStoreAgent.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>
                ))}
              </div>

              <div className="mb-6">
                <h3 className="text-sm font-semibold mb-2">About</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{selectedStoreAgent.longDescription}</p>
              </div>

              <div className="mb-6">
                <h3 className="text-sm font-semibold mb-2">Capabilities</h3>
                <ul className="space-y-1.5">
                  {selectedStoreAgent.capabilities.map((cap, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-green-500 shrink-0" />
                      <span className="text-muted-foreground">{cap}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mb-6">
                <h3 className="text-sm font-semibold mb-2">Run Command</h3>
                <div className="bg-zinc-950 text-zinc-200 font-mono text-xs rounded-md px-4 py-3">
                  $ {selectedStoreAgent.runCommand}
                </div>
              </div>
            </div>
          </ScrollArea>
        );

      // --- Installed: config & run ---
      case "installed":
        if (!selectedInstalledAgent) {
          return (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-2">
                <Settings2 className="h-10 w-10 mx-auto text-muted-foreground/40" />
                <p className="text-muted-foreground text-sm">
                  {installedAgents.length === 0 ? "Install an agent from the store first." : "Select an installed agent to configure."}
                </p>
              </div>
            </div>
          );
        }
        return (
          <ScrollArea className="h-full">
            <div className="p-6 max-w-2xl">
              <div className="flex items-center gap-3 mb-6">
                <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${selectedInstalledAgent.iconBg}`}>
                  <selectedInstalledAgent.icon className={`h-5 w-5 ${selectedInstalledAgent.iconColor}`} />
                </div>
                <div>
                  <h1 className="text-lg font-semibold">{selectedInstalledAgent.name}</h1>
                  <p className="text-xs text-muted-foreground">{selectedInstalledAgent.author}</p>
                </div>
              </div>

              <Card className="mb-6">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Settings2 className="h-3.5 w-3.5" /> Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 pb-4">
                  {selectedInstalledAgent.configFields.map((field) => (
                    <div key={field.key}>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{field.label}</label>
                      {field.key === "task" && howtos.length > 0 && (
                        <div className="mb-2">
                          <select
                            className="w-full h-8 text-xs border rounded-md px-2 bg-background"
                            value=""
                            onChange={(e) => {
                              const h = howtos.find((h) => h.howto_id === e.target.value);
                              if (h) {
                                updateConfig(selectedInstalledAgent.id, "task", `Implement: ${h.title}`);
                                updateConfig(selectedInstalledAgent.id, "_howtoId", h.howto_id);
                                if (h.ticket_id) updateConfig(selectedInstalledAgent.id, "_ticketId", h.ticket_id);
                              }
                            }}
                          >
                            <option value="">Load from How-to guide...</option>
                            {howtos.map((h) => (
                              <option key={h.howto_id} value={h.howto_id}>{h.title}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {field.type === "textarea" ? (
                        <Textarea
                          value={agentConfigs[selectedInstalledAgent.id]?.[field.key] ?? ""}
                          onChange={(e) => updateConfig(selectedInstalledAgent.id, field.key, e.target.value)}
                          placeholder={field.placeholder}
                          rows={3}
                          className="text-sm"
                        />
                      ) : field.type === "select" ? (
                        <Select
                          value={agentConfigs[selectedInstalledAgent.id]?.[field.key] ?? ""}
                          onValueChange={(v) => updateConfig(selectedInstalledAgent.id, field.key, v)}
                        >
                          <SelectTrigger className="h-9 text-sm">
                            <SelectValue placeholder={field.placeholder} />
                          </SelectTrigger>
                          <SelectContent>
                            {field.options?.map((opt) => (
                              <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={agentConfigs[selectedInstalledAgent.id]?.[field.key] ?? ""}
                          onChange={(e) => updateConfig(selectedInstalledAgent.id, field.key, e.target.value)}
                          placeholder={field.placeholder}
                          className="text-sm"
                        />
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>

              <div className="mb-6">
                <h3 className="text-xs font-medium text-muted-foreground mb-2">Command</h3>
                <div className="bg-zinc-950 text-zinc-200 font-mono text-xs rounded-md px-4 py-3">
                  $ {selectedInstalledAgent.runCommand} {agentConfigs[selectedInstalledAgent.id]?.task ? `"${agentConfigs[selectedInstalledAgent.id].task.slice(0, 50)}..."` : ""}
                </div>
              </div>

              <Button onClick={() => startRun(selectedInstalledAgent)} className="w-full">
                <Play className="h-4 w-4 mr-2" />
                Run {selectedInstalledAgent.name}
              </Button>
            </div>
          </ScrollArea>
        );

      case "ready":
        if (!selectedReadyHowto) {
          return (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-2">
                <FileText className="h-10 w-10 mx-auto text-muted-foreground/40" />
                <p className="text-muted-foreground text-sm">Select a ready-to-implement guide.</p>
                <p className="text-xs text-muted-foreground/70">
                  These are the items a user can load into an agent before starting a run.
                </p>
              </div>
            </div>
          );
        }
        return (
          <ScrollArea className="h-full">
            <div className="p-6 max-w-3xl">
              <div className="flex items-start gap-3 mb-5">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <FileText className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <h1 className="text-lg font-semibold">{selectedReadyHowto.title}</h1>
                  <div className="flex items-center gap-2 flex-wrap mt-1.5">
                    {selectedReadyHowto.ticket_id && (
                      <Badge variant="outline" className="text-[10px]">
                        Ticket
                      </Badge>
                    )}
                    {selectedReadyHowto.project_node_id && (
                      <Badge variant="outline" className="text-[10px]">
                        Project
                      </Badge>
                    )}
                    {selectedReadyHowto.created_at && (
                      <Badge variant="secondary" className="text-[10px]">
                        {new Date(selectedReadyHowto.created_at).toLocaleDateString()}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              {selectedReadyHowto.ticket_id && ticketById.get(selectedReadyHowto.ticket_id) && (
                <Card className="mb-4">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <TicketCheck className="h-3.5 w-3.5" />
                      Linked Ticket
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-4">
                    <p className="text-sm font-medium">{ticketById.get(selectedReadyHowto.ticket_id)?.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {ticketById.get(selectedReadyHowto.ticket_id)?.source} • {ticketById.get(selectedReadyHowto.ticket_id)?.workflow_state}
                    </p>
                  </CardContent>
                </Card>
              )}

              {selectedReadyHowto.project_node_id && projectById.get(selectedReadyHowto.project_node_id) && (
                <Card className="mb-4">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <FolderKanban className="h-3.5 w-3.5" />
                      Linked Project
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-4">
                    <p className="text-sm font-medium">{projectById.get(selectedReadyHowto.project_node_id)?.display_name}</p>
                  </CardContent>
                </Card>
              )}

              <Card className="mb-6">
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Guide Preview</CardTitle>
                </CardHeader>
                <CardContent className="pb-4 space-y-4">
                  {(selectedReadyHowto.sections ?? []).length > 0 ? (
                    (selectedReadyHowto.sections ?? []).map((section) => (
                      <div key={section.section_name}>
                        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
                          {section.section_name}
                        </h3>
                        <div className="text-sm whitespace-pre-wrap rounded-md bg-muted/30 px-3 py-2">
                          {section.content || "No content yet."}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      This guide exists, but it does not have section content yet.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Ready to Execute</CardTitle>
                </CardHeader>
                <CardContent className="pb-4">
                  {installedExecutionAgents.length === 0 ? (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Install an engineering agent first, then load this guide into it.
                      </p>
                      <Button variant="outline" onClick={() => setSidebarTab("store")}>
                        Open Agent Store
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">
                        Load this guide into an installed agent, review the config, then start the run.
                      </p>
                      <div className="flex gap-2 flex-wrap">
                        {installedExecutionAgents.map((agent) => (
                          <Button
                            key={agent.id}
                            variant="outline"
                            onClick={() => openHowtoInAgent(agent.id, selectedReadyHowto)}
                          >
                            <agent.icon className="h-4 w-4 mr-2" />
                            Load in {agent.name}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </ScrollArea>
        );

      // --- Runs: terminal output ---
      case "runs":
        if (!selectedRun) {
          return (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-2">
                <Terminal className="h-10 w-10 mx-auto text-muted-foreground/40" />
                <p className="text-muted-foreground text-sm">
                  {runs.length === 0 ? "No runs yet. Configure and run an agent." : "Select a run to view output."}
                </p>
              </div>
            </div>
          );
        }
        return (
          <div className="flex flex-col h-full">
            <div className="border-b px-4 py-2.5 flex items-center gap-3 shrink-0">
              <div className={`h-6 w-6 rounded flex items-center justify-center ${selectedRun.agentIconBg}`}>
                <selectedRun.agentIcon className={`h-3.5 w-3.5 ${selectedRun.agentIconColor}`} />
              </div>
              <span className="text-sm font-medium">{selectedRun.agentName}</span>
              <Badge
                variant={selectedRun.status === "running" ? "default" : selectedRun.status === "completed" ? "secondary" : "destructive"}
                className="text-[10px]"
              >
                {selectedRun.status === "running" && <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />}
                {selectedRun.status}
              </Badge>
              <span className="text-[10px] text-muted-foreground ml-auto">
                {selectedRun.startedAt.toLocaleTimeString()}
                {selectedRun.endedAt && ` — ${selectedRun.endedAt.toLocaleTimeString()}`}
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <TerminalOutput lines={selectedRun.output} isRunning={selectedRun.status === "running"} />
            </div>
          </div>
        );
    }
  })();

  return (
    <div className="flex h-full flex-1 min-w-0">
      {/* Left sidebar */}
      <div className="w-64 shrink-0 border-r flex flex-col">
        <div className="p-2 border-b">
          <Tabs value={sidebarTab} onValueChange={(v) => setSidebarTab(v as SidebarTab)}>
            <TabsList className="w-full h-auto grid grid-cols-2 gap-1">
              <TabsTrigger value="store" className="text-[10px] h-7 gap-1">
                <Store className="h-3 w-3" />Store
              </TabsTrigger>
              <TabsTrigger value="installed" className="text-[10px] h-7 gap-1">
                <Settings2 className="h-3 w-3" />Installed
                {installedAgents.length > 0 && (
                  <Badge variant="secondary" className="text-[8px] h-3.5 px-1 ml-0.5">{installedAgents.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="ready" className="text-[9px] h-7 gap-1">
                <Play className="h-3 w-3" />
                <span className="leading-tight">Ready to implement</span>
                {howtos.length > 0 && (
                  <Badge variant="secondary" className="text-[8px] h-3.5 px-1 ml-0.5">{howtos.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="runs" className="text-[10px] h-7 gap-1">
                <Terminal className="h-3 w-3" />Runs
                {runs.filter((r) => r.status === "running").length > 0 && (
                  <Badge className="text-[8px] h-3.5 px-1 ml-0.5 bg-yellow-500">{runs.filter((r) => r.status === "running").length}</Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {sidebarContent}
      </div>

      {/* Main + Right panel */}
      <SplitLayout
        autoSaveId="execute"
        mainContent={<div className="h-full overflow-hidden">{mainContent}</div>}
        rightPanel={
          <KB2RightPanel
            companySlug={companySlug}
            autoContext={
              selectedRun && sidebarTab === "runs"
                ? { type: "howto" as const, id: selectedRun.agentId, title: `${selectedRun.agentName} Run` }
                : selectedReadyHowto && sidebarTab === "ready"
                  ? { type: "howto" as const, id: selectedReadyHowto.howto_id, title: selectedReadyHowto.title }
                : selectedInstalledAgent && sidebarTab === "installed"
                  ? { type: "howto" as const, id: selectedInstalledAgent.id, title: selectedInstalledAgent.name }
                  : selectedStoreAgent && sidebarTab === "store"
                    ? { type: "howto" as const, id: selectedStoreAgent.id, title: selectedStoreAgent.name }
                    : null
            }
            sourceRefs={sidebarTab === "ready" ? getReadyItemSourceRefs(selectedReadyHowto) : []}
            relatedEntityPages={[]}
            defaultTab={sidebarTab === "ready" ? "sources" : "chat"}
          />
        }
      />
    </div>
  );
}
