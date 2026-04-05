import { AppSidebar } from '@/components/pidrax/AppSidebar';

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <AppSidebar />
      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
