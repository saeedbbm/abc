"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ArrowLeft, ArrowRight, RotateCcw, CheckCircle2, MessageSquare, FileText, Terminal, AlertTriangle, Zap } from 'lucide-react';

const steps = [
  { title: 'Submit Feedback', icon: MessageSquare, description: 'A customer requests MP4 video enhancement support.' },
  { title: 'Generate Epic', icon: FileText, description: 'Pidrax drafts a Jira epic with stories and acceptance criteria.' },
  { title: 'Ask "How?"', icon: Zap, description: 'Engineer asks how to implement. Pidrax generates a KB doc.' },
  { title: 'Verify Claims', icon: AlertTriangle, description: 'Review highlighted claims. Confirm or request more info.' },
  { title: 'Run It', icon: Terminal, description: 'Pidrax applies changes across your codebase.' },
];

function StepContent({ step }: { step: number }) {
  if (step === 0) {
    return (
      <div className="max-w-lg mx-auto space-y-4 animate-fade-in">
        <div className="rounded-xl border bg-card p-5">
          <p className="text-xs text-muted-foreground mb-2">Customer Feedback · #feature-requests</p>
          <div className="flex gap-3">
            <div className="h-8 w-8 shrink-0 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">JM</div>
            <div>
              <p className="text-sm font-medium">Jessica Martinez</p>
              <p className="text-sm text-foreground/90 mt-1">
                "We love the image enhancement feature! Any chance you could support MP4 video files too? Our marketing team uploads a lot of video content and it would save us a ton of time."
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Zap className="h-3.5 w-3.5 text-primary" />
          Pidrax is analyzing this against your existing architecture…
        </div>
      </div>
    );
  }
  if (step === 1) {
    return (
      <div className="max-w-lg mx-auto animate-fade-in">
        <div className="rounded-xl border bg-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">BIX-234</span>
            <span className="badge-status badge-new">Epic</span>
          </div>
          <h3 className="font-semibold">Implement Video Processing Pipeline</h3>
          <p className="text-sm text-muted-foreground">Assigned to Alex Rivera · Sprint 14</p>
          <div className="space-y-1.5 pt-2 border-t">
            {['Extend Celery config for video timeouts', 'Implement multipart upload endpoint', 'Add webhook notification system', 'Update S3 bucket policies'].map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">BIX-{235 + i}</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (step === 2) {
    return (
      <div className="max-w-lg mx-auto animate-fade-in space-y-3">
        <div className="rounded-xl bg-primary text-primary-foreground p-4 text-sm">
          How do I implement the Video Processing Pipeline?
        </div>
        <div className="rounded-xl border bg-card p-5 space-y-2">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Pidrax</span>
          </div>
          <p className="text-sm leading-relaxed">Based on the existing architecture, here's what to modify:</p>
          <div className="space-y-2 mt-2">
            <div className="confidence-inferred py-1 rounded">
              <p className="text-sm">1. Increase Celery timeout from 60s to <strong>600s</strong> for video jobs
                <span className="source-chip ml-2 text-[10px]">Slack · #backend-ops</span>
              </p>
            </div>
            <div className="confidence-needs-verification py-1 rounded">
              <p className="text-sm">2. Add multipart upload for files &gt;100MB
                <span className="source-chip ml-2 text-[10px]">Jira · BIX-236</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (step === 3) {
    return (
      <div className="max-w-lg mx-auto animate-fade-in space-y-3">
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-semibold mb-3">Verification Task</h3>
          <div className="confidence-needs-verification p-3 rounded-lg mb-3">
            <p className="text-sm italic text-muted-foreground">"The Celery timeout should be increased to 600 seconds…"</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
            <span>Assigned to @david</span>
            <span>·</span>
            <span>Due Aug 22</span>
            <span className="badge-status badge-needs-review ml-auto">Pending</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="text-xs gap-1"><CheckCircle2 className="h-3 w-3" /> Confirm</Button>
            <Button variant="ghost" size="sm" className="text-xs">Edit</Button>
            <Button variant="ghost" size="sm" className="text-xs">Request info</Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-lg mx-auto animate-fade-in">
      <div className="terminal-surface rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex gap-1.5">
            <div className="h-2 w-2 rounded-full bg-red-500/60" />
            <div className="h-2 w-2 rounded-full bg-yellow-500/60" />
            <div className="h-2 w-2 rounded-full bg-green-500/60" />
          </div>
        </div>
        <div className="space-y-0 text-xs">
          <p className="text-white font-semibold">$ pidrax apply --epic BIX-234</p>
          <p className="mt-2 text-white/80">▸ Generating changes...</p>
          <p className="text-blue-400 mt-1">  [1/4] celeryconfig.py — timeout: 60s → 600s</p>
          <p className="text-green-400/70">         + CELERY_VIDEO_TIMEOUT = 600</p>
          <p className="text-blue-400 mt-1">  [2/4] upload.py — adding multipart handler</p>
          <p className="text-green-400/70">         + @router.post("/upload/multipart")</p>
          <p className="mt-2 text-green-400 font-semibold">✅ All changes ready.</p>
        </div>
      </div>
    </div>
  );
}

export default function Sandbox() {
  const [currentStep, setCurrentStep] = useState(0);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const router = useRouter();

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar */}
      <div className="border-b bg-card">
        <div className="max-w-4xl mx-auto flex items-center justify-between px-6 h-14">
          <button onClick={() => router.push('/')} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <span className="text-sm font-semibold">Interactive Sandbox</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setCurrentStep(0)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </button>
            <Button size="sm" variant="default" onClick={() => setWaitlistOpen(true)}>
              Join Waitlist
            </Button>
          </div>
        </div>
      </div>

      {/* Progress */}
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center gap-1 mb-8">
          {steps.map((s, i) => (
            <button
              key={i}
              onClick={() => setCurrentStep(i)}
              className="flex-1 group"
            >
              <div className={`h-1 rounded-full mb-2 transition-colors ${
                i <= currentStep ? 'bg-primary' : 'bg-border'
              }`} />
              <div className="flex items-center gap-1.5">
                <s.icon className={`h-3.5 w-3.5 ${i <= currentStep ? 'text-primary' : 'text-muted-foreground'}`} />
                <span className={`text-xs font-medium ${i <= currentStep ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {s.title}
                </span>
              </div>
            </button>
          ))}
        </div>

        {/* Step description */}
        <p className="text-center text-sm text-muted-foreground mb-8">{steps[currentStep].description}</p>

        {/* Content */}
        <StepContent step={currentStep} />

        {/* Navigation */}
        <div className="flex items-center justify-center gap-3 mt-10">
          <Button
            variant="outline"
            size="sm"
            disabled={currentStep === 0}
            onClick={() => setCurrentStep(s => s - 1)}
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Previous
          </Button>
          {currentStep < steps.length - 1 ? (
            <Button size="sm" onClick={() => setCurrentStep(s => s + 1)}>
              Next <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" variant="default" onClick={() => setWaitlistOpen(true)}>
                Join the Waitlist <ArrowRight className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="outline" onClick={() => router.push('/app/chat')}>
                Open Full App
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Simple waitlist modal */}
      {waitlistOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm" onClick={() => setWaitlistOpen(false)}>
          <div className="bg-card rounded-xl border shadow-xl max-w-md w-full mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-2">Join the Waitlist</h3>
            <p className="text-sm text-muted-foreground mb-4">Be among the first engineering teams to use Pidrax.</p>
            <div className="flex gap-2">
              <input placeholder="you@company.com" className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
              <Button onClick={() => setWaitlistOpen(false)}>Join</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
