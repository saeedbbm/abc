"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle, X, Zap } from "lucide-react";

function WaitlistModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleJoin = async () => {
    if (!email.includes("@") || saving) return;
    setSaving(true);
    try {
      await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch {
      // still show success — we don't want to block the UX
    }
    setSaving(false);
    setSubmitted(true);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-xl border shadow-xl max-w-md w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Join the Waitlist</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {submitted ? (
          <div className="text-center py-6">
            <div className="h-12 w-12 rounded-full bg-[hsl(var(--status-verified)/0.1)] flex items-center justify-center mx-auto mb-3">
              <CheckCircle
                className="h-6 w-6"
                style={{ color: "hsl(var(--status-verified))" }}
              />
            </div>
            <p className="font-semibold mb-1">You're on the list!</p>
            <p className="text-sm text-muted-foreground">
              We'll reach out when it's your turn.
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground mb-4">
              Be among the first engineering teams to use Pidrax. We'll notify you
              as soon as access opens.
            </p>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                placeholder="you@company.com"
                className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button onClick={handleJoin} disabled={!email.includes("@") || saving}>
                Join
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function MarketingTopNav() {
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  useEffect(() => {
    const openWaitlist = () => setWaitlistOpen(true);
    window.addEventListener("pidrax:open-waitlist", openWaitlist);
    return () => window.removeEventListener("pidrax:open-waitlist", openWaitlist);
  }, []);

  return (
    <>
      <WaitlistModal open={waitlistOpen} onClose={() => setWaitlistOpen(false)} />
      <nav id="top" className="sticky top-0 z-50 border-b bg-card/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-6 h-14">
          <Link href="/" className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
              <Zap className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-base">Pidrax</span>
          </Link>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/pawfinder2/docs">Demo</Link>
            </Button>
            <Button size="sm" onClick={() => setWaitlistOpen(true)}>
              Join Waitlist
            </Button>
          </div>
        </div>
      </nav>
    </>
  );
}
