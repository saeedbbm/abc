/**
 * Sync Status API - Returns the current sync state for all providers
 * 
 * GET /api/[companySlug]/sync-status
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveCompanySlug } from "@/lib/company-resolver";
import { MongoDBSyncStateRepository } from "@/src/infrastructure/repositories/mongodb.sync-state.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { QdrantClient } from "@qdrant/js-client-rest";

// Qdrant client for checking actual embedding counts
const qdrantClient = new QdrantClient({
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || undefined,
    checkCompatibility: false,
});

const syncStateRepository = new MongoDBSyncStateRepository();
const knowledgeDocumentsRepository = new MongoDBKnowledgeDocumentsRepository();
const oauthTokensRepository = new MongoDBOAuthTokensRepository();

interface ProviderStatus {
    provider: 'slack' | 'jira' | 'confluence';
    connected: boolean;
    lastSyncedAt: string | null;
    status: 'idle' | 'syncing' | 'error' | 'never_synced';
    lastError: string | null;
    documentCount: number;
    embeddingCount: number;
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        // Get sync states for all providers
        const syncStates = await syncStateRepository.listByProject(projectId);
        
        // Get OAuth tokens to check connection status
        const slackToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'slack');
        const atlassianToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'atlassian');

        // Get document counts per provider
        const slackDocsResult = await knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'slack');
        const jiraDocsResult = await knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'jira');
        const confluenceDocsResult = await knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'confluence');

        // Build status for each provider
        const providers: ProviderStatus[] = [
            {
                provider: 'slack',
                connected: !!slackToken,
                lastSyncedAt: syncStates.find(s => s.provider === 'slack')?.lastSyncedAt || null,
                status: getProviderStatus(syncStates.find(s => s.provider === 'slack')),
                lastError: syncStates.find(s => s.provider === 'slack')?.lastError || null,
                documentCount: slackDocsResult.items.length,
                embeddingCount: syncStates.find(s => s.provider === 'slack')?.totalEmbeddings || 0,
            },
            {
                provider: 'jira',
                connected: !!atlassianToken,
                lastSyncedAt: syncStates.find(s => s.provider === 'jira')?.lastSyncedAt || null,
                status: getProviderStatus(syncStates.find(s => s.provider === 'jira')),
                lastError: syncStates.find(s => s.provider === 'jira')?.lastError || null,
                documentCount: jiraDocsResult.items.length,
                embeddingCount: syncStates.find(s => s.provider === 'jira')?.totalEmbeddings || 0,
            },
            {
                provider: 'confluence',
                connected: !!atlassianToken,
                lastSyncedAt: syncStates.find(s => s.provider === 'confluence')?.lastSyncedAt || null,
                status: getProviderStatus(syncStates.find(s => s.provider === 'confluence')),
                lastError: syncStates.find(s => s.provider === 'confluence')?.lastError || null,
                documentCount: confluenceDocsResult.items.length,
                embeddingCount: syncStates.find(s => s.provider === 'confluence')?.totalEmbeddings || 0,
            },
        ];

        // Calculate totals
        const totalDocuments = providers.reduce((sum, p) => sum + p.documentCount, 0);
        const totalEmbeddings = providers.reduce((sum, p) => sum + p.embeddingCount, 0);

        // Get actual Qdrant counts for debugging
        let qdrantCounts: Record<string, number> = {};
        try {
            const collectionName = 'knowledge_embeddings';
            const collections = await qdrantClient.getCollections();
            if (collections.collections.some(c => c.name === collectionName)) {
                for (const provider of ['slack', 'jira', 'confluence']) {
                    const count = await qdrantClient.count(collectionName, {
                        filter: {
                            must: [
                                { key: 'projectId', match: { value: projectId } },
                                { key: 'provider', match: { value: provider } },
                            ]
                        },
                        exact: true,
                    });
                    qdrantCounts[provider] = count.count;
                }
            }
        } catch (e) {
            console.log('[Sync Status API] Could not get Qdrant counts:', e);
        }

        return NextResponse.json({
            projectId,
            providers,
            totals: {
                documents: totalDocuments,
                embeddings: totalEmbeddings,
            },
            qdrantCounts,
        });
    } catch (error) {
        console.error('[Sync Status API] Error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch sync status' },
            { status: 500 }
        );
    }
}

function getProviderStatus(syncState: any | undefined): 'idle' | 'syncing' | 'error' | 'never_synced' {
    if (!syncState) return 'never_synced';
    if (syncState.status === 'syncing') return 'syncing';
    if (syncState.status === 'error' || syncState.lastError) return 'error';
    if (!syncState.lastSyncedAt) return 'never_synced';
    return 'idle';
}
