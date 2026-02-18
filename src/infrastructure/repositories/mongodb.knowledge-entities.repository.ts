import { z } from "zod";
import { ObjectId, Filter } from "mongodb";
import { db } from "@/lib/mongodb";
import { 
    KnowledgeEntity, 
    CreateKnowledgeEntitySchema, 
    UpdateKnowledgeEntitySchema,
    EntityVersionEntry,
} from "@/src/entities/models/knowledge-entity";

const DocSchema = KnowledgeEntity.omit({ id: true });

export class MongoDBKnowledgeEntitiesRepository {
    private collection = db.collection<z.infer<typeof DocSchema>>('knowledge_entities');

    async create(data: z.infer<typeof CreateKnowledgeEntitySchema>): Promise<z.infer<typeof KnowledgeEntity>> {
        const now = new Date().toISOString();
        
        const doc = {
            ...data,
            version: 1,
            previousVersions: [],
            createdAt: now,
            updatedAt: now,
        };

        const result = await this.collection.insertOne(doc);

        return {
            ...doc,
            id: result.insertedId.toString(),
        };
    }

    async fetch(id: string): Promise<z.infer<typeof KnowledgeEntity> | null> {
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
        data: z.infer<typeof UpdateKnowledgeEntitySchema>,
        reason?: string
    ): Promise<z.infer<typeof KnowledgeEntity>> {
        const existing = await this.fetch(id);
        if (!existing) {
            throw new Error('Entity not found');
        }

        const now = new Date().toISOString();
        
        // Determine which fields changed
        const changedFields: string[] = [];
        if (data.name && data.name !== existing.name) changedFields.push('name');
        if (data.aliases) changedFields.push('aliases');
        if (data.metadata) {
            Object.keys(data.metadata).forEach(k => {
                if (JSON.stringify(data.metadata![k]) !== JSON.stringify((existing.metadata as any)[k])) {
                    changedFields.push(`metadata.${k}`);
                }
            });
        }
        if (data.sources) changedFields.push('sources');

        // Create version entry
        const versionEntry: z.infer<typeof EntityVersionEntry> = {
            version: existing.version,
            metadata: existing.metadata as Record<string, any>,
            updatedAt: existing.updatedAt,
            reason,
            changedFields,
        };

        // Keep only last 5 versions
        const previousVersions = [versionEntry, ...existing.previousVersions].slice(0, 5);

        const result = await this.collection.findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $set: {
                    ...data,
                    version: existing.version + 1,
                    previousVersions,
                    updatedAt: now,
                },
            },
            { returnDocument: 'after' }
        );

        if (!result) {
            throw new Error('Entity not found');
        }

        const { _id, ...rest } = result;
        return {
            ...rest,
            id: _id.toString(),
        };
    }

    async delete(id: string, projectId?: string): Promise<void> {
        // Soft delete
        const filter: Filter<z.infer<typeof DocSchema>> = { _id: new ObjectId(id) };
        if (projectId) filter.projectId = projectId;
        await this.collection.updateOne(
            filter,
            { $set: { deletedAt: new Date().toISOString() } }
        );
    }

    async findByProject(
        projectId: string,
        type?: string
    ): Promise<z.infer<typeof KnowledgeEntity>[]> {
        const query: Filter<z.infer<typeof DocSchema>> = {
            projectId,
            deletedAt: { $exists: false },
        };
        if (type) query.type = type;

        const results = await this.collection.find(query).toArray();
        return results.map(doc => {
            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        });
    }

    async updateMetadata(
        entityId: string,
        projectId: string,
        metadata: Record<string, any>
    ): Promise<void> {
        await this.collection.updateOne(
            { _id: new ObjectId(entityId), projectId },
            { $set: { metadata, updatedAt: new Date().toISOString() } }
        );
    }

    async findByProjectId(
        projectId: string,
        options: {
            type?: string;
            cursor?: string;
            limit?: number;
            includeDeleted?: boolean;
        } = {}
    ): Promise<{ items: z.infer<typeof KnowledgeEntity>[]; nextCursor?: string }> {
        const { type, cursor, limit = 50, includeDeleted = false } = options;

        const query: Filter<z.infer<typeof DocSchema>> = { projectId };
        if (type) query.type = type;
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

    async findByName(
        projectId: string,
        name: string,
        type?: string
    ): Promise<z.infer<typeof KnowledgeEntity> | null> {
        const query: Filter<z.infer<typeof DocSchema>> = {
            projectId,
            name: { $regex: new RegExp(`^${name}$`, 'i') },
            deletedAt: { $exists: false },
        };
        if (type) query.type = type;

        const doc = await this.collection.findOne(query);
        if (!doc) return null;

        const { _id, ...rest } = doc;
        return { ...rest, id: _id.toString() };
    }

    async findByAlias(
        projectId: string,
        alias: string,
        type?: string
    ): Promise<z.infer<typeof KnowledgeEntity> | null> {
        const query: Filter<z.infer<typeof DocSchema>> = {
            projectId,
            aliases: { $elemMatch: { $regex: new RegExp(`^${alias}$`, 'i') } },
            deletedAt: { $exists: false },
        };
        if (type) query.type = type;

        const doc = await this.collection.findOne(query);
        if (!doc) return null;

        const { _id, ...rest } = doc;
        return { ...rest, id: _id.toString() };
    }

    async findBySourceId(
        projectId: string,
        provider: string,
        sourceId: string
    ): Promise<z.infer<typeof KnowledgeEntity> | null> {
        const doc = await this.collection.findOne({
            projectId,
            'sources.provider': provider,
            'sources.sourceId': sourceId,
            deletedAt: { $exists: false },
        });

        if (!doc) return null;

        const { _id, ...rest } = doc;
        return { ...rest, id: _id.toString() };
    }

    async searchByName(
        projectId: string,
        query: string,
        options: { type?: string; limit?: number } = {}
    ): Promise<z.infer<typeof KnowledgeEntity>[]> {
        const { type, limit = 10 } = options;

        const filter: Filter<z.infer<typeof DocSchema>> = {
            projectId,
            $or: [
                { name: { $regex: query, $options: 'i' } },
                { aliases: { $elemMatch: { $regex: query, $options: 'i' } } },
            ],
            deletedAt: { $exists: false },
        };
        if (type) filter.type = type;

        const results = await this.collection
            .find(filter)
            .limit(limit)
            .toArray();

        return results.map(doc => {
            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        });
    }

    async bulkUpsert(
        items: z.infer<typeof CreateKnowledgeEntitySchema>[]
    ): Promise<z.infer<typeof KnowledgeEntity>[]> {
        const results: z.infer<typeof KnowledgeEntity>[] = [];
        
        for (const item of items) {
            // Check if entity exists by name or source
            let existing: z.infer<typeof KnowledgeEntity> | null = null;
            
            // First try to find by source
            if (item.sources && item.sources.length > 0) {
                const source = item.sources[0];
                existing = await this.findBySourceId(item.projectId, source.provider, source.sourceId);
            }
            
            // If not found by source, try by name
            if (!existing) {
                existing = await this.findByName(item.projectId, item.name, item.type);
            }

            if (existing) {
                // Merge sources and aliases
                const mergedSources = [...existing.sources];
                for (const source of item.sources || []) {
                    const existingSourceIndex = mergedSources.findIndex(
                        s => s.provider === source.provider && s.sourceId === source.sourceId
                    );
                    if (existingSourceIndex >= 0) {
                        mergedSources[existingSourceIndex] = source;
                    } else {
                        mergedSources.push(source);
                    }
                }

                const mergedAliases = [...new Set([...existing.aliases, ...(item.aliases || [])])];

                // Merge metadata
                const mergedMetadata = {
                    ...(existing.metadata as Record<string, any>),
                    ...(item.metadata as Record<string, any>),
                };

                const updated = await this.update(existing.id, {
                    aliases: mergedAliases,
                    metadata: mergedMetadata,
                    sources: mergedSources,
                }, 'Bulk upsert merge');

                results.push(updated);
            } else {
                const created = await this.create(item);
                results.push(created);
            }
        }

        return results;
    }

    async deleteByProjectId(projectId: string): Promise<void> {
        await this.collection.deleteMany({ projectId });
    }
}
