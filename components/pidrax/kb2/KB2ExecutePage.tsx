"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Play,
  Bot,
  MessageSquare,
  User,
  GitPullRequest,
  ArrowRight,
} from "lucide-react";

const MOCK_TIMELINE = [
  {
    type: "agent",
    icon: Bot,
    label: "Agent started task",
    detail: 'Working on: "Add rate limiting to Checkout API"',
    time: "2m ago",
  },
  {
    type: "question",
    icon: MessageSquare,
    label: "Agent asked a question",
    detail:
      '"Should I use token bucket or sliding window for rate limiting?"',
    time: "1m 30s ago",
  },
  {
    type: "human",
    icon: User,
    label: "Human replied",
    detail:
      '"Use token bucket — we already use it for the Upload service (see Decision: Rate Limiting Strategy)."',
    time: "1m ago",
  },
  {
    type: "agent",
    icon: Bot,
    label: "Agent continued",
    detail: "Implementing token bucket rate limiter with Redis backend...",
    time: "30s ago",
  },
  {
    type: "pr",
    icon: GitPullRequest,
    label: "Agent opened PR",
    detail: "PR #142: Add token bucket rate limiting to Checkout API",
    time: "Just now",
  },
];

export function KB2ExecutePage({ companySlug }: { companySlug: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6">
        <div className="mb-8">
          <h1 className="text-xl font-semibold mb-1">Execute</h1>
          <p className="text-sm text-muted-foreground">
            Connect your AI agent to execute tasks using the knowledge base.
          </p>
        </div>

        {/* Connect agent form (non-functional placeholder) */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Bot className="h-4 w-4" /> Connect Your Agent
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input placeholder="Agent name (e.g., Claude Code)" disabled />
            <Input
              placeholder="Agent endpoint URL"
              disabled
            />
            <Textarea
              placeholder="Description of what this agent does..."
              rows={2}
              disabled
            />
            <Button disabled>
              <Play className="h-3 w-3 mr-1" /> Connect Agent
            </Button>
            <p className="text-xs text-muted-foreground">
              Agent integration coming soon. This will allow AI agents to
              read from the KB, execute tasks, and request human-in-the-loop
              approval.
            </p>
          </CardContent>
        </Card>

        {/* Mock run timeline */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Example Agent Run Timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {MOCK_TIMELINE.map((event, i) => (
                <div key={i} className="flex gap-3">
                  <div className="shrink-0 mt-0.5">
                    <div
                      className={`h-8 w-8 rounded-full flex items-center justify-center ${
                        event.type === "agent"
                          ? "bg-blue-500/10 text-blue-500"
                          : event.type === "human"
                            ? "bg-green-500/10 text-green-500"
                            : event.type === "question"
                              ? "bg-yellow-500/10 text-yellow-500"
                              : "bg-purple-500/10 text-purple-500"
                      }`}
                    >
                      <event.icon className="h-4 w-4" />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {event.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {event.time}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {event.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
