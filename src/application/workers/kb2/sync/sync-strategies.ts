/**
 * Sync strategies for incremental data updates.
 *
 * CursorStrategy: Uses a cursor/timestamp to fetch only items changed since last sync.
 *   - Confluence: modified_after
 *   - Jira: updated > timestamp
 *   - Slack: oldest parameter
 *   - GitHub: since parameter
 *
 * HashStrategy: Computes a hash of the full dataset and compares.
 *   - If hash differs, marks all items as changed.
 *   - Used for customerFeedback where there's no reliable cursor.
 */

export interface DetectChangesResult {
  newItems: string[];
  updatedItems: string[];
  deletedItems: string[];
  newCursor?: string;
  newHash?: string;
}

/**
 * Detects changes for a given source using the configured strategy.
 * Returns item IDs that are new, updated, or deleted.
 *
 * For now this is a stub that returns empty arrays — the actual connector
 * logic will vary per source.
 */
export async function detectChanges(
  source: string,
  companySlug: string,
  strategy: "cursor" | "hash",
): Promise<DetectChangesResult> {
  // Stub: connector-specific logic will be implemented per source
  void source;
  void companySlug;
  void strategy;

  return {
    newItems: [],
    updatedItems: [],
    deletedItems: [],
  };
}
