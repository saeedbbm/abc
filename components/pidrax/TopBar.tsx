"use client";

import { Search, ChevronDown, Shield } from 'lucide-react';
import { useParams } from 'next/navigation';

export function TopBar() {
  const { companySlug } = useParams<{ companySlug: string }>();

  return (
    <header className="h-12 border-b bg-card flex items-center px-4 gap-4 shrink-0">
      {/* Company */}
      <div className="flex items-center gap-2">
        <div className="h-6 w-6 rounded-md bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
          {(companySlug ?? 'B').charAt(0).toUpperCase()}
        </div>
        <span className="font-semibold text-sm capitalize">{companySlug ?? 'Company'}</span>
      </div>

      {/* Search */}
      <div className="flex-1 max-w-md mx-auto">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search knowledge, people, systems…"
            className="w-full rounded-lg border bg-secondary/50 py-1.5 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* User */}
      <div className="flex items-center gap-2">
        <span className="badge-status badge-new flex items-center gap-1">
          <Shield className="h-3 w-3" />
          Admin
        </span>
        <button className="flex items-center gap-1.5 text-sm">
          <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">AR</div>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>
    </header>
  );
}
