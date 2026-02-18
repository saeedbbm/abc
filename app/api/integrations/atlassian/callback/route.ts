import { NextRequest } from "next/server";
import { exchangeAtlassianCodeForTokens, getAtlassianAccessibleResources } from "@/src/application/lib/integrations/atlassian";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { triggerBackgroundSync } from "@/lib/sync-trigger";
import { registerAtlassianWebhooks } from "@/src/application/lib/integrations/atlassian/webhooks";

const oauthTokensRepository = new MongoDBOAuthTokensRepository();

/**
 * GET /api/integrations/atlassian/callback
 * 
 * Handles the Atlassian OAuth callback after user authorizes the app.
 * Automatically triggers sync in the background after successful connection.
 */
export async function GET(req: NextRequest): Promise<Response> {
    const code = req.nextUrl.searchParams.get('code');
    const state = req.nextUrl.searchParams.get('state');
    const error = req.nextUrl.searchParams.get('error');

    if (error) {
        console.error('Atlassian OAuth error:', error);
        return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/admin?error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
        return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/admin?error=Missing+code+or+state`);
    }

    try {
        // Decode state to get projectId
        const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
        const { projectId } = stateData;

        if (!projectId) {
            throw new Error('Invalid state: missing projectId');
        }

        // Exchange code for tokens
        const tokens = await exchangeAtlassianCodeForTokens(code);

        // Get accessible resources (cloud sites)
        const resources = await getAtlassianAccessibleResources(tokens.accessToken);

        if (resources.length === 0) {
            throw new Error('No accessible Atlassian sites found');
        }

        // Use the first site (in most cases there's only one)
        const site = resources[0];

        // Check if token already exists for this project
        const existingToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'atlassian');

        if (existingToken) {
            // Update existing token
            await oauthTokensRepository.update(existingToken.id, {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt.toISOString(),
                scopes: tokens.scope.split(' '),
                metadata: {
                    cloudId: site.id,
                    siteUrl: site.url,
                    siteName: site.name,
                    availableScopes: site.scopes,
                    allSites: resources,
                },
            });
        } else {
            // Create new token
            await oauthTokensRepository.create({
                projectId,
                provider: 'atlassian',
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt.toISOString(),
                scopes: tokens.scope.split(' '),
                metadata: {
                    cloudId: site.id,
                    siteUrl: site.url,
                    siteName: site.name,
                    availableScopes: site.scopes,
                    allSites: resources,
                },
            });
        }

        // Register webhooks for real-time updates from Jira/Confluence
        console.log('[Atlassian Callback] Registering webhooks...');
        registerAtlassianWebhooks(tokens.accessToken, site.id, projectId).catch(err => {
            console.error('[Atlassian Callback] Webhook registration failed:', err);
        });

        // Trigger background sync to ingest Jira and Confluence data immediately
        console.log('[Atlassian Callback] Triggering background sync...');
        triggerBackgroundSync(projectId, 'atlassian');

        // Redirect back to setup page with success
        return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/admin?connected=atlassian`);
    } catch (error) {
        console.error('Atlassian OAuth callback error:', error);
        return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/admin?error=${encodeURIComponent(error instanceof Error ? error.message : 'OAuth failed')}`);
    }
}
