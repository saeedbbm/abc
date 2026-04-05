"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type { ImperativePanelHandle } from "react-resizable-panels";

interface LeftSidebarLayoutProps {
  autoSaveId: string;
  leftSidebar: ReactNode;
  mainContent: ReactNode;
  leftDefaultSize?: number;
  leftMinSize?: number;
  mainDefaultSize?: number;
  mainMinSize?: number;
}

const DEFAULT_LEFT = 24;

export function LeftSidebarLayout({
  autoSaveId,
  leftSidebar,
  mainContent,
  leftDefaultSize = DEFAULT_LEFT,
  leftMinSize = 18,
  mainDefaultSize = 100 - leftDefaultSize,
  mainMinSize = 35,
}: LeftSidebarLayoutProps) {
  const leftRef = useRef<ImperativePanelHandle>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const expand = useCallback(() => {
    leftRef.current?.resize(leftDefaultSize);
  }, [leftDefaultSize]);

  return (
    <div className="relative flex-1 h-full min-w-0">
      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId={autoSaveId}
        className="h-full w-full"
      >
        <ResizablePanel
          ref={leftRef}
          defaultSize={leftDefaultSize}
          minSize={leftMinSize}
          collapsible
          collapsedSize={0}
          onCollapse={() => setIsCollapsed(true)}
          onExpand={() => setIsCollapsed(false)}
          className="min-w-0 overflow-hidden"
        >
          {leftSidebar}
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          defaultSize={mainDefaultSize}
          minSize={mainMinSize}
          className="min-w-0 overflow-hidden"
        >
          {mainContent}
        </ResizablePanel>
      </ResizablePanelGroup>

      {isCollapsed && (
        <button
          onClick={expand}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-6 h-12 rounded-r-md border border-l-0 bg-background shadow-sm hover:bg-accent transition-colors"
          title="Open left panel"
        >
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
