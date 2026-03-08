export interface SyncCursor {
  source: string; // "confluence", "jira", "slack", "github", "customerFeedback"
  company_slug: string;
  strategy: "cursor" | "hash";
  last_sync_at: string; // ISO date
  cursor_value?: string; // for cursor-based: page token, updated_after timestamp, etc.
  last_hash?: string; // for hash-based: hash of last synced content
  items_synced: number;
  status: "idle" | "syncing" | "error";
  error?: string;
}

export interface SyncRun {
  sync_id: string;
  company_slug: string;
  started_at: string;
  completed_at?: string;
  status: "running" | "completed" | "failed";
  sources_synced: string[];
  new_documents: number;
  updated_documents: number;
  error?: string;
}
