import type { TenantCollections } from "@/lib/mongodb";

function normalizeRunIds(runIds: unknown[]): string[] {
  return runIds.filter((runId): runId is string => typeof runId === "string" && runId.trim().length > 0);
}

export async function getLatestCompletedRunId(
  tc: TenantCollections,
  companySlug: string,
  candidateRunIds?: unknown[],
): Promise<string | null> {
  const runFilter: Record<string, unknown> = {
    company_slug: companySlug,
    status: "completed",
  };

  const normalizedRunIds = candidateRunIds ? normalizeRunIds(candidateRunIds) : [];
  if (normalizedRunIds.length > 0) {
    runFilter.run_id = { $in: normalizedRunIds };
  }

  const latestRun = await tc.runs.findOne(
    runFilter,
    { sort: { completed_at: -1 }, projection: { run_id: 1 } },
  );
  return typeof latestRun?.run_id === "string" ? latestRun.run_id : null;
}

export async function getLatestRunIdFromCollection(
  tc: TenantCollections,
  companySlug: string,
  collection: Pick<TenantCollections["runs"], "distinct">,
): Promise<string | null> {
  const runIds = normalizeRunIds(await collection.distinct("run_id"));
  if (runIds.length === 0) return null;
  return getLatestCompletedRunId(tc, companySlug, runIds);
}

export async function getLatestCompletedStepExecutionId(
  tc: TenantCollections,
  runId: string,
  stepId: string,
): Promise<string | null> {
  const step = await tc.run_steps.findOne(
    { run_id: runId, step_id: stepId, status: "completed" },
    { sort: { execution_number: -1, completed_at: -1 }, projection: { execution_id: 1 } },
  );
  return typeof step?.execution_id === "string" ? step.execution_id : null;
}
