"use client";

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { kbDocuments, type KBDocument } from '@/data/mockData';
import { SourceChip } from '@/components/pidrax/SourceChip';
import { useInspector, type SourceType } from '@/contexts/InspectorContext';
import { ChevronRight, ChevronDown, FileText, CheckCircle2, AlertTriangle, AlertCircle, Sparkles, Loader2 } from 'lucide-react';

const statusConfig = {
  verified: { label: 'Verified', className: 'badge-verified', icon: CheckCircle2 },
  'needs-review': { label: 'Needs review', className: 'badge-needs-review', icon: AlertTriangle },
  conflict: { label: 'Conflicts', className: 'badge-conflict', icon: AlertCircle },
  new: { label: 'New', className: 'badge-new', icon: Sparkles },
};

const confidenceLabels = {
  verified: 'Verified',
  inferred: 'Inferred',
  'needs-verification': 'Needs verification',
};

export default function KBPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const [documents, setDocuments] = useState<KBDocument[]>(kbDocuments);
  const [selectedDoc, setSelectedDoc] = useState<KBDocument>(kbDocuments[0]);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() =>
    new Set(kbDocuments.map(d => d.category))
  );
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { showSource } = useInspector();

  const categories = Array.from(new Set(documents.map(d => d.category)));

  const fetchDocuments = useCallback(async () => {
    setIsLoading(true);
    try {
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
      // API unavailable — keep mock data as fallback
    } finally {
      setIsLoading(false);
    }
  }, [companySlug]);

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

    // If the document has a MongoDB _id, fetch full content
    const docAny = doc as KBDocument & { _id?: string };
    if (docAny._id) {
      try {
        const res = await fetch(`/api/${companySlug}/kb/${docAny._id}`);
        if (res.ok) {
          const fullDoc = await res.json();
          setSelectedDoc(fullDoc);
          showFirstCitation(fullDoc);
          return;
        }
      } catch {
        // Fall through to using the doc as-is
      }
    }

    setSelectedDoc(doc);
    showFirstCitation(doc);
  };

  const showFirstCitation = (doc: KBDocument) => {
    for (const section of doc.sections) {
      for (const para of section.paragraphs) {
        if (para.citations.length > 0) {
          const c = para.citations[0];
          showSource(c.source as SourceType, c.id);
          return;
        }
      }
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

    // Apply local edit optimistically
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
                    {cat}
                    <span className="ml-auto text-[10px] text-muted-foreground/60">{docs.length}</span>
                  </button>
                  {isExpanded && (
                    <div className="ml-2 border-l pl-1">
                      {docs.map(doc => {
                        const sc = statusConfig[doc.status];
                        return (
                          <button
                            key={doc.id}
                            onClick={() => handleDocClick(doc)}
                            className={`w-full text-left rounded-md px-2 py-1.5 transition-colors flex items-start gap-1.5 ${
                              selectedDoc.id === doc.id ? 'bg-accent' : 'hover:bg-accent/50'
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
      <div className="flex-1 overflow-y-auto p-6 animate-fade-in" key={selectedDoc.id}>
        <div className="max-w-2xl">
          {/* Header */}
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className={`badge-status ${statusConfig[selectedDoc.status].className}`}>
                {statusConfig[selectedDoc.status].label}
              </span>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">{selectedDoc.category}</span>
            </div>
            <h1 className="text-xl font-semibold mb-1">{selectedDoc.title}</h1>
            <p className="text-xs text-muted-foreground">
              Generated by {selectedDoc.author} · Last updated {selectedDoc.lastUpdated}
              {selectedDoc.verifiedBy && ` · Verified by ${selectedDoc.verifiedBy}`}
            </p>
          </div>

          {/* Sections */}
          {selectedDoc.sections.map(section => (
            <div key={section.id} className="mb-6">
              <h2 className="text-base font-semibold mb-3">{section.heading}</h2>
              <div className="space-y-3">
                {section.paragraphs.map((para, i) => {
                  const paraKey = `${section.id}-${i}`;
                  const isEditing = editingKey === paraKey;
                  return (
                    <div
                      key={i}
                      className={`confidence-${para.confidence} py-1 cursor-pointer hover:bg-accent/30 rounded-r transition-colors`}
                      onClick={() => {
                        if (para.citations.length > 0) {
                          const c = para.citations[0];
                          showSource(c.source as SourceType, c.id);
                        }
                      }}
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
                        <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${
                          para.confidence === 'verified' ? 'badge-verified' :
                          para.confidence === 'inferred' ? 'badge-needs-review' : 'badge-conflict'
                        }`}>
                          {confidenceLabels[para.confidence]}
                        </span>
                      </div>
                      {para.citations.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {para.citations.map(c => (
                            <SourceChip key={c.id} source={c.source} label={c.label} citationId={c.id} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
