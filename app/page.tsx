"use client";

import { MarketingTopNav } from '@/components/pidrax/MarketingTopNav';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Zap, BookOpen, Terminal, Play, ArrowRight, CheckCircle } from 'lucide-react';

const features = [
  {
    icon: BookOpen,
    title: 'Unified KB',
    description: 'Auto-generated knowledge base from Slack, Jira, Confluence, and your codebase. One source of truth.',
  },
  {
    icon: CheckCircle,
    title: 'Human Verification',
    description: 'Google Docs–style review tasks ensure every claim is verified by the right person before it becomes canon.',
  },
  {
    icon: Terminal,
    title: 'Actionable Outputs',
    description: 'Generate Jira epics, KB docs, and run code changes directly from chat. Ask, verify, ship.',
  },
];

export default function Landing() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-background">
      <MarketingTopNav />
      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border bg-card px-4 py-1.5 mb-6 text-xs font-medium text-muted-foreground">
          <Zap className="h-3 w-3 text-primary" />
          AI Knowledge Bot for Engineering Teams
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.1] mb-4">
          Stop searching.
          <br />
          Start building.
        </h1>
        <p className="text-lg text-muted-foreground max-w-lg mx-auto mb-8">
          Pidrax turns scattered Slack threads, Jira tickets, and Confluence pages into a verified, searchable knowledge base your team actually uses.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Button variant="hero" size="lg" onClick={() => router.push('/pawfinder/docs')}>
            <Play className="h-4 w-4" />
            Watch Demo
          </Button>
          <Button variant="hero-outline" size="lg" onClick={() => router.push('/pawfinder/docs')}>
            Try the Interactive Sandbox
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </section>

      {/* Demo placeholder */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="rounded-xl border bg-card shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <div className="flex gap-1.5">
              <div className="h-2.5 w-2.5 rounded-full bg-destructive/40" />
              <div className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--status-needs-review))]/40" />
              <div className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--status-verified))]/40" />
            </div>
            <span className="text-xs text-muted-foreground ml-2">pidrax — Bix workspace</span>
          </div>
          <div className="aspect-video flex items-center justify-center bg-muted/30">
            <div className="text-center">
              <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Play className="h-8 w-8 text-primary" />
              </div>
              <p className="text-sm font-medium">60-second product demo</p>
              <p className="text-xs text-muted-foreground mt-1">See Pidrax turn a customer request into shipped code</p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-6 pb-16">
        <div className="grid md:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <div key={i} className="rounded-xl border bg-card p-6 hover:shadow-md transition-shadow">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                <f.icon className="h-5 w-5 text-primary" />
              </div>
              <h3 className="font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Waitlist CTA */}
      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="rounded-xl border bg-card p-10 text-center">
          <h2 className="text-2xl font-bold mb-2">Ready to unify your team's knowledge?</h2>
          <p className="text-muted-foreground mb-6 max-w-md mx-auto">
            Join the waitlist and be among the first to experience Pidrax.
          </p>
          <Button
            size="lg"
            onClick={() => window.dispatchEvent(new Event("pidrax:open-waitlist"))}
          >
            Join the Waitlist
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-between text-xs text-muted-foreground">
          <span>© 2025 Pidrax. Built for engineering teams.</span>
          <div className="flex items-center gap-1">
            <Zap className="h-3 w-3 text-primary" />
            <span>Powered by Pidrax AI</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
