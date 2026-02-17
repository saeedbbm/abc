"use client";

import { useState, useRef, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { chatMessages, type ChatMsg } from '@/data/mockData';
import { SourceChip } from '@/components/pidrax/SourceChip';
import { useInspector } from '@/contexts/InspectorContext';
import { Button } from '@/components/ui/button';
import { Send, Zap, FileText, Terminal, LayoutList } from 'lucide-react';

const suggestedPrompts = [
  'Customers want MP4 video enhancement—what should we build?',
  'Draft a Jira epic and assign it to Alex',
  'How do I implement the Video Processing Pipeline?',
  'Run it',
];

export default function ChatPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  const [messages, setMessages] = useState<ChatMsg[]>(chatMessages);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const { showSource } = useInspector();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;
    const userMsg: ChatMsg = { id: `msg-${Date.now()}`, role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');

    const assistantId = `msg-${Date.now() + 1}`;
    setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '' }]);
    setIsStreaming(true);

    try {
      const response = await fetch(`/api/${companySlug}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input }),
      });

      if (!response.ok) throw new Error('Failed to get response');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.done) break;
              if (data.content) {
                accumulated += data.content;
                setMessages(prev =>
                  prev.map(m =>
                    m.id === assistantId ? { ...m, content: accumulated } : m
                  )
                );
              }
            } catch {
              // ignore malformed JSON chunks
            }
          }
        }
      }
    } catch {
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? { ...m, content: 'Sorry, I encountered an error. Please try again.' }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
    }
  };

  const handleAction = (type: string) => {
    if (type === 'epic') showSource('jira');
    else if (type === 'kb') showSource('confluence');
    else if (type === 'terminal') showSource('terminal');
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
              <Zap className="h-6 w-6 text-primary" />
            </div>
            <h2 className="text-lg font-semibold mb-1">Ask Pidrax anything</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              I can answer questions, generate docs, draft tasks, and run changes across your codebase.
            </p>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`flex gap-3 animate-fade-in ${msg.role === 'user' ? 'justify-end' : ''}`}>
            {msg.role === 'assistant' && (
              <div className="h-7 w-7 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center mt-0.5">
                <Zap className="h-3.5 w-3.5 text-primary" />
              </div>
            )}
            <div
              className={`max-w-2xl rounded-xl px-4 py-3 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border'
              }`}
            >
              {/* Typing indicator for empty streaming assistant messages */}
              {msg.role === 'assistant' && msg.content === '' && isStreaming ? (
                <div className="flex items-center gap-1 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
                </div>
              ) : (
                msg.content.split('\n').map((line, i) => {
                  if (line.startsWith('**') && line.endsWith('**')) {
                    return <p key={i} className="font-semibold mt-2 first:mt-0">{line.replace(/\*\*/g, '')}</p>;
                  }
                  if (line.startsWith('• ')) {
                    return <p key={i} className="ml-3">• {line.slice(2)}</p>;
                  }
                  return <p key={i} className={line === '' ? 'h-2' : ''}>{line}</p>;
                })
              )}

              {msg.citations && msg.citations.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-border/50">
                  {msg.citations.map(c => (
                    <SourceChip key={c.id} source={c.source} label={c.label} citationId={c.id} />
                  ))}
                </div>
              )}

              {msg.actions && msg.actions.length > 0 && (
                <div className="flex gap-2 mt-3">
                  {msg.actions.map((a, i) => (
                    <Button key={i} variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => handleAction(a.type)}>
                      {a.type === 'epic' && <LayoutList className="h-3 w-3" />}
                      {a.type === 'kb' && <FileText className="h-3 w-3" />}
                      {a.type === 'terminal' && <Terminal className="h-3 w-3" />}
                      {a.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Suggested prompts */}
      {messages.length <= 1 && (
        <div className="px-6 pb-2">
          <div className="flex flex-wrap gap-2">
            {suggestedPrompts.map((p, i) => (
              <button
                key={i}
                onClick={() => setInput(p)}
                className="rounded-lg border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t p-4">
        <div className="flex gap-2 max-w-3xl mx-auto">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Ask Pidrax anything…"
            disabled={isStreaming}
            className="flex-1 rounded-lg border bg-card px-4 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <Button size="icon" onClick={handleSend} disabled={isStreaming} className="shrink-0">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
