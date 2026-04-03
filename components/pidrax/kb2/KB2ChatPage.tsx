"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Bot, User, Loader2 } from "lucide-react";
import { KB2RightPanel } from "./KB2RightPanel";
import { SplitLayout } from "./SplitLayout";

interface SourceRef {
  source_type: string;
  doc_id: string;
  title: string;
  section_heading?: string;
  excerpt?: string;
}

interface RelatedEntityPage {
  page_id: string;
  title: string;
  node_type: string;
  sections: {
    section_name: string;
    items: { text: string; confidence: string }[];
  }[];
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SourceRef[];
}

export function KB2ChatPage({ companySlug }: { companySlug: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sourceRefs, setSourceRefs] = useState<SourceRef[]>([]);
  const [relatedEntityPages, setRelatedEntityPages] = useState<RelatedEntityPage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMsg: ChatMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`/api/${companySlug}/kb2/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: input,
          conversation_history: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });
      const data = await res.json();

      const inputSources: SourceRef[] = data.input_sources ?? [];
      const kbPages: RelatedEntityPage[] = data.kb_sources ?? [];

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: data.answer ?? "I couldn't find an answer.",
        sources: inputSources,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setSourceRefs(inputSources);
      setRelatedEntityPages(kbPages);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, something went wrong. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => {
        scrollRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    }
  };

  return (
    <SplitLayout
      autoSaveId="chat"
      mainContent={
        <div className="flex flex-col h-full">
          <div className="border-b px-6 py-4">
            <h1 className="text-xl font-semibold">Chat</h1>
            <p className="text-sm text-muted-foreground">
              Ask questions about your company knowledge base
            </p>
          </div>

          <ScrollArea className="flex-1 px-6 py-4">
            <div className="max-w-2xl mx-auto space-y-4">
              {messages.length === 0 && (
                <div className="text-center py-12">
                  <Bot className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                  <h2 className="text-lg font-medium mb-2">
                    Ask anything about your company
                  </h2>
                  <p className="text-sm text-muted-foreground mb-6">
                    I use the knowledge graph to find accurate, sourced answers.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {[
                      "What conventions should I follow for Toy Donation?",
                      "What customer evidence supports Toy Donation, and what should the MVP include?",
                      "What owners and dependencies does Toy Donation touch?",
                      "Why does Toy Donation matter and what makes it feasible?",
                    ].map((prompt) => (
                      <Button
                        key={prompt}
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => {
                          setInput(prompt);
                        }}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}
                >
                  {msg.role === "assistant" && (
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                  )}
                  <div
                    className={`max-w-lg rounded-lg px-4 py-2 ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:mb-2 [&_p]:last:mb-0 [&_ol]:mb-2 [&_ul]:mb-2 [&_li]:mb-0.5 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_code]:text-xs [&_code]:bg-muted-foreground/10 [&_code]:px-1 [&_code]:rounded">
                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                    )}
                  </div>
                  {msg.role === "user" && (
                    <div className="h-7 w-7 rounded-full bg-primary flex items-center justify-center shrink-0">
                      <User className="h-4 w-4 text-primary-foreground" />
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div className="flex gap-3">
                  <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                  <div className="bg-muted rounded-lg px-4 py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                </div>
              )}

              <div ref={scrollRef} />
            </div>
          </ScrollArea>

          <div className="border-t px-6 py-3">
            <div className="max-w-2xl mx-auto flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Ask a question..."
                disabled={loading}
                rows={1}
                className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[36px] max-h-[120px] disabled:opacity-50"
                style={{ fieldSizing: "content" } as React.CSSProperties}
              />
              <Button
                className="shrink-0"
                onClick={handleSend}
                disabled={loading || !input.trim()}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      }
      rightPanel={
        <KB2RightPanel
          companySlug={companySlug}
          autoContext={null}
          sourceRefs={sourceRefs}
          relatedEntityPages={relatedEntityPages}
          defaultTab="sources"
        />
      }
    />
  );
}
