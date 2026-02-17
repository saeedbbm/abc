/**
 * Review Feedback Service
 * 
 * When a reviewer accepts or edits a reviewable block on a KB page,
 * this service propagates the change back into the bot's knowledge:
 *   1. Re-embeds the updated KB page into Qdrant (so RAG picks it up)
 *   2. Updates the related knowledge entity metadata
 *   3. Marks related claims as verified or updates their text
 */

import { PrefixLogger } from "@/lib/utils";
import { MongoDBKnowledgePagesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-pages.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { MongoDBClaimsRepository } from "@/src/infrastructure/repositories/mongodb.claims.repository";
import { embedKnowledgeDocument } from "@/src/application/lib/knowledge/embedding-service";
import { KnowledgeDocumentType } from "@/src/entities/models/knowledge-document";

const logger = new PrefixLogger('review-feedback');

export class ReviewFeedbackService {
    private pagesRepo: MongoDBKnowledgePagesRepository;
    private entitiesRepo: MongoDBKnowledgeEntitiesRepository;
    private claimsRepo: MongoDBClaimsRepository;

    constructor() {
        this.pagesRepo = new MongoDBKnowledgePagesRepository();
        this.entitiesRepo = new MongoDBKnowledgeEntitiesRepository();
        this.claimsRepo = new MongoDBClaimsRepository();
    }

    /**
     * Propagate a review action back into the bot's knowledge.
     * This is designed to be called fire-and-forget (don't await in the API route).
     */
    async propagateReview(
        projectId: string,
        pageId: string,
        blockId: string,
        action: 'accept' | 'edit',
        editedText?: string
    ): Promise<void> {
        try {
            const page = await this.pagesRepo.fetch(pageId);
            if (!page) {
                logger.log(`Page ${pageId} not found, skipping feedback propagation`);
                return;
            }

            // 1. Re-embed the KB page into Qdrant as an "internal" document
            await this.reEmbedPage(page);

            // 2. Update related knowledge entity
            if (action === 'edit' && editedText) {
                await this.updateRelatedEntity(projectId, page.entityName, page.entityType, editedText);
            }

            // 3. Update related claims
            await this.updateRelatedClaims(projectId, page.title, blockId, action, editedText);

            logger.log(`Feedback propagated for page "${page.title}" block ${blockId} (${action})`);
        } catch (error) {
            logger.log(`Error propagating review feedback: ${error}`);
        }
    }

    /**
     * Re-embed the KB page as an internal knowledge document so RAG can find it.
     */
    private async reEmbedPage(page: {
        id: string;
        projectId: string;
        companySlug: string;
        title: string;
        content: string;
        entityName: string;
        entityType: string;
        sources: Array<{ provider: string; title: string; url?: string }>;
    }): Promise<void> {
        // Build a synthetic KnowledgeDocumentType from the KB page
        const syntheticDoc: KnowledgeDocumentType = {
            id: `kb:${page.id}`,
            projectId: page.projectId,
            provider: 'internal',
            sourceType: 'kb_page',
            sourceId: `kb:${page.id}`,
            title: page.title,
            content: this.stripHtml(page.content),
            metadata: {
                companySlug: page.companySlug,
                entityName: page.entityName,
                entityType: page.entityType,
                pageId: page.id,
            },
            entityRefs: [],
            syncedAt: new Date().toISOString(),
        };

        const result = await embedKnowledgeDocument(syntheticDoc, logger, { skipHashCheck: true });
        if (result.success) {
            logger.log(`Re-embedded KB page "${page.title}" (${result.chunksCreated} chunks)`);
        }
    }

    /**
     * Update the knowledge entity that this page documents.
     * When text is edited, update the entity's description or relevant metadata.
     */
    private async updateRelatedEntity(
        projectId: string,
        entityName: string,
        entityType: string,
        editedText: string
    ): Promise<void> {
        try {
            const entity = await this.entitiesRepo.findByName(projectId, entityName, entityType);
            if (!entity) return;

            const metadata = entity.metadata as Record<string, any>;

            // If the entity has no description or a short one, use the edited text
            // as enrichment for the entity's description
            if (!metadata.description || metadata.description.length < editedText.length) {
                await this.entitiesRepo.update(entity.id, {
                    metadata: {
                        ...metadata,
                        lastReviewedFact: editedText,
                        lastReviewedAt: new Date().toISOString(),
                    },
                }, 'Updated by KB review feedback');
                logger.log(`Updated entity "${entityName}" with review feedback`);
            }
        } catch (error) {
            logger.log(`Error updating entity "${entityName}": ${error}`);
        }
    }

    /**
     * Update claims related to this KB page.
     * - Accepted blocks: mark claims as "verified"
     * - Edited blocks: update claim text to the corrected version
     */
    private async updateRelatedClaims(
        projectId: string,
        pageTitle: string,
        blockId: string,
        action: 'accept' | 'edit',
        editedText?: string
    ): Promise<void> {
        try {
            // Find claims that reference this page title (KB pages are named like entities)
            const claims = await this.claimsRepo.getClaimsByEntity(projectId, pageTitle);
            if (claims.length === 0) return;

            for (const claim of claims) {
                if (action === 'accept') {
                    await this.claimsRepo.updateClaimStatus(projectId, claim.id, 'verified');
                } else if (action === 'edit' && editedText) {
                    // Update the claim text to the corrected version
                    await this.claimsRepo.updateClaimStatus(
                        projectId,
                        claim.id,
                        'verified',
                        `Corrected by reviewer: ${editedText.substring(0, 200)}`
                    );
                }
            }
            logger.log(`Updated ${claims.length} related claims for "${pageTitle}"`);
        } catch (error) {
            logger.log(`Error updating claims for "${pageTitle}": ${error}`);
        }
    }

    /**
     * Strip HTML tags from content for plain-text embedding.
     */
    private stripHtml(html: string): string {
        return html
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
}
