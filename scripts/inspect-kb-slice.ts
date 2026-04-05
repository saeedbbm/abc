import { MongoClient } from "mongodb";
import { getOptionalServerEnv } from "../lib/server-env";

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
  const mongoUri = getOptionalServerEnv("MONGODB_CONNECTION_STRING") || "mongodb://localhost:27017";
  const client = new MongoClient(mongoUri);
  await client.connect();

  try {
    const db = client.db(resolveDbName(companySlug));
    const runId = await resolveRunId(db, requestedRunId);
    const step3ExecId = await getLatestCompletedStepExecutionId(db, runId, "pass1-step-3");
    const step4ExecId = await getLatestCompletedStepExecutionId(db, runId, "pass1-step-4");
    const step5ExecId = await getLatestCompletedStepExecutionId(db, runId, "pass1-step-5");
    const step9ExecId = await getLatestCompletedStepExecutionId(db, runId, "pass1-step-9");
    const step10ExecId = await getLatestCompletedStepExecutionId(db, runId, "pass1-step-10");

    const nodes = await db.collection("kb2_graph_nodes")
      .find({ execution_id: { $in: [step9ExecId, step10ExecId].filter(Boolean) } })
      .project({ display_name: 1, type: 1, truth_status: 1, attributes: 1, aliases: 1 })
      .toArray();

    const repoNodes = nodes
      .filter((node) => node.type === "repository")
      .map((node) => ({
        name: node.display_name,
        aliases: node.aliases ?? [],
        truth_status: node.truth_status,
        repo: node.attributes?.repo,
        status: node.attributes?.status,
        documentation_level: node.attributes?.documentation_level,
        candidate_origin: node.attributes?._candidate_origin,
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const projectNodes = nodes
      .filter((node) => node.type === "project")
      .map((node) => ({
        name: node.display_name,
        truth_status: node.truth_status,
        status: node.attributes?.status,
        discovery_category: node.attributes?.discovery_category,
        documentation_level: node.attributes?.documentation_level,
        candidate_origin: node.attributes?._candidate_origin,
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const stepArtifacts = await db.collection("kb2_run_steps")
      .find({ execution_id: { $in: [step3ExecId, step4ExecId, step5ExecId].filter(Boolean) } })
      .project({ step_id: 1, execution_id: 1, artifact: 1 })
      .toArray();

    const artifactByStep = new Map(stepArtifacts.map((step) => [step.step_id, step.artifact]));

    console.log(JSON.stringify({
      company_slug: companySlug,
      run_id: runId,
      executions: {
        step3: step3ExecId,
        step4: step4ExecId,
        step5: step5ExecId,
        step9: step9ExecId,
        step10: step10ExecId,
      },
      step3_summary: {
        entities_by_type: artifactByStep.get("pass1-step-3")?.entities_by_type ?? null,
        candidate_entities_by_type: artifactByStep.get("pass1-step-3")?.candidate_entities_by_type ?? null,
      },
      step4_summary: {
        total_entities_before: artifactByStep.get("pass1-step-4")?.total_entities_before ?? null,
        total_entities_after: artifactByStep.get("pass1-step-4")?.total_entities_after ?? null,
        deterministic_actions: artifactByStep.get("pass1-step-4")?.deterministic_actions ?? null,
      },
      step5_summary: {
        before_count_by_type: artifactByStep.get("pass1-step-5")?.before_count_by_type ?? null,
        after_count_by_type: artifactByStep.get("pass1-step-5")?.after_count_by_type ?? null,
        merges: artifactByStep.get("pass1-step-5")?.merges ?? null,
      },
      repo_nodes: repoNodes,
      project_nodes: projectNodes,
    }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
