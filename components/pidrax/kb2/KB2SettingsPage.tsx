"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import {
  FileText,
  MessageSquare,
  Code2,
  MessageCircle,
  Mic,
  Ticket,
  Github,
  Key,
  Globe,
} from "lucide-react";

interface IntegrationConfig {
  key: string;
  name: string;
  icon: React.ReactNode;
  fieldLabel: string;
  fieldPlaceholder: string;
}

const INTEGRATIONS: Record<string, IntegrationConfig[]> = {
  Documents: [
    { key: "confluence", name: "Confluence", icon: <FileText className="h-4 w-4" />, fieldLabel: "Workspace URL", fieldPlaceholder: "https://your-workspace.atlassian.net/wiki" },
    { key: "notion", name: "Notion", icon: <FileText className="h-4 w-4" />, fieldLabel: "Workspace URL", fieldPlaceholder: "https://www.notion.so/your-workspace" },
  ],
  Messaging: [
    { key: "slack", name: "Slack", icon: <MessageSquare className="h-4 w-4" />, fieldLabel: "Workspace", fieldPlaceholder: "your-workspace.slack.com" },
    { key: "teams", name: "Microsoft Teams", icon: <MessageSquare className="h-4 w-4" />, fieldLabel: "Tenant", fieldPlaceholder: "your-tenant.onmicrosoft.com" },
  ],
  "Code Repositories": [
    { key: "github", name: "GitHub", icon: <Github className="h-4 w-4" />, fieldLabel: "Org/Repo", fieldPlaceholder: "org/repo" },
    { key: "bitbucket", name: "Bitbucket", icon: <Code2 className="h-4 w-4" />, fieldLabel: "Workspace", fieldPlaceholder: "https://bitbucket.org/workspace" },
  ],
  "Customer Feedback": [
    { key: "zendesk", name: "Zendesk", icon: <MessageCircle className="h-4 w-4" />, fieldLabel: "Subdomain", fieldPlaceholder: "your-subdomain.zendesk.com" },
    { key: "intercom", name: "Intercom", icon: <MessageCircle className="h-4 w-4" />, fieldLabel: "App ID", fieldPlaceholder: "your-app-id" },
  ],
  "Meeting Notes": [
    { key: "fireflies", name: "Fireflies.ai", icon: <Mic className="h-4 w-4" />, fieldLabel: "API Key", fieldPlaceholder: "Your API key" },
    { key: "otter", name: "Otter.ai", icon: <Mic className="h-4 w-4" />, fieldLabel: "API Key", fieldPlaceholder: "Your API key" },
  ],
  Ticketing: [
    { key: "jira", name: "Jira", icon: <Ticket className="h-4 w-4" />, fieldLabel: "Site URL", fieldPlaceholder: "https://your-site.atlassian.net" },
    { key: "trello", name: "Trello", icon: <Ticket className="h-4 w-4" />, fieldLabel: "Board URL", fieldPlaceholder: "https://trello.com/b/board-id" },
  ],
};

function IntegrationRow({
  config,
  connected,
  fieldValue,
  onFieldChange,
  onConnect,
  onDisconnect,
}: {
  config: IntegrationConfig;
  connected: boolean;
  fieldValue: string;
  onFieldChange: (v: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3 min-w-[140px]">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground shrink-0">
          {config.icon}
        </div>
        <div>
          <span className="font-medium text-sm">{config.name}</span>
          <div className="mt-0.5">
            {connected ? (
              <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[10px]">
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px] text-muted-foreground">
                Not Connected
              </Badge>
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <Input
          placeholder={config.fieldPlaceholder}
          value={fieldValue}
          onChange={(e) => onFieldChange(e.target.value)}
          className="h-9"
        />
      </div>
      <div className="shrink-0">
        {connected ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              console.log("Disconnect", config.key);
              onDisconnect();
            }}
          >
            Disconnect
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => {
              console.log("Connect", config.key);
              onConnect();
            }}
          >
            Connect
          </Button>
        )}
      </div>
    </div>
  );
}

export function KB2SettingsPage({ companySlug }: { companySlug: string }) {
  // Connection statuses for each integration
  const [connections, setConnections] = useState<Record<string, boolean>>({});
  // Field values for each integration
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  // Deployment config
  const [vercelProjectId, setVercelProjectId] = useState("");
  const [vercelApiToken, setVercelApiToken] = useState("");
  const [githubRepoUrl, setGithubRepoUrl] = useState("");
  const [githubAccessToken, setGithubAccessToken] = useState("");
  const [baseBranch, setBaseBranch] = useState("dev");
  const [customerDomain, setCustomerDomain] = useState("");

  const toggleConnection = (key: string) => {
    setConnections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const setFieldValue = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6 space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Configure integrations and deployment for {companySlug}
          </p>
        </div>

        {/* Section 1: Input Source Connections */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Input Source Connections</CardTitle>
            <p className="text-sm text-muted-foreground">
              Connect your data sources to power the knowledge base and AI features.
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            {Object.entries(INTEGRATIONS).map(([category, items]) => (
              <div key={category}>
                <h4 className="text-sm font-medium text-muted-foreground mb-3">{category}</h4>
                <div className="space-y-0">
                  {items.map((config) => (
                    <div key={config.key}>
                      <IntegrationRow
                        config={config}
                        connected={connections[config.key] ?? false}
                        fieldValue={fieldValues[config.key] ?? ""}
                        onFieldChange={(v) => setFieldValue(config.key, v)}
                        onConnect={() => toggleConnection(config.key)}
                        onDisconnect={() => toggleConnection(config.key)}
                      />
                      {config.key !== items[items.length - 1].key && (
                        <Separator className="my-0" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Section 2: Deployment Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Deployment Configuration</CardTitle>
            <p className="text-sm text-muted-foreground">
              Configure how your KB is deployed to Vercel and connected to GitHub.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="vercel-project-id">Vercel Project ID</Label>
                <Input
                  id="vercel-project-id"
                  placeholder="prj_xxxx"
                  value={vercelProjectId}
                  onChange={(e) => setVercelProjectId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="vercel-api-token">Vercel API Token</Label>
                <Input
                  id="vercel-api-token"
                  type="password"
                  placeholder="••••••••••••••••"
                  value={vercelApiToken}
                  onChange={(e) => setVercelApiToken(e.target.value)}
                />
              </div>
            </div>
            <Separator />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="github-repo-url">
                  <Github className="h-3.5 w-3.5 inline mr-1" />
                  GitHub Repository URL
                </Label>
                <Input
                  id="github-repo-url"
                  placeholder="https://github.com/org/repo"
                  value={githubRepoUrl}
                  onChange={(e) => setGithubRepoUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="github-access-token">
                  <Key className="h-3.5 w-3.5 inline mr-1" />
                  GitHub Access Token
                </Label>
                <Input
                  id="github-access-token"
                  type="password"
                  placeholder="••••••••••••••••"
                  value={githubAccessToken}
                  onChange={(e) => setGithubAccessToken(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="base-branch">
                  <Code2 className="h-3.5 w-3.5 inline mr-1" />
                  Base Branch
                </Label>
                <Input
                  id="base-branch"
                  placeholder="dev"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="customer-domain">
                  <Globe className="h-3.5 w-3.5 inline mr-1" />
                  Customer Domain
                </Label>
                <Input
                  id="customer-domain"
                  placeholder="dev.nixorg.com"
                  value={customerDomain}
                  onChange={(e) => setCustomerDomain(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Your deployment domain — provided by you, not created by Pidrax
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Section 3: Team */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Team</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Team members are automatically extracted from your connected data sources. To manage
              notifications, configure integrations above.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
