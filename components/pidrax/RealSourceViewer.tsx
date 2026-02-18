"use client";

import { useEffect, useState } from "react";
import { Loader2, AlertCircle, User, Clock, Hash, Tag } from "lucide-react";
import type { SourceType } from "@/contexts/InspectorContext";

interface RealSourceViewerProps {
  source: SourceType;
  docId: string;
  companySlug: string;
  highlightId?: string;
}

interface DocumentData {
  _id: string;
  sourceId: string;
  provider: string;
  title?: string;
  content?: string;
  rawContent?: string;
  metadata?: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
}

export function RealSourceViewer({
  source,
  docId,
  companySlug,
  highlightId,
}: RealSourceViewerProps) {
  const [doc, setDoc] = useState<DocumentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDoc(null);

    const fetchDoc = async () => {
      try {
        const res = await fetch(
          `/api/${companySlug}/sources/${source}/${docId}`
        );
        if (!res.ok) {
          throw new Error(res.status === 404 ? "Document not found" : "Failed to load");
        }
        const data = await res.json();
        if (!cancelled) setDoc(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to load document");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchDoc();
    return () => { cancelled = true; };
  }, [source, docId, companySlug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-xs">Loading source document...</span>
        </div>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <AlertCircle className="h-5 w-5" />
          <span className="text-xs">{error || "Document not found"}</span>
        </div>
      </div>
    );
  }

  if (source === "slack") return <SlackRealView doc={doc} highlightId={highlightId} />;
  if (source === "jira") return <JiraRealView doc={doc} />;
  if (source === "confluence") return <ConfluenceRealView doc={doc} highlightId={highlightId} />;

  return null;
}

function SlackRealView({ doc, highlightId }: { doc: DocumentData; highlightId?: string }) {
  const meta = doc.metadata || {};
  const author = meta.authorName || meta.author || "Unknown";
  const channel = meta.channelName || meta.channel || "";
  const timestamp = doc.createdAt
    ? new Date(doc.createdAt).toLocaleString()
    : "";
  const reactions = meta.reactions || [];

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: "var(--slack-sidebar, #3F0E40)" }}>
      {/* Channel sidebar header */}
      <div className="px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-1.5 text-white/90">
          <Hash className="h-3.5 w-3.5" />
          <span className="text-sm font-medium">{channel || "channel"}</span>
        </div>
      </div>

      {/* Message area */}
      <div className="flex-1 overflow-y-auto bg-white p-4 space-y-3">
        <div
          className={`flex gap-3 p-2 rounded-lg ${
            highlightId ? "bg-yellow-50 border border-yellow-200" : ""
          }`}
        >
          <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">
            {author.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{author}</span>
              <span className="text-[10px] text-muted-foreground">{timestamp}</span>
            </div>
            <div className="text-sm text-foreground/80 mt-0.5 whitespace-pre-wrap break-words">
              {doc.content || doc.rawContent || "No message content"}
            </div>
            {reactions.length > 0 && (
              <div className="flex gap-1 mt-2">
                {reactions.map((r: any, i: number) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] bg-secondary/50"
                  >
                    {r.name || r} {r.count && `${r.count}`}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function JiraRealView({ doc }: { doc: DocumentData }) {
  const meta = doc.metadata || {};
  const issueKey = meta.issueKey || meta.key || doc.sourceId || "";
  const issueType = meta.issueType || meta.type || "Task";
  const status = meta.status || "Open";
  const priority = meta.priority || "Medium";
  const assignee = meta.assignee || "Unassigned";
  const summary = doc.title || meta.summary || "Untitled";

  return (
    <div className="h-full overflow-y-auto bg-white p-4 space-y-4">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="rounded bg-blue-100 text-blue-700 text-[10px] font-semibold px-1.5 py-0.5 uppercase">
            {issueType}
          </span>
          <span className="text-sm font-mono text-muted-foreground">{issueKey}</span>
        </div>
        <h3 className="text-base font-semibold text-foreground">{summary}</h3>
      </div>

      {/* Fields */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Status</span>
          <div className="mt-0.5">
            <span className="rounded-full bg-blue-100 text-blue-700 text-xs px-2 py-0.5 font-medium">
              {status}
            </span>
          </div>
        </div>
        <div>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Priority</span>
          <div className="mt-0.5 flex items-center gap-1">
            <Tag className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs">{priority}</span>
          </div>
        </div>
        <div>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Assignee</span>
          <div className="mt-0.5 flex items-center gap-1">
            <User className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs">{assignee}</span>
          </div>
        </div>
        <div>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Created</span>
          <div className="mt-0.5 flex items-center gap-1">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs">
              {doc.createdAt ? new Date(doc.createdAt).toLocaleDateString() : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Description */}
      <div>
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Description</span>
        <div className="mt-1 text-sm text-foreground/80 whitespace-pre-wrap">
          {doc.content || doc.rawContent || "No description available."}
        </div>
      </div>
    </div>
  );
}

function ConfluenceRealView({ doc, highlightId }: { doc: DocumentData; highlightId?: string }) {
  const meta = doc.metadata || {};
  const space = meta.spaceName || meta.space || "";
  const title = doc.title || meta.title || "Untitled Page";
  const breadcrumbs = meta.breadcrumbs || (space ? [space] : []);

  return (
    <div className="h-full overflow-y-auto bg-white p-4 space-y-3">
      {/* Breadcrumbs */}
      {breadcrumbs.length > 0 && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          {breadcrumbs.map((crumb: string, i: number) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span>/</span>}
              <span className="hover:text-foreground cursor-default">{crumb}</span>
            </span>
          ))}
        </div>
      )}

      {/* Space name */}
      {space && (
        <div className="text-xs text-blue-600 font-medium">{space}</div>
      )}

      {/* Title */}
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>

      {/* Content */}
      <div
        className={`text-sm text-foreground/80 prose prose-sm max-w-none ${
          highlightId ? "highlight-citation" : ""
        }`}
        dangerouslySetInnerHTML={{
          __html: doc.content || doc.rawContent || "<p>No content available.</p>",
        }}
      />
    </div>
  );
}
