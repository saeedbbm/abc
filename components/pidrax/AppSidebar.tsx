import Link from 'next/link';
import { AppSidebarNav } from '@/components/pidrax/AppSidebarNav';

export function AppSidebar() {
  return (
    <aside className="w-16 shrink-0 flex flex-col items-center py-4 gap-1 bg-sidebar border-r border-sidebar-border">
      <Link
        href="/"
        aria-label="Go to home page"
        className="mb-4 h-8 w-8 rounded-lg bg-sidebar-primary flex items-center justify-center"
      >
        <span className="text-sidebar-primary-foreground text-xs font-bold">P</span>
      </Link>
      <AppSidebarNav />
    </aside>
  );
}
