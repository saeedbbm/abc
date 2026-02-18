"use client";

import { useState, useRef, useEffect, useCallback } from 'react';
import { useInspector, type CitationSource } from '@/contexts/InspectorContext';
import { SlackMock } from './SlackMock';
import { JiraMock } from './JiraMock';
import { ConfluenceMock } from './ConfluenceMock';
import { TerminalMock } from './TerminalMock';
import { X, ExternalLink, Hash, User, Clock, Tag, ChevronDown } from 'lucide-react';


function SourceIcon({ source, className }: { source: string; className?: string }) {
  if (source === 'slack') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.528 2.528 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
      </svg>
    );
  }
  if (source === 'confluence') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.487-.843.79-1.404 1.68-3.11 3.381-2.726 6.46-1.102l4.665 2.463a.766.766 0 0 0 1.03-.338l2.592-5.205a.766.766 0 0 0-.344-1.028c-1.42-.706-4.348-2.163-6.834-3.475C8.27 9.84 3.884 11.32.87 18.257zM23.131 5.743c.249-.382.531-.875.764-1.245a.764.764 0 0 0-.256-1.04L18.674.404a.764.764 0 0 0-1.058.26c-.199.332-.487.843-.789 1.404-1.681 3.11-3.382 2.726-6.461 1.102L5.702.707a.766.766 0 0 0-1.03.338L2.08 6.25a.766.766 0 0 0 .344 1.028c1.42.706 4.348 2.163 6.834 3.475 6.48 3.408 10.866 1.928 13.873-5.01z" />
      </svg>
    );
  }
  if (source === 'jira') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24.013 12.5V1.005A1.005 1.005 0 0 0 23.013 0z" />
      </svg>
    );
  }
  return null;
}

/**
 * Main inspector component.
 * When citations are present (from a clicked paragraph), renders stacked source cards.
 * Falls back to legacy mock views for demo mode.
 */
export function ContextInspector() {
  const { state, hideSource } = useInspector();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const handleDoubleClick = (id: string, text: string) => {
    setEditingId(id);
    setEditText(text);
  };

  const handleSave = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditText('');
  };

  if (!state.source) return null;

  // Citations mode: stacked source cards
  if (state.citations.length > 0) {
    return (
      <div className="inspector-panel flex flex-col border-l rounded-l-xl h-full">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0">
          <span className="text-xs font-medium flex-1 text-muted-foreground">
            {state.citations.length} source{state.citations.length !== 1 ? 's' : ''}
          </span>
          <button
            onClick={hideSource}
            className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <SourceCardStack citations={state.citations} companySlug={state.companySlug} />
        </div>
      </div>
    );
  }

  // Legacy single-source mode (demo/mock)
  const renderContent = () => {
    if (state.source === 'terminal') return <TerminalMock />;
    if (state.source === 'slack') return <SlackMock editingId={editingId} editText={editText} onEditText={setEditText} onDoubleClick={handleDoubleClick} />;
    if (state.source === 'confluence') return <ConfluenceMock editingId={editingId} editText={editText} onEditText={setEditText} onDoubleClick={handleDoubleClick} />;
    if (state.source === 'jira') return <JiraMock editingId={editingId} editText={editText} onEditText={setEditText} onDoubleClick={handleDoubleClick} />;
    return null;
  };

  return (
    <div className="inspector-panel flex flex-col border-l rounded-l-xl h-full">
      {state.source && state.source !== 'terminal' && (
        <div className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0">
          <SourceIcon source={state.source} className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium capitalize flex-1">{state.source}</span>
          <button
            onClick={hideSource}
            className="h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {editingId && (
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-primary/5">
          <span className="text-xs text-muted-foreground flex-1">Editing…</span>
          <button onClick={handleSave} className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            Save
          </button>
          <button onClick={handleCancel} className="rounded-md border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
            Cancel
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {renderContent()}
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────── */
/*  Stacked Source Cards                                       */
/* ─────────────────────────────────────────────────────────── */

function SourceCardStack({ citations, companySlug }: { citations: CitationSource[]; companySlug?: string }) {
  const [expandedId, setExpandedId] = useState<string | null>(
    citations.length === 1 ? citations[0].id : null
  );
  const [lastCollapsedId, setLastCollapsedId] = useState<string | null>(null);

  // Auto-expand the first card
  useEffect(() => {
    if (citations.length === 1) {
      setExpandedId(citations[0].id);
    } else {
      setExpandedId(null);
    }
    setLastCollapsedId(null);
  }, [citations]);

  const handleToggle = useCallback((id: string) => {
    setExpandedId(prev => {
      if (prev === id) {
        setLastCollapsedId(id);
        return null;
      }
      setLastCollapsedId(null);
      return id;
    });
  }, []);

  // Clear highlight after 2 seconds
  useEffect(() => {
    if (!lastCollapsedId) return;
    const t = setTimeout(() => setLastCollapsedId(null), 2000);
    return () => clearTimeout(t);
  }, [lastCollapsedId]);

  return (
    <div className="p-2 space-y-1.5">
      {citations.map((cit) => (
        <SourceCard
          key={cit.id}
          citation={cit}
          isExpanded={expandedId === cit.id}
          isHighlighted={lastCollapsedId === cit.id}
          onToggle={() => handleToggle(cit.id)}
          companySlug={companySlug}
        />
      ))}
    </div>
  );
}


function SourceCard({
  citation,
  isExpanded,
  isHighlighted,
  onToggle,
  companySlug,
}: {
  citation: CitationSource;
  isExpanded: boolean;
  isHighlighted: boolean;
  onToggle: () => void;
  companySlug?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [isExpanded, citation]);

  // When expanding, scroll so the card top is visible
  useEffect(() => {
    if (isExpanded && cardRef.current) {
      cardRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isExpanded]);

  const preview = citation.sourcePreview;
  const sourceUrl = citation.url || preview?.url;

  return (
    <div
      ref={cardRef}
      className={`rounded-lg border overflow-hidden transition-all duration-200 ${
        isHighlighted
          ? 'ring-2 ring-primary/30 border-primary/20'
          : isExpanded
          ? 'border-border shadow-sm'
          : 'border-border/60 hover:border-border'
      }`}
    >
      {/* Card header — always visible */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/30 transition-colors"
      >
        <SourceIcon source={citation.source} className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{citation.label}</p>
          {!isExpanded && preview?.excerpt && (
            <p className="text-[10px] text-muted-foreground truncate mt-0.5">
              {preview.excerpt.substring(0, 80)}
            </p>
          )}
        </div>
        <ChevronDown className={`h-3 w-3 text-muted-foreground shrink-0 transition-transform duration-200 ${
          isExpanded ? 'rotate-180' : ''
        }`} />
      </button>

      {/* Expandable content — anchored at top, grows downward */}
      <div
        style={{
          maxHeight: isExpanded ? `${Math.max(contentHeight, 200)}px` : '0px',
          opacity: isExpanded ? 1 : 0,
        }}
        className="transition-all duration-200 ease-out overflow-hidden"
      >
        <div ref={contentRef}>
          <div className="border-t">
            {preview ? (
              <SourcePreviewContent preview={preview} source={citation.source} />
            ) : citation.docId && companySlug ? (
              <LazySourceContent source={citation.source} docId={citation.docId} companySlug={companySlug} />
            ) : (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                {citation.detail || 'No preview available'}
              </div>
            )}

            {/* Open in new tab button */}
            {sourceUrl && (
              <div className="px-3 py-2 border-t bg-muted/20">
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[10px] font-medium text-primary hover:text-primary/80 transition-colors"
                  onClick={e => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3" />
                  Open in new tab
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────── */
/*  Source Preview Renderers — pixel-matched to mock UIs       */
/* ─────────────────────────────────────────────────────────── */

function SourcePreviewContent({ preview, source }: { preview: NonNullable<CitationSource['sourcePreview']>; source: string }) {
  if (source === 'slack') return <SlackPreview preview={preview} />;
  if (source === 'jira') return <JiraPreview preview={preview} />;
  if (source === 'confluence') return <ConfluencePreview preview={preview} />;
  return <GenericPreview preview={preview} />;
}

/* ── Slack — matches SlackMock.tsx ── */

const AVATAR_COLORS = [
  'hsl(200, 60%, 45%)', 'hsl(340, 65%, 47%)', 'hsl(160, 50%, 40%)',
  'hsl(45, 70%, 50%)', 'hsl(270, 50%, 50%)', 'hsl(20, 65%, 50%)',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string): string {
  if (!name || name === 'Unknown') return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function SlackMessage({ author, text, timestamp }: { author: string; text: string; timestamp: string }) {
  const initials = getInitials(author);
  const color = getAvatarColor(author);

  return (
    <div className="flex gap-2.5 px-4 py-2 hover:bg-gray-50 transition-colors">
      <div
        className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-xs font-bold text-white"
        style={{ backgroundColor: color }}
      >
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold" style={{ color: '#1D1C1D' }}>{author}</span>
          <span className="text-xs" style={{ color: '#616061' }}>{timestamp}</span>
        </div>
        <p className="text-[15px] leading-relaxed mt-0.5 whitespace-pre-wrap break-words" style={{ color: '#1D1C1D' }}>
          {text}
        </p>
      </div>
    </div>
  );
}

function SlackPreview({ preview }: { preview: NonNullable<CitationSource['sourcePreview']> }) {
  const messages = (preview as any).messages as Array<{ author: string; text: string; timestamp: string }> | undefined;
  const hasMultipleMessages = messages && messages.length > 0;

  // Single message mode (slack_message)
  const author = preview.author || 'Unknown';
  const timestamp = preview.date
    ? new Date(preview.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      + ' · ' + new Date(preview.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '';

  return (
    <div className="flex flex-col">
      {/* Channel header — Slack purple */}
      {preview.channelName && (
        <div className="flex items-center gap-2 px-4 py-2" style={{ backgroundColor: 'hsl(283, 72%, 18%)', borderBottom: '1px solid hsl(283, 40%, 25%)' }}>
          <Hash className="h-3.5 w-3.5" style={{ color: 'hsl(283, 20%, 65%)' }} />
          <span className="text-[13px] font-bold text-white">{preview.channelName}</span>
        </div>
      )}

      {/* Messages area — white bg like Slack */}
      <div className="bg-white py-1">
        {hasMultipleMessages ? (
          /* Conversation: multiple messages */
          messages.map((msg, i) => (
            <SlackMessage key={i} author={msg.author} text={msg.text} timestamp={msg.timestamp} />
          ))
        ) : (
          /* Single message */
          <SlackMessage author={author} text={preview.excerpt} timestamp={timestamp} />
        )}
      </div>

      {/* Reactions — for single message */}
      {!hasMultipleMessages && preview.reactions && preview.reactions.length > 0 && (
        <div className="flex gap-1 px-4 pb-2 bg-white">
          {preview.reactions.map((r, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs cursor-pointer transition-colors hover:bg-gray-100"
              style={{ borderColor: '#DFE1E6', backgroundColor: '#fff', color: '#1D1C1D' }}
            >
              {r.name} <span style={{ color: '#616061' }}>{r.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Jira — matches JiraMock.tsx ── */
const jiraStatusColors: Record<string, { bg: string; text: string }> = {
  'To Do': { bg: '#DFE1E6', text: '#42526E' },
  'In Progress': { bg: '#DEEBFF', text: '#0747A6' },
  'Done': { bg: '#E3FCEF', text: '#006644' },
  'In Review': { bg: '#EAE6FF', text: '#403294' },
  'Open': { bg: '#DEEBFF', text: '#0747A6' },
  'Closed': { bg: '#E3FCEF', text: '#006644' },
};

const jiraPriorityIcons: Record<string, { color: string; arrow: string }> = {
  Critical: { color: '#FF5630', arrow: '⬆' },
  Highest: { color: '#FF5630', arrow: '⬆' },
  High: { color: '#FF7452', arrow: '⬆' },
  Medium: { color: '#FFAB00', arrow: '⬆' },
  Low: { color: '#2684FF', arrow: '⬇' },
  Lowest: { color: '#2684FF', arrow: '⬇' },
};

function JiraPreview({ preview }: { preview: NonNullable<CitationSource['sourcePreview']> }) {
  const sc = jiraStatusColors[preview.status || ''] || { bg: '#DEEBFF', text: '#0747A6' };
  const pc = jiraPriorityIcons[preview.priority || ''] || { color: '#FFAB00', arrow: '⬆' };
  const assigneeInitials = preview.assignee
    ? preview.assignee.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : '?';

  return (
    <div className="flex flex-col bg-white">
      {/* Jira top bar */}
      <div className="h-9 flex items-center px-4 shrink-0" style={{ borderBottom: '1px solid #DFE1E6' }}>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: '#5E6C84' }}>
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="#2684FF">
            <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24.013 12.5V1.005A1.005 1.005 0 0 0 23.013 0z" />
          </svg>
          {preview.issueKey && <span style={{ color: '#172B4D', fontWeight: 600 }}>{preview.issueKey}</span>}
        </div>
      </div>

      <div className="p-4">
        {/* Type badge + key */}
        <div className="flex items-center gap-2 mb-2">
          {preview.issueType && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase" style={{ backgroundColor: '#E9F2FF', color: '#0747A6' }}>
              {preview.issueType}
            </span>
          )}
        </div>

        {/* Title */}
        <h2 className="text-base font-semibold mb-3" style={{ color: '#172B4D' }}>{preview.title}</h2>

        {/* Fields grid — same layout as JiraMock */}
        <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 mb-4 text-sm">
          {preview.status && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#6B778C' }}>Status</p>
              <span className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{ backgroundColor: sc.bg, color: sc.text }}>
                {preview.status}
              </span>
            </div>
          )}
          {preview.priority && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#6B778C' }}>Priority</p>
              <span className="flex items-center gap-1 text-xs" style={{ color: '#172B4D' }}>
                <span style={{ color: pc.color }}>{pc.arrow}</span>
                {preview.priority}
              </span>
            </div>
          )}
          {preview.assignee && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#6B778C' }}>Assignee</p>
              <span className="flex items-center gap-1.5 text-xs" style={{ color: '#172B4D' }}>
                <span className="h-5 w-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white" style={{ backgroundColor: '#00875A' }}>
                  {assigneeInitials}
                </span>
                {preview.assignee}
              </span>
            </div>
          )}
          {preview.date && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#6B778C' }}>Created</p>
              <span className="text-xs" style={{ color: '#172B4D' }}>
                {new Date(preview.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
          )}
        </div>

        {/* Description */}
        {preview.excerpt && (
          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: '#5E6C84' }}>Description</h4>
            <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: '#172B4D' }}>
              {preview.excerpt}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Confluence — matches ConfluenceMock.tsx ── */
function ConfluencePreview({ preview }: { preview: NonNullable<CitationSource['sourcePreview']> }) {
  const authorInitials = preview.author
    ? preview.author.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : 'P';
  const dateStr = preview.date
    ? new Date(preview.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  // Split excerpt into content blocks for Confluence-like rendering
  const contentBlocks = (preview.excerpt || '').split('\n').filter(l => l.trim().length > 0);

  return (
    <div className="flex flex-col bg-white">
      {/* Confluence top bar */}
      <div className="h-9 flex items-center px-4 shrink-0" style={{ borderBottom: '1px solid #DFE1E6' }}>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: '#5E6C84' }}>
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="#1868DB">
            <path d="M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.487-.843.79-1.404 1.68-3.11 3.381-2.726 6.46-1.102l4.665 2.463a.766.766 0 0 0 1.03-.338l2.592-5.205a.766.766 0 0 0-.344-1.028c-1.42-.706-4.348-2.163-6.834-3.475C8.27 9.84 3.884 11.32.87 18.257zM23.131 5.743c.249-.382.531-.875.764-1.245a.764.764 0 0 0-.256-1.04L18.674.404a.764.764 0 0 0-1.058.26c-.199.332-.487.843-.789 1.404-1.681 3.11-3.382 2.726-6.461 1.102L5.702.707a.766.766 0 0 0-1.03.338L2.08 6.25a.766.766 0 0 0 .344 1.028c1.42.706 4.348 2.163 6.834 3.475 6.48 3.408 10.866 1.928 13.873-5.01z" />
          </svg>
          {preview.breadcrumbs && preview.breadcrumbs.length > 0 ? (
            preview.breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span style={{ color: '#5E6C84' }}>›</span>}
                <span style={{ color: i === preview.breadcrumbs!.length - 1 ? '#172B4D' : '#5E6C84', fontWeight: i === preview.breadcrumbs!.length - 1 ? 600 : 400 }}>{crumb}</span>
              </span>
            ))
          ) : preview.spaceName ? (
            <span style={{ color: '#172B4D', fontWeight: 600 }}>{preview.spaceName}</span>
          ) : null}
        </div>
      </div>

      {/* Page content — Confluence style */}
      <div className="p-5">
        {/* Space name */}
        {preview.spaceName && (
          <div className="text-xs font-medium mb-2" style={{ color: '#0052CC' }}>{preview.spaceName}</div>
        )}

        {/* Title */}
        <h1 className="text-lg font-semibold mb-1" style={{ color: '#172B4D' }}>{preview.title}</h1>

        {/* Meta — author + date */}
        <div className="flex items-center gap-2.5 mb-4 text-xs" style={{ color: '#5E6C84' }}>
          {preview.author && (
            <span className="flex items-center gap-1.5">
              <span className="h-5 w-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white" style={{ backgroundColor: '#00875A' }}>
                {authorInitials}
              </span>
              {preview.author}
            </span>
          )}
          {dateStr && (
            <>
              <span>·</span>
              <span>{dateStr}</span>
            </>
          )}
        </div>

        {/* Content blocks */}
        <div className="space-y-2">
          {contentBlocks.map((block, i) => {
            // Detect if it looks like a heading
            if (block.match(/^#{1,3}\s/) || (block.length < 60 && block === block.replace(/[a-z]/g, '') && block.trim().length > 3)) {
              return (
                <h3 key={i} className="text-sm font-semibold mt-3 pb-0.5" style={{ color: '#172B4D', borderBottom: '1px solid #DFE1E6' }}>
                  {block.replace(/^#{1,3}\s*/, '')}
                </h3>
              );
            }
            return (
              <p key={i} className="text-sm leading-relaxed" style={{ color: '#172B4D' }}>
                {block}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GenericPreview({ preview }: { preview: NonNullable<CitationSource['sourcePreview']> }) {
  const authorInitials = preview.author
    ? preview.author.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : '';

  return (
    <div className="p-4 bg-white space-y-2">
      <h4 className="text-sm font-semibold" style={{ color: '#172B4D' }}>{preview.title}</h4>
      {preview.author && (
        <div className="flex items-center gap-1.5 text-xs" style={{ color: '#5E6C84' }}>
          <span className="h-5 w-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white" style={{ backgroundColor: '#6554C0' }}>
            {authorInitials}
          </span>
          {preview.author}
        </div>
      )}
      {preview.excerpt && (
        <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: '#172B4D' }}>
          {preview.excerpt}
        </p>
      )}
    </div>
  );
}


/* ─────────────────────────────────────────────────────────── */
/*  Lazy Source Content (fallback when no preview embedded)     */
/* ─────────────────────────────────────────────────────────── */

function LazySourceContent({ source, docId, companySlug }: { source: string; docId: string; companySlug: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/${companySlug}/sources/${source}/${docId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [source, docId, companySlug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <div className="h-4 w-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (!data) {
    return <div className="px-3 py-4 text-xs text-center" style={{ color: '#5E6C84' }}>Source not found</div>;
  }

  const meta = data.metadata || {};
  const content = data.content || data.rawContent || '';
  const preview: NonNullable<CitationSource['sourcePreview']> = {
    provider: data.provider || source,
    docId: data._id?.toString() || docId,
    title: data.title || 'Untitled',
    excerpt: content.length > 500 ? content.substring(0, 500) + '…' : content,
    author: meta.authorName || meta.author,
    date: data.sourceCreatedAt || data.createdAt,
    url: meta.url || meta.permalink || meta.webUrl,
    channelName: meta.channelName,
    reactions: meta.reactions,
    issueKey: meta.issueKey,
    issueType: meta.issueType,
    status: meta.status,
    priority: meta.priority,
    assignee: meta.assignee,
    spaceName: meta.spaceName,
    breadcrumbs: meta.breadcrumbs,
  };

  return <SourcePreviewContent preview={preview} source={source} />;
}
