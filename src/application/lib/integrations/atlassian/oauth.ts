import { AtlassianOAuthTokenResponseType, AtlassianAccessibleResourceType } from './types';

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

export interface AtlassianOAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
}

export interface AtlassianOAuthTokens {
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
    scope: string;
}

/**
 * Get the Atlassian OAuth configuration from environment variables
 */
export function getAtlassianOAuthConfig(): AtlassianOAuthConfig {
    const clientId = process.env.ATLASSIAN_CLIENT_ID;
    const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET;
    const redirectUri = process.env.ATLASSIAN_REDIRECT_URI || `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/integrations/atlassian/callback`;

    if (!clientId || !clientSecret) {
        throw new Error('Missing ATLASSIAN_CLIENT_ID or ATLASSIAN_CLIENT_SECRET environment variables');
    }

    return {
        clientId,
        clientSecret,
        redirectUri,
        scopes: [
            // ==================
            // JIRA SCOPES (Classic)
            // ==================
            'read:jira-work',        // Read issues, projects, boards, sprints
            'read:jira-user',        // Read user info
            'write:jira-work',       // Create/edit issues, comments, worklogs
            'manage:jira-project',   // Manage project settings
            
            // ==================
            // CONFLUENCE SCOPES (Granular - required for v2 API)
            // ==================
            // Read scopes
            'read:space:confluence',              // Read spaces
            'read:space-details:confluence',      // Read space details
            'read:page:confluence',               // Read pages
            'read:content:confluence',            // Read content
            'read:content-details:confluence',    // Read content details
            'read:blogpost:confluence',           // Read blog posts
            'read:custom-content:confluence',     // Read custom content
            'read:attachment:confluence',         // Read attachments
            'read:comment:confluence',            // Read comments
            'read:template:confluence',           // Read templates
            'read:label:confluence',              // Read labels
            'read:watcher:confluence',            // Read watchers
            'read:group:confluence',              // Read groups
            'read:relation:confluence',           // Read relations
            'read:permission:confluence',         // Read permissions
            'read:user:confluence',               // Read user details
            'read:analytics.content:confluence',  // Read content analytics
            'read:email-address:confluence',      // Read email addresses
            // Write scopes (granular v2)
            'write:page:confluence',              // Create/edit pages
            'write:content:confluence',           // Create/edit content
            'write:blogpost:confluence',          // Create/edit blog posts
            'write:custom-content:confluence',    // Create/edit custom content
            'write:attachment:confluence',        // Upload attachments
            'write:comment:confluence',           // Create/edit comments
            'write:label:confluence',             // Create/edit labels
            'write:watcher:confluence',           // Manage watchers
            // Classic scopes (needed for v1 API endpoints like adding page comments)
            'write:confluence-content',           // Classic: write content (comments via v1 API)
            'read:confluence-content.all',        // Classic: read all content
            
            // ==================
            // OFFLINE ACCESS
            // ==================
            'offline_access',        // Get refresh tokens
        ],
    };
}

/**
 * Generate the Atlassian OAuth authorization URL
 */
export function getAtlassianAuthorizationUrl(state: string, config?: AtlassianOAuthConfig): string {
    const oauthConfig = config || getAtlassianOAuthConfig();
    
    const params = new URLSearchParams({
        audience: 'api.atlassian.com',
        client_id: oauthConfig.clientId,
        scope: oauthConfig.scopes.join(' '),
        redirect_uri: oauthConfig.redirectUri,
        state,
        response_type: 'code',
        prompt: 'consent',
    });

    return `${ATLASSIAN_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeAtlassianCodeForTokens(
    code: string,
    config?: AtlassianOAuthConfig
): Promise<AtlassianOAuthTokens> {
    const oauthConfig = config || getAtlassianOAuthConfig();

    const response = await fetch(ATLASSIAN_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: oauthConfig.clientId,
            client_secret: oauthConfig.clientSecret,
            code,
            redirect_uri: oauthConfig.redirectUri,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Atlassian OAuth error: ${error}`);
    }

    const data = await response.json() as AtlassianOAuthTokenResponseType;

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
        scope: data.scope,
    };
}

/**
 * Refresh an access token
 */
export async function refreshAtlassianTokens(
    refreshToken: string,
    config?: AtlassianOAuthConfig
): Promise<AtlassianOAuthTokens> {
    const oauthConfig = config || getAtlassianOAuthConfig();

    const response = await fetch(ATLASSIAN_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: oauthConfig.clientId,
            client_secret: oauthConfig.clientSecret,
            refresh_token: refreshToken,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Atlassian token refresh error: ${error}`);
    }

    const data = await response.json() as AtlassianOAuthTokenResponseType;

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken, // May or may not return new refresh token
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
        scope: data.scope,
    };
}

/**
 * Get accessible resources (cloud sites) for the authenticated user
 */
export async function getAtlassianAccessibleResources(
    accessToken: string
): Promise<AtlassianAccessibleResourceType[]> {
    const response = await fetch(ATLASSIAN_ACCESSIBLE_RESOURCES_URL, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
        },
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to get accessible resources: ${error}`);
    }

    const data = await response.json();
    return data as AtlassianAccessibleResourceType[];
}
