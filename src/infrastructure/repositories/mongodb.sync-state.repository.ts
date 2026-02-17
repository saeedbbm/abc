import { Collection, ObjectId } from "mongodb";
import { z } from "zod";
import { db } from "@/lib/mongodb";
import { 
    SyncState, 
    UpdateSyncStateSchema 
} from "@/src/entities/models/sync-state";

const COLLECTION_NAME = 'sync_states';

// MongoDB document schema (with _id instead of id)
const DocSchema = SyncState.omit({ id: true }).extend({
    _id: z.instanceof(ObjectId).optional(),
});

export class MongoDBSyncStateRepository {
    private collection: Collection<z.infer<typeof DocSchema>>;

    constructor() {
        this.collection = db.collection(COLLECTION_NAME);
        
        // Create unique index on projectId + provider
        this.collection.createIndex(
            { projectId: 1, provider: 1 }, 
            { unique: true }
        ).catch(err => console.error('Failed to create sync_states index:', err));
    }

    async fetch(
        projectId: string, 
        provider: 'slack' | 'jira' | 'confluence'
    ): Promise<z.infer<typeof SyncState> | null> {
        const doc = await this.collection.findOne({ projectId, provider });
        
        if (!doc) return null;

        const { _id, ...rest } = doc;
        return {
            ...rest,
            id: _id!.toString(),
        };
    }

    async upsert(
        projectId: string,
        provider: 'slack' | 'jira' | 'confluence',
        data: Partial<z.infer<typeof UpdateSyncStateSchema>>
    ): Promise<z.infer<typeof SyncState>> {
        const now = new Date().toISOString();
        
        // Build the default values for insert, excluding any fields that are in data
        const defaultValues: Record<string, any> = {
            projectId,
            provider,
            lastSyncedAt: null,
            lastCursor: null,
            totalDocuments: 0,
            totalEmbeddings: 0,
            lastError: null,
            consecutiveErrors: 0,
            status: 'idle',
            createdAt: now,
        };
        
        // Remove fields from defaultValues that are being set in data
        // to avoid MongoDB conflict between $set and $setOnInsert
        const dataKeys = Object.keys(data);
        for (const key of dataKeys) {
            delete defaultValues[key];
        }
        // Also remove updatedAt if it somehow got in
        delete defaultValues['updatedAt'];
        
        const result = await this.collection.findOneAndUpdate(
            { projectId, provider },
            {
                $set: {
                    ...data,
                    updatedAt: now,
                },
                $setOnInsert: defaultValues,
            },
            { 
                upsert: true, 
                returnDocument: 'after' 
            }
        );

        if (!result) {
            throw new Error('Failed to upsert sync state');
        }

        const { _id, ...rest } = result;
        return {
            ...rest,
            id: _id!.toString(),
        };
    }

    async update(
        id: string,
        data: z.infer<typeof UpdateSyncStateSchema>
    ): Promise<z.infer<typeof SyncState>> {
        const now = new Date().toISOString();
        
        const result = await this.collection.findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $set: {
                    ...data,
                    updatedAt: now,
                },
            },
            { returnDocument: 'after' }
        );

        if (!result) {
            throw new Error('Sync state not found');
        }

        const { _id, ...rest } = result;
        return {
            ...rest,
            id: _id!.toString(),
        };
    }

    async listByProject(projectId: string): Promise<z.infer<typeof SyncState>[]> {
        const docs = await this.collection.find({ projectId }).toArray();
        
        return docs.map(doc => {
            const { _id, ...rest } = doc;
            return {
                ...rest,
                id: _id!.toString(),
            };
        });
    }

    async delete(id: string): Promise<void> {
        await this.collection.deleteOne({ _id: new ObjectId(id) });
    }

    async deleteByProject(projectId: string): Promise<void> {
        await this.collection.deleteMany({ projectId });
    }
}
