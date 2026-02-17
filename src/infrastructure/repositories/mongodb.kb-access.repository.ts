/**
 * MongoDB KB Access Repositories
 * 
 * Handles persistence for KB memberships (user <-> company role)
 * and per-page permission overrides.
 */

import { ObjectId, WithId } from "mongodb";
import { db } from "@/lib/mongodb";
import {
    KBMembershipType,
    CreateKBMembershipType,
    KBPagePermissionType,
    CreateKBPagePermissionType,
    KBRoleType,
} from "@/src/entities/models/kb-access";

type MembershipDoc = Omit<KBMembershipType, 'id'>;
type PagePermDoc = Omit<KBPagePermissionType, 'id'>;

// ------------------------------------------------------------------
// Membership Repository
// ------------------------------------------------------------------

export class KBMembershipRepository {
    private collection = db.collection<MembershipDoc>('kb_memberships');

    private toEntity(doc: WithId<MembershipDoc>): KBMembershipType {
        const { _id, ...rest } = doc;
        return { ...rest, id: _id.toString() };
    }

    async findByUserAndProject(userId: string, projectId: string): Promise<KBMembershipType | null> {
        const doc = await this.collection.findOne({ userId, projectId });
        return doc ? this.toEntity(doc) : null;
    }

    async findByEmailAndProject(email: string, projectId: string): Promise<KBMembershipType | null> {
        const doc = await this.collection.findOne({ userEmail: email.toLowerCase(), projectId });
        return doc ? this.toEntity(doc) : null;
    }

    async listByProject(projectId: string): Promise<KBMembershipType[]> {
        const docs = await this.collection.find({ projectId }).sort({ createdAt: -1 }).toArray();
        return docs.map(d => this.toEntity(d));
    }

    async create(data: CreateKBMembershipType): Promise<KBMembershipType> {
        const now = new Date().toISOString();
        const doc: MembershipDoc = {
            ...data,
            userEmail: data.userEmail.toLowerCase(),
            createdAt: now,
            updatedAt: now,
        };
        const result = await this.collection.insertOne(doc);
        return { ...doc, id: result.insertedId.toString() };
    }

    async updateRole(id: string, role: KBRoleType): Promise<KBMembershipType | null> {
        const result = await this.collection.findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: { role, updatedAt: new Date().toISOString() } },
            { returnDocument: 'after' }
        );
        return result ? this.toEntity(result) : null;
    }

    async delete(id: string): Promise<boolean> {
        const result = await this.collection.deleteOne({ _id: new ObjectId(id) });
        return result.deletedCount > 0;
    }

    async deleteByProject(projectId: string): Promise<number> {
        const result = await this.collection.deleteMany({ projectId });
        return result.deletedCount;
    }
}

// ------------------------------------------------------------------
// Page Permission Repository
// ------------------------------------------------------------------

export class KBPagePermissionRepository {
    private collection = db.collection<PagePermDoc>('kb_page_permissions');

    private toEntity(doc: WithId<PagePermDoc>): KBPagePermissionType {
        const { _id, ...rest } = doc;
        return { ...rest, id: _id.toString() };
    }

    async findByPageAndUser(pageId: string, userId: string): Promise<KBPagePermissionType | null> {
        const doc = await this.collection.findOne({ pageId, userId });
        return doc ? this.toEntity(doc) : null;
    }

    async listByPage(pageId: string): Promise<KBPagePermissionType[]> {
        const docs = await this.collection.find({ pageId }).toArray();
        return docs.map(d => this.toEntity(d));
    }

    async listByUser(userId: string, projectId?: string): Promise<KBPagePermissionType[]> {
        const filter: Record<string, any> = { userId };
        const docs = await this.collection.find(filter).toArray();
        return docs.map(d => this.toEntity(d));
    }

    /** Get all page IDs that a user is explicitly denied access to */
    async getDeniedPageIds(userId: string): Promise<string[]> {
        const docs = await this.collection.find({ userId, access: 'none' }).toArray();
        return docs.map(d => d.pageId);
    }

    async upsert(data: CreateKBPagePermissionType): Promise<KBPagePermissionType> {
        const now = new Date().toISOString();
        const result = await this.collection.findOneAndUpdate(
            { pageId: data.pageId, userId: data.userId },
            {
                $set: {
                    access: data.access,
                    grantedBy: data.grantedBy,
                    userEmail: data.userEmail.toLowerCase(),
                },
                $setOnInsert: { createdAt: now },
            },
            { upsert: true, returnDocument: 'after' }
        );
        return this.toEntity(result!);
    }

    async delete(id: string): Promise<boolean> {
        const result = await this.collection.deleteOne({ _id: new ObjectId(id) });
        return result.deletedCount > 0;
    }

    async deleteByPage(pageId: string): Promise<number> {
        const result = await this.collection.deleteMany({ pageId });
        return result.deletedCount;
    }
}
