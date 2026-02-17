import { NextRequest } from "next/server";
import { exchangeSlackCodeForTokens } from "@/src/application/lib/integrations/slack";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { triggerBackgroundSync } from "@/lib/sync-trigger";

const oauthTokensRepository = new MongoDBOAuthTokensRepository();

/**
 * GET /api/integrations/slack/callback
 * 
 * Handles the Slack OAuth callback after user authorizes the app.
 * Automatically triggers sync in the background after successful connection.
 */
export async function GET(req: NextRequest): Promise<Response> {
    const code = req.nextUrl.searchParams.get('code');
    const state = req.nextUrl.searchParams.get('state');
    const error = req.nextUrl.searchParams.get('error');

    if (error) {
        console.error('Slack OAuth error:', error);
        return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/c/error?message=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
        return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/c/error?message=Missing+code+or+state`);
    }

    try {
        // Decode state to get projectId
        const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
        const { projectId } = stateData;

        if (!projectId) {
            throw new Error('Invalid state: missing projectId');
        }

        // Exchange code for tokens
        const tokens = await exchangeSlackCodeForTokens(code);

        // Check if token already exists for this project
        const existingToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'slack');

        if (existingToken) {
            // Update existing token
            await oauthTokensRepository.update(existingToken.id, {
                accessToken: tokens.accessToken,
                scopes: tokens.scope.split(','),
                metadata: {
                    teamId: tokens.teamId,
                    teamName: tokens.teamName,
                    botUserId: tokens.botUserId,
                    appId: tokens.appId,
                },
            });
        } else {
            // Create new token
            await oauthTokensRepository.create({
                projectId,
                provider: 'slack',
                accessToken: tokens.accessToken,
                scopes: tokens.scope.split(','),
                metadata: {
                    teamId: tokens.teamId,
                    teamName: tokens.teamName,
                    botUserId: tokens.botUserId,
                    appId: tokens.appId,
                },
            });
        }

        // Trigger background sync to ingest Slack data immediately
        console.log('[Slack Callback] Triggering background sync...');
        triggerBackgroundSync(projectId, 'slack');

        // Redirect back to setup page with success
        return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/c/${projectId}/setup?connected=slack`);
    } catch (error) {
        console.error('Slack OAuth callback error:', error);
        return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/c/error?message=${encodeURIComponent(error instanceof Error ? error.message : 'OAuth failed')}`);
    }
}
