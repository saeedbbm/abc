"use client";

import { useEffect, useRef } from "react";

interface DemoStateResponse {
  active_state?: {
    base_run_id?: string | null;
  } | null;
  latest_completed_run_id?: string | null;
}

export function useLatestCompletedRunAutoRefresh(companySlug: string) {
  const hasInitializedRef = useRef(false);
  const latestSeenRunIdRef = useRef<string | null>(null);
  const lastReloadedRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    let isCancelled = false;

    const checkForNewRun = async () => {
      try {
        const res = await fetch(`/api/${companySlug}/kb2/demo-state`, {
          cache: "no-store",
        });
        if (!res.ok || isCancelled) return;

        const data = await res.json() as DemoStateResponse;
        if (isCancelled) return;

        const latestCompletedRunId =
          typeof data.latest_completed_run_id === "string" && data.latest_completed_run_id.trim().length > 0
            ? data.latest_completed_run_id
            : null;
        const activeBaseRunId =
          typeof data.active_state?.base_run_id === "string" && data.active_state.base_run_id.trim().length > 0
            ? data.active_state.base_run_id
            : null;

        if (!hasInitializedRef.current) {
          hasInitializedRef.current = true;
          latestSeenRunIdRef.current = latestCompletedRunId;
          return;
        }

        if (latestSeenRunIdRef.current === latestCompletedRunId) {
          return;
        }

        latestSeenRunIdRef.current = latestCompletedRunId;

        if (
          latestCompletedRunId &&
          activeBaseRunId === latestCompletedRunId &&
          lastReloadedRunIdRef.current !== latestCompletedRunId
        ) {
          lastReloadedRunIdRef.current = latestCompletedRunId;
          window.location.reload();
        }
      } catch {
        // Ignore transient polling failures.
      }
    };

    void checkForNewRun();
    const intervalId = window.setInterval(() => {
      void checkForNewRun();
    }, 5000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [companySlug]);
}
