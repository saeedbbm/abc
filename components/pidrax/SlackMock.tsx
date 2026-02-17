"use client";

import { Hash, ChevronDown, Circle, Plus, Bookmark, MoreHorizontal } from 'lucide-react';
import { slackMessages } from '@/data/mockData';

const channels = [
  { name: 'general', unread: false },
  { name: 'backend-ops', unread: true, active: true },
  { name: 'frontend', unread: false },
  { name: 'design', unread: false },
  { name: 'sre-incidents', unread: true },
];

const directMessages = [
  { name: 'David Chen', initials: 'DC', online: true },
  { name: 'Sarah Park', initials: 'SP', online: true },
  { name: 'Alex Rivera', initials: 'AR', online: false },
];

interface SlackMockProps {
  editingId?: string | null;
  editText?: string;
  onEditText?: (text: string) => void;
  onDoubleClick?: (id: string, text: string) => void;
}

export function SlackMock({ editingId, editText, onEditText, onDoubleClick }: SlackMockProps) {
  return (
    <div className="flex h-full animate-fade-in">
      {/* Slack sidebar - authentic purple */}
      <div className="w-[180px] shrink-0 hidden lg:flex flex-col" style={{ backgroundColor: 'hsl(283, 72%, 18%)' }}>
        {/* Workspace header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b" style={{ borderColor: 'hsl(283, 40%, 25%)' }}>
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-sm text-white">Bix Engineering</span>
            <ChevronDown className="h-3 w-3 text-white/60" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {/* Channels section */}
          <div className="px-3 mb-1">
            <button className="flex items-center gap-1 w-full text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'hsl(283, 20%, 65%)' }}>
              <ChevronDown className="h-3 w-3" />
              Channels
            </button>
          </div>
          {channels.map(ch => (
            <button
              key={ch.name}
              className="flex w-full items-center gap-1.5 px-3 py-[3px] text-[13px] transition-colors"
              style={{
                backgroundColor: ch.active ? 'hsl(216, 100%, 40%)' : 'transparent',
                color: ch.active ? '#fff' : ch.unread ? '#fff' : 'hsl(283, 20%, 65%)',
                fontWeight: ch.unread ? 600 : 400,
                borderRadius: '4px',
                margin: '0 8px',
                paddingLeft: '8px',
              }}
            >
              <Hash className="h-3 w-3 shrink-0" style={{ opacity: 0.8 }} />
              {ch.name}
            </button>
          ))}

          {/* DMs section */}
          <div className="px-3 mt-4 mb-1">
            <button className="flex items-center gap-1 w-full text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'hsl(283, 20%, 65%)' }}>
              <ChevronDown className="h-3 w-3" />
              Direct Messages
            </button>
          </div>
          {directMessages.map(dm => (
            <button
              key={dm.name}
              className="flex w-full items-center gap-1.5 px-3 py-[3px] text-[13px] transition-colors"
              style={{
                color: 'hsl(283, 20%, 75%)',
                borderRadius: '4px',
                margin: '0 8px',
                paddingLeft: '8px',
              }}
            >
              <span className="relative">
                <span className="h-4 w-4 rounded-[3px] flex items-center justify-center text-[8px] font-semibold" style={{ backgroundColor: 'hsl(283, 40%, 30%)', color: 'hsl(283, 20%, 75%)' }}>
                  {dm.initials}
                </span>
                {dm.online && (
                  <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border" style={{ backgroundColor: 'hsl(154, 60%, 52%)', borderColor: 'hsl(283, 72%, 18%)' }} />
                )}
              </span>
              <span className="truncate">{dm.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Message area - white */}
      <div className="flex-1 flex flex-col min-w-0 bg-card">
        {/* Channel header */}
        <div className="flex items-center gap-2 border-b px-4 py-2 bg-card">
          <Hash className="h-4 w-4 text-muted-foreground" />
          <span className="font-bold text-[15px]">backend-ops</span>
          <span className="text-xs text-muted-foreground ml-1">4 members</span>
          <div className="ml-auto flex items-center gap-2 text-muted-foreground">
            <Bookmark className="h-4 w-4" />
            <MoreHorizontal className="h-4 w-4" />
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
          {slackMessages.map((msg, idx) => {
            const showHeader = idx === 0 || slackMessages[idx - 1].author !== msg.author;
            const isEditing = editingId === msg.id;

            return (
              <div
                key={msg.id}
                className={`group relative rounded-lg px-3 py-1 transition-colors ${
                  msg.highlighted ? 'bg-[hsl(51,100%,95%)] border-l-[3px]' : 'hover:bg-muted/50'
                }`}
                style={msg.highlighted ? { borderLeftColor: 'hsl(51, 100%, 50%)' } : undefined}
                onDoubleClick={() => onDoubleClick?.(msg.id, msg.content)}
              >
                {showHeader && (
                  <div className="flex items-center gap-2 mt-2">
                    <div className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-xs font-bold text-white" style={{ backgroundColor: msg.author === 'David Chen' ? 'hsl(200, 60%, 45%)' : 'hsl(330, 50%, 55%)' }}>
                      {msg.initials}
                    </div>
                    <span className="text-[15px] font-bold">{msg.author}</span>
                    <span className="text-xs text-muted-foreground">{msg.timestamp}</span>
                  </div>
                )}
                <div className={showHeader ? 'pl-10' : 'pl-10'}>
                  {isEditing ? (
                    <textarea
                      value={editText}
                      onChange={e => onEditText?.(e.target.value)}
                      className="w-full text-[15px] leading-relaxed bg-card border rounded-lg p-2 focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                      rows={2}
                      autoFocus
                    />
                  ) : (
                    <p className="text-[15px] leading-relaxed text-foreground">{msg.content}</p>
                  )}
                  {msg.reactions && (
                    <div className="flex gap-1 mt-1">
                      {msg.reactions.map((r, i) => (
                        <span key={i} className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs hover:bg-accent cursor-pointer transition-colors">
                          {r.emoji} <span className="text-muted-foreground">{r.count}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Message input */}
        <div className="px-4 py-3 border-t">
          <div className="rounded-lg border bg-card px-3 py-2 flex items-center gap-2">
            <Plus className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Message #backend-ops</span>
          </div>
        </div>
      </div>
    </div>
  );
}
