"use client";

import React, { createContext, useContext, useState, useCallback } from 'react';

export type SourceType = 'slack' | 'confluence' | 'jira' | 'terminal';

export interface CitationSource {
  id: string;
  source: SourceType;
  label: string;
  detail?: string;
  date?: string;
  docId?: string;
  url?: string;
  sourcePreview?: {
    provider: string;
    docId: string;
    title: string;
    excerpt: string;
    author?: string;
    date?: string;
    url?: string;
    channelName?: string;
    reactions?: Array<{ name: string; count: number }>;
    messages?: Array<{ author: string; text: string; timestamp: string; avatarUrl?: string }>;
    issueKey?: string;
    issueType?: string;
    status?: string;
    priority?: string;
    assignee?: string;
    spaceName?: string;
    breadcrumbs?: string[];
  };
}

interface InspectorState {
  /** All citations for the currently selected paragraph */
  citations: CitationSource[];
  /** Legacy: single source type (for demo/mock mode) */
  source: SourceType | null;
  highlightId?: string;
  docId?: string;
  companySlug?: string;
}

interface InspectorContextValue {
  state: InspectorState;
  /** Show sources for a paragraph — pass all its citations */
  showCitations: (citations: CitationSource[]) => void;
  /** Legacy: show a single source (for demo/mock mode) */
  showSource: (type: SourceType, highlightId?: string, docId?: string) => void;
  hideSource: () => void;
  setCompanySlug: (slug: string) => void;
}

const InspectorContext = createContext<InspectorContextValue | null>(null);

export const useInspector = () => {
  const ctx = useContext(InspectorContext);
  if (!ctx) throw new Error('useInspector must be used within InspectorProvider');
  return ctx;
};

export const InspectorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<InspectorState>({
    citations: [],
    source: null,
  });

  const showCitations = useCallback((citations: CitationSource[]) => {
    if (citations.length === 0) return;
    setState(prev => ({
      ...prev,
      citations,
      source: citations[0].source,
      highlightId: citations[0].id,
      docId: citations[0].docId,
    }));
  }, []);

  const showSource = useCallback((type: SourceType, highlightId?: string, docId?: string) => {
    setState(prev => ({ ...prev, source: type, highlightId, docId, citations: [] }));
  }, []);

  const hideSource = useCallback(() => {
    setState(prev => ({
      ...prev,
      source: null,
      highlightId: undefined,
      docId: undefined,
      citations: [],
    }));
  }, []);

  const setCompanySlug = useCallback((slug: string) => {
    setState(prev => ({ ...prev, companySlug: slug }));
  }, []);

  return (
    <InspectorContext.Provider value={{ state, showCitations, showSource, hideSource, setCompanySlug }}>
      {children}
    </InspectorContext.Provider>
  );
};
