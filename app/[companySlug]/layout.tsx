"use client";

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { AppSidebar } from '@/components/pidrax/AppSidebar';
import { TopBar } from '@/components/pidrax/TopBar';
import { ContextInspector } from '@/components/pidrax/ContextInspector';
import { InspectorProvider, useInspector } from '@/contexts/InspectorContext';

function CompanyLayoutInner({ children }: { children: React.ReactNode }) {
  const { companySlug } = useParams<{ companySlug: string }>();
  const { state, setCompanySlug } = useInspector();

  useEffect(() => {
    if (companySlug) setCompanySlug(companySlug);
  }, [companySlug, setCompanySlug]);

  const inspectorOpen = state.source !== null;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <AppSidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <TopBar />
        <div className="flex flex-1 min-h-0">
          {/* Primary pane — takes full width when inspector is closed */}
          <div className={`min-w-0 overflow-y-auto ${inspectorOpen ? 'flex-[7]' : 'flex-1'}`}>
            {children}
          </div>
          {/* Inspector pane — only visible when a source is selected */}
          {inspectorOpen && (
            <div className="flex-[3] min-w-0 hidden md:block animate-slide-in-right">
              <ContextInspector />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  return (
    <InspectorProvider>
      <CompanyLayoutInner>{children}</CompanyLayoutInner>
    </InspectorProvider>
  );
}
