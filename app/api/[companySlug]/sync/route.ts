/**
 * Sync API - Triggers background sync for integrations
 * 
 * POST /api/[companySlug]/sync
 * Body: { provider?: 'slack' | 'jira' | 'confluence' | 'all' }
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveCompanySlug } from "@/lib/company-resolver";
import { PrefixLogger } from "@/lib/utils";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { SlackSyncWorker } from "@/src/application/workers/sync/slack.sync";
import { JiraSyncWorker } from "@/src/application/workers/sync/jira.sync";
import { ConfluenceSyncWorker } from "@/src/application/workers/sync/confluence.sync";
import { getValidAtlassianToken } from "@/src/application/lib/integrations/atlassian";

const oauthTokensRepository = new MongoDBOAuthTokensRepository();
const knowledgeDocumentsRepository = new MongoDBKnowledgeDocumentsRepository();
const knowledgeEntitiesRepository = new MongoDBKnowledgeEntitiesRepository();

const slackSyncWorker = new SlackSyncWorker(
    oauthTokensRepository,
    knowledgeDocumentsRepository,
    knowledgeEntitiesRepository,
    new PrefixLogger('api-slack-sync')
);

const jiraSyncWorker = new JiraSyncWorker(
    oauthTokensRepository,
    knowledgeDocumentsRepository,
    knowledgeEntitiesRepository,
    new PrefixLogger('api-jira-sync')
);

const confluenceSyncWorker = new ConfluenceSyncWorker(
    oauthTokensRepository,
    knowledgeDocumentsRepository,
    knowledgeEntitiesRepository,
    new PrefixLogger('api-confluence-sync')
);

// Allow long-running syncs
export const maxDuration = 300; // 5 minutes

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const provider = body.provider || 'all';
    const fullSync = body.fullSync || false;

    console.log(`[Sync API] Starting sync for project ${projectId}, provider: ${provider}, fullSync: ${fullSync}`);

    const results: Record<string, any> = {};

    try {
        // Sync Slack
        if (provider === 'all' || provider === 'slack') {
            const slackToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'slack');
            if (slackToken) {
                try {
                    console.log('[Sync API] Starting Slack sync...');
                    const slackStats = await slackSyncWorker.sync({
                        projectId,
                        messageDays: 30,
                        includePrivate: true,
                        includeThreadReplies: true,
                        generateEmbeddings: true,
                        fullSync,
                        createConversationSummaries: true,
                    });
                    results.slack = { success: true, stats: slackStats };
                    console.log('[Sync API] Slack sync completed:', slackStats);
                } catch (error) {
                    console.error('[Sync API] Slack sync failed:', error);
                    results.slack = { success: false, error: String(error) };
                }
            } else {
                results.slack = { success: false, error: 'Not connected' };
            }
        }

        // Sync Jira
        if (provider === 'all' || provider === 'jira') {
            const atlassianToken = await getValidAtlassianToken(projectId);
            if (atlassianToken && atlassianToken.metadata?.cloudId) {
                try {
                    console.log('[Sync API] Starting Jira sync...');
                    const jiraStats = await jiraSyncWorker.sync({
                        projectId,
                        issueDays: 30,
                        includeComments: true,
                        generateEmbeddings: true,
                    });
                    results.jira = { success: true, stats: jiraStats };
                    console.log('[Sync API] Jira sync completed:', jiraStats);
                } catch (error) {
                    console.error('[Sync API] Jira sync failed:', error);
                    results.jira = { success: false, error: String(error) };
                }
            } else {
                results.jira = { success: false, error: 'Not connected' };
            }
        }

        // Sync Confluence
        if (provider === 'all' || provider === 'confluence') {
            const atlassianToken = await getValidAtlassianToken(projectId);
            if (atlassianToken && atlassianToken.metadata?.cloudId) {
                try {
                    console.log('[Sync API] Starting Confluence sync...');
                    const confluenceStats = await confluenceSyncWorker.sync({
                        projectId,
                        includeArchived: false,
                        generateEmbeddings: true,
                    });
                    results.confluence = { success: true, stats: confluenceStats };
                    console.log('[Sync API] Confluence sync completed:', confluenceStats);
                } catch (error) {
                    console.error('[Sync API] Confluence sync failed:', error);
                    results.confluence = { success: false, error: String(error) };
                }
            } else {
                results.confluence = { success: false, error: 'Not connected' };
            }
        }

        return NextResponse.json({
            success: true,
            results,
        });
    } catch (error) {
        console.error('[Sync API] Sync failed:', error);
        return NextResponse.json({
            success: false,
            error: String(error),
            results,
        }, { status: 500 });
    }
}

/**
 * Trigger sync in the background without waiting for completion.
 * This is used by OAuth callbacks to start sync immediately after connection.
 */
export async function triggerBackgroundSync(
    projectId: string,
    provider: 'slack' | 'atlassian'
): Promise<void> {
    console.log(`[Sync API] Triggering background sync for ${provider}...`);

    setImmediate(async () => {
        try {
            if (provider === 'slack') {
                const slackToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'slack');
                if (slackToken) {
                    console.log('[Sync API] Background Slack sync starting...');
                    await slackSyncWorker.sync({
                        projectId,
                        messageDays: 30,
                        includePrivate: true,
                        includeThreadReplies: true,
                        generateEmbeddings: true,
                        createConversationSummaries: true,
                    });
                    console.log('[Sync API] Background Slack sync completed');
                }
            } else if (provider === 'atlassian') {
                const atlassianToken = await getValidAtlassianToken(projectId);
                if (atlassianToken && atlassianToken.metadata?.cloudId) {
                    console.log('[Sync API] Background Jira sync starting...');
                    await jiraSyncWorker.sync({
                        projectId,
                        issueDays: 30,
                        includeComments: true,
                        generateEmbeddings: true,
                    });
                    console.log('[Sync API] Background Jira sync completed');

                    console.log('[Sync API] Background Confluence sync starting...');
                    await confluenceSyncWorker.sync({
                        projectId,
                        includeArchived: false,
                        generateEmbeddings: true,
                    });
                    console.log('[Sync API] Background Confluence sync completed');
                }
            }
        } catch (error) {
            console.error(`[Sync API] Background ${provider} sync failed:`, error);
        }
    });
}
