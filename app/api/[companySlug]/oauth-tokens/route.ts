/**
 * OAuth Tokens API
 * 
 * GET /api/[companySlug]/oauth-tokens
 * 
 * Returns the OAuth tokens connected for a project.
 * Automatically refreshes expired Atlassian tokens.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/mongodb";
import { resolveCompanySlug } from "@/lib/company-resolver";
import { getValidAtlassianToken } from "@/src/application/lib/integrations/atlassian";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        // Verify project exists
        const project = await db.collection('projects').findOne({ _id: projectId });
        if (!project) {
            return Response.json({ error: "Project not found" }, { status: 404 });
        }

        // Try to refresh Atlassian token if expired
        await getValidAtlassianToken(projectId).catch(err => {
            console.error("Failed to refresh Atlassian token:", err);
        });

        // Get tokens from database (will have refreshed token if applicable)
        const tokens = await db.collection('oauth_tokens')
            .find({ projectId })
            .toArray();

        // Convert to a map by provider
        const tokensMap: Record<string, any> = {};
        for (const token of tokens) {
            const isExpired = token.expiresAt && new Date(token.expiresAt) < new Date();
            
            tokensMap[token.provider] = {
                id: token._id.toString(),
                provider: token.provider,
                scopes: token.scopes,
                metadata: token.metadata,
                createdAt: token.createdAt,
                updatedAt: token.updatedAt,
                expiresAt: token.expiresAt,
                isExpired: isExpired,
                hasRefreshToken: !!token.refreshToken,
            };
        }

        return Response.json({ tokens: tokensMap });
    } catch (error) {
        console.error("Error fetching OAuth tokens:", error);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
