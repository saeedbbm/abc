/**
 * Source-Agnostic Provider Interface
 * 
 * Defines the contract that all data providers (Slack, Jira, Confluence, GitHub, etc.)
 * must implement. This makes it easy to add new data sources without changing the core pipeline.
 * 
 * Each provider registers:
 * - Its name and document types
 * - A chunking strategy for its documents
 * - Optional webhook configuration
 * - Optional OAuth configuration
 */

import { SmartChunk } from "@/src/application/lib/knowledge/smart-chunker";

/**
 * Chunking strategy for a specific document type.
 */
export interface ChunkStrategy {
    /** Source types this strategy handles */
    sourceTypes: string[];
    /** Chunk a document's content */
    chunk(content: string, metadata?: Record<string, any>): Promise<SmartChunk[]>;
}

/**
 * Webhook configuration for a provider.
 */
export interface WebhookConfig {
    /** URL path for the webhook endpoint (e.g., '/api/webhooks/slack') */
    path: string;
    /** Events this webhook handles */
    events: string[];
    /** Whether the webhook requires signature verification */
    requiresSignature: boolean;
}

/**
 * OAuth configuration for a provider.
 */
export interface OAuthConfig {
    /** Authorization URL */
    authorizeUrl: string;
    /** Token exchange URL */
    tokenUrl: string;
    /** Required scopes */
    scopes: string[];
    /** Redirect path (e.g., '/api/integrations/slack/callback') */
    redirectPath: string;
}

/**
 * Data provider interface.
 * All data sources (Slack, Jira, Confluence, GitHub, etc.) implement this.
 */
export interface DataProvider {
    /** Unique identifier for this provider */
    name: string;
    /** Human-readable display name */
    displayName: string;
    /** Document types this provider creates in knowledge_documents */
    sourceTypes: string[];
    /** Chunking strategies for each document type */
    chunkStrategies: ChunkStrategy[];
    /** Webhook configuration (if real-time events are supported) */
    webhookConfig?: WebhookConfig;
    /** OAuth configuration (if OAuth is needed for connection) */
    oauthConfig?: OAuthConfig;
    /** Icon name for UI display */
    icon?: string;
}

/**
 * Provider Registry
 * 
 * Central registry where all providers are registered.
 * The core pipeline queries this registry to determine how to process documents.
 */
class ProviderRegistry {
    private providers = new Map<string, DataProvider>();
    private chunkStrategies = new Map<string, ChunkStrategy>();

    /**
     * Register a data provider.
     */
    register(provider: DataProvider): void {
        this.providers.set(provider.name, provider);
        
        // Register chunk strategies by source type
        for (const strategy of provider.chunkStrategies) {
            for (const sourceType of strategy.sourceTypes) {
                this.chunkStrategies.set(sourceType, strategy);
            }
        }
    }

    /**
     * Get a provider by name.
     */
    getProvider(name: string): DataProvider | undefined {
        return this.providers.get(name);
    }

    /**
     * Get all registered providers.
     */
    getAllProviders(): DataProvider[] {
        return Array.from(this.providers.values());
    }

    /**
     * Get the chunk strategy for a given source type.
     */
    getChunkStrategy(sourceType: string): ChunkStrategy | undefined {
        return this.chunkStrategies.get(sourceType);
    }

    /**
     * Check if a provider is registered.
     */
    hasProvider(name: string): boolean {
        return this.providers.has(name);
    }
}

// Singleton registry
export const providerRegistry = new ProviderRegistry();

// --- Built-in provider registrations ---

import { smartChunk } from "@/src/application/lib/knowledge/smart-chunker";

/**
 * Standard webhook handler pattern for new sources.
 * Steps 4-6 are shared across all providers:
 * 4. smartChunk() + embed()
 * 5. matchAndVerifyClaims()
 * 6. resolveEntities()
 */
export interface WebhookHandlerContext {
    projectId: string;
    documentId: string;
    content: string;
    sourceType: string;
    provider: string;
    title: string;
    sourceId: string;
}

/**
 * Standard post-ingestion pipeline (shared steps 4-6).
 * Call this after creating/updating a knowledge_document from any provider.
 */
export async function runPostIngestionPipeline(ctx: WebhookHandlerContext): Promise<void> {
    const { embedKnowledgeDocument } = await import("@/src/application/lib/knowledge/embedding-service");
    const { matchAndVerifyClaims } = await import("@/src/application/lib/knowledge/claim-matcher");
    
    // Step 4: Embed (smart chunking is handled inside embedKnowledgeDocument)
    const doc = {
        id: ctx.documentId,
        projectId: ctx.projectId,
        content: ctx.content,
        provider: ctx.provider,
        sourceType: ctx.sourceType,
        sourceId: ctx.sourceId,
        title: ctx.title,
        metadata: {},
        syncedAt: new Date().toISOString(),
    } as any;
    
    await embedKnowledgeDocument(doc);

    // Step 5: Event-driven claim verification
    matchAndVerifyClaims(ctx.projectId, {
        id: ctx.documentId,
        content: ctx.content,
        provider: ctx.provider,
        sourceType: ctx.sourceType,
        title: ctx.title,
        sourceId: ctx.sourceId,
    }).catch(() => {});
    
    // Step 6: Entity resolution is handled during sync
}

// Register Slack provider
providerRegistry.register({
    name: 'slack',
    displayName: 'Slack',
    sourceTypes: ['slack_message', 'slack_thread', 'slack_conversation', 'slack_channel', 'slack_user'],
    chunkStrategies: [{
        sourceTypes: ['slack_message', 'slack_thread', 'slack_conversation', 'slack_channel', 'slack_user'],
        chunk: async (content) => smartChunk(content, 'slack_message'),
    }],
    webhookConfig: {
        path: '/api/webhooks/slack',
        events: ['message', 'message_changed', 'message_deleted', 'channel_created', 'channel_rename'],
        requiresSignature: true,
    },
    oauthConfig: {
        authorizeUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        scopes: ['channels:history', 'channels:read', 'chat:write', 'users:read', 'groups:history', 'groups:read'],
        redirectPath: '/api/integrations/slack/callback',
    },
    icon: 'slack',
});

// Register Jira provider
providerRegistry.register({
    name: 'jira',
    displayName: 'Jira',
    sourceTypes: ['jira_issue', 'jira_comment', 'jira_project', 'jira_user'],
    chunkStrategies: [{
        sourceTypes: ['jira_issue'],
        chunk: async (content) => smartChunk(content, 'jira_issue'),
    }, {
        sourceTypes: ['jira_comment', 'jira_project', 'jira_user'],
        chunk: async (content, meta) => smartChunk(content, meta?.sourceType || 'jira_comment'),
    }],
    webhookConfig: {
        path: '/api/webhooks/atlassian',
        events: ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted', 'comment_created', 'comment_updated'],
        requiresSignature: false,
    },
    oauthConfig: {
        authorizeUrl: 'https://auth.atlassian.com/authorize',
        tokenUrl: 'https://auth.atlassian.com/oauth/token',
        scopes: ['read:jira-work', 'read:jira-user', 'write:jira-work'],
        redirectPath: '/api/integrations/atlassian/callback',
    },
    icon: 'jira',
});

// Register Confluence provider
providerRegistry.register({
    name: 'confluence',
    displayName: 'Confluence',
    sourceTypes: ['confluence_page', 'confluence_space'],
    chunkStrategies: [{
        sourceTypes: ['confluence_page'],
        chunk: async (content) => smartChunk(content, 'confluence_page'),
    }, {
        sourceTypes: ['confluence_space'],
        chunk: async (content) => smartChunk(content, 'confluence_space'),
    }],
    webhookConfig: {
        path: '/api/webhooks/atlassian',
        events: ['page_created', 'page_updated', 'page_removed'],
        requiresSignature: false,
    },
    oauthConfig: {
        authorizeUrl: 'https://auth.atlassian.com/authorize',
        tokenUrl: 'https://auth.atlassian.com/oauth/token',
        scopes: ['read:confluence-content.all', 'read:confluence-space.summary'],
        redirectPath: '/api/integrations/atlassian/callback',
    },
    icon: 'confluence',
});

// GitHub provider (FUTURE — registered with placeholder config)
providerRegistry.register({
    name: 'github',
    displayName: 'GitHub',
    sourceTypes: ['github_pr', 'github_issue', 'github_commit', 'github_readme', 'github_file'],
    chunkStrategies: [{
        sourceTypes: ['github_pr', 'github_issue'],
        chunk: async (content) => smartChunk(content, 'jira_issue'), // Similar structure to Jira
    }, {
        sourceTypes: ['github_readme', 'github_file'],
        chunk: async (content) => smartChunk(content, 'confluence_page'), // Similar structure to Confluence
    }, {
        sourceTypes: ['github_commit'],
        chunk: async (content) => smartChunk(content, 'slack_message'), // Short, atomic
    }],
    webhookConfig: {
        path: '/api/webhooks/github',
        events: ['push', 'pull_request', 'issues', 'issue_comment'],
        requiresSignature: true,
    },
    oauthConfig: {
        authorizeUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        scopes: ['repo', 'read:org'],
        redirectPath: '/api/integrations/github/callback',
    },
    icon: 'github',
});
