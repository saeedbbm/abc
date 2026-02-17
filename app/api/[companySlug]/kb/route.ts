/**
 * Knowledge Base API — List & Delete pages
 * 
 * GET    /api/[companySlug]/kb  — List all KB pages
 * DELETE /api/[companySlug]/kb  — Delete all KB pages for this project
 */

import { resolveCompanySlug } from "@/lib/company-resolver";
import { MongoDBKnowledgePagesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-pages.repository";
import { PageCategoryType } from "@/src/entities/models/knowledge-page";

const pagesRepo = new MongoDBKnowledgePagesRepository();

export async function GET(
    req: Request,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    const url = new URL(req.url);
    const category = url.searchParams.get('category') as PageCategoryType | null;
    const status = url.searchParams.get('status');

    try {
        const { pages, total } = await pagesRepo.findByProject(projectId, {
            category: category || undefined,
            status: status || undefined,
        });

        const stats = await pagesRepo.getStats(projectId);

        return Response.json({
            pages,
            total,
            stats,
        });
    } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        const deletedCount = await pagesRepo.deleteByProject(projectId);
        return Response.json({ success: true, deletedCount });
    } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
    }
}
