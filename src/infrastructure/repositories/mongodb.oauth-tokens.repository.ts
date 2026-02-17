import { z } from "zod";
import { ObjectId } from "mongodb";
import { db } from "@/lib/mongodb";
import { OAuthToken, CreateOAuthTokenSchema } from "@/src/entities/models/oauth-token";

const DocSchema = OAuthToken.omit({ id: true });

export class MongoDBOAuthTokensRepository {
    private collection = db.collection<z.infer<typeof DocSchema>>('oauth_tokens');

    async create(data: z.infer<typeof CreateOAuthTokenSchema>): Promise<z.infer<typeof OAuthToken>> {
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

    async fetch(id: string): Promise<z.infer<typeof OAuthToken> | null> {
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

    async fetchByProjectAndProvider(
        projectId: string, 
        provider: 'slack' | 'atlassian'
    ): Promise<z.infer<typeof OAuthToken> | null> {
        const doc = await this.collection.findOne({ projectId, provider });
        if (!doc) return null;

        const { _id, ...rest } = doc;
        return {
            ...rest,
            id: _id.toString(),
        };
    }

    async update(
        id: string, 
        data: Partial<z.infer<typeof CreateOAuthTokenSchema>>
    ): Promise<z.infer<typeof OAuthToken>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $set: {
                    ...data,
                    updatedAt: new Date().toISOString(),
                },
            },
            { returnDocument: 'after' }
        );

        if (!result) {
            throw new Error('OAuth token not found');
        }

        const { _id, ...rest } = result;
        return {
            ...rest,
            id: _id.toString(),
        };
    }

    async delete(id: string): Promise<void> {
        await this.collection.deleteOne({ _id: new ObjectId(id) });
    }

    async deleteByProjectId(projectId: string): Promise<void> {
        await this.collection.deleteMany({ projectId });
    }

    async deleteByProjectAndProvider(
        projectId: string, 
        provider: 'slack' | 'atlassian'
    ): Promise<{ deletedCount: number }> {
        const result = await this.collection.deleteMany({ projectId, provider });
        return { deletedCount: result.deletedCount || 0 };
    }

    async findByProviderMetadata(
        provider: 'slack' | 'atlassian',
        metadataKey: string,
        metadataValue: string
    ): Promise<Array<z.infer<typeof OAuthToken>>> {
        const query = {
            provider,
            [`metadata.${metadataKey}`]: metadataValue,
        };

        const docs = await this.collection.find(query).toArray();
        
        return docs.map(doc => {
            const { _id, ...rest } = doc;
            return {
                ...rest,
                id: _id.toString(),
            };
        });
    }
}
