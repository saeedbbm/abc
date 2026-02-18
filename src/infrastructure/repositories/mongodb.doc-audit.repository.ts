import { z } from "zod";
import { ObjectId, Filter } from "mongodb";
import { db } from "@/lib/mongodb";
import {
    DocAuditFinding,
    CreateDocAuditFindingSchema,
    UpdateDocAuditFindingSchema,
    DocAuditRun,
    DocAuditConfig,
} from "@/src/entities/models/doc-audit";

// --- Findings Repository ---

const FindingSchema = DocAuditFinding.omit({ id: true });

export class MongoDBDocAuditFindingsRepository {
    private collection = db.collection<z.infer<typeof FindingSchema>>('doc_audit_findings');

    async create(data: z.infer<typeof CreateDocAuditFindingSchema>): Promise<z.infer<typeof DocAuditFinding>> {
        const now = new Date().toISOString();

        const doc = {
            ...data,
            createdAt: now,
            updatedAt: now,
        };

        const result = await this.collection.insertOne(doc);

        return {
            ...doc,
            id: result.insertedId.toString(),
        };
    }

    /** Alias for `create` — used by event-driven claim matcher */
    async createFinding(data: z.infer<typeof CreateDocAuditFindingSchema>): Promise<z.infer<typeof DocAuditFinding>> {
        return this.create(data);
    }

    async fetch(id: string): Promise<z.infer<typeof DocAuditFinding> | null> {
        try {
            const doc = await this.collection.findOne({ _id: new ObjectId(id) });
            if (!doc) return null;

            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        } catch {
            return null;
        }
    }

    async update(
        id: string,
        data: z.infer<typeof UpdateDocAuditFindingSchema>
    ): Promise<z.infer<typeof DocAuditFinding>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: { ...data, updatedAt: new Date().toISOString() } },
            { returnDocument: 'after' }
        );

        if (!result) {
            throw new Error('Finding not found');
        }

        const { _id, ...rest } = result;
        return { ...rest, id: _id.toString() };
    }

    async findByProjectId(
        projectId: string,
        options: {
            type?: string;
            status?: string;
            auditRunId?: string;
            limit?: number;
        } = {}
    ): Promise<z.infer<typeof DocAuditFinding>[]> {
        const { type, status, auditRunId, limit = 100 } = options;

        const query: Filter<z.infer<typeof FindingSchema>> = { projectId };
        if (type) query.type = type;
        if (status) query.status = status;
        if (auditRunId) query.auditRunId = auditRunId;

        const results = await this.collection
            .find(query)
            .sort({ detectedAt: -1 })
            .limit(limit)
            .toArray();

        return results.map(doc => {
            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        });
    }

    /**
     * Check if a similar finding already exists (deduplication).
     * Matches on projectId + type + TITLE (exact match).
     * Only considers findings that have been accepted — pending/notified findings
     * from previous runs should NOT block regeneration.
     */
    async findExistingFinding(
        projectId: string,
        confluencePageId: string | undefined,
        type: string,
        title: string
    ): Promise<z.infer<typeof DocAuditFinding> | null> {
        const query: Record<string, any> = {
            projectId,
            type,
            title,
            status: { $in: ['accepted'] }, // Only skip if previously ACCEPTED
        };

        if (confluencePageId) {
            query.confluencePageId = confluencePageId;
        }

        const doc = await this.collection.findOne(query);
        if (!doc) return null;

        const { _id, ...rest } = doc;
        return { ...rest, id: _id.toString() };
    }

    /**
     * Clear all findings from previous runs that are still pending/notified
     * so they can be regenerated with fresh data.
     */
    async clearStaleFindings(projectId: string): Promise<number> {
        const result = await this.collection.deleteMany({
            projectId,
            status: { $in: ['pending', 'notified', 'proposal_created'] },
        } as any);
        return result.deletedCount;
    }

    async countByProject(
        projectId: string,
        options: { status?: string; type?: string } = {}
    ): Promise<number> {
        const query: Filter<z.infer<typeof FindingSchema>> = { projectId };
        if (options.status) query.status = options.status;
        if (options.type) query.type = options.type;
        return await this.collection.countDocuments(query);
    }
}

// --- Audit Runs Repository ---

const RunSchema = DocAuditRun.omit({ id: true });

export class MongoDBDocAuditRunsRepository {
    private collection = db.collection<z.infer<typeof RunSchema>>('doc_audit_runs');

    async create(data: Omit<z.infer<typeof DocAuditRun>, 'id'>): Promise<z.infer<typeof DocAuditRun>> {
        const result = await this.collection.insertOne(data);
        return { ...data, id: result.insertedId.toString() };
    }

    async fetch(id: string): Promise<z.infer<typeof DocAuditRun> | null> {
        try {
            const doc = await this.collection.findOne({ _id: new ObjectId(id) });
            if (!doc) return null;
            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        } catch {
            return null;
        }
    }

    async update(
        id: string,
        data: Partial<Omit<z.infer<typeof DocAuditRun>, 'id'>>
    ): Promise<z.infer<typeof DocAuditRun>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: { ...data, updatedAt: new Date().toISOString() } },
            { returnDocument: 'after' }
        );

        if (!result) throw new Error('Audit run not found');
        const { _id, ...rest } = result;
        return { ...rest, id: _id.toString() };
    }

    async findByProjectId(
        projectId: string,
        limit: number = 20
    ): Promise<z.infer<typeof DocAuditRun>[]> {
        const results = await this.collection
            .find({ projectId })
            .sort({ startedAt: -1 })
            .limit(limit)
            .toArray();

        return results.map(doc => {
            const { _id, ...rest } = doc;
            return { ...rest, id: _id.toString() };
        });
    }

    async getLatestRun(projectId: string): Promise<z.infer<typeof DocAuditRun> | null> {
        const doc = await this.collection
            .findOne({ projectId }, { sort: { startedAt: -1 } });

        if (!doc) return null;
        const { _id, ...rest } = doc;
        return { ...rest, id: _id.toString() };
    }
}

// --- Audit Config Repository ---

const ConfigSchema = DocAuditConfig.omit({ id: true });

export class MongoDBDocAuditConfigRepository {
    private collection = db.collection<z.infer<typeof ConfigSchema>>('doc_audit_configs');

    async getOrCreate(projectId: string): Promise<z.infer<typeof DocAuditConfig>> {
        const existing = await this.collection.findOne({ projectId });
        if (existing) {
            const { _id, ...rest } = existing;
            return { ...rest, id: _id.toString() };
        }

        const now = new Date().toISOString();
        const defaults = {
            projectId,
            enabled: false,
            cronExpression: '0 9 * * 1-5',
            slackChannelName: 'documentation',
            auditConflicts: true,
            auditGaps: true,
            targetSpaceIds: [],
            conflictSimilarityThreshold: 0.7,
            gapSimilarityThreshold: 0.5,
            minTopicMentions: 3,
            pidraxSpaceKey: 'PidraxBot',
            pidraxCategoryPages: {},
            createdAt: now,
            updatedAt: now,
        };

        const result = await this.collection.insertOne(defaults);
        return { ...defaults, id: result.insertedId.toString() };
    }

    async update(
        projectId: string,
        data: Partial<Omit<z.infer<typeof DocAuditConfig>, 'id' | 'projectId' | 'createdAt'>>
    ): Promise<z.infer<typeof DocAuditConfig>> {
        // Ensure config exists first
        await this.getOrCreate(projectId);

        const result = await this.collection.findOneAndUpdate(
            { projectId },
            { $set: { ...data, updatedAt: new Date().toISOString() } },
            { returnDocument: 'after' }
        );

        if (!result) {
            throw new Error('Failed to update config');
        }

        const { _id, ...rest } = result;
        return { ...rest, id: _id.toString() };
    }
}
