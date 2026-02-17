import { db } from "@/lib/mongodb";
import { Project } from "@/src/entities/models/project";
import { z } from "zod";

const docSchema = Project
    .omit({
        id: true,
    })
    .extend({
        _id: z.string().uuid(),
    });

export class MongoDBProjectsRepository {
    private collection = db.collection<z.infer<typeof docSchema>>('projects');

    async create(data: {
        name: string;
        createdByUserId: string;
        secret: string;
        companySlug?: string;
    }): Promise<z.infer<typeof Project>> {
        const now = new Date();
        const id = crypto.randomUUID();

        const doc = {
            ...data,
            createdAt: now.toISOString(),
        };
        await this.collection.insertOne({
            ...doc,
            _id: id,
        });
        return {
            ...doc,
            id,
        };
    }

    async fetch(id: string): Promise<z.infer<typeof Project> | null> {
        const doc = await this.collection.findOne({ _id: id });
        if (!doc) {
            return null;
        }
        const { _id, ...rest } = doc;
        return {
            ...rest,
            id,
        };
    }

    async countCreatedProjects(createdByUserId: string): Promise<number> {
        return await this.collection.countDocuments({ createdByUserId });
    }

    async updateSecret(projectId: string, secret: string): Promise<z.infer<typeof Project>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    secret,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new Error('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async updateWebhookUrl(projectId: string, url: string): Promise<z.infer<typeof Project>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    webhookUrl: url,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new Error('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async updateName(projectId: string, name: string): Promise<z.infer<typeof Project>> {
        const result = await this.collection.findOneAndUpdate(
            { _id: projectId },
            {
                $set: {
                    name,
                    lastUpdatedAt: new Date().toISOString(),
                }
            },
            { returnDocument: 'after' }
        );
        if (!result) {
            throw new Error('Project not found');
        }
        const { _id, ...rest } = result;
        return { ...rest, id: _id };
    }

    async delete(projectId: string): Promise<boolean> {
        const result = await this.collection.deleteOne({ _id: projectId });
        return result.deletedCount > 0;
    }
}
