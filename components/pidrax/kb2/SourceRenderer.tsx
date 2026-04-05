"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  MessageSquare,
  FileText,
  GitPullRequest,
  Ticket,
  MessageCircle,
  ExternalLink,
} from "lucide-react";

interface SourceRef {
  source_type: string;
  doc_id: string;
  title: string;
  excerpt?: string;
  section_heading?: string;
}

const PROVIDER_CONFIG: Record<string, { icon: React.ReactNode; label: string; accent: string; bg: string }> = {
  slack: {
    icon: <MessageSquare className="h-3.5 w-3.5" />,
    label: "Slack",
    accent: "border-l-purple-500",
    bg: "bg-purple-50 dark:bg-purple-950/20",
  },
  confluence: {
    icon: <FileText className="h-3.5 w-3.5" />,
    label: "Confluence",
    accent: "border-l-blue-500",
    bg: "bg-blue-50 dark:bg-blue-950/20",
  },
  github: {
    icon: <GitPullRequest className="h-3.5 w-3.5" />,
    label: "GitHub",
    accent: "border-l-gray-500",
    bg: "bg-gray-50 dark:bg-gray-950/20",
  },
  jira: {
    icon: <Ticket className="h-3.5 w-3.5" />,
    label: "Jira",
    accent: "border-l-blue-600",
    bg: "bg-blue-50 dark:bg-blue-950/20",
  },
  customerFeedback: {
    icon: <MessageCircle className="h-3.5 w-3.5" />,
    label: "Feedback",
    accent: "border-l-pink-500",
    bg: "bg-pink-50 dark:bg-pink-950/20",
  },
};

function SlackCard({ source }: { source: SourceRef }) {
  const lines = (source.excerpt ?? "").split("\n").filter(Boolean);
  return (
    <div className="border-l-4 border-l-purple-500 bg-purple-50 dark:bg-purple-950/20 rounded-r-md p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-3.5 w-3.5 text-purple-600" />
        <span className="text-xs font-medium text-purple-700 dark:text-purple-300">{source.title}</span>
        {source.section_heading && (
          <Badge variant="outline" className="text-[9px] text-purple-600 border-purple-300">
            #{source.section_heading}
          </Badge>
        )}
      </div>
      <div className="space-y-1">
        {lines.slice(0, 4).map((line, i) => {
          const match = line.match(/^(\w[\w\s.]*?):\s*(.*)$/);
          if (match) {
            return (
              <div key={i} className="flex gap-2 text-xs">
                <span className="font-medium text-purple-800 dark:text-purple-200 shrink-0">{match[1]}:</span>
                <span className="text-muted-foreground">{match[2]}</span>
              </div>
            );
          }
          return <p key={i} className="text-xs text-muted-foreground">{line}</p>;
        })}
      </div>
    </div>
  );
}

function ConfluenceCard({ source }: { source: SourceRef }) {
  return (
    <div className="border-l-4 border-l-blue-500 bg-blue-50 dark:bg-blue-950/20 rounded-r-md p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-blue-600" />
        <span className="text-xs font-medium text-blue-700 dark:text-blue-300">{source.title}</span>
        {source.section_heading && (
          <Badge variant="outline" className="text-[9px] text-blue-600 border-blue-300">
            {source.section_heading}
          </Badge>
        )}
      </div>
      {source.excerpt && (
        <div className="text-xs text-muted-foreground leading-relaxed line-clamp-4 whitespace-pre-wrap">
          {source.excerpt}
        </div>
      )}
    </div>
  );
}

function GitHubCard({ source }: { source: SourceRef }) {
  const prMatch = source.title.match(/PR\s*#?(\d+)|#(\d+)/i);
  const prNum = prMatch ? prMatch[1] ?? prMatch[2] : null;

  return (
    <div className="border-l-4 border-l-gray-500 bg-gray-50 dark:bg-gray-950/20 rounded-r-md p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <GitPullRequest className="h-3.5 w-3.5 text-gray-600" />
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{source.title}</span>
        {prNum && (
          <Badge className="text-[9px] bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
            #{prNum}
          </Badge>
        )}
      </div>
      {source.excerpt && (
        <div className="text-xs text-muted-foreground font-mono leading-relaxed line-clamp-4 whitespace-pre-wrap bg-white/50 dark:bg-black/20 rounded px-2 py-1">
          {source.excerpt}
        </div>
      )}
    </div>
  );
}

function JiraCard({ source }: { source: SourceRef }) {
  const ticketMatch = source.title.match(/^([A-Z]+-\d+)/);
  const ticketKey = ticketMatch ? ticketMatch[1] : null;
  const title = ticketKey ? source.title.replace(ticketKey, "").replace(/^[\s:—-]+/, "") : source.title;

  return (
    <div className="border-l-4 border-l-blue-600 bg-blue-50 dark:bg-blue-950/20 rounded-r-md p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <Ticket className="h-3.5 w-3.5 text-blue-700" />
        {ticketKey && (
          <Badge className="text-[9px] bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300 font-mono">
            {ticketKey}
          </Badge>
        )}
        <span className="text-xs font-medium text-blue-700 dark:text-blue-300">{title}</span>
      </div>
      {source.excerpt && (
        <div className="text-xs text-muted-foreground leading-relaxed line-clamp-3 whitespace-pre-wrap">
          {source.excerpt}
        </div>
      )}
    </div>
  );
}

function FeedbackCard({ source }: { source: SourceRef }) {
  return (
    <div className="border-l-4 border-l-pink-500 bg-pink-50 dark:bg-pink-950/20 rounded-r-md p-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <MessageCircle className="h-3.5 w-3.5 text-pink-600" />
        <span className="text-xs font-medium text-pink-700 dark:text-pink-300">{source.title}</span>
      </div>
      {source.excerpt && (
        <div className="text-xs text-muted-foreground leading-relaxed line-clamp-4 italic whitespace-pre-wrap">
          &ldquo;{source.excerpt}&rdquo;
        </div>
      )}
    </div>
  );
}

function GenericCard({ source }: { source: SourceRef }) {
  const config = PROVIDER_CONFIG[source.source_type];
  return (
    <div className={`border-l-4 ${config?.accent ?? "border-l-gray-400"} ${config?.bg ?? "bg-muted/30"} rounded-r-md p-3 space-y-1.5`}>
      <div className="flex items-center gap-2">
        {config?.icon ?? <FileText className="h-3.5 w-3.5" />}
        <span className="text-xs font-medium">{source.title}</span>
        <Badge variant="outline" className="text-[9px]">{config?.label ?? source.source_type}</Badge>
      </div>
      {source.excerpt && (
        <div className="text-xs text-muted-foreground leading-relaxed line-clamp-3 whitespace-pre-wrap">
          {source.excerpt}
        </div>
      )}
    </div>
  );
}

export function SourceRenderer({ source, compact = false }: { source: SourceRef; compact?: boolean }) {
  if (compact) {
    const config = PROVIDER_CONFIG[source.source_type];
    return (
      <div className="flex items-center gap-2 text-xs py-1">
        {config?.icon ?? <FileText className="h-3 w-3" />}
        <span className="text-muted-foreground">{config?.label ?? source.source_type}</span>
        <span className="font-medium truncate">{source.title}</span>
        {source.section_heading && (
          <span className="text-muted-foreground text-[10px]">&middot; {source.section_heading}</span>
        )}
      </div>
    );
  }

  switch (source.source_type) {
    case "slack": return <SlackCard source={source} />;
    case "confluence": return <ConfluenceCard source={source} />;
    case "github": return <GitHubCard source={source} />;
    case "jira": return <JiraCard source={source} />;
    case "customerFeedback": return <FeedbackCard source={source} />;
    default: return <GenericCard source={source} />;
  }
}

export function SourceList({ sources, compact = false, maxItems = 5 }: { sources: SourceRef[]; compact?: boolean; maxItems?: number }) {
  const unique = sources.reduce((acc, s) => {
    const key = `${s.source_type}:${s.doc_id}:${s.section_heading ?? ""}`;
    if (!acc.has(key)) acc.set(key, s);
    return acc;
  }, new Map<string, SourceRef>());

  const items = Array.from(unique.values()).slice(0, maxItems);
  const remaining = unique.size - items.length;

  return (
    <div className="space-y-2">
      {items.map((s, i) => (
        <SourceRenderer key={`${s.doc_id}-${i}`} source={s} compact={compact} />
      ))}
      {remaining > 0 && (
        <p className="text-[10px] text-muted-foreground">+{remaining} more source{remaining > 1 ? "s" : ""}</p>
      )}
    </div>
  );
}
