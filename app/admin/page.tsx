"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import {
  Plus,
  RefreshCw,
  ExternalLink,
  Loader2,
  CheckCircle2,
  Circle,
  Hash,
  FileText,
  Sparkles,
  Unplug,
} from "lucide-react";

interface Company {
  id: string;
  name: string;
  companySlug: string;
  createdAt: string;
  connectedProviders: Record<string, boolean>;
  syncStatus: Record<string, any>;
  docCount: number;
  pageCount: number;
}

export default function AdminPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [auditing, setAuditing] = useState<Record<string, boolean>>({});
  const [auditStatus, setAuditStatus] = useState<Record<string, any>>({});
  const [disconnecting, setDisconnecting] = useState<Record<string, boolean>>({});

  const fetchCompanies = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/companies");
      if (res.ok) {
        const data = await res.json();
        setCompanies(data.companies || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      const res = await fetch("/api/admin/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, companySlug: slug }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create company");
        return;
      }
      setName("");
      setSlug("");
      setShowForm(false);
      await fetchCompanies();
    } catch {
      setError("Network error");
    } finally {
      setCreating(false);
    }
  };

  const handleSync = async (company: Company) => {
    setSyncing((prev) => ({ ...prev, [company.id]: true }));
    try {
      await fetch(`/api/${company.companySlug}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "all" }),
      });
      await fetchCompanies();
    } catch {
      // silent
    } finally {
      setSyncing((prev) => ({ ...prev, [company.id]: false }));
    }
  };

  const handleConnectSlack = (projectId: string) => {
    window.location.href = `/api/integrations/slack/authorize?projectId=${projectId}`;
  };

  const handleConnectAtlassian = (projectId: string) => {
    window.location.href = `/api/integrations/atlassian/authorize?projectId=${projectId}`;
  };

  const handleDisconnect = async (company: Company, provider: "slack" | "atlassian") => {
    const label = provider === "atlassian" ? "Jira + Confluence" : "Slack";
    if (!confirm(`Disconnect ${label} from ${company.name}? You can reconnect later.`)) return;

    const key = `${company.id}-${provider}`;
    setDisconnecting((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await fetch(`/api/${company.companySlug}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to disconnect");
      }
      await fetchCompanies();
    } catch {
      alert("Network error");
    } finally {
      setDisconnecting((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleAudit = async (company: Company) => {
    setAuditing((prev) => ({ ...prev, [company.id]: true }));
    try {
      await fetch(`/api/${company.companySlug}/doc-audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "audit" }),
      });

      const poll = async () => {
        try {
          const res = await fetch(`/api/${company.companySlug}/doc-audit`);
          if (res.ok) {
            const data = await res.json();
            setAuditStatus((prev) => ({ ...prev, [company.id]: data }));
            if (
              data.latestRun?.status === "completed" ||
              data.latestRun?.status === "error"
            ) {
              setAuditing((prev) => ({ ...prev, [company.id]: false }));
              await fetchCompanies();
              return;
            }
          }
        } catch {
          // silent
        }
        setTimeout(poll, 5000);
      };
      setTimeout(poll, 5000);
    } catch {
      setAuditing((prev) => ({ ...prev, [company.id]: false }));
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Companies</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Onboard companies and connect their integrations.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchCompanies}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setShowForm(!showForm)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Company
          </Button>
        </div>
      </div>

      {/* Create form */}
      {showForm && (
        <form
          onSubmit={handleCreate}
          className="rounded-xl border bg-card p-6 mb-6 space-y-4"
        >
          <h2 className="font-semibold">New Company</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1.5">
                Company Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Bix Technologies"
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1.5">
                URL Slug
              </label>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="bix"
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                required
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Workspace will be at /{slug || "slug"}/chat
              </p>
            </div>
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={creating}>
              {creating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Create
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setShowForm(false);
                setError("");
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty state */}
      {!loading && companies.length === 0 && (
        <div className="rounded-xl border bg-card p-12 text-center">
          <h3 className="font-semibold mb-1">No companies yet</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Click "Add Company" to onboard your first company.
          </p>
        </div>
      )}

      {/* Company cards */}
      <div className="space-y-4">
        {companies.map((company) => (
          <div
            key={company.id}
            className="rounded-xl border bg-card p-6 space-y-4"
          >
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-lg">{company.name}</h3>
                  <span className="text-xs text-muted-foreground bg-secondary rounded-md px-2 py-0.5">
                    /{company.companySlug}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  ID: {company.id}
                </p>
              </div>
              <Link
                href={`/${company.companySlug}/chat`}
                className="flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Open workspace
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>

            {/* Stats */}
            <div className="flex gap-6 text-sm">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Hash className="h-3.5 w-3.5" />
                <span>{company.docCount} documents</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                <span>{company.pageCount} KB pages</span>
              </div>
            </div>

            {/* Integrations */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Integrations
              </h4>
              <div className="flex flex-wrap gap-3">
                {/* Slack */}
                <div className="flex items-center gap-2 rounded-lg border px-3 py-2 min-w-[200px]">
                  {company.connectedProviders.slack ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                  )}
                  <span className="text-sm font-medium flex-1">Slack</span>
                  {company.connectedProviders.slack ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-green-600 font-medium">Connected</span>
                      <button
                        onClick={() => handleDisconnect(company, "slack")}
                        disabled={disconnecting[`${company.id}-slack`]}
                        className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="Disconnect Slack"
                      >
                        {disconnecting[`${company.id}-slack`] ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Unplug className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] px-2"
                      onClick={() => handleConnectSlack(company.id)}
                    >
                      Connect
                    </Button>
                  )}
                </div>

                {/* Atlassian (Jira + Confluence) */}
                <div className="flex items-center gap-2 rounded-lg border px-3 py-2 min-w-[200px]">
                  {company.connectedProviders.atlassian ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                  )}
                  <span className="text-sm font-medium flex-1">Jira + Confluence</span>
                  {company.connectedProviders.atlassian ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-green-600 font-medium">Connected</span>
                      <button
                        onClick={() => handleDisconnect(company, "atlassian")}
                        disabled={disconnecting[`${company.id}-atlassian`]}
                        className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="Disconnect Jira + Confluence"
                      >
                        {disconnecting[`${company.id}-atlassian`] ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Unplug className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] px-2"
                      onClick={() => handleConnectAtlassian(company.id)}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Sync */}
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSync(company)}
                  disabled={syncing[company.id]}
                >
                  {syncing[company.id] ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {syncing[company.id] ? "Syncing..." : "Sync Now"}
                </Button>
                <span className="text-[10px] text-muted-foreground/70">
                  Initial backfill only — after first sync, changes are received in real-time via webhooks
                </span>
              </div>
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                {(() => {
                  const providers: string[] = [];
                  if (company.connectedProviders.slack) providers.push("slack");
                  if (company.connectedProviders.atlassian) {
                    providers.push("confluence", "jira");
                  }
                  Object.keys(company.syncStatus).forEach(p => {
                    if (!providers.includes(p)) providers.push(p);
                  });
                  return providers.map(provider => {
                    const status = company.syncStatus[provider];
                    const hasSynced = !!status?.lastSyncAt;
                    return (
                      <span key={provider} className="flex items-center gap-1">
                        {hasSynced && (
                          <span className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" title="Live — receiving real-time updates" />
                        )}
                        {provider}:{" "}
                        {hasSynced
                          ? new Date(status.lastSyncAt).toLocaleString()
                          : "never"}
                      </span>
                    );
                  });
                })()}
              </div>
            </div>

            {/* Doc-Audit */}
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleAudit(company)}
                  disabled={auditing[company.id]}
                >
                  {auditing[company.id] ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {auditing[company.id] ? "Running..." : "Run Doc-Audit"}
                </Button>
                <span className="text-[10px] text-muted-foreground/70">
                  Discovers entities, detects conflicts, fills documentation gaps, generates KB pages
                </span>
              </div>
              {auditStatus[company.id] && (
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>Conflicts: {auditStatus[company.id].stats?.conflicts || 0}</span>
                  <span>Gaps: {auditStatus[company.id].stats?.gaps || 0}</span>
                  <span>KB pages: {auditStatus[company.id].stats?.proposals || 0}</span>
                  {auditStatus[company.id].latestRun && (
                    <span>Last run: {new Date(auditStatus[company.id].latestRun.startedAt).toLocaleString()}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
