import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { db } from "@/lib/mongodb";
import { getValidAtlassianToken } from "@/src/application/lib/integrations/atlassian";
import { SlackSyncWorker } from "@/src/application/workers/sync/slack.sync";
import { JiraSyncWorker } from "@/src/application/workers/sync/jira.sync";
import { ConfluenceSyncWorker } from "@/src/application/workers/sync/confluence.sync";
import { deduplicateEntities } from "@/src/application/lib/knowledge/entity-resolver";

const oauthTokensRepository = new MongoDBOAuthTokensRepository();
const knowledgeDocumentsRepository = new MongoDBKnowledgeDocumentsRepository();
const knowledgeEntitiesRepository = new MongoDBKnowledgeEntitiesRepository();

const slackSyncWorker = new SlackSyncWorker(
    oauthTokensRepository,
    knowledgeDocumentsRepository,
    knowledgeEntitiesRepository,
);

const jiraSyncWorker = new JiraSyncWorker(
    oauthTokensRepository,
    knowledgeDocumentsRepository,
    knowledgeEntitiesRepository,
);

const confluenceSyncWorker = new ConfluenceSyncWorker(
    oauthTokensRepository,
    knowledgeDocumentsRepository,
    knowledgeEntitiesRepository,
);

/**
 * Trigger sync in the background without waiting for completion.
 * This is used by OAuth callbacks to start sync immediately after connection.
 */
export async function triggerBackgroundSync(
    projectId: string,
    provider: 'slack' | 'atlassian'
): Promise<void> {
    console.log(`[Sync] Triggering background sync for ${provider}...`);

    setImmediate(async () => {
        try {
            if (provider === 'slack') {
                const slackToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'slack');
                if (slackToken) {
                    console.log('[Sync] Background Slack sync starting...');
                    await slackSyncWorker.sync({
                        projectId,
                        messageDays: 30,
                        includePrivate: true,
                        includeThreadReplies: true,
                        generateEmbeddings: true,
                        createConversationSummaries: true,
                    });
                    console.log('[Sync] Background Slack sync completed');

                    // Run entity deduplication
                    deduplicateEntities(projectId, knowledgeEntitiesRepository).catch(err => {
                        console.error('[Sync] Entity dedup failed:', err);
                    });

                    // Auto-trigger doc-audit after first sync
                    try {
                        const hasRunBefore = await db.collection('doc_audit_runs').findOne({ projectId });
                        if (!hasRunBefore) {
                            console.log('[Sync] First sync complete — auto-triggering doc-audit...');
                            const { DocAuditWorker } = await import("@/src/application/workers/doc-audit");
                            const { MongoDBDocAuditFindingsRepository, MongoDBDocAuditRunsRepository, MongoDBDocAuditConfigRepository } = await import("@/src/infrastructure/repositories/mongodb.doc-audit.repository");
                            const { PrefixLogger } = await import("@/lib/utils");
                            const worker = new DocAuditWorker(
                                oauthTokensRepository,
                                knowledgeDocumentsRepository,
                                knowledgeEntitiesRepository,
                                new MongoDBDocAuditFindingsRepository(),
                                new MongoDBDocAuditRunsRepository(),
                                new MongoDBDocAuditConfigRepository(),
                                new PrefixLogger('auto-doc-audit')
                            );
                            worker.run(projectId).then(result => {
                                console.log('[Sync] Auto doc-audit complete:', JSON.stringify(result));
                            }).catch(err => {
                                console.error('[Sync] Auto doc-audit failed:', err);
                            });
                        }
                    } catch (err) {
                        console.error('[Sync] Error checking doc-audit history:', err);
                    }
                }
            } else if (provider === 'atlassian') {
                const atlassianToken = await getValidAtlassianToken(projectId);
                if (atlassianToken && atlassianToken.metadata?.cloudId) {
                    console.log('[Sync] Background Jira sync starting...');
                    await jiraSyncWorker.sync({
                        projectId,
                        issueDays: 30,
                        includeComments: true,
                        generateEmbeddings: true,
                    });
                    console.log('[Sync] Background Jira sync completed');

                    console.log('[Sync] Background Confluence sync starting...');
                    await confluenceSyncWorker.sync({
                        projectId,
                        includeArchived: false,
                        generateEmbeddings: true,
                    });
                    console.log('[Sync] Background Confluence sync completed');

                    // Run entity deduplication
                    deduplicateEntities(projectId, knowledgeEntitiesRepository).catch(err => {
                        console.error('[Sync] Entity dedup failed:', err);
                    });

                    // Auto-trigger doc-audit after first sync
                    try {
                        const hasRunBefore = await db.collection('doc_audit_runs').findOne({ projectId });
                        if (!hasRunBefore) {
                            console.log('[Sync] First sync complete — auto-triggering doc-audit...');
                            const { DocAuditWorker } = await import("@/src/application/workers/doc-audit");
                            const { MongoDBDocAuditFindingsRepository, MongoDBDocAuditRunsRepository, MongoDBDocAuditConfigRepository } = await import("@/src/infrastructure/repositories/mongodb.doc-audit.repository");
                            const { PrefixLogger } = await import("@/lib/utils");
                            const worker = new DocAuditWorker(
                                oauthTokensRepository,
                                knowledgeDocumentsRepository,
                                knowledgeEntitiesRepository,
                                new MongoDBDocAuditFindingsRepository(),
                                new MongoDBDocAuditRunsRepository(),
                                new MongoDBDocAuditConfigRepository(),
                                new PrefixLogger('auto-doc-audit')
                            );
                            worker.run(projectId).then(result => {
                                console.log('[Sync] Auto doc-audit complete:', JSON.stringify(result));
                            }).catch(err => {
                                console.error('[Sync] Auto doc-audit failed:', err);
                            });
                        }
                    } catch (err) {
                        console.error('[Sync] Error checking doc-audit history:', err);
                    }
                }
            }
        } catch (error) {
            console.error(`[Sync] Background ${provider} sync failed:`, error);
        }
    });
}
