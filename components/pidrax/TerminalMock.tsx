"use client";

import { useState, useEffect } from 'react';
import { terminalLines } from '@/data/mockData';

export function TerminalMock() {
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    setVisibleCount(0);
    const interval = setInterval(() => {
      setVisibleCount(prev => {
        if (prev >= terminalLines.length) {
          clearInterval(interval);
          return prev;
        }
        return prev + 1;
      });
    }, 120);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="terminal-surface h-full overflow-y-auto p-4 rounded-lg animate-fade-in">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-red-500/60" />
          <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/60" />
          <div className="h-2.5 w-2.5 rounded-full bg-green-500/60" />
        </div>
        <span className="text-xs opacity-50 ml-2">pidrax-agent</span>
      </div>

      <div className="space-y-0">
        {terminalLines.slice(0, visibleCount).map((line, i) => (
          <div key={i} className="leading-6">
            {line.startsWith('✅') ? (
              <span className="text-green-400 font-semibold">{line}</span>
            ) : line.startsWith('  ✓') ? (
              <span className="text-green-400/80">{line}</span>
            ) : line.startsWith('  [') ? (
              <span className="text-blue-400">{line}</span>
            ) : line.startsWith('         +') ? (
              <span className="text-green-400/70">{line}</span>
            ) : line.startsWith('▸') ? (
              <span className="text-white/90">{line}</span>
            ) : line.startsWith('$') ? (
              <span className="text-white font-semibold">{line}</span>
            ) : (
              <span className="opacity-70">{line || '\u00A0'}</span>
            )}
          </div>
        ))}
        {visibleCount < terminalLines.length && (
          <span className="inline-block w-2 h-4 bg-green-400 animate-terminal-blink" />
        )}
      </div>
    </div>
  );
}
