/**
 * Knowledge Base API — Single page operations
 * 
 * GET    /api/[companySlug]/kb/[pageId]  — Get a single page
 * PUT    /api/[companySlug]/kb/[pageId]  — Update page content
 * DELETE /api/[companySlug]/kb/[pageId]  — Delete a page
 */

import { resolveCompanySlug } from "@/lib/company-resolver";
import { MongoDBKnowledgePagesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-pages.repository";

const pagesRepo = new MongoDBKnowledgePagesRepository();

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ companySlug: string; pageId: string }> }
): Promise<Response> {
    const { companySlug, pageId } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        const page = await pagesRepo.fetch(pageId);
        if (!page) {
            return Response.json({ error: 'Page not found' }, { status: 404 });
        }
        return Response.json(page);
    } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
    }
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ companySlug: string; pageId: string }> }
): Promise<Response> {
    const { companySlug, pageId } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        const body = await req.json();
        await pagesRepo.update(pageId, body);
        const updated = await pagesRepo.fetch(pageId);
        return Response.json(updated);
    } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ companySlug: string; pageId: string }> }
): Promise<Response> {
    const { companySlug, pageId } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        await pagesRepo.delete(pageId);
        return Response.json({ success: true });
    } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
    }
}
