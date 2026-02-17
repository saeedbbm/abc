/**
 * Knowledge Base API — Review a specific block
 * 
 * POST /api/[companySlug]/kb/[pageId]/review
 * Body: { blockId: string, action: 'accept' | 'edit', editedText?: string, reviewerName: string }
 */

import { resolveCompanySlug } from "@/lib/company-resolver";
import { MongoDBKnowledgePagesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-pages.repository";
import { ReviewFeedbackService } from "@/src/application/services/review-feedback.service";

const pagesRepo = new MongoDBKnowledgePagesRepository();
const feedbackService = new ReviewFeedbackService();

export async function POST(
    req: Request,
    { params }: { params: Promise<{ companySlug: string; pageId: string }> }
): Promise<Response> {
    const { companySlug, pageId } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        const body = await req.json();
        const { blockId, action, editedText, reviewerName } = body;

        if (!blockId || !action || !reviewerName) {
            return Response.json(
                { error: 'blockId, action, and reviewerName are required' },
                { status: 400 }
            );
        }

        if (action !== 'accept' && action !== 'edit') {
            return Response.json(
                { error: 'action must be "accept" or "edit"' },
                { status: 400 }
            );
        }

        if (action === 'edit' && !editedText) {
            return Response.json(
                { error: 'editedText is required when action is "edit"' },
                { status: 400 }
            );
        }

        // Update the review block
        const updatedPage = await pagesRepo.updateReviewBlock(pageId, blockId, {
            status: action === 'accept' ? 'accepted' : 'edited',
            editedText: action === 'edit' ? editedText : undefined,
            reviewedBy: reviewerName,
        });

        if (!updatedPage) {
            return Response.json({ error: 'Page not found' }, { status: 404 });
        }

        // If the block was edited, also update the HTML content
        if (action === 'edit' && editedText) {
            await pagesRepo.applyBlockEdit(pageId, blockId, editedText);
        }

        const finalPage = await pagesRepo.fetch(pageId);

        // Fire-and-forget: propagate review into bot knowledge (embeddings, entities, claims)
        feedbackService.propagateReview(projectId, pageId, blockId, action, editedText).catch(() => {});

        return Response.json(finalPage);
    } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
    }
}
