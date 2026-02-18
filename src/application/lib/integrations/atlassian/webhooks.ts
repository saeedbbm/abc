/**
 * Atlassian Webhook Registration
 * 
 * Registers webhooks with Jira and Confluence so they push changes to us
 * in real-time instead of us polling. Called after OAuth connection.
 * 
 * Jira: POST /rest/api/3/webhook (dynamic webhooks, registered per-app)
 * Confluence: Uses Connect-style webhooks via REST API
 */

import { atlassianRateLimiter } from './rate-limiter';
import { PrefixLogger } from '@/lib/utils';
import { db } from '@/lib/mongodb';

const logger = new PrefixLogger('atlassian-webhooks');

interface WebhookRegistration {
    projectId: string;
    cloudId: string;
    provider: 'jira' | 'confluence';
    webhookId: string;
    webhookUrl: string;
    events: string[];
    registeredAt: string;
}

/**
 * Register Jira webhooks for a project.
 * Uses Jira's dynamic webhook registration API.
 */
export async function registerJiraWebhooks(
    accessToken: string,
    cloudId: string,
    projectId: string,
): Promise<void> {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    const webhookUrl = `${baseUrl}/api/webhooks/atlassian`;

    // Check if already registered
    const existing = await db.collection('webhook_registrations').findOne({
        projectId,
        provider: 'jira',
        cloudId,
    });

    if (existing) {
        logger.log(`Jira webhooks already registered for project ${projectId}`);
        return;
    }

    try {
        await atlassianRateLimiter.waitForToken(cloudId);

        const response = await fetch(
            `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    webhooks: [{
                        url: webhookUrl,
                        events: [
                            'jira:issue_created',
                            'jira:issue_updated',
                            'jira:issue_deleted',
                            'comment_created',
                            'comment_updated',
                            'comment_deleted',
                        ],
                        jqlFilter: 'project is not EMPTY',
                    }],
                    url: webhookUrl,
                }),
            }
        );

        if (!response.ok) {
            const text = await response.text();
            logger.log(`Jira webhook registration failed (${response.status}): ${text}`);

            // If dynamic webhooks aren't supported, try the legacy approach
            if (response.status === 403 || response.status === 404) {
                logger.log('Dynamic webhooks not available, will rely on polling + Slack events');
            }
            return;
        }

        const data = await response.json();
        const webhookIds = data.webhookRegistrationResult?.map((r: any) => r.createdWebhookId) || [];

        // Store registration in DB
        await db.collection('webhook_registrations').insertOne({
            projectId,
            provider: 'jira',
            cloudId,
            webhookId: webhookIds[0] || 'unknown',
            webhookUrl,
            events: ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted', 'comment_created', 'comment_updated', 'comment_deleted'],
            registeredAt: new Date().toISOString(),
        } satisfies WebhookRegistration);

        logger.log(`Registered Jira webhooks for project ${projectId}: ${webhookIds.join(', ')}`);
    } catch (error) {
        logger.log(`Error registering Jira webhooks: ${error}`);
    }
}

/**
 * Register Confluence webhooks for a project.
 * Confluence Cloud doesn't have the same dynamic webhook API as Jira,
 * but we can use the Confluence REST API for webhook-like notifications
 * via watches or use the Connect framework.
 * 
 * For Confluence Cloud with OAuth, the recommended approach is:
 * - Use Confluence's REST API to list spaces and track `version.when` timestamps
 * - Poll only changed pages using `lastModified` filter
 * - Or use Atlassian Connect webhooks (requires an app installed on the site)
 * 
 * For now, we register a lightweight poller that only checks for recently modified pages.
 */
export async function registerConfluenceWebhooks(
    accessToken: string,
    cloudId: string,
    projectId: string,
): Promise<void> {
    // Confluence Cloud doesn't support dynamic webhook registration like Jira.
    // Instead, we'll use Confluence's CQL search to find recently-modified pages
    // on subsequent syncs, which is much more efficient than re-fetching everything.
    //
    // The real-time ingestion will come from:
    // 1. Jira webhooks (for Jira issues)
    // 2. Slack Events API (for Slack messages)
    // 3. Confluence: incremental polling using CQL `lastModified > "lastSyncTime"`

    const existing = await db.collection('webhook_registrations').findOne({
        projectId,
        provider: 'confluence',
        cloudId,
    });

    if (existing) {
        logger.log(`Confluence tracking already configured for project ${projectId}`);
        return;
    }

    await db.collection('webhook_registrations').insertOne({
        projectId,
        provider: 'confluence',
        cloudId,
        webhookId: 'incremental-poll',
        webhookUrl: '',
        events: ['page_created', 'page_updated', 'page_removed'],
        registeredAt: new Date().toISOString(),
    } satisfies WebhookRegistration);

    logger.log(`Configured Confluence incremental tracking for project ${projectId}`);
}

/**
 * Register all Atlassian webhooks for a project.
 */
export async function registerAtlassianWebhooks(
    accessToken: string,
    cloudId: string,
    projectId: string,
): Promise<void> {
    await Promise.all([
        registerJiraWebhooks(accessToken, cloudId, projectId),
        registerConfluenceWebhooks(accessToken, cloudId, projectId),
    ]);
}
