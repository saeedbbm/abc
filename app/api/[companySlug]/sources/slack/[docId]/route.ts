/**
 * Slack Source Document API
 * 
 * GET /api/[companySlug]/sources/slack/[docId]
 * 
 * Returns a specific Slack knowledge document by docId and projectId.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/mongodb";
import { resolveCompanySlug } from "@/lib/company-resolver";
import { ObjectId } from "mongodb";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string; docId: string }> }
): Promise<Response> {
    const { companySlug, docId } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        let filter: Record<string, any> = { projectId, provider: 'slack' };

        // Try matching by _id (ObjectId) or by sourceId
        try {
            filter._id = new ObjectId(docId);
        } catch {
            filter = { projectId, provider: 'slack', sourceId: docId };
        }

        const doc = await db.collection('knowledge_documents').findOne(filter);
        if (!doc) {
            return Response.json({ error: "Document not found" }, { status: 404 });
        }

        return Response.json(doc);
    } catch (error) {
        console.error('[Sources/Slack] Error:', error);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
