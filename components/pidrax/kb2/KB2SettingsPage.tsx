"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  FileText, MessageSquare, Code2, MessageCircle, Mic, Ticket,
  Github, Key, Globe, Save, Loader2, Plus, Trash2, Users, Building2,
  Info, CheckCircle2,
} from "lucide-react";

interface PersonHint {
  name: string;
  role: string;
  slack_handle: string;
  email: string;
  focus_areas: string[];
}

interface TeamHint {
  team_name: string;
  lead: string;
  members: string[];
  responsibilities: string;
}

interface ProfileConfig {
  company_context: string;
  company_name: string;
  business_model: string;
  product_type: string;
  project_prefix: string;
  acronyms: { short: string; full: string }[];
  focus_areas: string[];
  exclusions: string;
}

interface IntegrationDef {
  key: string;
  name: string;
  icon: React.ReactNode;
  fieldLabel: string;
  fieldPlaceholder: string;
  category: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  { key: "confluence", name: "Confluence", icon: <FileText className="h-4 w-4" />, fieldLabel: "Workspace URL", fieldPlaceholder: "https://your-workspace.atlassian.net/wiki", category: "Documents" },
  { key: "notion", name: "Notion", icon: <FileText className="h-4 w-4" />, fieldLabel: "Workspace URL", fieldPlaceholder: "https://www.notion.so/your-workspace", category: "Documents" },
  { key: "slack", name: "Slack", icon: <MessageSquare className="h-4 w-4" />, fieldLabel: "Workspace", fieldPlaceholder: "your-workspace.slack.com", category: "Messaging" },
  { key: "teams", name: "Microsoft Teams", icon: <MessageSquare className="h-4 w-4" />, fieldLabel: "Tenant", fieldPlaceholder: "your-tenant.onmicrosoft.com", category: "Messaging" },
  { key: "github", name: "GitHub", icon: <Github className="h-4 w-4" />, fieldLabel: "Org/Repo", fieldPlaceholder: "org/repo", category: "Code Repositories" },
  { key: "bitbucket", name: "Bitbucket", icon: <Code2 className="h-4 w-4" />, fieldLabel: "Workspace", fieldPlaceholder: "https://bitbucket.org/workspace", category: "Code Repositories" },
  { key: "zendesk", name: "Zendesk", icon: <MessageCircle className="h-4 w-4" />, fieldLabel: "Subdomain", fieldPlaceholder: "your-subdomain.zendesk.com", category: "Customer Feedback" },
  { key: "intercom", name: "Intercom", icon: <MessageCircle className="h-4 w-4" />, fieldLabel: "App ID", fieldPlaceholder: "your-app-id", category: "Customer Feedback" },
  { key: "jira", name: "Jira", icon: <Ticket className="h-4 w-4" />, fieldLabel: "Site URL", fieldPlaceholder: "https://your-site.atlassian.net", category: "Ticketing" },
];

const EMPTY_PROFILE: ProfileConfig = {
  company_context: "",
  company_name: "",
  business_model: "b2c",
  product_type: "web_app",
  project_prefix: "",
  acronyms: [],
  focus_areas: [],
  exclusions: "",
};

export function KB2SettingsPage({ companySlug }: { companySlug: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);

  const [profile, setProfile] = useState<ProfileConfig>(EMPTY_PROFILE);
  const [peopleHints, setPeopleHints] = useState<PersonHint[]>([]);
  const [teamHints, setTeamHints] = useState<TeamHint[]>([]);

  const [connections, setConnections] = useState<Record<string, boolean>>({});
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [kbStructure, setKbStructure] = useState<Record<string, any>>({});
  const [syncConfig, setSyncConfig] = useState<Record<string, any>>({});

  const [focusAreaInput, setFocusAreaInput] = useState("");
  const [newAcronymShort, setNewAcronymShort] = useState("");
  const [newAcronymFull, setNewAcronymFull] = useState("");

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch(`/api/${companySlug}/kb2/config`);
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const data = await res.json();
      if (data.config) {
        const cfg = data.config;
        setProfile(cfg.profile ?? EMPTY_PROFILE);
        setPeopleHints(cfg.people_hints ?? []);
        setTeamHints(cfg.team_hints ?? []);
        const conn: Record<string, boolean> = {};
        const fv: Record<string, string> = {};
        for (const ds of cfg.data_sources ?? []) {
          conn[ds.source] = ds.connected;
          fv[ds.source] = ds.filters?.include?.[0] ?? "";
        }
        setConnections(conn);
        setFieldValues(fv);
        setKbStructure(cfg.kb_structure ?? {});
        setSyncConfig(cfg.sync_config ?? {});
      }
      setActiveVersion(data.active_version);
    } catch (e) {
      console.error("Failed to load config:", e);
    } finally {
      setLoading(false);
    }
  }, [companySlug]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveConfig = async () => {
    setSaving(true);
    try {
      const dataSources = INTEGRATIONS.map((i) => ({
        source: i.key,
        connected: connections[i.key] ?? false,
        filters: { include: fieldValues[i.key] ? [fieldValues[i.key]] : [], exclude: [] },
      }));

      const res = await fetch(`/api/${companySlug}/kb2/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: {
            profile,
            people_hints: peopleHints,
            team_hints: teamHints,
            data_sources: dataSources,
            kb_structure: kbStructure,
            sync_config: syncConfig,
          },
          changed_by: "IT Admin",
          change_summary: "Updated settings",
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      const result = await res.json();
      setActiveVersion(result.version);
      toast.success("Settings saved", { description: `Config version ${result.version}` });
    } catch (e: any) {
      toast.error("Failed to save", { description: e.message });
    } finally {
      setSaving(false);
    }
  };

  const addPersonHint = () => {
    setPeopleHints((prev) => [...prev, { name: "", role: "", slack_handle: "", email: "", focus_areas: [] }]);
  };

  const updatePersonHint = (idx: number, field: keyof PersonHint, value: any) => {
    setPeopleHints((prev) => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };

  const removePersonHint = (idx: number) => {
    setPeopleHints((prev) => prev.filter((_, i) => i !== idx));
  };

  const addTeamHint = () => {
    setTeamHints((prev) => [...prev, { team_name: "", lead: "", members: [], responsibilities: "" }]);
  };

  const updateTeamHint = (idx: number, field: keyof TeamHint, value: any) => {
    setTeamHints((prev) => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
  };

  const removeTeamHint = (idx: number) => {
    setTeamHints((prev) => prev.filter((_, i) => i !== idx));
  };

  if (loading) {
    return (
      <div className="flex flex-1 min-w-0 items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const grouped = INTEGRATIONS.reduce((acc, i) => {
    if (!acc[i.category]) acc[i.category] = [];
    acc[i.category].push(i);
    return acc;
  }, {} as Record<string, IntegrationDef[]>);

  return (
    <div className="flex-1 min-w-0 h-full overflow-y-auto">
      <div className="w-full py-8 px-4 sm:px-6 lg:px-8 space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>Configure {companySlug} &mdash; for IT administrators</span>
              {activeVersion && (
                <Badge variant="outline" className="ml-2 text-[10px]">v{activeVersion}</Badge>
              )}
            </div>
          </div>
          <Button onClick={saveConfig} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save All
          </Button>
        </div>

        <Tabs defaultValue="company" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="company">Company</TabsTrigger>
            <TabsTrigger value="sources">Data Sources</TabsTrigger>
            <TabsTrigger value="people">People & Teams</TabsTrigger>
            <TabsTrigger value="kb">Docs Structure</TabsTrigger>
            <TabsTrigger value="sync">Sync</TabsTrigger>
          </TabsList>

          {/* === Company Tab === */}
          <TabsContent value="company" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building2 className="h-5 w-5" />
                  Company Profile
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Company Name</Label>
                    <Input
                      value={profile.company_name}
                      onChange={(e) => setProfile((p) => ({ ...p, company_name: e.target.value }))}
                      placeholder="PawFinder Inc."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Business Model</Label>
                    <select
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={profile.business_model}
                      onChange={(e) => setProfile((p) => ({ ...p, business_model: e.target.value }))}
                    >
                      <option value="b2c">B2C</option>
                      <option value="b2b">B2B</option>
                      <option value="both">Both</option>
                      <option value="internal">Internal Tool</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>Product Type</Label>
                    <Input
                      value={profile.product_type}
                      onChange={(e) => setProfile((p) => ({ ...p, product_type: e.target.value }))}
                      placeholder="web_app, mobile_app, api, saas..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Project Prefix</Label>
                    <Input
                      value={profile.project_prefix}
                      onChange={(e) => setProfile((p) => ({ ...p, project_prefix: e.target.value }))}
                      placeholder="PAW"
                    />
                    <p className="text-xs text-muted-foreground">Used for generating ticket keys (e.g., PAW-100)</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Info className="h-5 w-5" />
                  Company Context
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Free-text description of the company to help the AI understand your context. This will be injected into LLM prompts.
                </p>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={profile.company_context}
                  onChange={(e) => setProfile((p) => ({ ...p, company_context: e.target.value }))}
                  placeholder="We are a pet adoption platform that connects shelters with potential adopters. Our main products are a web app and mobile app. We use React Native for mobile, Next.js for web, and have a Django API backend..."
                  rows={6}
                  className="resize-y"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Acronyms & Terminology</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {profile.acronyms.map((a, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={a.short}
                      onChange={(e) => {
                        const updated = [...profile.acronyms];
                        updated[idx] = { ...updated[idx], short: e.target.value };
                        setProfile((p) => ({ ...p, acronyms: updated }));
                      }}
                      className="w-24"
                      placeholder="PAW"
                    />
                    <span className="text-muted-foreground">=</span>
                    <Input
                      value={a.full}
                      onChange={(e) => {
                        const updated = [...profile.acronyms];
                        updated[idx] = { ...updated[idx], full: e.target.value };
                        setProfile((p) => ({ ...p, acronyms: updated }));
                      }}
                      className="flex-1"
                      placeholder="PawFinder"
                    />
                    <Button variant="ghost" size="icon" onClick={() => {
                      setProfile((p) => ({ ...p, acronyms: p.acronyms.filter((_, i) => i !== idx) }));
                    }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Input
                    value={newAcronymShort}
                    onChange={(e) => setNewAcronymShort(e.target.value)}
                    className="w-24"
                    placeholder="Short"
                  />
                  <span className="text-muted-foreground">=</span>
                  <Input
                    value={newAcronymFull}
                    onChange={(e) => setNewAcronymFull(e.target.value)}
                    className="flex-1"
                    placeholder="Full name"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      if (newAcronymShort && newAcronymFull) {
                        setProfile((p) => ({ ...p, acronyms: [...p.acronyms, { short: newAcronymShort, full: newAcronymFull }] }));
                        setNewAcronymShort("");
                        setNewAcronymFull("");
                      }
                    }}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Focus Areas & Exclusions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Focus Areas</Label>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {profile.focus_areas.map((area, idx) => (
                      <Badge key={idx} variant="secondary" className="gap-1 pr-1">
                        {area}
                        <button
                          onClick={() => setProfile((p) => ({ ...p, focus_areas: p.focus_areas.filter((_, i) => i !== idx) }))}
                          className="ml-1 hover:text-destructive"
                        >
                          &times;
                        </button>
                      </Badge>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={focusAreaInput}
                      onChange={(e) => setFocusAreaInput(e.target.value)}
                      placeholder="Add focus area..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && focusAreaInput.trim()) {
                          setProfile((p) => ({ ...p, focus_areas: [...p.focus_areas, focusAreaInput.trim()] }));
                          setFocusAreaInput("");
                        }
                      }}
                    />
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (focusAreaInput.trim()) {
                          setProfile((p) => ({ ...p, focus_areas: [...p.focus_areas, focusAreaInput.trim()] }));
                          setFocusAreaInput("");
                        }
                      }}
                    >
                      Add
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Exclusions</Label>
                  <Textarea
                    value={profile.exclusions}
                    onChange={(e) => setProfile((p) => ({ ...p, exclusions: e.target.value }))}
                    placeholder="Things to exclude from analysis (e.g., 'Ignore archived Confluence pages', 'Skip internal-tools repo')"
                    rows={3}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* === Data Sources Tab === */}
          <TabsContent value="sources" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Input Source Connections</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Connect your data sources to power the knowledge base.
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                {Object.entries(grouped).map(([category, items]) => (
                  <div key={category}>
                    <h4 className="text-sm font-medium text-muted-foreground mb-3">{category}</h4>
                    <div className="space-y-0">
                      {items.map((config, idx) => (
                        <div key={config.key}>
                          <div className="flex flex-col sm:flex-row sm:items-center gap-3 py-3 first:pt-0 last:pb-0">
                            <div className="flex items-center gap-3 min-w-[140px]">
                              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground shrink-0">
                                {config.icon}
                              </div>
                              <div>
                                <span className="font-medium text-sm">{config.name}</span>
                                <div className="mt-0.5">
                                  {connections[config.key] ? (
                                    <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[10px]">
                                      <CheckCircle2 className="h-3 w-3 mr-1" />
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
                                value={fieldValues[config.key] ?? ""}
                                onChange={(e) => setFieldValues((p) => ({ ...p, [config.key]: e.target.value }))}
                                className="h-9"
                              />
                            </div>
                            <div className="shrink-0">
                              <Button
                                variant={connections[config.key] ? "destructive" : "default"}
                                size="sm"
                                onClick={() => setConnections((p) => ({ ...p, [config.key]: !p[config.key] }))}
                              >
                                {connections[config.key] ? "Disconnect" : "Connect"}
                              </Button>
                            </div>
                          </div>
                          {idx < items.length - 1 && <Separator className="my-0" />}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          {/* === People & Teams Tab === */}
          <TabsContent value="people" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  Known People
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Pre-seed known team members so the AI can identify them correctly during extraction. Optional — the pipeline discovers people automatically.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {peopleHints.map((person, idx) => (
                  <div key={idx} className="rounded-lg border p-4 space-y-3 relative">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-2 right-2 h-7 w-7"
                      onClick={() => removePersonHint(idx)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Name</Label>
                        <Input
                          value={person.name}
                          onChange={(e) => updatePersonHint(idx, "name", e.target.value)}
                          placeholder="Jane Smith"
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Role</Label>
                        <Input
                          value={person.role}
                          onChange={(e) => updatePersonHint(idx, "role", e.target.value)}
                          placeholder="Senior Backend Engineer"
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Slack Handle</Label>
                        <Input
                          value={person.slack_handle}
                          onChange={(e) => updatePersonHint(idx, "slack_handle", e.target.value)}
                          placeholder="@janesmith"
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Email</Label>
                        <Input
                          value={person.email}
                          onChange={(e) => updatePersonHint(idx, "email", e.target.value)}
                          placeholder="jane@company.com"
                          className="h-8"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Focus Areas (comma-separated)</Label>
                      <Input
                        value={person.focus_areas.join(", ")}
                        onChange={(e) => updatePersonHint(idx, "focus_areas", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                        placeholder="API design, payment integrations"
                        className="h-8"
                      />
                    </div>
                  </div>
                ))}
                <Button variant="outline" onClick={addPersonHint} className="gap-2 w-full">
                  <Plus className="h-4 w-4" />
                  Add Person
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Users className="h-5 w-5" />
                  Known Teams
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Pre-seed known teams for better organization extraction.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {teamHints.map((team, idx) => (
                  <div key={idx} className="rounded-lg border p-4 space-y-3 relative">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-2 right-2 h-7 w-7"
                      onClick={() => removeTeamHint(idx)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Team Name</Label>
                        <Input
                          value={team.team_name}
                          onChange={(e) => updateTeamHint(idx, "team_name", e.target.value)}
                          placeholder="Platform Team"
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Lead</Label>
                        <Input
                          value={team.lead}
                          onChange={(e) => updateTeamHint(idx, "lead", e.target.value)}
                          placeholder="Jane Smith"
                          className="h-8"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Members (comma-separated)</Label>
                      <Input
                        value={team.members.join(", ")}
                        onChange={(e) => updateTeamHint(idx, "members", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                        placeholder="Jane Smith, Bob Jones"
                        className="h-8"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Responsibilities</Label>
                      <Input
                        value={team.responsibilities}
                        onChange={(e) => updateTeamHint(idx, "responsibilities", e.target.value)}
                        placeholder="Core API, infrastructure, DevOps"
                        className="h-8"
                      />
                    </div>
                  </div>
                ))}
                <Button variant="outline" onClick={addTeamHint} className="gap-2 w-full">
                  <Plus className="h-4 w-4" />
                  Add Team
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* === KB Structure Tab === */}
          <TabsContent value="kb" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Docs Layers</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Control which layers and pages appear in the human-readable Docs sidebar.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {Object.entries(kbStructure.layers ?? {}).map(([layerKey, layerData]: [string, any]) => (
                  <div key={layerKey} className="rounded-lg border p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <h4 className="text-sm font-semibold capitalize">{layerKey} Layer</h4>
                        <Badge variant={layerData.enabled ? "default" : "secondary"} className="text-[10px]">
                          {layerData.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      <Switch
                        checked={layerData.enabled ?? true}
                        onCheckedChange={(checked) => {
                          setKbStructure((prev) => ({
                            ...prev,
                            layers: {
                              ...prev.layers,
                              [layerKey]: { ...layerData, enabled: checked },
                            },
                          }));
                        }}
                      />
                    </div>
                    {layerData.pages && layerData.pages.length > 0 && (
                      <div className="space-y-1.5 ml-2">
                        {layerData.pages.map((page: any, pi: number) => (
                          <div key={pi} className="flex items-center gap-3 rounded border px-3 py-2">
                            <input
                              type="checkbox"
                              checked={page.enabled !== false}
                              onChange={(e) => {
                                const pages = [...layerData.pages];
                                pages[pi] = { ...pages[pi], enabled: e.target.checked };
                                setKbStructure((prev) => ({
                                  ...prev,
                                  layers: {
                                    ...prev.layers,
                                    [layerKey]: { ...layerData, pages },
                                  },
                                }));
                              }}
                              className="h-4 w-4"
                            />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium">{page.title}</span>
                              {page.description && (
                                <p className="text-xs text-muted-foreground truncate">{page.description}</p>
                              )}
                            </div>
                            <Badge variant="outline" className="text-[9px] shrink-0">{page.category}</Badge>
                            <div className="flex items-center gap-1 shrink-0">
                              <Label className="text-[10px] text-muted-foreground">Order:</Label>
                              <input
                                type="number"
                                value={page.order ?? pi}
                                onChange={(e) => {
                                  const pages = [...layerData.pages];
                                  pages[pi] = { ...pages[pi], order: Number(e.target.value) };
                                  setKbStructure((prev) => ({
                                    ...prev,
                                    layers: {
                                      ...prev.layers,
                                      [layerKey]: { ...layerData, pages },
                                    },
                                  }));
                                }}
                                className="w-14 h-7 rounded-md border border-input bg-background px-2 py-1 text-xs text-center"
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {Object.keys(kbStructure.layers ?? {}).length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    KB structure will be populated after the first pipeline run.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* === Sync Tab === */}
          <TabsContent value="sync" className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Continuous Sync</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Configure how frequently Pidrax syncs new data from your sources.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Sync Frequency</Label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={syncConfig.frequency ?? "daily"}
                    onChange={(e) => setSyncConfig((p) => ({ ...p, frequency: e.target.value }))}
                  >
                    <option value="manual">Manual Only</option>
                    <option value="hourly">Hourly</option>
                    <option value="every_6_hours">Every 6 Hours</option>
                    <option value="twice_daily">Twice Daily</option>
                    <option value="daily">Daily</option>
                  </select>
                </div>
                <Separator />
                <div className="space-y-3">
                  <Label className="text-sm font-medium">Per-Source Settings</Label>
                  {(syncConfig.sources ?? []).map((src: any, idx: number) => (
                    <div key={idx} className="flex items-center gap-4 rounded-lg border px-4 py-3">
                      <Switch
                        checked={src.enabled ?? true}
                        onCheckedChange={(checked) => {
                          const sources = [...(syncConfig.sources ?? [])];
                          sources[idx] = { ...sources[idx], enabled: checked };
                          setSyncConfig((p) => ({ ...p, sources }));
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium capitalize">{src.source}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="text-xs text-muted-foreground">Strategy:</Label>
                        <select
                          className="flex h-8 rounded-md border border-input bg-background px-2 py-1 text-xs"
                          value={src.strategy ?? "cursor"}
                          onChange={(e) => {
                            const sources = [...(syncConfig.sources ?? [])];
                            sources[idx] = { ...sources[idx], strategy: e.target.value };
                            setSyncConfig((p) => ({ ...p, sources }));
                          }}
                        >
                          <option value="cursor">Cursor-Based</option>
                          <option value="hash">Hash-Based</option>
                        </select>
                      </div>
                    </div>
                  ))}
                  {(syncConfig.sources ?? []).length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      Sync sources will be populated from your connected data sources.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
