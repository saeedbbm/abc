import { NextRequest } from "next/server";
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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const activeState = await resolveActiveDemoState(tc, companySlug);
  const [states, latestCompletedRunId] = await Promise.all([
    listDemoStates(tc, companySlug),
    getLatestCompletedRunId(tc, companySlug),
  ]);
  return Response.json({
    active_state: activeState,
    states,
    latest_completed_run_id: latestCompletedRunId,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const body = await request.json();
  const action = body.action as string | undefined;

  try {
    switch (action) {
      case "publish_baseline": {
        const runId = typeof body.run_id === "string" ? body.run_id : await getLatestCompletedRunId(tc, companySlug);
        if (!runId) {
          return Response.json({ error: "No completed run available to publish" }, { status: 400 });
        }
        const baseline = await publishRunAsBaseline(tc, companySlug, runId);
        if (!baseline) {
          return Response.json({ error: "No completed run available to publish" }, { status: 400 });
        }
        return Response.json({ ok: true, baseline });
      }
      case "start_workspace": {
        const workspace = await createWorkspaceFromBaseline(
          tc,
          companySlug,
          typeof body.run_id === "string" ? body.run_id : null,
          typeof body.label === "string" ? body.label : undefined,
        );
        return Response.json({ ok: true, workspace });
      }
      case "reset_workspace": {
        const result = await resetActiveWorkspaceToBaseline(
          tc,
          companySlug,
          typeof body.label === "string" ? body.label : undefined,
        );
        return Response.json({ ok: true, ...result });
      }
      case "save_checkpoint": {
        const checkpoint = await createCheckpointFromActiveState(
          tc,
          companySlug,
          typeof body.label === "string" ? body.label : undefined,
        );
        return Response.json({ ok: true, checkpoint });
      }
      case "activate_state": {
        if (typeof body.state_id !== "string" || body.state_id.trim().length === 0) {
          return Response.json({ error: "state_id is required" }, { status: 400 });
        }
        const state = await activateDemoState(tc, companySlug, body.state_id);
        return Response.json({ ok: true, state });
      }
      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error: any) {
    return Response.json(
      { error: error?.message ?? "Demo state action failed" },
      { status: 500 },
    );
  }
}
