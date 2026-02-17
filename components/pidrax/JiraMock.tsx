"use client";

import { jiraTickets } from '@/data/mockData';
import { ChevronRight, MoreHorizontal } from 'lucide-react';

interface JiraMockProps {
  editingId?: string | null;
  editText?: string;
  onEditText?: (text: string) => void;
  onDoubleClick?: (id: string, text: string) => void;
}

const statusColors: Record<string, { bg: string; text: string }> = {
  'To Do': { bg: '#DFE1E6', text: '#42526E' },
  'In Progress': { bg: '#DEEBFF', text: '#0747A6' },
  'Done': { bg: '#E3FCEF', text: '#006644' },
  'In Review': { bg: '#EAE6FF', text: '#403294' },
};

const priorityIcons: Record<string, { color: string; label: string }> = {
  Critical: { color: '#FF5630', label: '⬆' },
  High: { color: '#FF7452', label: '⬆' },
  Medium: { color: '#FFAB00', label: '⬆' },
  Low: { color: '#2684FF', label: '⬇' },
};

export function JiraMock({ editingId, editText, onEditText, onDoubleClick }: JiraMockProps) {
  const ticket = jiraTickets[0];
  const sc = statusColors[ticket.status] || statusColors['To Do'];
  const pc = priorityIcons[ticket.priority] || priorityIcons['Medium'];

  return (
    <div className="h-full flex flex-col animate-fade-in bg-card">
      {/* Jira top bar */}
      <div className="h-10 flex items-center px-4 shrink-0" style={{ backgroundColor: '#fff', borderBottom: '1px solid #DFE1E6' }}>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: '#5E6C84' }}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="#2684FF">
            <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24.013 12.5V1.005A1.005 1.005 0 0 0 23.013 0z" />
          </svg>
          <span>Bix</span>
          <ChevronRight className="h-3 w-3" />
          <span>BIX Board</span>
          <ChevronRight className="h-3 w-3" />
          <span style={{ color: '#172B4D' }}>{ticket.key}</span>
        </div>
        <MoreHorizontal className="h-4 w-4 ml-auto" style={{ color: '#6B778C' }} />
      </div>

      {/* Ticket content */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-5">
          {/* Type icon + key */}
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex items-center justify-center h-5 w-5 rounded" style={{ backgroundColor: '#E3FCEF' }}>
              <svg className="h-3 w-3" viewBox="0 0 16 16" fill="#36B37E"><path d="M2 0h12a2 2 0 012 2v12a2 2 0 01-2 2H2a2 2 0 01-2-2V2a2 2 0 012-2zm1.5 4.5a1 1 0 100 2h9a1 1 0 100-2h-9zm0 5a1 1 0 100 2h6a1 1 0 100-2h-6z" /></svg>
            </span>
            <span className="text-xs font-medium" style={{ color: '#5E6C84' }}>{ticket.key}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase" style={{ backgroundColor: '#E9F2FF', color: '#0747A6' }}>
              {ticket.type}
            </span>
          </div>

          {/* Title */}
          <h2
            className="text-lg font-semibold mb-4"
            style={{ color: '#172B4D' }}
            onDoubleClick={() => onDoubleClick?.('jira-title', ticket.title)}
          >
            {editingId === 'jira-title' ? (
              <input value={editText} onChange={e => onEditText?.(e.target.value)} className="w-full text-lg font-semibold border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring" autoFocus />
            ) : ticket.title}
          </h2>

          {/* Fields grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-5 text-sm">
            <Field label="Status">
              <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wider" style={{ backgroundColor: sc.bg, color: sc.text }}>
                {ticket.status}
              </span>
            </Field>
            <Field label="Priority">
              <span className="flex items-center gap-1 text-sm" style={{ color: '#172B4D' }}>
                <span style={{ color: pc.color }}>{pc.label}</span>
                {ticket.priority}
              </span>
            </Field>
            <Field label="Assignee">
              <span className="flex items-center gap-1.5 text-sm" style={{ color: '#172B4D' }}>
                <span className="h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: '#00875A' }}>AR</span>
                {ticket.assignee}
              </span>
            </Field>
            <Field label="Reporter">
              <span className="flex items-center gap-1.5 text-sm" style={{ color: '#172B4D' }}>
                <span className="h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: '#6554C0' }}>AI</span>
                {ticket.reporter}
              </span>
            </Field>
            <Field label="Sprint">
              <span className="text-sm" style={{ color: '#172B4D' }}>{ticket.sprint}</span>
            </Field>
          </div>

          {/* Description */}
          <div className="mb-5">
            <h4 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#5E6C84' }}>Description</h4>
            <p
              className="text-sm leading-relaxed"
              style={{ color: '#172B4D' }}
              onDoubleClick={() => onDoubleClick?.('jira-desc', ticket.description)}
            >
              {editingId === 'jira-desc' ? (
                <textarea value={editText} onChange={e => onEditText?.(e.target.value)} className="w-full text-sm border rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-ring resize-none" rows={4} autoFocus />
              ) : ticket.description}
            </p>
          </div>

          {/* Acceptance Criteria */}
          <div className="mb-5">
            <h4 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#5E6C84' }}>Acceptance Criteria</h4>
            <ul className="space-y-1.5">
              {ticket.acceptanceCriteria.map((ac, i) => (
                <li key={i} className="flex items-start gap-2 text-sm" style={{ color: '#172B4D' }}>
                  <span className="mt-1 h-4 w-4 rounded border flex items-center justify-center shrink-0" style={{ borderColor: '#DFE1E6' }}>
                    <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" stroke="#42526E" strokeWidth="2"><polyline points="2 6 5 9 10 3" /></svg>
                  </span>
                  {ac}
                </li>
              ))}
            </ul>
          </div>

          {/* Child stories */}
          {ticket.stories && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#5E6C84' }}>Child issues</h4>
              <div className="space-y-1">
                {ticket.stories.map(s => {
                  const ssc = statusColors[s.status] || statusColors['To Do'];
                  return (
                    <div key={s.key} className="flex items-center gap-2 rounded border px-3 py-2 text-sm" style={{ borderColor: '#DFE1E6' }}>
                      <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="#2684FF"><rect width="16" height="16" rx="2" /><path d="M4 5h8M4 8h8M4 11h5" stroke="#fff" strokeWidth="1.5" /></svg>
                      <span className="font-mono text-xs" style={{ color: '#5E6C84' }}>{s.key}</span>
                      <span className="flex-1 truncate" style={{ color: '#172B4D' }}>{s.title}</span>
                      <span className="text-[10px] font-bold uppercase rounded px-1.5 py-0.5" style={{ backgroundColor: ssc.bg, color: ssc.text }}>{s.status}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#6B778C' }}>{label}</p>
      {children}
    </div>
  );
}
