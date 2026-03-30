import { randomUUID } from "crypto";
import type { TenantCollections } from "@/lib/mongodb";
import { getLatestCompletedRunId } from "@/src/application/lib/kb2/run-scope";

export type KB2DemoStateKind = "baseline" | "workspace" | "checkpoint";

export interface KB2DemoStateDoc {
  state_id: string;
  company_slug: string;
  kind: KB2DemoStateKind;
  label: string;
  base_run_id: string;
  parent_state_id?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
}

export type KB2WorkspaceLikeState = KB2DemoStateDoc & {
  kind: "workspace" | "checkpoint";
};

export const DEMO_SCOPED_COLLECTIONS = [
  "tickets",
  "howto",
  "verification_cards",
  "claims",
  "entity_pages",
  "graph_nodes",
] as const;

export type DemoScopedCollectionName = (typeof DEMO_SCOPED_COLLECTIONS)[number];

function nowIso(): string {
  return new Date().toISOString();
}

function baselineLabelForRun(runId: string): string {
  return `Pipeline Baseline ${runId.slice(0, 8)}`;
}

function cloneLabel(kind: KB2DemoStateKind, base: string): string {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  if (kind === "workspace") return `${base} Workspace ${stamp}`;
  return `${base} Checkpoint ${stamp}`;
}

function isArchived(state: KB2DemoStateDoc | null | undefined): boolean {
  return Boolean(state?.archived_at);
}

function stateCollection(tc: TenantCollections) {
  return tc.demo_states;
}

export function buildBaselineRunFilter(runId: string): Record<string, unknown> {
  return {
    run_id: runId,
    demo_state_id: { $exists: false },
  };
}

export function buildStateFilter(stateId: string): Record<string, unknown> {
  return { demo_state_id: stateId };
}

export function isWorkspaceLikeState(
  state: KB2DemoStateDoc | null | undefined,
): state is KB2WorkspaceLikeState {
  return Boolean(state && state.kind !== "baseline" && !isArchived(state));
}

function stripDemoMetadata(doc: Record<string, unknown>): Record<string, unknown> {
  const {
    _id,
    demo_state_id,
    demo_state_kind,
    demo_base_run_id,
    demo_parent_state_id,
    demo_cloned_at,
    ...rest
  } = doc;
  return rest;
}

function getSourceFilter(sourceState: KB2DemoStateDoc): Record<string, unknown> {
  if (sourceState.kind === "baseline") {
    return buildBaselineRunFilter(sourceState.base_run_id);
  }
  return buildStateFilter(sourceState.state_id);
}

async function getStateById(
  tc: TenantCollections,
  companySlug: string,
  stateId: string,
): Promise<KB2DemoStateDoc | null> {
  const state = await stateCollection(tc).findOne({
    state_id: stateId,
    company_slug: companySlug,
  });
  return state as unknown as KB2DemoStateDoc | null;
}

async function setOnlyActiveState(
  tc: TenantCollections,
  companySlug: string,
  stateId: string,
): Promise<void> {
  const updatedAt = nowIso();
  await stateCollection(tc).updateMany(
    { company_slug: companySlug, is_active: true },
    { $set: { is_active: false, updated_at: updatedAt } },
  );
  await stateCollection(tc).updateOne(
    { state_id: stateId, company_slug: companySlug },
    { $set: { is_active: true, updated_at: updatedAt } },
  );
}

async function insertState(
  tc: TenantCollections,
  companySlug: string,
  input: {
    kind: KB2DemoStateKind;
    label: string;
    baseRunId: string;
    parentStateId?: string | null;
    isActive?: boolean;
  },
): Promise<KB2DemoStateDoc> {
  const ts = nowIso();
  const doc: KB2DemoStateDoc = {
    state_id: randomUUID(),
    company_slug: companySlug,
    kind: input.kind,
    label: input.label,
    base_run_id: input.baseRunId,
    parent_state_id: input.parentStateId ?? null,
    is_active: Boolean(input.isActive),
    created_at: ts,
    updated_at: ts,
    archived_at: null,
  };
  await stateCollection(tc).insertOne(doc);
  if (doc.is_active) {
    await setOnlyActiveState(tc, companySlug, doc.state_id);
  }
  return doc;
}

async function cloneCollectionIntoState(
  tc: TenantCollections,
  collectionName: DemoScopedCollectionName,
  sourceState: KB2DemoStateDoc,
  targetState: KB2DemoStateDoc,
): Promise<number> {
  const collection = tc[collectionName];
  const docs = await collection.find(getSourceFilter(sourceState)).toArray();
  if (docs.length === 0) return 0;
  const cloned = docs.map((doc) => ({
    ...stripDemoMetadata(doc as unknown as Record<string, unknown>),
    demo_state_id: targetState.state_id,
    demo_state_kind: targetState.kind,
    demo_base_run_id: targetState.base_run_id,
    demo_parent_state_id: targetState.parent_state_id ?? null,
    demo_cloned_at: nowIso(),
  }));
  await collection.insertMany(cloned);
  return cloned.length;
}

async function cloneStateDocs(
  tc: TenantCollections,
  sourceState: KB2DemoStateDoc,
  targetState: KB2DemoStateDoc,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const collectionName of DEMO_SCOPED_COLLECTIONS) {
    counts[collectionName] = await cloneCollectionIntoState(
      tc,
      collectionName,
      sourceState,
      targetState,
    );
  }
  return counts;
}

export async function listDemoStates(
  tc: TenantCollections,
  companySlug: string,
): Promise<KB2DemoStateDoc[]> {
  const docs = await stateCollection(tc)
    .find({ company_slug: companySlug })
    .sort({ is_active: -1, updated_at: -1, created_at: -1 })
    .toArray();
  return docs as unknown as KB2DemoStateDoc[];
}

export async function ensureBaselineState(
  tc: TenantCollections,
  companySlug: string,
  runId?: string | null,
): Promise<KB2DemoStateDoc | null> {
  const effectiveRunId = runId ?? await getLatestCompletedRunId(tc, companySlug);
  if (!effectiveRunId) return null;
  const existing = await stateCollection(tc).findOne({
    company_slug: companySlug,
    kind: "baseline",
    base_run_id: effectiveRunId,
  });
  if (existing) return existing as unknown as KB2DemoStateDoc;
  return insertState(tc, companySlug, {
    kind: "baseline",
    label: baselineLabelForRun(effectiveRunId),
    baseRunId: effectiveRunId,
    isActive: false,
  });
}

export async function resolveActiveDemoState(
  tc: TenantCollections,
  companySlug: string,
  requestedStateId?: string | null,
): Promise<KB2DemoStateDoc | null> {
  if (requestedStateId) {
    return getStateById(tc, companySlug, requestedStateId);
  }

  const active = await stateCollection(tc).findOne({
    company_slug: companySlug,
    is_active: true,
    archived_at: null,
  });
  if (active) return active as unknown as KB2DemoStateDoc;

  const baseline = await ensureBaselineState(tc, companySlug);
  if (!baseline) return null;
  await setOnlyActiveState(tc, companySlug, baseline.state_id);
  return { ...baseline, is_active: true, updated_at: nowIso() };
}

export async function publishRunAsBaseline(
  tc: TenantCollections,
  companySlug: string,
  runId: string,
): Promise<KB2DemoStateDoc | null> {
  const baseline = await ensureBaselineState(tc, companySlug, runId);
  if (!baseline) return null;
  await tc.runs.updateOne(
    { run_id: runId },
    { $set: { demo_published_baseline_state_id: baseline.state_id } },
  );
  return baseline;
}

export async function activateDemoState(
  tc: TenantCollections,
  companySlug: string,
  stateId: string,
): Promise<KB2DemoStateDoc> {
  const state = await getStateById(tc, companySlug, stateId);
  if (!state || isArchived(state)) {
    throw new Error("Demo state not found");
  }
  await setOnlyActiveState(tc, companySlug, stateId);
  return { ...state, is_active: true, updated_at: nowIso() };
}

export async function archiveDemoState(
  tc: TenantCollections,
  companySlug: string,
  stateId: string,
): Promise<void> {
  await stateCollection(tc).updateOne(
    { state_id: stateId, company_slug: companySlug },
    { $set: { is_active: false, archived_at: nowIso(), updated_at: nowIso() } },
  );
}

export async function createStateFromSource(
  tc: TenantCollections,
  companySlug: string,
  sourceState: KB2DemoStateDoc,
  kind: Exclude<KB2DemoStateKind, "baseline">,
  label?: string,
  activate = true,
): Promise<KB2DemoStateDoc> {
  const nextState = await insertState(tc, companySlug, {
    kind,
    label: label?.trim() || cloneLabel(kind, sourceState.label),
    baseRunId: sourceState.base_run_id,
    parentStateId: sourceState.state_id,
    isActive: activate,
  });
  await cloneStateDocs(tc, sourceState, nextState);
  return nextState;
}

export async function createWorkspaceFromBaseline(
  tc: TenantCollections,
  companySlug: string,
  runId?: string | null,
  label?: string,
): Promise<KB2DemoStateDoc> {
  const baseline = await ensureBaselineState(tc, companySlug, runId);
  if (!baseline) {
    throw new Error("No completed pipeline run available to create a demo workspace");
  }
  return createStateFromSource(tc, companySlug, baseline, "workspace", label, true);
}

export async function ensureWritableDemoState(
  tc: TenantCollections,
  companySlug: string,
): Promise<KB2DemoStateDoc> {
  const active = await resolveActiveDemoState(tc, companySlug);
  if (!active) {
    throw new Error("No completed pipeline run available to start a demo workspace");
  }
  if (active.kind === "workspace" && !isArchived(active)) {
    return active;
  }
  return createStateFromSource(tc, companySlug, active, "workspace", undefined, true);
}

export async function createCheckpointFromActiveState(
  tc: TenantCollections,
  companySlug: string,
  label?: string,
): Promise<KB2DemoStateDoc> {
  const active = await resolveActiveDemoState(tc, companySlug);
  if (!active) {
    throw new Error("No active demo state found");
  }
  return createStateFromSource(tc, companySlug, active, "checkpoint", label, false);
}

export async function resetActiveWorkspaceToBaseline(
  tc: TenantCollections,
  companySlug: string,
  label?: string,
): Promise<{ archived_state_id: string | null; workspace: KB2DemoStateDoc }> {
  const active = await resolveActiveDemoState(tc, companySlug);
  if (!active) {
    throw new Error("No active demo state found");
  }
  const baseline = await ensureBaselineState(tc, companySlug, active.base_run_id);
  if (!baseline) {
    throw new Error("No baseline available for the active demo state");
  }

  let archivedStateId: string | null = null;
  if (active.kind === "workspace") {
    archivedStateId = active.state_id;
    await archiveDemoState(tc, companySlug, active.state_id);
  }

  const workspace = await createStateFromSource(
    tc,
    companySlug,
    baseline,
    "workspace",
    label,
    true,
  );
  return { archived_state_id: archivedStateId, workspace };
}
