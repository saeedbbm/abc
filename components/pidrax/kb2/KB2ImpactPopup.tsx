"use client";

import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, X, AlertTriangle } from "lucide-react";

export interface Impact {
  id: string;
  summary: string;
  reason: string;
  recommended_action: string;
  target_type: string;
  target_id: string;
  severity: string;
  accepted?: boolean;
}

interface KB2ImpactPopupProps {
  open: boolean;
  onClose: () => void;
  impacts: Impact[];
  onConfirm: (acceptedIds: string[]) => void;
}

const SEVERITY_COLORS: Record<string, string> = {
  S1: "bg-red-600 text-white hover:bg-red-700",
  S2: "bg-orange-500 text-white hover:bg-orange-600",
  S3: "bg-yellow-400 text-black hover:bg-yellow-500",
  S4: "bg-blue-500 text-white hover:bg-blue-600",
};

export function KB2ImpactPopup({
  open,
  onClose,
  impacts,
  onConfirm,
}: KB2ImpactPopupProps) {
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(
    impacts[0]?.id ?? null,
  );

  const reviewedCount = accepted.size + dismissed.size;
  const allReviewed = reviewedCount === impacts.length && impacts.length > 0;

  const selectedImpact = useMemo(
    () => impacts.find((i) => i.id === selectedId) ?? null,
    [impacts, selectedId],
  );

  function toggleAccept(id: string) {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setDismissed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function toggleDismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setAccepted((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function acceptAll() {
    setAccepted(new Set(impacts.map((i) => i.id)));
    setDismissed(new Set());
  }

  function dismissAll() {
    setDismissed(new Set(impacts.map((i) => i.id)));
    setAccepted(new Set());
  }

  function handleConfirm() {
    onConfirm([...accepted]);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl min-h-[500px] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-3 border-b shrink-0">
          <DialogTitle>Review Changes</DialogTitle>
          <DialogDescription>
            The following impacts were detected. Review each before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 min-h-0">
          {/* Left panel – impact list */}
          <div className="w-[40%] border-r flex flex-col">
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {impacts.map((impact) => {
                  const isAccepted = accepted.has(impact.id);
                  const isDismissed = dismissed.has(impact.id);
                  const isSelected = selectedId === impact.id;

                  return (
                    <div
                      key={impact.id}
                      className={`rounded-md border p-3 cursor-pointer transition-colors ${
                        isSelected
                          ? "border-primary bg-muted"
                          : "hover:bg-muted/50"
                      }`}
                      onClick={() => setSelectedId(impact.id)}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge
                          className={`text-xs ${SEVERITY_COLORS[impact.severity] ?? "bg-gray-400 text-white"}`}
                        >
                          {impact.severity}
                        </Badge>
                        <span className="text-sm font-medium truncate flex-1">
                          {impact.summary}
                        </span>
                      </div>
                      <div className="flex gap-1 mt-2">
                        <Button
                          size="sm"
                          variant={isAccepted ? "default" : "outline"}
                          className="h-7 px-2 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleAccept(impact.id);
                          }}
                        >
                          <Check className="h-3 w-3 mr-1" />
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant={isDismissed ? "destructive" : "outline"}
                          className="h-7 px-2 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleDismiss(impact.id);
                          }}
                        >
                          <X className="h-3 w-3 mr-1" />
                          Dismiss
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>

          {/* Right panel – impact detail */}
          <div className="w-[60%] flex flex-col">
            <ScrollArea className="flex-1">
              {selectedImpact ? (
                <div className="p-6 space-y-4">
                  <div className="flex items-center gap-2">
                    <Badge
                      className={`${SEVERITY_COLORS[selectedImpact.severity] ?? "bg-gray-400 text-white"}`}
                    >
                      {selectedImpact.severity}
                    </Badge>
                    <h3 className="text-lg font-semibold">
                      {selectedImpact.summary}
                    </h3>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">
                      Reason
                    </h4>
                    <p className="text-sm">{selectedImpact.reason}</p>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium text-muted-foreground mb-1">
                      Recommended Action
                    </h4>
                    <p className="text-sm">
                      {selectedImpact.recommended_action}
                    </p>
                  </div>

                  <div className="flex gap-4">
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-1">
                        Target Type
                      </h4>
                      <Badge variant="outline">
                        {selectedImpact.target_type}
                      </Badge>
                    </div>
                    <div>
                      <h4 className="text-sm font-medium text-muted-foreground mb-1">
                        Target ID
                      </h4>
                      <code className="text-xs bg-muted px-2 py-1 rounded">
                        {selectedImpact.target_id}
                      </code>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground p-6">
                  <div className="text-center">
                    <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Select an impact to view details</p>
                  </div>
                </div>
              )}
            </ScrollArea>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t px-6 py-3 flex items-center justify-between shrink-0">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={acceptAll}>
              Accept All
            </Button>
            <Button variant="outline" size="sm" onClick={dismissAll}>
              Dismiss All
            </Button>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">
              {reviewedCount} of {impacts.length} reviewed
            </span>
            <Button disabled={!allReviewed} onClick={handleConfirm}>
              Confirm Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
