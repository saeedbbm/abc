"use client";

import { AppSidebar } from '@/components/pidrax/AppSidebar';
import { TopBar } from '@/components/pidrax/TopBar';
import { ContextInspector } from '@/components/pidrax/ContextInspector';
import { InspectorProvider } from '@/contexts/InspectorContext';

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  return (
    <InspectorProvider>
      <div className="flex h-screen w-full overflow-hidden bg-background">
        <AppSidebar />
        <div className="flex flex-1 flex-col min-w-0">
          <TopBar />
          <div className="flex flex-1 min-h-0">
            {/* Primary pane */}
            <div className="flex-[7] min-w-0 overflow-y-auto">
              {children}
            </div>
            {/* Inspector pane */}
            <div className="flex-[3] min-w-0 hidden md:block">
              <ContextInspector />
            </div>
          </div>
        </div>
      </div>
    </InspectorProvider>
  );
}
