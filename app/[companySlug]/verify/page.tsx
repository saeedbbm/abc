"use client";

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { verificationTasks, kbDocuments, type VerificationTask, type KBDocument } from '@/data/mockData';
import { useInspector, type SourceType } from '@/contexts/InspectorContext';
import { User, Calendar, CheckCircle2, Pencil, HelpCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isDemo } from '@/lib/is-demo';

interface ApiVerificationTask extends VerificationTask {
  pageId?: string;
  blockId?: string;
}

export default function VerifyPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const { showSource } = useInspector();
  const demo = isDemo(companySlug);
  const [tasks, setTasks] = useState<ApiVerificationTask[]>(demo ? verificationTasks : []);
  const [docs, setDocs] = useState<KBDocument[]>(demo ? kbDocuments : []);
  const [isLoading, setIsLoading] = useState(!demo);
  const [confirming, setConfirming] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    if (demo) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/${companySlug}/kb`);
      if (!res.ok) throw new Error('Failed to fetch KB');
      const data = await res.json();

      if (data.pages && data.pages.length > 0) {
        const pages = data.pages as (KBDocument & { _id?: string })[];
        setDocs(pages);

        const apiTasks: ApiVerificationTask[] = [];
        for (const page of pages) {
          for (const section of page.sections) {
            for (let i = 0; i < section.paragraphs.length; i++) {
              const para = section.paragraphs[i];
              if (para.confidence === 'needs-verification') {
                apiTasks.push({
                  id: `api-task-${page._id || page.id}-${section.id}-${i}`,
                  docId: page.id,
                  sectionId: section.id,
                  snippet: para.text.length > 80
                    ? para.text.slice(0, 80) + '…'
                    : para.text,
                  assignee: page.author || 'Unassigned',
                  dueDate: page.lastUpdated || 'No date',
                  status: 'pending',
                  pageId: page._id || page.id,
                  blockId: `${section.id}-${i}`,
                });
              }
            }
          }
        }

        setTasks(apiTasks);
      }
    } catch {
      // API unavailable — keep empty state
    } finally {
      setIsLoading(false);
    }
  }, [companySlug, demo]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

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

      // Optimistically update the task status
      setTasks(prev => prev.map(t =>
        t.id === task.id ? { ...t, status: 'confirmed' as const } : t
      ));
    } catch {
      // Silently fail — user can retry
    } finally {
      setConfirming(null);
    }
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
        for (const para of section.paragraphs) {
          if (para.citations.length > 0) {
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
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold mb-1">Verification Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Claims that need your review and confirmation. Click a task to see its source.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            <span className="text-sm">Loading verification tasks…</span>
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="h-12 w-12 rounded-xl bg-muted/50 flex items-center justify-center mb-4">
              <CheckCircle2 className="h-6 w-6 text-muted-foreground" />
            </div>
            <h2 className="text-base font-semibold mb-1">No verification tasks</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              Verification tasks will appear here once the knowledge base has been populated and claims have been extracted.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map(task => {
              const doc = docs.find(d => d.id === task.docId);
              const isConfirmed = task.status === 'confirmed';
              return (
                <button
                  key={task.id}
                  onClick={() => handleTaskClick(task)}
                  className={`w-full text-left rounded-xl border bg-card p-4 space-y-3 hover:shadow-md transition-shadow cursor-pointer ${
                    isConfirmed ? 'opacity-60' : ''
                  }`}
                >
                  {/* Header */}
                  <div className="flex items-start gap-3">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                      isConfirmed
                        ? 'bg-green-500/10'
                        : 'bg-[hsl(var(--status-needs-review)/0.1)]'
                    }`}>
                      {isConfirmed ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <AlertTriangle className="h-4 w-4" style={{ color: 'hsl(var(--status-needs-review))' }} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm leading-relaxed italic text-muted-foreground">"{task.snippet}"</p>
                      {doc && (
                        <p className="text-xs text-muted-foreground mt-1">
                          From: <span className="font-medium text-foreground">{doc.title}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Meta */}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground pl-11">
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {task.assignee}
                    </span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {task.dueDate}
                    </span>
                    <span className={`badge-status ml-auto ${
                      isConfirmed ? 'badge-verified' : 'badge-needs-review'
                    }`}>
                      {isConfirmed ? 'Confirmed' : 'Pending'}
                    </span>
                  </div>

                  {/* Actions */}
                  {!isConfirmed && (
                    <div className="flex gap-2 pl-11" onClick={e => e.stopPropagation()}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        disabled={confirming === task.id}
                        onClick={() => handleConfirm(task)}
                      >
                        {confirming === task.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3" />
                        )}
                        Confirm
                      </Button>
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                        <Pencil className="h-3 w-3" /> Edit
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                        <HelpCircle className="h-3 w-3" /> Request info
                      </Button>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
