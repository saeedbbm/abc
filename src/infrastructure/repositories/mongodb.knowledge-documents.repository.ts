import { z } from "zod";
import { ObjectId, Filter } from "mongodb";
import { db } from "@/lib/mongodb";
import { 
    KnowledgeDocument, 
    CreateKnowledgeDocumentSchema, 
    UpdateKnowledgeDocumentSchema,
    DocumentVersionEntry,
} from "@/src/entities/models/knowledge-document";

const DocSchema = KnowledgeDocument.omit({ id: true });

export class MongoDBKnowledgeDocumentsRepository {
    private collection = db.collection<z.infer<typeof DocSchema>>('knowledge_documents');

    async create(data: z.infer<typeof CreateKnowledgeDocumentSchema>): Promise<z.infer<typeof KnowledgeDocument>> {
        const now = new Date().toISOString();
        
        const doc = {
            ...data,
            version: 1,
            previousVersions: [],
            embeddingStatus: 'pending' as const,
            createdAt: now,
            updatedAt: now,
        };

        const result = await this.collection.insertOne(doc);

        return {
            ...doc,
            id: result.insertedId.toString(),
        };
    }

    async fetch(id: string): Promise<z.infer<typeof KnowledgeDocument> | null> {
        try {
            const doc = await this.collection.findOne({ _id: new ObjectId(id) });
            if (!doc) return null;

            const { _id, ...rest } = doc;
            return {
                ...rest,
                id: _id.toString(),
            };
        } catch {
            return null;
        }
    }

    async update(
        id: string, 
        data: z.infer<typeof UpdateKnowledgeDocumentSchema>
    ): Promise<z.infer<typeof KnowledgeDocument>> {
        const existing = await this.fetch(id);
        if (!existing) {
            throw new Error('Document not found');
        }

        const now = new Date().toISOString();
        
        // If content changed, create version entry
        let previousVersions = existing.previousVersions;
        if (data.content && data.content !== existing.content) {
            const versionEntry: z.infer<typeof DocumentVersionEntry> = {
                version: existing.version,
                content: existing.content,
                metadata: existing.metadata,
                updatedAt: existing.updatedAt,
                sourceUpdatedAt: existing.sourceUpdatedAt,
            };
            previousVersions = [versionEntry, ...previousVersions].slice(0, 5);
        }

        const updateData: Record<string, any> = {
            ...data,
            updatedAt: now,
        };

        if (data.content && data.content !== existing.content) {
            updateData.version = existing.version + 1;
            updateData.previousVersions = previousVersions;
            updateData.embeddingStatus = 'pending'; // Re-embed on content change
        }

        const result = await this.collection.findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: updateData },
            { returnDocument: 'after' }
        );

        if (!result) {
            throw new Error('Document not found');
        }

        const { _id, ...rest } = result;
        return {
            ...rest,
            id: _id.toString(),
        };
    }

    async delete(id: string): Promise<void> {
        // Soft delete
        await this.collection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { deletedAt: new Date().toISOString() } }
        );
    }

    async findByProjectId(
        projectId: string,
        options: {
            provider?: string;
            sourceType?: string;
            embeddingStatus?: string;
            cursor?: string;
            limit?: number;
            includeDeleted?: boolean;
        } = {}
    ): Promise<{ items: z.infer<typeof KnowledgeDocument>[]; nextCursor?: string }> {
        const { provider, sourceType, embeddingStatus, cursor, limit = 50, includeDeleted = false } = options;

        const query: Filter<z.infer<typeof DocSchema>> = { projectId };
        if (provider) query.provider = provider;
        if (sourceType) query.sourceType = sourceType;
        if (embeddingStatus) query.embeddingStatus = embeddingStatus;
        if (!includeDeleted) query.deletedAt = { $exists: false };
        if (cursor) query._id = { $lt: new ObjectId(cursor) };

        const results = await this.collection
            .find(query)
            .sort({ _id: -1 })
            .limit(limit + 1)
            .toArray();

        const hasNextPage = results.length > limit;
        const items = results.slice(0, limit).map(doc => {
            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        });

        return {
            items,
            nextCursor: hasNextPage ? items[items.length - 1]?.id : undefined,
        };
    }

    async findBySourceId(
        projectId: string,
        provider: string,
        sourceId: string
    ): Promise<z.infer<typeof KnowledgeDocument> | null> {
        const doc = await this.collection.findOne({
            projectId,
            provider,
            sourceId,
            deletedAt: { $exists: false },
        });

        if (!doc) return null;

        const { _id, ...rest } = doc;
        return { ...rest, id: _id.toString() };
    }

    async findByParentId(
        projectId: string,
        parentId: string
    ): Promise<z.infer<typeof KnowledgeDocument>[]> {
        const results = await this.collection
            .find({
                projectId,
                parentId,
                deletedAt: { $exists: false },
            })
            .toArray();

        return results.map(doc => {
            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        });
    }

    async findPendingEmbedding(
        projectId: string,
        limit: number = 100
    ): Promise<z.infer<typeof KnowledgeDocument>[]> {
        const results = await this.collection
            .find({
                projectId,
                embeddingStatus: 'pending',
                deletedAt: { $exists: false },
            })
            .limit(limit)
            .toArray();

        return results.map(doc => {
            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        });
    }

    async bulkCreate(
        items: z.infer<typeof CreateKnowledgeDocumentSchema>[]
    ): Promise<z.infer<typeof KnowledgeDocument>[]> {
        if (items.length === 0) return [];

        const now = new Date().toISOString();
        
        const docs = items.map(item => ({
            ...item,
            version: 1,
            previousVersions: [],
            embeddingStatus: 'pending' as const,
            createdAt: now,
            updatedAt: now,
        }));

        const result = await this.collection.insertMany(docs);

        return docs.map((doc, index) => ({
            ...doc,
            id: result.insertedIds[index].toString(),
        }));
    }

    async bulkUpdateEmbeddingStatus(
        ids: string[],
        status: 'pending' | 'ready' | 'error',
        error?: string
    ): Promise<void> {
        const objectIds = ids.map(id => new ObjectId(id));
        
        const update: Record<string, any> = {
            embeddingStatus: status,
            updatedAt: new Date().toISOString(),
        };
        
        if (error) {
            update.embeddingError = error;
        }

        await this.collection.updateMany(
            { _id: { $in: objectIds } },
            { $set: update }
        );
    }

    async deleteByProjectId(projectId: string): Promise<void> {
        await this.collection.deleteMany({ projectId });
    }

    async deleteByProvider(projectId: string, provider: string): Promise<void> {
        await this.collection.deleteMany({ projectId, provider });
    }

    async findByProjectAndProvider(
        projectId: string,
        provider: string,
        options: { limit?: number } = {}
    ): Promise<{ items: z.infer<typeof KnowledgeDocument>[] }> {
        const { limit = 1000 } = options;

        const results = await this.collection
            .find({
                projectId,
                provider,
                deletedAt: { $exists: false },
            })
            .sort({ _id: -1 })
            .limit(limit)
            .toArray();

        const items = results.map(doc => {
            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        });

        return { items };
    }

    async countByProjectId(
        projectId: string,
        options: { provider?: string; embeddingStatus?: string } = {}
    ): Promise<number> {
        const { provider, embeddingStatus } = options;
        
        const query: Filter<z.infer<typeof DocSchema>> = {
            projectId,
            deletedAt: { $exists: false },
        };
        if (provider) query.provider = provider;
        if (embeddingStatus) query.embeddingStatus = embeddingStatus;

        return await this.collection.countDocuments(query);
    }
}
