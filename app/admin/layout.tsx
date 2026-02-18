import Link from "next/link";
import { Zap } from "lucide-react";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-6 h-14">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
                <Zap className="h-4 w-4 text-primary-foreground" />
              </div>
              <span className="font-semibold text-base">Pidrax</span>
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm font-medium">Admin</span>
          </div>
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Back to site
          </Link>
        </div>
      </nav>
      {children}
    </div>
  );
}
