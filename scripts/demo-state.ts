import "dotenv/config";
import { getTenantCollections } from "@/lib/mongodb";
import {
  activateDemoState,
  createCheckpointFromActiveState,
  createWorkspaceFromBaseline,
  listDemoStates,
  publishRunAsBaseline,
  resetActiveWorkspaceToBaseline,
  resolveActiveDemoState,
} from "@/src/application/lib/kb2/demo-state";
import { getLatestCompletedRunId } from "@/src/application/lib/kb2/run-scope";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run demo-state -- <companySlug> status",
      "  npm run demo-state -- <companySlug> publish [runId]",
      "  npm run demo-state -- <companySlug> start [runId] [label]",
      "  npm run demo-state -- <companySlug> reset [label]",
      "  npm run demo-state -- <companySlug> checkpoint [label]",
      "  npm run demo-state -- <companySlug> activate <stateId>",
    ].join("\n"),
  );
  process.exit(1);
}

function looksLikeRunId(value: string | undefined): boolean {
  return Boolean(value && /^[a-f0-9-]{8,}$/i.test(value));
}

async function main() {
  const [, , companySlug, command, ...rest] = process.argv;
  if (!companySlug || !command) usage();

  const tc = getTenantCollections(companySlug);

  switch (command) {
    case "status": {
      const activeState = await resolveActiveDemoState(tc, companySlug);
      const [latestRunId, states] = await Promise.all([
        getLatestCompletedRunId(tc, companySlug),
        listDemoStates(tc, companySlug),
      ]);
      console.log(JSON.stringify({
        company_slug: companySlug,
        latest_completed_run_id: latestRunId,
        active_state: activeState,
        states,
      }, null, 2));
      return;
    }
    case "publish": {
      const runId = rest[0] ?? await getLatestCompletedRunId(tc, companySlug);
      if (!runId) throw new Error("No completed run available");
      const baseline = await publishRunAsBaseline(tc, companySlug, runId);
      console.log(JSON.stringify({ ok: true, baseline }, null, 2));
      return;
    }
    case "start": {
      const runId = looksLikeRunId(rest[0]) ? rest[0]! : null;
      const label = runId ? rest.slice(1).join(" ").trim() || undefined : rest.join(" ").trim() || undefined;
      const workspace = await createWorkspaceFromBaseline(tc, companySlug, runId, label);
      console.log(JSON.stringify({ ok: true, workspace }, null, 2));
      return;
    }
    case "reset": {
      const label = rest.join(" ").trim() || undefined;
      const result = await resetActiveWorkspaceToBaseline(tc, companySlug, label);
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    case "checkpoint": {
      const label = rest.join(" ").trim() || undefined;
      const checkpoint = await createCheckpointFromActiveState(tc, companySlug, label);
      console.log(JSON.stringify({ ok: true, checkpoint }, null, 2));
      return;
    }
    case "activate": {
      const stateId = rest[0];
      if (!stateId) usage();
      const state = await activateDemoState(tc, companySlug, stateId);
      console.log(JSON.stringify({ ok: true, state }, null, 2));
      return;
    }
    default:
      usage();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
