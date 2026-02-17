import { z } from "zod";

/**
 * Sync State - tracks the synchronization state for each provider
 * Enables incremental syncing and handles reconnection gracefully
 */
export const SyncState = z.object({
    id: z.string(),
    projectId: z.string(),
    provider: z.enum(['slack', 'jira', 'confluence']),
    
    // Last successful sync timestamp
    lastSyncedAt: z.string().datetime().nullable(),
    
    // Provider-specific cursor for pagination
    // For Slack: oldest message timestamp
    // For Jira: last issue updated timestamp
    // For Confluence: last page updated timestamp
    lastCursor: z.string().nullable(),
    
    // Sync statistics
    totalDocuments: z.number().default(0),
    totalEmbeddings: z.number().default(0),
    
    // Error tracking
    lastError: z.string().nullable(),
    consecutiveErrors: z.number().default(0),
    
    // Status
    status: z.enum(['idle', 'syncing', 'error']).default('idle'),
    
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type SyncStateType = z.infer<typeof SyncState>;

export const CreateSyncStateSchema = SyncState.omit({
    id: true,
    createdAt: true,
    updatedAt: true,
});

export const UpdateSyncStateSchema = SyncState.partial().omit({
    id: true,
    projectId: true,
    provider: true,
    createdAt: true,
});
