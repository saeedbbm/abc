/**
 * Claim Extractor
 * 
 * Extracts specific, verifiable claims from Confluence pages.
 * Claims are factual statements that can be checked against other sources.
 * 
 * Types of claims:
 * - factual: "PostgreSQL latency is 400ms"
 * - ownership: "Jake owns auth-cerberus"
 * - process: "Code freeze starts December 15"
 * - status: "The ML pipeline is in production"
 * - architecture: "Auth uses Keycloak for SSO"
 */

import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { createHash } from "crypto";
import { PrefixLogger } from "@/lib/utils";
import { KnowledgeDocumentType } from "@/src/entities/models/knowledge-document";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";

// Claim types
export const ClaimType = z.enum(['factual', 'ownership', 'process', 'status', 'architecture']);
export type ClaimTypeEnum = z.infer<typeof ClaimType>;

export const ClaimStatus = z.enum(['active', 'contradicted', 'stale', 'verified', 'unknown']);
export type ClaimStatusEnum = z.infer<typeof ClaimStatus>;

// A single extracted claim
export interface ExtractedClaim {
    id: string;
    projectId: string;
    claimText: string;
    claimType: ClaimTypeEnum;
    sourcePageId: string;           // Confluence page ID
    sourcePageTitle: string;
    sourcePageUrl: string;
    sourceSection: string;          // Which section of the page
    pageLastModified: string;       // When the source page was last updated
    relatedEntityNames: string[];   // Systems, people, projects referenced in the claim
    status: ClaimStatusEnum;
    contradictionEvidence?: string;
    contradictionSource?: string;
    extractedAt: string;
    lastVerifiedAt?: string;
}

// Schema for LLM extraction
const ExtractedClaimSchema = z.object({
    claims: z.array(z.object({
        text: z.string().describe("The exact claim/statement being made"),
        type: ClaimType.describe("Type of claim"),
        section: z.string().describe("Which section or heading this claim is from"),
        relatedEntities: z.array(z.string()).describe("Systems, people, projects mentioned in this claim"),
        importance: z.enum(['high', 'medium', 'low']).describe("How important is this claim to verify"),
    })),
});

export class ClaimExtractor {
    private docsRepo: MongoDBKnowledgeDocumentsRepository;
    private logger: PrefixLogger;

    constructor(docsRepo: MongoDBKnowledgeDocumentsRepository, logger?: PrefixLogger) {
        this.docsRepo = docsRepo;
        this.logger = logger || new PrefixLogger('claim-extractor');
    }

    /**
     * Compute a content hash for a page to detect changes
     */
    private contentHash(content: string): string {
        return createHash('md5').update(content).digest('hex');
    }

    /**
     * Extract claims from all Confluence pages in a project.
     * Uses content hashing to skip unchanged pages (incremental).
     */
    async extractAllClaims(
        projectId: string,
        existingHashMap?: Map<string, string> // pageId -> contentHash from previous claims
    ): Promise<ExtractedClaim[]> {
        this.logger.log(`Extracting claims for project ${projectId}`);

        const allClaims: ExtractedClaim[] = [];
        let skippedPages = 0;

        // Get all Confluence pages
        const confluencePages = await this.getConfluencePages(projectId);
        this.logger.log(`Found ${confluencePages.length} Confluence pages to extract claims from`);

        for (const page of confluencePages) {
            try {
                const pageMeta = page.metadata as Record<string, any>;
                const pageId = pageMeta.pageId || page.sourceId;
                const hash = this.contentHash(page.content);

                // Skip if content hasn't changed since last extraction
                if (existingHashMap && existingHashMap.get(pageId) === hash) {
                    skippedPages++;
                    continue;
                }

                const pageClaims = await this.extractFromPage(projectId, page);
                // Tag each claim with the content hash for future incremental runs
                for (const c of pageClaims) {
                    (c as any).contentHash = hash;
                }
                allClaims.push(...pageClaims);
            } catch (error) {
                this.logger.log(`Error extracting claims from "${page.title}": ${error}`);
            }
        }

        this.logger.log(`Extracted ${allClaims.length} claims from ${confluencePages.length - skippedPages} pages (${skippedPages} skipped — unchanged)`);
        return allClaims;
    }

    /**
     * Extract claims from a single Confluence page
     */
    async extractFromPage(
        projectId: string,
        page: KnowledgeDocumentType
    ): Promise<ExtractedClaim[]> {
        // Skip very short pages
        if (page.content.length < 100) return [];

        const pageMeta = page.metadata as Record<string, any>;
        const pageId = pageMeta.pageId || page.sourceId;
        const pageUrl = pageMeta.webUrl || '';
        const pageLastModified = page.sourceUpdatedAt || page.syncedAt;

        try {
            const { object } = await generateObject({
                model: openai('gpt-4o-mini'),
                schema: ExtractedClaimSchema,
                system: `You are a fact extractor. Your job is to extract specific, verifiable claims from documentation.

EXTRACT:
- Specific numbers, metrics, SLAs (e.g., "latency is 400ms", "uptime is 99.9%")
- Ownership statements (e.g., "Jake manages the auth service", "Team X owns billing")
- Process details (e.g., "code freeze is Dec 15", "deploys happen on Tuesdays")
- Status statements (e.g., "ML pipeline is in production", "feature X is deprecated")  
- Architecture facts (e.g., "auth uses Keycloak", "data stored in PostgreSQL")

DO NOT EXTRACT:
- Opinions or subjective statements
- Generic descriptions that can't be verified
- Very obvious/trivial facts
- Marketing language

Be PRECISE. Extract the claim EXACTLY as stated in the document.`,
                prompt: `Extract verifiable claims from this documentation page:

TITLE: "${page.title}"
---
${page.content.substring(0, 4000)}
---`,
            });

            return object.claims.map((claim, i) => ({
                id: `${pageId}:claim:${i}`,
                projectId,
                claimText: claim.text,
                claimType: claim.type,
                sourcePageId: pageId,
                sourcePageTitle: page.title,
                sourcePageUrl: pageUrl,
                sourceSection: claim.section,
                pageLastModified,
                relatedEntityNames: claim.relatedEntities,
                status: 'active' as const,
                extractedAt: new Date().toISOString(),
            }));
        } catch (error) {
            this.logger.log(`LLM claim extraction error for "${page.title}": ${error}`);
            return [];
        }
    }

    private async getConfluencePages(projectId: string): Promise<KnowledgeDocumentType[]> {
        const allPages: KnowledgeDocumentType[] = [];
        let cursor: string | undefined;

        do {
            const result = await this.docsRepo.findByProjectId(projectId, {
                provider: 'confluence',
                sourceType: 'confluence_page',
                limit: 100,
                cursor,
            });
            allPages.push(...result.items);
            cursor = result.nextCursor;
        } while (cursor);

        return allPages;
    }
}
