"use client";

import React, { createContext, useContext, useState, useCallback } from 'react';

export type SourceType = 'slack' | 'confluence' | 'jira' | 'terminal';

interface InspectorState {
  source: SourceType;
  highlightId?: string;
}

interface InspectorContextValue {
  state: InspectorState;
  showSource: (type: SourceType, highlightId?: string) => void;
}

const InspectorContext = createContext<InspectorContextValue | null>(null);

export const useInspector = () => {
  const ctx = useContext(InspectorContext);
  if (!ctx) throw new Error('useInspector must be used within InspectorProvider');
  return ctx;
};

export const InspectorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<InspectorState>({
    source: 'slack',
  });

  const showSource = useCallback((type: SourceType, highlightId?: string) => {
    setState({ source: type, highlightId });
  }, []);

  return (
    <InspectorContext.Provider value={{ state, showSource }}>
      {children}
    </InspectorContext.Provider>
  );
};
