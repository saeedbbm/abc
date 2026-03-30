import { MongoClient } from "mongodb";
import { getOptionalServerEnv } from "../lib/server-env";
import { evaluateStep } from "../src/application/lib/kb2/step-judge-configs";

function resolveDbName(companySlug: string): string {
  return getOptionalServerEnv("PIDRAX_MULTI_TENANT") === "true"
    ? `pidrax_${companySlug}`
    : "pidrax";
}

async function resolveRunId(
  db: ReturnType<MongoClient["db"]>,
  requestedRunId?: string,
): Promise<string> {
  if (requestedRunId) {
    const exact = await db.collection("kb2_runs").findOne({
      run_id: requestedRunId,
      status: "completed",
    });
    if (exact?.run_id) return exact.run_id as string;

    const prefixed = await db.collection("kb2_runs").findOne(
      {
        run_id: { $regex: `^${requestedRunId}` },
        status: "completed",
      },
      { sort: { completed_at: -1 } },
    );
    if (prefixed?.run_id) return prefixed.run_id as string;
    throw new Error(`Run ${requestedRunId} not found.`);
  }

  const latest = await db.collection("kb2_runs").findOne(
    { status: "completed" },
    { sort: { completed_at: -1 } },
  );
  if (!latest?.run_id) throw new Error("No completed run found.");
  return latest.run_id as string;
}

async function getLatestCompletedStepExecutionId(
  db: ReturnType<MongoClient["db"]>,
  runId: string,
  stepId: string,
): Promise<string | null> {
  const step = await db.collection("kb2_run_steps").findOne(
    { run_id: runId, step_id: stepId, status: "completed" },
    { sort: { execution_number: -1, completed_at: -1 }, projection: { execution_id: 1 } },
  );
  return (step?.execution_id as string | undefined) ?? null;
}

async function main(): Promise<void> {
  const companySlug = process.argv[2] || "pawfinder2";
  const requestedRunId = process.argv[3];
  const stepNumbers = (process.argv[4] || "12,13,14,15")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  const mongoUri = getOptionalServerEnv("MONGODB_CONNECTION_STRING") || "mongodb://localhost:27017";
  const client = new MongoClient(mongoUri);
  await client.connect();

  try {
    const db = client.db(resolveDbName(companySlug));
    const runId = await resolveRunId(db, requestedRunId);
    const results: Array<Record<string, unknown>> = [];

    for (const stepNumber of stepNumbers) {
      const stepId = `pass1-step-${stepNumber}`;
      const executionId = await getLatestCompletedStepExecutionId(db, runId, stepId);
      if (!executionId) {
        results.push({
          step_number: stepNumber,
          step_id: stepId,
          execution_id: null,
          status: "missing",
        });
        continue;
      }

      const judgeResult = await evaluateStep(companySlug, executionId);
      results.push({
        step_number: stepNumber,
        step_id: stepId,
        execution_id: executionId,
        overall_score: judgeResult.overall_score,
        go_no_go: judgeResult.go_no_go ?? null,
        pass: judgeResult.pass,
        blockers: judgeResult.blockers ?? [],
        rerun_from_step: judgeResult.rerun_from_step ?? null,
      });
    }

    console.log(JSON.stringify({
      company_slug: companySlug,
      run_id: runId,
      steps: results,
    }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
