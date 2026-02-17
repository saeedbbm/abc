import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { getSlackAuthorizationUrl } from "@/src/application/lib/integrations/slack";

/**
 * GET /api/integrations/slack/authorize
 * 
 * Initiates the Slack OAuth flow. Requires projectId query parameter.
 */
export async function GET(req: NextRequest): Promise<Response> {
    const projectId = req.nextUrl.searchParams.get('projectId');
    
    if (!projectId) {
        return Response.json({ error: 'projectId is required' }, { status: 400 });
    }

    try {
        // Create a state that includes projectId for callback
        const state = Buffer.from(JSON.stringify({
            projectId,
            nonce: nanoid(),
        })).toString('base64url');

        const authUrl = getSlackAuthorizationUrl(state);
        
        return Response.redirect(authUrl);
    } catch (error) {
        console.error('Slack OAuth error:', error);
        return Response.json({ 
            error: error instanceof Error ? error.message : 'Failed to initiate OAuth' 
        }, { status: 500 });
    }
}
