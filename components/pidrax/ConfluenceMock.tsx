"use client";

import { confluencePages } from '@/data/mockData';
import { ChevronRight, MoreHorizontal, ThumbsUp, Eye } from 'lucide-react';

interface ConfluenceMockProps {
  editingId?: string | null;
  editText?: string;
  onEditText?: (text: string) => void;
  onDoubleClick?: (id: string, text: string) => void;
}

export function ConfluenceMock({ editingId, editText, onEditText, onDoubleClick }: ConfluenceMockProps) {
  const page = confluencePages[0];

  return (
    <div className="h-full flex flex-col animate-fade-in bg-card">
      {/* Confluence top bar */}
      <div className="h-10 flex items-center px-4 shrink-0" style={{ backgroundColor: '#fff', borderBottom: '1px solid #DFE1E6' }}>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: '#5E6C84' }}>
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="#1868DB">
            <path d="M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.487-.843.79-1.404 1.68-3.11 3.381-2.726 6.46-1.102l4.665 2.463a.766.766 0 0 0 1.03-.338l2.592-5.205a.766.766 0 0 0-.344-1.028c-1.42-.706-4.348-2.163-6.834-3.475C8.27 9.84 3.884 11.32.87 18.257zM23.131 5.743c.249-.382.531-.875.764-1.245a.764.764 0 0 0-.256-1.04L18.674.404a.764.764 0 0 0-1.058.26c-.199.332-.487.843-.789 1.404-1.681 3.11-3.382 2.726-6.461 1.102L5.702.707a.766.766 0 0 0-1.03.338L2.08 6.25a.766.766 0 0 0 .344 1.028c1.42.706 4.348 2.163 6.834 3.475 6.48 3.408 10.866 1.928 13.873-5.01z" />
          </svg>
          {page.breadcrumb.map((item, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3" />}
              <span style={{ color: i === page.breadcrumb.length - 1 ? '#172B4D' : '#5E6C84', fontWeight: i === page.breadcrumb.length - 1 ? 600 : 400 }}>{item}</span>
            </span>
          ))}
        </div>
        <MoreHorizontal className="h-4 w-4 ml-auto" style={{ color: '#6B778C' }} />
      </div>

      {/* Page content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto p-6">
          {/* Title */}
          <h1
            className="text-xl font-semibold mb-1"
            style={{ color: '#172B4D' }}
            onDoubleClick={() => onDoubleClick?.('conf-title', page.title)}
          >
            {editingId === 'conf-title' ? (
              <input value={editText} onChange={e => onEditText?.(e.target.value)} className="w-full text-xl font-semibold border-b-2 border-primary py-1 focus:outline-none" autoFocus />
            ) : page.title}
          </h1>

          {/* Meta */}
          <div className="flex items-center gap-3 mb-6 text-xs" style={{ color: '#5E6C84' }}>
            <span className="flex items-center gap-1">
              <span className="h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: '#00875A' }}>DC</span>
              David Chen
            </span>
            <span>·</span>
            <span>Aug 12, 2025</span>
            <span className="flex items-center gap-1 ml-auto">
              <Eye className="h-3 w-3" /> 24 views
            </span>
            <span className="flex items-center gap-1">
              <ThumbsUp className="h-3 w-3" /> 3
            </span>
          </div>

          {/* Content blocks */}
          <div className="space-y-3">
            {page.content.map((block, i) => {
              const blockId = `conf-block-${i}`;
              const isEditing = editingId === blockId;

              if (block.type === 'heading') {
                return (
                  <h3
                    key={i}
                    className="text-base font-semibold mt-6 pb-1"
                    style={{ color: '#172B4D', borderBottom: '1px solid #DFE1E6' }}
                  >
                    {block.text}
                  </h3>
                );
              }
              if (block.type === 'callout') {
                return (
                  <div
                    key={i}
                    className={`rounded-[3px] px-4 py-3 text-sm flex gap-3 ${block.highlighted ? 'border-l-[3px]' : ''}`}
                    style={{
                      backgroundColor: block.highlighted ? '#FFFAE6' : '#DEEBFF',
                      borderLeftColor: block.highlighted ? '#FF8B00' : undefined,
                      color: '#172B4D',
                    }}
                    onDoubleClick={() => onDoubleClick?.(blockId, block.text)}
                  >
                    <span className="shrink-0 mt-0.5">{block.highlighted ? '⚠️' : 'ℹ️'}</span>
                    {isEditing ? (
                      <textarea value={editText} onChange={e => onEditText?.(e.target.value)} className="flex-1 text-sm bg-transparent border rounded p-1 focus:outline-none resize-none" rows={2} autoFocus />
                    ) : (
                      <span>{block.text}</span>
                    )}
                  </div>
                );
              }
              return (
                <p
                  key={i}
                  className="text-sm leading-relaxed"
                  style={{ color: '#172B4D' }}
                  onDoubleClick={() => onDoubleClick?.(blockId, block.text)}
                >
                  {isEditing ? (
                    <textarea value={editText} onChange={e => onEditText?.(e.target.value)} className="w-full text-sm border rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-ring resize-none" rows={2} autoFocus />
                  ) : block.text}
                </p>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
