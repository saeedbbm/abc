/**
 * Disconnect API
 * 
 * POST /api/[companySlug]/disconnect
 * 
 * Disconnect an integration by deleting its OAuth token
 */

import { NextRequest } from "next/server";
import { resolveCompanySlug } from "@/lib/company-resolver";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";

const oauthTokensRepository = new MongoDBOAuthTokensRepository();

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        const body = await req.json();
        const { provider } = body;

        if (!provider || !['slack', 'atlassian'].includes(provider)) {
            return Response.json({ error: "Invalid provider" }, { status: 400 });
        }

        // Find and delete the token
        const token = await oauthTokensRepository.fetchByProjectAndProvider(projectId, provider);
        
        if (!token) {
            return Response.json({ error: "Token not found" }, { status: 404 });
        }

        await oauthTokensRepository.delete(token.id);

        console.log(`[Disconnect] Deleted ${provider} token for project ${projectId}`);

        return Response.json({ 
            success: true, 
            message: `Disconnected ${provider} successfully` 
        });
    } catch (error) {
        console.error('Disconnect error:', error);
        return Response.json({ 
            error: error instanceof Error ? error.message : 'Failed to disconnect' 
        }, { status: 500 });
    }
}
