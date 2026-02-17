import { refreshAtlassianTokens } from './oauth';
import { MongoDBOAuthTokensRepository } from '@/src/infrastructure/repositories/mongodb.oauth-tokens.repository';
import { OAuthTokenType } from '@/src/entities/models/oauth-token';

const oauthTokensRepository = new MongoDBOAuthTokensRepository();

// Buffer time before expiry to refresh (5 minutes)
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Check if a token is expired or about to expire
 */
export function isTokenExpired(token: OAuthTokenType): boolean {
    if (!token.expiresAt) {
        // If no expiry, assume it's valid (Slack tokens don't expire)
        return false;
    }
    
    const expiresAt = new Date(token.expiresAt).getTime();
    const now = Date.now();
    
    // Expired or will expire within buffer time
    return now >= expiresAt - REFRESH_BUFFER_MS;
}

/**
 * Get a valid Atlassian access token, refreshing if necessary
 * Returns the updated token or null if refresh fails
 */
export async function getValidAtlassianToken(
    projectId: string
): Promise<OAuthTokenType | null> {
    // Fetch the current token
    const token = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'atlassian');
    
    if (!token) {
        console.log('[TokenManager] No Atlassian token found for project:', projectId);
        return null;
    }
    
    // Check if token needs refresh
    if (!isTokenExpired(token)) {
        // Token is still valid
        return token;
    }
    
    console.log('[TokenManager] Atlassian token expired, attempting refresh...');
    
    // Check if we have a refresh token
    if (!token.refreshToken) {
        console.error('[TokenManager] No refresh token available, cannot refresh');
        return null;
    }
    
    try {
        // Refresh the token
        const newTokens = await refreshAtlassianTokens(token.refreshToken);
        
        console.log('[TokenManager] Token refreshed successfully, new expiry:', newTokens.expiresAt);
        
        // Update the token in database
        const updatedToken = await oauthTokensRepository.update(token.id, {
            accessToken: newTokens.accessToken,
            refreshToken: newTokens.refreshToken,
            expiresAt: newTokens.expiresAt.toISOString(),
        });
        
        return updatedToken;
    } catch (error) {
        console.error('[TokenManager] Failed to refresh Atlassian token:', error);
        return null;
    }
}

/**
 * Get valid Atlassian clients with auto-refresh
 * Returns { jiraClient, confluenceClient, token } or null values if unavailable
 */
export async function getAtlassianClients(projectId: string): Promise<{
    token: OAuthTokenType | null;
    cloudId: string | null;
}> {
    const token = await getValidAtlassianToken(projectId);
    
    if (!token) {
        return { token: null, cloudId: null };
    }
    
    const cloudId = token.metadata?.cloudId as string | undefined;
    
    if (!cloudId) {
        console.error('[TokenManager] No cloudId in token metadata');
        return { token: null, cloudId: null };
    }
    
    return { token, cloudId };
}
