import { SlackOAuthResponse } from './types';

const SLACK_OAUTH_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_OAUTH_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

export interface SlackOAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
}

export interface SlackOAuthTokens {
    accessToken: string;
    tokenType: string;
    scope: string;
    botUserId?: string;
    appId?: string;
    teamId?: string;
    teamName?: string;
    authedUserId?: string;
}

/**
 * Get the Slack OAuth configuration from environment variables
 */
export function getSlackOAuthConfig(): SlackOAuthConfig {
    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    const redirectUri = process.env.SLACK_REDIRECT_URI || `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/integrations/slack/callback`;

    if (!clientId || !clientSecret) {
        throw new Error('Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET environment variables');
    }

    return {
        clientId,
        clientSecret,
        redirectUri,
        scopes: [
            // Read channels - MUST MATCH what you added in Slack App settings
            'channels:history',
            'channels:read',
            'channels:join',
            // Read private channels (groups)
            'groups:history',
            'groups:read',
            // Read DMs
            'im:history',
            'im:read',
            'im:write',
            // Read multi-person DMs
            'mpim:history',
            'mpim:read',
            'mpim:write',
            // Users
            'users:read',
            'users:read.email',
            'users.profile:read',
            'team:read',
            // Write messages
            'chat:write',
            'chat:write.public',
            // Reactions & files
            'reactions:read',
            'reactions:write',
            'files:read',
            'links:read',
            // Pins & bookmarks
            'pins:read',
            'bookmarks:read',
            // Bot mentions
            'app_mentions:read',
        ],
    };
}

/**
 * Generate the Slack OAuth authorization URL
 */
export function getSlackAuthorizationUrl(state: string, config?: SlackOAuthConfig): string {
    const oauthConfig = config || getSlackOAuthConfig();
    
    const params = new URLSearchParams({
        client_id: oauthConfig.clientId,
        scope: oauthConfig.scopes.join(','),
        redirect_uri: oauthConfig.redirectUri,
        state,
    });

    return `${SLACK_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeSlackCodeForTokens(
    code: string,
    config?: SlackOAuthConfig
): Promise<SlackOAuthTokens> {
    const oauthConfig = config || getSlackOAuthConfig();

    const response = await fetch(SLACK_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: oauthConfig.clientId,
            client_secret: oauthConfig.clientSecret,
            code,
            redirect_uri: oauthConfig.redirectUri,
        }),
    });

    const data = await response.json() as {
        ok: boolean;
        access_token?: string;
        token_type?: string;
        scope?: string;
        bot_user_id?: string;
        app_id?: string;
        team?: { id?: string; name?: string };
        authed_user?: { id?: string };
        error?: string;
    };

    if (!data.ok || !data.access_token) {
        throw new Error(`Slack OAuth error: ${data.error || 'Unknown error'}`);
    }

    return {
        accessToken: data.access_token,
        tokenType: data.token_type || 'bot',
        scope: data.scope || '',
        botUserId: data.bot_user_id,
        appId: data.app_id,
        teamId: data.team?.id,
        teamName: data.team?.name,
        authedUserId: data.authed_user?.id,
    };
}

/**
 * Verify a Slack request signature
 */
export function verifySlackSignature(
    signature: string,
    timestamp: string,
    body: string,
    signingSecret: string
): boolean {
    const crypto = require('crypto');
    
    // Check timestamp to prevent replay attacks
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - parseInt(timestamp, 10)) > 60 * 5) {
        return false;
    }

    const baseString = `v0:${timestamp}:${body}`;
    const hmac = crypto.createHmac('sha256', signingSecret);
    hmac.update(baseString);
    const mySignature = `v0=${hmac.digest('hex')}`;

    return crypto.timingSafeEqual(
        Buffer.from(mySignature),
        Buffer.from(signature)
    );
}
