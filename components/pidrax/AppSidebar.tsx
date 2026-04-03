"use client";

import { ClipboardList, BookMarked, MessageSquare, BookOpen, Settings2, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';

type NavItem = { segment: string; icon: any; label: string };

const primaryNav: NavItem[] = [
  { segment: 'kb', icon: BookOpen, label: 'Docs' },
  { segment: 'tickets', icon: ClipboardList, label: 'Tickets' },
  { segment: 'howto', icon: BookMarked, label: 'Plans' },
  { segment: 'chat', icon: MessageSquare, label: 'Chat' },
];

const secondaryNav: NavItem[] = [
  { segment: 'settings', icon: Settings2, label: 'Settings' },
  { segment: 'admin', icon: Settings, label: 'Admin' },
];

function NavLink({ item, companySlug, pathname }: { item: NavItem; companySlug: string; pathname: string }) {
  const href = `/${companySlug}/${item.segment}`;
  const isActive = pathname.startsWith(href);

  return (
    <Link
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
}

export function AppSidebar() {
  const pathname = usePathname();
  const { companySlug } = useParams<{ companySlug: string }>();

  return (
    <aside className="w-16 shrink-0 flex flex-col items-center py-4 gap-1 bg-sidebar border-r border-sidebar-border">
      <div className="mb-4 h-8 w-8 rounded-lg bg-sidebar-primary flex items-center justify-center">
        <span className="text-sidebar-primary-foreground text-xs font-bold">P</span>
      </div>

      {primaryNav.map(item => (
        <NavLink key={item.segment} item={item} companySlug={companySlug} pathname={pathname} />
      ))}

      <div className="my-2 w-8 border-t border-sidebar-border" />

      {secondaryNav.map(item => (
        <NavLink key={item.segment} item={item} companySlug={companySlug} pathname={pathname} />
      ))}
    </aside>
  );
}
