import "dotenv/config";
import { ensureStepsRegistered } from "@/src/application/workers/kb2/register-steps";
import { runPipeline } from "@/src/application/workers/kb2/pipeline-runner";

async function main() {
  const [, , reuseRunId, fromStepRaw, toStepRaw] = process.argv;
  if (!reuseRunId || !fromStepRaw || !toStepRaw) {
    throw new Error("Usage: npx tsx scripts/run-pass1-range.ts <reuseRunId> <fromStep> <toStep>");
  }

  process.env.PIDRAX_MULTI_TENANT ??= "true";
  ensureStepsRegistered();

  const fromStep = Number(fromStepRaw);
  const toStep = Number(toStepRaw);

  const result = await runPipeline({
    companySlug: "pawfinder2",
    pass: "pass1",
    fromStep,
    toStep,
    reuseRunId,
    title: `Pass 1 rerun ${fromStep}-${toStep}`,
  });

  console.log(JSON.stringify({ run_id: result.run_id, status: result.status, fromStep, toStep }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
