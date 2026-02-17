/**
 * MongoDB Knowledge Pages Repository
 * 
 * CRUD operations for bot-generated knowledge base pages.
 * These pages live on our platform, not Confluence.
 */

import { ObjectId, WithId } from "mongodb";
import { db } from "@/lib/mongodb";
import {
    KnowledgePageType,
    CreateKnowledgePageType,
    UpdateKnowledgePageType,
    ReviewableBlockType,
    PageCategoryType,
} from "@/src/entities/models/knowledge-page";

type KnowledgePageDoc = Omit<KnowledgePageType, 'id'>;

export class MongoDBKnowledgePagesRepository {
    private collection = db.collection<KnowledgePageDoc>('knowledge_pages');

    private toEntity(doc: WithId<KnowledgePageDoc>): KnowledgePageType {
        const { _id, ...rest } = doc;
        return { ...rest, id: _id.toString() };
    }

    async create(data: CreateKnowledgePageType): Promise<KnowledgePageType> {
        const now = new Date().toISOString();
        const doc: KnowledgePageDoc = {
            ...data,
            status: 'draft',
            reviewedBlocks: 0,
            createdAt: now,
            updatedAt: now,
        };
        const result = await this.collection.insertOne(doc as any);
        return this.toEntity({ ...doc, _id: result.insertedId } as any);
    }

    async fetch(id: string): Promise<KnowledgePageType | null> {
        try {
            const doc = await this.collection.findOne({ _id: new ObjectId(id) });
            return doc ? this.toEntity(doc) : null;
        } catch {
            return null;
        }
    }

    async update(id: string, data: UpdateKnowledgePageType): Promise<void> {
        await this.collection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { ...data, updatedAt: new Date().toISOString() } }
        );
    }

    async delete(id: string): Promise<void> {
        await this.collection.deleteOne({ _id: new ObjectId(id) });
    }

    /**
     * Find all pages for a project, optionally filtered by category
     */
    async findByProject(
        projectId: string,
        options?: {
            category?: PageCategoryType;
            status?: string;
            limit?: number;
            offset?: number;
        }
    ): Promise<{ pages: KnowledgePageType[]; total: number }> {
        const filter: Record<string, any> = { projectId };
        if (options?.category) filter.category = options.category;
        if (options?.status) filter.status = options.status;

        const total = await this.collection.countDocuments(filter);
        const cursor = this.collection
            .find(filter)
            .sort({ category: 1, title: 1 })
            .skip(options?.offset || 0)
            .limit(options?.limit || 100);

        const pages: KnowledgePageType[] = [];
        for await (const doc of cursor) {
            pages.push(this.toEntity(doc));
        }

        return { pages, total };
    }

    /**
     * Find a page by entity name and project (for deduplication)
     */
    async findByEntityName(
        projectId: string,
        entityName: string,
        category: PageCategoryType
    ): Promise<KnowledgePageType | null> {
        const doc = await this.collection.findOne({
            projectId,
            entityName,
            category,
        });
        return doc ? this.toEntity(doc) : null;
    }

    /**
     * Update a specific reviewable block
     */
    async updateReviewBlock(
        pageId: string,
        blockId: string,
        update: {
            status: 'accepted' | 'edited';
            editedText?: string;
            reviewedBy: string;
        }
    ): Promise<KnowledgePageType | null> {
        const page = await this.fetch(pageId);
        if (!page) return null;

        const blocks = page.reviewableBlocks.map(b => {
            if (b.id === blockId) {
                return {
                    ...b,
                    status: update.status,
                    editedText: update.editedText,
                    reviewedBy: update.reviewedBy,
                    reviewedAt: new Date().toISOString(),
                };
            }
            return b;
        });

        const reviewedCount = blocks.filter(b => b.status !== 'pending').length;
        const newStatus = reviewedCount === blocks.length ? 'accepted' : 'in_review';

        await this.collection.updateOne(
            { _id: new ObjectId(pageId) },
            {
                $set: {
                    reviewableBlocks: blocks,
                    reviewedBlocks: reviewedCount,
                    status: newStatus,
                    updatedAt: new Date().toISOString(),
                },
            }
        );

        return this.fetch(pageId);
    }

    /**
     * Update the HTML content (applying accepted edits inline)
     */
    async applyBlockEdit(
        pageId: string,
        blockId: string,
        newText: string
    ): Promise<void> {
        const page = await this.fetch(pageId);
        if (!page) return;

        // Replace the block's original text in the HTML content
        const block = page.reviewableBlocks.find(b => b.id === blockId);
        if (!block) return;

        // The content has data-review-id markers; update the text within
        const updatedContent = page.content.replace(
            new RegExp(
                `(<span[^>]*data-review-id="${blockId}"[^>]*>)([\\s\\S]*?)(</span>)`
            ),
            `$1${newText}$3`
        );

        await this.collection.updateOne(
            { _id: new ObjectId(pageId) },
            { $set: { content: updatedContent, updatedAt: new Date().toISOString() } }
        );
    }

    /**
     * Delete all pages for a project
     */
    async deleteByProject(projectId: string): Promise<number> {
        const result = await this.collection.deleteMany({ projectId });
        return result.deletedCount;
    }

    /**
     * Get summary stats for a project's knowledge base
     */
    async getStats(projectId: string): Promise<{
        totalPages: number;
        byCategory: Record<string, number>;
        byStatus: Record<string, number>;
        totalBlocks: number;
        reviewedBlocks: number;
    }> {
        const pages = await this.collection.find({ projectId }).toArray();

        const byCategory: Record<string, number> = {};
        const byStatus: Record<string, number> = {};
        let totalBlocks = 0;
        let reviewedBlocks = 0;

        for (const page of pages) {
            byCategory[page.category] = (byCategory[page.category] || 0) + 1;
            byStatus[page.status] = (byStatus[page.status] || 0) + 1;
            totalBlocks += page.totalBlocks;
            reviewedBlocks += page.reviewedBlocks;
        }

        return {
            totalPages: pages.length,
            byCategory,
            byStatus,
            totalBlocks,
            reviewedBlocks,
        };
    }
}
