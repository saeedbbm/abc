"use client";

import { useRef, useCallback, useState, type ReactNode } from "react";
import { PanelRightOpen } from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type { ImperativePanelHandle } from "react-resizable-panels";

interface SplitLayoutProps {
  autoSaveId: string;
  mainContent: ReactNode;
  rightPanel: ReactNode;
  mainDefaultSize?: number;
  mainMinSize?: number;
  rightDefaultSize?: number;
  rightMinSize?: number;
}

const DEFAULT_RIGHT = 35;

export function SplitLayout({
  autoSaveId,
  mainContent,
  rightPanel,
  mainDefaultSize = 65,
  mainMinSize = 30,
  rightDefaultSize = DEFAULT_RIGHT,
  rightMinSize = 20,
}: SplitLayoutProps) {
  const rightRef = useRef<ImperativePanelHandle>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const expand = useCallback(() => {
    rightRef.current?.resize(rightDefaultSize);
  }, [rightDefaultSize]);

  return (
    <div className="relative flex-1 h-full min-w-0">
      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId={autoSaveId}
        className="h-full w-full"
      >
        <ResizablePanel
          defaultSize={mainDefaultSize}
          minSize={mainMinSize}
          className="min-w-0 overflow-hidden"
        >
          {mainContent}
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          ref={rightRef}
          defaultSize={rightDefaultSize}
          minSize={rightMinSize}
          collapsible
          collapsedSize={0}
          onCollapse={() => setIsCollapsed(true)}
          onExpand={() => setIsCollapsed(false)}
          className="min-w-0 overflow-hidden"
        >
          {rightPanel}
        </ResizablePanel>
      </ResizablePanelGroup>

      {isCollapsed && (
        <button
          onClick={expand}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-6 h-12 rounded-l-md border border-r-0 bg-background shadow-sm hover:bg-accent transition-colors"
          title="Open panel"
        >
          <PanelRightOpen className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
