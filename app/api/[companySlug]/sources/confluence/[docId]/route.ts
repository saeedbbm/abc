/**
 * Confluence Source Document API
 * 
 * GET /api/[companySlug]/sources/confluence/[docId]
 * 
 * Returns a specific Confluence knowledge document by docId and projectId.
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
        let filter: Record<string, any> = { projectId, provider: 'confluence' };

        try {
            filter._id = new ObjectId(docId);
        } catch {
            filter = { projectId, provider: 'confluence', sourceId: docId };
        }

        const doc = await db.collection('knowledge_documents').findOne(filter);
        if (!doc) {
            return Response.json({ error: "Document not found" }, { status: 404 });
        }

        return Response.json(doc);
    } catch (error) {
        console.error('[Sources/Confluence] Error:', error);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
