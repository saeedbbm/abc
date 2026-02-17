/**
 * MongoDB Claims Repository
 * 
 * Stores and queries extracted claims from Confluence pages.
 * Used by the conflict detector to find contradictions.
 */

import { Collection, ObjectId } from "mongodb";
import { db } from "@/lib/mongodb";
import { z } from "zod";

const COLLECTION_NAME = "doc_audit_claims";

// Claim types (defined locally instead of importing from worker)
export const ClaimType = z.enum(['factual', 'ownership', 'process', 'status', 'architecture']);
export type ClaimTypeEnum = z.infer<typeof ClaimType>;

export const ClaimStatus = z.enum(['active', 'contradicted', 'stale', 'verified', 'unknown']);
export type ClaimStatusEnum = z.infer<typeof ClaimStatus>;

export interface ExtractedClaim {
    id: string;
    projectId: string;
    claimText: string;
    claimType: ClaimTypeEnum;
    sourcePageId: string;
    sourcePageTitle: string;
    sourcePageUrl: string;
    sourceSection: string;
    pageLastModified: string;
    relatedEntityNames: string[];
    status: ClaimStatusEnum;
    contradictionEvidence?: string;
    contradictionSource?: string;
    extractedAt: string;
    lastVerifiedAt?: string;
}

export class MongoDBClaimsRepository {
    private getCollection(): Collection {
        return db.collection(COLLECTION_NAME);
    }

    /**
     * Store claims for a project (replaces existing claims for the same page)
     */
    async storeClaims(claims: ExtractedClaim[]): Promise<void> {
        if (claims.length === 0) return;
        const collection = this.getCollection();

        // Group by page to do batch replacements
        const byPage = new Map<string, ExtractedClaim[]>();
        for (const claim of claims) {
            const pageId = claim.sourcePageId;
            if (!byPage.has(pageId)) byPage.set(pageId, []);
            byPage.get(pageId)!.push(claim);
        }

        for (const [pageId, pageClaims] of byPage) {
            // Delete old claims for this page
            await collection.deleteMany({
                projectId: pageClaims[0].projectId,
                sourcePageId: pageId,
            });

            // Insert new claims
            await collection.insertMany(pageClaims.map(c => ({
                ...c,
                _id: new ObjectId(),
            })));
        }
    }

    /**
     * Get all active claims for a project
     */
    async getActiveClaims(projectId: string): Promise<ExtractedClaim[]> {
        const collection = this.getCollection();
        const docs = await collection.find({
            projectId,
            status: { $in: ['active', 'unknown'] },
        }).toArray();

        return docs.map(d => ({
            id: d.id || d._id.toString(),
            projectId: d.projectId,
            claimText: d.claimText,
            claimType: d.claimType,
            sourcePageId: d.sourcePageId,
            sourcePageTitle: d.sourcePageTitle,
            sourcePageUrl: d.sourcePageUrl,
            sourceSection: d.sourceSection,
            pageLastModified: d.pageLastModified,
            relatedEntityNames: d.relatedEntityNames || [],
            status: d.status,
            contradictionEvidence: d.contradictionEvidence,
            contradictionSource: d.contradictionSource,
            extractedAt: d.extractedAt,
            lastVerifiedAt: d.lastVerifiedAt,
        }));
    }

    /**
     * Get claims by related entity name
     */
    async getClaimsByEntity(projectId: string, entityName: string): Promise<ExtractedClaim[]> {
        const collection = this.getCollection();
        const docs = await collection.find({
            projectId,
            relatedEntityNames: { $regex: new RegExp(entityName, 'i') },
        }).toArray();

        return docs.map(d => ({
            id: d.id || d._id.toString(),
            projectId: d.projectId,
            claimText: d.claimText,
            claimType: d.claimType,
            sourcePageId: d.sourcePageId,
            sourcePageTitle: d.sourcePageTitle,
            sourcePageUrl: d.sourcePageUrl,
            sourceSection: d.sourceSection,
            pageLastModified: d.pageLastModified,
            relatedEntityNames: d.relatedEntityNames || [],
            status: d.status,
            contradictionEvidence: d.contradictionEvidence,
            contradictionSource: d.contradictionSource,
            extractedAt: d.extractedAt,
            lastVerifiedAt: d.lastVerifiedAt,
        }));
    }

    /**
     * Update claim status
     */
    async updateClaimStatus(
        projectId: string,
        claimId: string,
        status: string,
        evidence?: string,
        source?: string
    ): Promise<void> {
        const collection = this.getCollection();
        await collection.updateOne(
            { projectId, id: claimId },
            {
                $set: {
                    status,
                    ...(evidence ? { contradictionEvidence: evidence } : {}),
                    ...(source ? { contradictionSource: source } : {}),
                    lastVerifiedAt: new Date().toISOString(),
                },
            }
        );
    }

    /**
     * Get content hashes for all pages that have claims (for incremental extraction)
     * Returns Map<pageId, contentHash>
     */
    async getContentHashes(projectId: string): Promise<Map<string, string>> {
        const collection = this.getCollection();
        const docs = await collection.aggregate([
            { $match: { projectId, contentHash: { $exists: true } } },
            { $group: { _id: '$sourcePageId', hash: { $first: '$contentHash' } } },
        ]).toArray();

        const map = new Map<string, string>();
        for (const d of docs) {
            if (d._id && d.hash) map.set(d._id, d.hash);
        }
        return map;
    }

    /**
     * Delete all claims for a project
     */
    async deleteByProject(projectId: string): Promise<void> {
        const collection = this.getCollection();
        await collection.deleteMany({ projectId });
    }
}
