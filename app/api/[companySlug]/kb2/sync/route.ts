import { NextRequest } from "next/server";
import {
  kb2SyncCursorsCollection,
  kb2SyncRunsCollection,
} from "@/lib/mongodb";
import { getSyncConfig } from "@/src/application/lib/kb2/company-config";
import {
  detectChanges,
  type DetectChangesResult,
} from "@/src/application/workers/kb2/sync/sync-strategies";
import type { SyncCursor, SyncRun } from "@/src/entities/models/kb2-sync-types";

const VALID_SOURCES = [
  "confluence",
  "jira",
  "slack",
  "github",
  "customerFeedback",
] as const;
type SourceType = (typeof VALID_SOURCES)[number];

/**
 * Ingest changed documents into kb2_raw_inputs.
 * Connector-specific: fetches content and merges/replaces in raw_inputs.
 * Stub for now — will be implemented per source.
 */
async function ingestChangesForSource(
  companySlug: string,
  source: string,
  result: DetectChangesResult,
): Promise<{ newCount: number; updatedCount: number }> {
  const { newItems, updatedItems } = result;
  const newCount = newItems.length;
  const updatedCount = updatedItems.length;
  if (newCount === 0 && updatedCount === 0) {
    return { newCount: 0, updatedCount: 0 };
  }
  // TODO: Per-source connector will fetch content and upsert into kb2_raw_inputs.
  // For now, no-op — detectChanges stub returns empty arrays.
  void companySlug;
  void source;
  return { newCount, updatedCount };
}

/**
 * GET — Returns sync status: last sync timestamps per source, recent sync runs.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;

  const [cursors, runs] = await Promise.all([
    kb2SyncCursorsCollection
      .find({ company_slug: companySlug })
      .sort({ last_sync_at: -1 })
      .toArray(),
    kb2SyncRunsCollection
      .find({ company_slug: companySlug })
      .sort({ started_at: -1 })
      .limit(20)
      .toArray(),
  ]);

  return Response.json({
    cursors: cursors as unknown as SyncCursor[],
    syncRuns: runs as unknown as SyncRun[],
  });
}

/**
 * POST — Triggers a sync run for all enabled sources (or specific sources if provided).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;

  let sourcesToSync: string[] | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    if (body.sources && Array.isArray(body.sources) && body.sources.length > 0) {
      sourcesToSync = body.sources.filter((s: string) =>
        VALID_SOURCES.includes(s as SourceType),
      );
    }
  } catch {
    // No body or invalid — use all enabled sources
  }

  const syncConfig = await getSyncConfig(companySlug);
  const enabledSources = syncConfig.sources.filter((s) => s.enabled);
  const sources =
    sourcesToSync && sourcesToSync.length > 0
      ? enabledSources.filter((s) => sourcesToSync!.includes(s.source))
      : enabledSources;

  if (sources.length === 0) {
    return Response.json(
      { error: "No enabled sources to sync" },
      { status: 400 },
    );
  }

  const syncId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const syncRun: SyncRun = {
    sync_id: syncId,
    company_slug: companySlug,
    started_at: new Date().toISOString(),
    status: "running",
    sources_synced: sources.map((s) => s.source),
    new_documents: 0,
    updated_documents: 0,
  };

  await kb2SyncRunsCollection.insertOne(syncRun as any);

  let totalNew = 0;
  let totalUpdated = 0;
  const errors: string[] = [];

  for (const srcConfig of sources) {
    const source = srcConfig.source;
    const strategy = srcConfig.strategy;

    try {
      // Mark cursor as syncing
      await kb2SyncCursorsCollection.updateOne(
        { company_slug: companySlug, source },
        {
          $set: {
            company_slug: companySlug,
            source,
            strategy,
            status: "syncing",
            last_sync_at: new Date().toISOString(),
          },
        },
        { upsert: true },
      );

      const result = await detectChanges(source, companySlug, strategy);

      const { newCount, updatedCount } = await ingestChangesForSource(
        companySlug,
        source,
        result,
      );
      totalNew += newCount;
      totalUpdated += updatedCount;

      await kb2SyncCursorsCollection.updateOne(
        { company_slug: companySlug, source },
        {
          $set: {
            cursor_value: result.newCursor,
            last_hash: result.newHash,
            items_synced: result.newItems.length + result.updatedItems.length,
            status: "idle",
            error: undefined,
          },
        },
      );
    } catch (err: any) {
      errors.push(`${source}: ${err.message}`);
      await kb2SyncCursorsCollection.updateOne(
        { company_slug: companySlug, source },
        {
          $set: {
            status: "error",
            error: err.message,
          },
        },
      );
    }
  }

  const runStatus = errors.length > 0 ? "failed" : "completed";
  await kb2SyncRunsCollection.updateOne(
    { sync_id: syncId },
    {
      $set: {
        completed_at: new Date().toISOString(),
        status: runStatus,
        new_documents: totalNew,
        updated_documents: totalUpdated,
        error: errors.length > 0 ? errors.join("; ") : undefined,
      },
    },
  );

  return Response.json({
    sync_id: syncId,
    status: runStatus,
    sources_synced: sources.map((s) => s.source),
    new_documents: totalNew,
    updated_documents: totalUpdated,
    errors: errors.length > 0 ? errors : undefined,
  });
}
