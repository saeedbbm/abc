"use client";

import { BookOpen, MessageSquare, CheckCircle, Settings, ClipboardList, Wrench, Database, ListTree, Play } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import { isDemo } from '@/lib/is-demo';

type NavItem = { segment: string; icon: any; label: string };

const demoNavItems: NavItem[] = [
  { segment: 'kb', icon: BookOpen, label: 'KB' },
  { segment: 'verify', icon: CheckCircle, label: 'Verify' },
  { segment: 'pm', icon: ClipboardList, label: 'PM' },
  { segment: 'implement', icon: Wrench, label: 'Implement' },
  { segment: 'chat', icon: MessageSquare, label: 'Chat' },
  { segment: 'admin', icon: Settings, label: 'Admin' },
];

const pidraxNavItems: NavItem[] = [
  { segment: 'kb', icon: Database, label: 'Input Data' },
  { segment: 'pass1', icon: BookOpen, label: 'Pass 1' },
  { segment: 'pass2', icon: ListTree, label: 'Pass 2' },
  { segment: 'verify', icon: CheckCircle, label: 'Verify' },
  { segment: 'pm', icon: ClipboardList, label: 'PM' },
  { segment: 'chat', icon: MessageSquare, label: 'Chat' },
  { segment: 'admin', icon: Settings, label: 'Admin' },
];

const arch2NavItems: NavItem[] = [
  { segment: 'kb', icon: BookOpen, label: 'KB' },
  { segment: 'verify', icon: CheckCircle, label: 'Verify' },
  { segment: 'tickets', icon: ClipboardList, label: 'Tickets' },
  { segment: 'howto', icon: Wrench, label: 'How-to' },
  { segment: 'execute', icon: Play, label: 'Execute' },
  { segment: 'chat', icon: MessageSquare, label: 'Chat' },
  { segment: 'admin', icon: Settings, label: 'KB Admin' },
];

function isArch2(slug: string | undefined): boolean {
  return slug === 'brewandgo2';
}

export function AppSidebar() {
  const pathname = usePathname();
  const { companySlug } = useParams<{ companySlug: string }>();

  const navItems = isArch2(companySlug)
    ? arch2NavItems
    : isDemo(companySlug)
      ? demoNavItems
      : pidraxNavItems;

  return (
    <aside className="w-16 shrink-0 flex flex-col items-center py-4 gap-1 bg-sidebar border-r border-sidebar-border">
      <div className="mb-4 h-8 w-8 rounded-lg bg-sidebar-primary flex items-center justify-center">
        <span className="text-sidebar-primary-foreground text-xs font-bold">P</span>
      </div>

      {navItems.map(item => {
        const href = `/${companySlug}/${item.segment}`;
        const isActive = pathname.startsWith(href);

        return (
          <Link
            key={item.segment}
            href={href}
            className={`flex flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[10px] font-medium transition-colors w-12 ${
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
            }`}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </aside>
  );
}
