"use client";

import { AppSidebar } from '@/components/pidrax/AppSidebar';
import { TopBar } from '@/components/pidrax/TopBar';

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <AppSidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <TopBar />
        <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  );
}
