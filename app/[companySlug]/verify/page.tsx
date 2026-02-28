"use client";

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { verificationTasks, kbDocuments, type VerificationTask, type KBDocument } from '@/data/mockData';
import { useInspector, type SourceType } from '@/contexts/InspectorContext';
import { User, Calendar, CheckCircle2, Pencil, HelpCircle, AlertTriangle, Loader2, ChevronDown, ChevronRight, Check, X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isDemo } from '@/lib/is-demo';
import { cn } from '@/lib/utils';
import type { VerificationGroup } from '@/src/application/workers/new-test/pidrax-pass2.worker';

interface ApiVerificationTask extends VerificationTask {
  pageId?: string;
  blockId?: string;
}

// ---------------------------------------------------------------------------
// Pidrax Verification (pass2 groups) for non-demo companies
// ---------------------------------------------------------------------------

function PidraxVerifyView({ companySlug }: { companySlug: string }) {
  const [groups, setGroups] = useState<VerificationGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPerson, setSelectedPerson] = useState("all");
  const [expandedSev, setExpandedSev] = useState<Set<string>>(new Set(["S1", "S2"]));
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editInstruction, setEditInstruction] = useState("");
  const [editPreviews, setEditPreviews] = useState<{ item_id: string; page_id: string; page_title: string; section: string; old_text: string; new_text: string }[] | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/${companySlug}/pidrax?type=pass2`);
      if (res.ok) {
        const data = await res.json();
        setGroups(data.verificationGroups || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [companySlug]);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  const displayVerifier = (v: string | null | undefined) => v && v !== "Unassigned" ? v : "Unassigned";

  const verifiers = useMemo(() =>
    [...new Set(groups.map(g => displayVerifier(g.verifier)))] as string[],
    [groups]
  );

  const filtered = useMemo(() => {
    if (selectedPerson === "all") return groups;
    return groups.filter(g => displayVerifier(g.verifier) === selectedPerson);
  }, [groups, selectedPerson]);

  const bySev: Record<string, VerificationGroup[]> = {};
  for (const g of filtered) {
    const sev = g.severity || "S4";
    if (!bySev[sev]) bySev[sev] = [];
    bySev[sev].push(g);
  }

  const handleVerify = async (groupId: string, action: "verify" | "reject") => {
    setVerifying(groupId);
    try {
      await fetch(`/api/${companySlug}/pidrax/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId, action }),
      });
      await fetchGroups();
    } catch { /* ignore */ }
    setVerifying(null);
  };

  const handleEditPreview = async (groupId: string) => {
    if (!editInstruction.trim()) return;
    setEditLoading(true);
    try {
      const res = await fetch(`/api/${companySlug}/pidrax/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group_id: groupId, user_instruction: editInstruction }),
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
      await fetch(`/api/${companySlug}/pidrax/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          group_id: groupId,
          action: "edit",
          rewrites: editPreviews.map(rw => ({ item_id: rw.item_id, new_text: rw.new_text })),
        }),
      });
      await fetchGroups();
    } catch { /* ignore */ }
    setEditLoading(false);
    setEditingGroupId(null);
    setEditInstruction("");
    setEditPreviews(null);
  };

  const selectedGroup = groups.find(g => g.group_id === selectedGroupId);

  const sevLabels: Record<string, { label: string; color: string }> = {
    S1: { label: "S1 — Urgent", color: "bg-red-100 text-red-800 border-red-200" },
    S2: { label: "S2 — This Week", color: "bg-orange-100 text-orange-800 border-orange-200" },
    S3: { label: "S3 — When Possible", color: "bg-yellow-100 text-yellow-800 border-yellow-200" },
    S4: { label: "S4 — Trivial", color: "bg-gray-100 text-gray-700 border-gray-200" },
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        <span className="text-sm">Loading verification groups...</span>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="h-12 w-12 rounded-xl bg-muted/50 flex items-center justify-center mb-4">
          <CheckCircle2 className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="text-base font-semibold mb-1">No verification groups</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Verification groups will appear here after the second-pass pipeline has been run and data replicated.
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-4 items-start">
      <div className={cn("min-w-0 space-y-3", selectedGroup ? "flex-1" : "w-full")}>
        <div className="flex items-center gap-2 mb-3">
          <User className="h-4 w-4 text-muted-foreground" />
          <select
            value={selectedPerson}
            onChange={e => setSelectedPerson(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            <option value="all">All ({groups.length} groups)</option>
            {verifiers.map(v => (
              <option key={v} value={v}>@{v} ({groups.filter(g => displayVerifier(g.verifier) === v).length})</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          {["S1", "S2", "S3", "S4"].map(sev => {
            const sevGroups = bySev[sev] || [];
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
                      const verifierName = displayVerifier(g.verifier);
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
                                <span className={cn(
                                  "text-[9px] px-1.5 py-0.5 rounded-full font-medium",
                                  verifierName === "Unassigned"
                                    ? "bg-gray-100 text-gray-500 italic"
                                    : "bg-indigo-100 text-indigo-700",
                                )}>
                                  @{verifierName}
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
                                disabled={verifying === g.group_id}
                                onClick={() => handleVerify(g.group_id, "verify")}
                              >
                                {verifying === g.group_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
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
                                disabled={verifying === g.group_id}
                                onClick={() => handleVerify(g.group_id, "reject")}
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
      </div>

      {selectedGroup && (
        <div className="w-[400px] shrink-0 sticky top-0 space-y-3">
          <div className="border rounded-lg bg-card shadow-sm p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Group Detail</h4>
              <button onClick={() => setSelectedGroupId(null)} className="text-muted-foreground hover:text-foreground rounded p-0.5 hover:bg-muted">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="text-xs mb-2 bg-muted/50 rounded p-2">{selectedGroup.canonical_text}</p>
            {selectedGroup.reason && (
              <p className="text-[10px] text-muted-foreground mb-3 italic border-l-2 border-muted pl-2">
                {selectedGroup.reason}
              </p>
            )}
            <div className="flex items-center gap-1.5 mb-2">
              <span className={cn(
                "text-[9px] px-1.5 py-0.5 rounded-full font-medium",
                displayVerifier(selectedGroup.verifier) === "Unassigned"
                  ? "bg-gray-100 text-gray-500 italic"
                  : "bg-indigo-100 text-indigo-700",
              )}>
                @{displayVerifier(selectedGroup.verifier)}
              </span>
              <span className="text-[9px] text-muted-foreground">
                Appears on {selectedGroup.page_ids.length} pages
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legacy demo-mode verification
// ---------------------------------------------------------------------------

function DemoVerifyView() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const { showSource } = useInspector();
  const [tasks, setTasks] = useState<ApiVerificationTask[]>(verificationTasks);
  const [docs] = useState<KBDocument[]>(kbDocuments);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<string>("all");

  const allPeople = useMemo(() => {
    const names = new Set<string>();
    for (const task of tasks) {
      if (task.assignee && task.assignee !== "Unassigned") names.add(task.assignee);
    }
    return Array.from(names).sort();
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    if (selectedPerson === "all") return tasks;
    return tasks.filter(t => t.assignee === selectedPerson);
  }, [tasks, selectedPerson]);

  const handleConfirm = async (task: ApiVerificationTask) => {
    const pageId = task.pageId || task.docId;
    const blockId = task.blockId || `${task.sectionId}-0`;
    setConfirming(task.id);
    try {
      const res = await fetch(`/api/${companySlug}/kb/${pageId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockId, action: 'accept' }),
      });
      if (!res.ok) throw new Error('Review failed');
      setTasks(prev => prev.map(t =>
        t.id === task.id ? { ...t, status: 'confirmed' as const } : t
      ));
    } catch { /* ignore */ }
    setConfirming(null);
  };

  const handleTaskClick = (task: ApiVerificationTask) => {
    const doc = docs.find(d => d.id === task.docId);
    if (doc) {
      const section = doc.sections.find(s => s.id === task.sectionId);
      if (section) {
        for (const para of section.paragraphs) {
          if (para.citations.length > 0 && para.text.startsWith(task.snippet.replace('…', '').trim().slice(0, 20))) {
            const cite = para.citations[0];
            showSource(cite.source as SourceType, cite.id);
            return;
          }
        }
      }
    }
    showSource('slack', '__no_match__');
  };

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <User className="h-4 w-4 text-muted-foreground" />
        <select
          value={selectedPerson}
          onChange={e => setSelectedPerson(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm"
        >
          <option value="all">All people ({tasks.length} tasks)</option>
          {allPeople.map(p => {
            const count = tasks.filter(t => t.assignee === p).length;
            return <option key={p} value={p}>{p} ({count} tasks)</option>;
          })}
        </select>
      </div>
      <div className="space-y-3">
        {filteredTasks.map(task => {
          const doc = docs.find(d => d.id === task.docId);
          const isConfirmed = task.status === 'confirmed';
          return (
            <button
              key={task.id}
              onClick={() => handleTaskClick(task)}
              className={`w-full text-left rounded-xl border bg-card p-4 space-y-3 hover:shadow-md transition-shadow cursor-pointer ${isConfirmed ? 'opacity-60' : ''}`}
            >
              <div className="flex items-start gap-3">
                <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${isConfirmed ? 'bg-green-500/10' : 'bg-[hsl(var(--status-needs-review)/0.1)]'}`}>
                  {isConfirmed ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <AlertTriangle className="h-4 w-4" style={{ color: 'hsl(var(--status-needs-review))' }} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm leading-relaxed italic text-muted-foreground">"{task.snippet}"</p>
                  {doc && <p className="text-xs text-muted-foreground mt-1">From: <span className="font-medium text-foreground">{doc.title}</span></p>}
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground pl-11">
                <span className="flex items-center gap-1"><User className="h-3 w-3" />{task.assignee}</span>
                <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{task.dueDate}</span>
                <span className={`badge-status ml-auto ${isConfirmed ? 'badge-verified' : 'badge-needs-review'}`}>
                  {isConfirmed ? 'Confirmed' : 'Pending'}
                </span>
              </div>
              {!isConfirmed && (
                <div className="flex gap-2 pl-11" onClick={e => e.stopPropagation()}>
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1" disabled={confirming === task.id} onClick={() => handleConfirm(task)}>
                    {confirming === task.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Confirm
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1"><Pencil className="h-3 w-3" /> Edit</Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"><HelpCircle className="h-3 w-3" /> Request info</Button>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Verify Page
// ---------------------------------------------------------------------------

export default function VerifyPage() {
  const { companySlug } = useParams<{ companySlug: string }>();

  if (companySlug === "brewandgo2") {
    const KB2VerifyPage = require("@/components/pidrax/kb2/KB2VerifyPage").KB2VerifyPage;
    return <KB2VerifyPage companySlug={companySlug} />;
  }

  const demo = isDemo(companySlug);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold mb-1">Verification Tasks</h1>
          <p className="text-sm text-muted-foreground">
            {demo
              ? 'Claims that need your review and confirmation. Click a task to see its source.'
              : 'Grouped verification items from the second-pass pipeline. Verify once to update across all pages.'}
          </p>
        </div>
        {demo ? <DemoVerifyView /> : <PidraxVerifyView companySlug={companySlug} />}
      </div>
    </div>
  );
}
