"use client";

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { kbDocuments, type KBDocument } from '@/data/mockData';
import { useInspector, type SourceType, type CitationSource } from '@/contexts/InspectorContext';
import { ChevronRight, ChevronDown, FileText, CheckCircle2, AlertTriangle, AlertCircle, Sparkles, Loader2, Link2 } from 'lucide-react';
import { isDemo } from '@/lib/is-demo';
import { KB_CATEGORY_LABELS, type KBCategory } from '@/src/entities/models/score-format';

const CATEGORY_ORDER: KBCategory[] = [
  "company_overview", "setup_onboarding", "people", "clients",
  "past_documented", "past_undocumented", "ongoing_projects", "new_projects", "processes",
];

const statusConfig: Record<string, { label: string; className: string; icon: any }> = {
  verified: { label: 'Verified', className: 'badge-verified', icon: CheckCircle2 },
  accepted: { label: 'Verified', className: 'badge-verified', icon: CheckCircle2 },
  'needs-review': { label: 'Needs review', className: 'badge-needs-review', icon: AlertTriangle },
  in_review: { label: 'In review', className: 'badge-needs-review', icon: AlertTriangle },
  conflict: { label: 'Conflicts', className: 'badge-conflict', icon: AlertCircle },
  new: { label: 'New', className: 'badge-new', icon: Sparkles },
  draft: { label: 'Draft', className: 'badge-new', icon: Sparkles },
};
const defaultStatus = { label: 'Draft', className: 'badge-new', icon: Sparkles };

const confidenceLabels: Record<string, string> = {
  verified: 'Verified',
  inferred: 'Inferred',
  'needs-verification': 'Needs verification',
};

function KB2Gate() {
  const { companySlug } = useParams<{ companySlug: string }>();
  if (companySlug === "brewandgo2") {
    const KB2KBPage = require("@/components/pidrax/kb2/KB2KBPage").KB2KBPage;
    return <KB2KBPage companySlug={companySlug} />;
  }
  return null;
}

export default function KBPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  if (companySlug === "brewandgo2") return <KB2Gate />;
  const demo = isDemo(companySlug);
  const [documents, setDocuments] = useState<KBDocument[]>(demo ? kbDocuments : []);
  const [selectedDoc, setSelectedDoc] = useState<KBDocument | null>(demo ? kbDocuments[0] : null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() =>
    demo ? new Set(kbDocuments.map(d => d.category)) : new Set()
  );
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [isLoading, setIsLoading] = useState(!demo);
  const [activePara, setActivePara] = useState<string | null>(null);
  const { showSource, showCitations, hideSource } = useInspector();

  const docCategories = new Set(documents.map(d => d.category));
  const categories = CATEGORY_ORDER.filter(c => docCategories.has(c) || docCategories.has(c.replace(/_/g, ' ')));
  // Also include any categories from the API that don't match the new system (backward compat)
  for (const cat of docCategories) {
    if (!categories.includes(cat as KBCategory)) categories.push(cat as KBCategory);
  }

  const fetchDocuments = useCallback(async () => {
    if (demo) return;
    setIsLoading(true);
    try {
      // Try pidrax inputs first (for companies with pidrax data)
      const pidraxRes = await fetch(`/api/${companySlug}/pidrax?type=inputs`);
      if (pidraxRes.ok) {
        const pidraxData = await pidraxRes.json();
        if (pidraxData.inputs) {
          const inputDocs: KBDocument[] = [];
          const inputs = pidraxData.inputs as Record<string, string>;
          for (const [source, content] of Object.entries(inputs)) {
            if (!content || typeof content !== 'string') continue;
            const paragraphs = content.split('\n\n').filter((p: string) => p.trim().length > 0);
            inputDocs.push({
              id: `input-${source}`,
              title: source.charAt(0).toUpperCase() + source.slice(1).replace(/([A-Z])/g, ' $1'),
              category: source,
              status: 'new' as const,
              lastUpdated: pidraxData.createdAt ? new Date(pidraxData.createdAt).toLocaleDateString() : '',
              author: 'Pidrax Sync',
              sections: [{
                id: `section-${source}`,
                heading: 'Content',
                paragraphs: paragraphs.length > 0
                  ? paragraphs.map((text: string, i: number) => ({
                      text: text.trim(),
                      confidence: 'inferred' as const,
                      citations: [],
                    }))
                  : [{ text: '(empty)', confidence: 'inferred' as const, citations: [] }],
              }],
            });
          }
          if (inputDocs.length > 0) {
            setDocuments(inputDocs);
            setSelectedDoc(inputDocs[0]);
            setExpandedCategories(new Set(inputDocs.map(d => d.category)));
            setIsLoading(false);
            return;
          }
        }
      }

      // Fallback to standard KB endpoint
      const res = await fetch(`/api/${companySlug}/kb`);
      if (!res.ok) throw new Error('Failed to fetch KB');
      const data = await res.json();
      if (data.pages && data.pages.length > 0) {
        const pages = data.pages as KBDocument[];
        setDocuments(pages);
        setSelectedDoc(pages[0]);
        setExpandedCategories(new Set(pages.map((d: KBDocument) => d.category)));
      }
    } catch {
      // API unavailable — keep empty state
    } finally {
      setIsLoading(false);
    }
  }, [companySlug, demo]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleDocClick = async (doc: KBDocument) => {
    setEditingKey(null);
    setActivePara(null);
    hideSource();

    const docAny = doc as KBDocument & { _id?: string };
    if (docAny._id) {
      try {
        const res = await fetch(`/api/${companySlug}/kb/${docAny._id}`);
        if (res.ok) {
          const fullDoc = await res.json();
          setSelectedDoc(fullDoc);
          return;
        }
      } catch {
        // Fall through
      }
    }

    setSelectedDoc(doc);
  };

  const handleParaClick = (paraKey: string, citations: any[]) => {
    if (citations.length === 0) return;

    setActivePara(paraKey);

    if (demo) {
      // Demo mode: use legacy single-source approach
      const c = citations[0];
      showSource(c.source as SourceType, c.id);
    } else {
      // Real data: pass all citations with embedded previews
      const mapped: CitationSource[] = citations.map((c: any) => ({
        id: c.id,
        source: c.source as SourceType,
        label: c.label || 'Source',
        detail: c.detail,
        date: c.date,
        docId: c.docId,
        url: c.url,
        sourcePreview: c.sourcePreview,
      }));
      showCitations(mapped);
    }
  };

  const handleDoubleClick = (key: string, text: string) => {
    setEditingKey(key);
    setEditText(text);
  };

  const handleSave = async (sectionId: string, paraIndex: number) => {
    const docAny = selectedDoc as KBDocument & { _id?: string };
    const blockId = `${sectionId}-${paraIndex}`;

    if (docAny._id) {
      try {
        await fetch(`/api/${companySlug}/kb/${docAny._id}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blockId, action: 'edit', editedText: editText }),
        });
      } catch {
        // Silently fail — local edit still applies
      }
    }

    setSelectedDoc(prev => ({
      ...prev,
      sections: prev.sections.map(s =>
        s.id === sectionId
          ? {
              ...s,
              paragraphs: s.paragraphs.map((p, i) =>
                i === paraIndex ? { ...p, text: editText } : p
              ),
            }
          : s
      ),
    }));

    setEditingKey(null);
    setEditText('');
  };

  const handleCancel = () => {
    setEditingKey(null);
    setEditText('');
  };

  return (
    <div className="flex h-full">
      {/* Tree sidebar */}
      <div className="w-64 shrink-0 border-r flex flex-col bg-card">
        <div className="p-3 border-b">
          <h2 className="text-sm font-semibold">Knowledge Base</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span className="text-xs">Loading…</span>
            </div>
          ) : documents.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <span className="text-xs">No pages yet</span>
            </div>
          ) : (
            categories.map(cat => {
              const docs = documents.filter(d => d.category === cat);
              const isExpanded = expandedCategories.has(cat);
              return (
                <div key={cat} className="mb-1">
                  <button
                    onClick={() => toggleCategory(cat)}
                    className="flex items-center gap-1.5 w-full rounded-md px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent transition-colors"
                  >
                    {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    {KB_CATEGORY_LABELS[cat as KBCategory] || cat}
                    <span className="ml-auto text-[10px] text-muted-foreground/60">{docs.length}</span>
                  </button>
                  {isExpanded && (
                    <div className="ml-2 border-l pl-1">
                      {docs.map(doc => {
                        const sc = statusConfig[doc.status] || defaultStatus;
                        return (
                          <button
                            key={doc.id}
                            onClick={() => handleDocClick(doc)}
                            className={`w-full text-left rounded-md px-2 py-1.5 transition-colors flex items-start gap-1.5 ${
                              selectedDoc?.id === doc.id ? 'bg-accent' : 'hover:bg-accent/50'
                            }`}
                          >
                            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                            <div className="min-w-0">
                              <p className="text-xs font-medium truncate">{doc.title}</p>
                              <div className="flex items-center gap-1 mt-0.5">
                                <span className={`badge-status ${sc.className} text-[9px] py-0`}>{sc.label}</span>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Document reader */}
      {selectedDoc ? (
      <div className="flex-1 overflow-y-auto p-6 animate-fade-in" key={selectedDoc.id}>
        <div className="max-w-2xl">
          {/* Header */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className={`badge-status ${(statusConfig[selectedDoc.status] || defaultStatus).className}`}>
                {(statusConfig[selectedDoc.status] || defaultStatus).label}
              </span>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">{selectedDoc.category}</span>
            </div>
            <h1 className="text-xl font-semibold mb-1">{selectedDoc.title}</h1>
            <p className="text-xs text-muted-foreground">
              {selectedDoc.author && <>Generated by {selectedDoc.author} · </>}
              {selectedDoc.lastUpdated ? `Last updated ${selectedDoc.lastUpdated}` : selectedDoc.updatedAt ? `Last updated ${new Date(selectedDoc.updatedAt).toLocaleDateString()}` : ''}
              {selectedDoc.verifiedBy && ` · Verified by ${selectedDoc.verifiedBy}`}
            </p>
          </div>

          {/* Sections */}
          {(selectedDoc.sections || []).map(section => (
            <div key={section.id} className="mb-6">
              <h2 className="text-base font-semibold mb-3">{section.heading}</h2>
              <div className="space-y-1">
                {section.paragraphs.map((para, i) => {
                  const paraKey = `${section.id}-${i}`;
                  const isEditing = editingKey === paraKey;
                  const isActive = activePara === paraKey;
                  const hasSources = para.citations && para.citations.length > 0;
                  return (
                    <div
                      key={i}
                      className={`group relative confidence-${para.confidence} py-1.5 rounded-r transition-all duration-150 ${
                        hasSources ? 'cursor-pointer hover:bg-accent/20' : ''
                      } ${isActive ? 'bg-accent/30' : ''}`}
                      onClick={() => handleParaClick(paraKey, para.citations || [])}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleDoubleClick(paraKey, para.text);
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        {isEditing ? (
                          <textarea
                            value={editText}
                            onChange={e => setEditText(e.target.value)}
                            onClick={e => e.stopPropagation()}
                            onBlur={handleCancel}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && e.ctrlKey) {
                                e.preventDefault();
                                handleSave(section.id, i);
                              }
                              if (e.key === 'Escape') handleCancel();
                            }}
                            className="flex-1 text-sm leading-relaxed rounded-md border bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring resize-none min-h-[60px]"
                            autoFocus
                          />
                        ) : (
                          <p className="text-sm leading-relaxed flex-1">{para.text}</p>
                        )}
                        <div className="flex items-center gap-1 shrink-0">
                          {hasSources && (
                            <Link2 className={`h-3 w-3 transition-opacity ${
                              isActive ? 'opacity-60' : 'opacity-0 group-hover:opacity-40'
                            }`} />
                          )}
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                            para.confidence === 'verified' ? 'badge-verified' :
                            para.confidence === 'inferred' ? 'badge-needs-review' : 'badge-conflict'
                          }`}>
                            {confidenceLabels[para.confidence] || para.confidence}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

        </div>
      </div>
      ) : (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <div className="h-12 w-12 rounded-xl bg-muted/50 flex items-center justify-center mb-4 mx-auto">
            <FileText className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold mb-1">No KB pages yet</h2>
          <p className="text-sm text-muted-foreground">
            Knowledge base pages will appear here after data has been synced and the doc-audit pipeline has processed your documents.
          </p>
        </div>
      </div>
      )}
    </div>
  );
}
