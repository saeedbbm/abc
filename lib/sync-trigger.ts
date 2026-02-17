import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { getValidAtlassianToken } from "@/src/application/lib/integrations/atlassian";
import { SlackSyncWorker } from "@/src/application/workers/sync/slack.sync";
import { JiraSyncWorker } from "@/src/application/workers/sync/jira.sync";
import { ConfluenceSyncWorker } from "@/src/application/workers/sync/confluence.sync";

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
                }
            }
        } catch (error) {
            console.error(`[Sync] Background ${provider} sync failed:`, error);
        }
    });
}
