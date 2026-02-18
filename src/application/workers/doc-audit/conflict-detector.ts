/**
 * Conflict Detector v2
 * 
 * Uses claim extraction to find specific contradictions between documentation
 * and evidence from Slack/Jira. Instead of comparing entire pages, it extracts
 * verifiable claims and checks each one against recent activity.
 */

import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { PrefixLogger } from "@/lib/utils";
import { searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { MongoDBClaimsRepository } from "@/src/infrastructure/repositories/mongodb.claims.repository";
import { ClaimExtractor, ExtractedClaim } from "./claim-extractor";
import { RelationshipResolver } from "@/src/application/lib/knowledge/relationship-resolver";
import {
    AuditEvidenceType,
    CreateDocAuditFindingType,
} from "@/src/entities/models/doc-audit";

/**
 * Append a Confluence-style section anchor to a URL.
 * Confluence heading anchors use dashes for spaces and strip special chars.
 */
function appendConfluenceAnchor(url: string | undefined, section: string | undefined): string | undefined {
    if (!url || !section) return url;
    const anchor = section.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    return `${url}#${anchor}`;
}

export interface ConflictDetectorConfig {
    similarityThreshold: number;    // Min score to consider related (default 0.6)
    maxClaimsPerRun: number;        // Max claims to verify per run
}

export interface ConflictResult {
    findings: CreateDocAuditFindingType[];
    pagesScanned: number;
    claimsExtracted: number;
    claimsVerified: number;
}

const DEFAULT_CONFIG: ConflictDetectorConfig = {
    similarityThreshold: 0.4,
    maxClaimsPerRun: 200,
};

export class ConflictDetector {
    private knowledgeDocsRepo: MongoDBKnowledgeDocumentsRepository;
    private knowledgeEntitiesRepo: MongoDBKnowledgeEntitiesRepository;
    private claimsRepo: MongoDBClaimsRepository;
    private claimExtractor: ClaimExtractor;
    private relationshipResolver: RelationshipResolver;
    private logger: PrefixLogger;
    private config: ConflictDetectorConfig;

    constructor(
        knowledgeDocsRepo: MongoDBKnowledgeDocumentsRepository,
        knowledgeEntitiesRepo: MongoDBKnowledgeEntitiesRepository,
        logger: PrefixLogger,
        config: Partial<ConflictDetectorConfig> = {}
    ) {
        this.knowledgeDocsRepo = knowledgeDocsRepo;
        this.knowledgeEntitiesRepo = knowledgeEntitiesRepo;
        this.claimsRepo = new MongoDBClaimsRepository();
        this.claimExtractor = new ClaimExtractor(knowledgeDocsRepo, logger.child('extractor'));
        this.relationshipResolver = new RelationshipResolver(
            knowledgeEntitiesRepo,
            knowledgeDocsRepo,
            logger.child('resolver')
        );
        this.logger = logger;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Run conflict detection for a project.
     * Uses incremental claim extraction (skips unchanged pages) and
     * parallel verification (batches of 10).
     */
    async detect(projectId: string, auditRunId: string): Promise<ConflictResult> {
        this.logger.log(`Starting claim-based conflict detection for project ${projectId}`);

        // Step 1: Extract claims incrementally (skip unchanged pages)
        this.logger.log('Step 1: Extracting claims from Confluence pages (incremental)...');
        const existingHashes = await this.claimsRepo.getContentHashes(projectId);
        this.logger.log(`Found ${existingHashes.size} existing page hashes for incremental extraction`);

        const newClaims = await this.claimExtractor.extractAllClaims(projectId, existingHashes);

        // Store newly extracted claims (unchanged page claims remain in DB)
        if (newClaims.length > 0) {
            await this.claimsRepo.storeClaims(newClaims);
        }

        // Load ALL active claims (both new and previously extracted unchanged ones)
        const allClaims = await this.claimsRepo.getActiveClaims(projectId);
        this.logger.log(`Total active claims: ${allClaims.length} (${newClaims.length} newly extracted)`);

        // Step 2: Verify claims in PARALLEL batches of 10
        this.logger.log('Step 2: Verifying claims against Slack/Jira evidence (parallel batches of 10)...');
        const findings: CreateDocAuditFindingType[] = [];
        // Only verify claims that haven't been verified recently (event-driven handles the rest)
        const staleCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const staleClaims = allClaims.filter(c => !c.lastVerifiedAt || c.lastVerifiedAt < staleCutoff);
        const claimsToCheck = staleClaims.slice(0, this.config.maxClaimsPerRun);
        this.logger.log(`${staleClaims.length} stale claims (not verified in 24h), checking up to ${claimsToCheck.length}`);
        let verified = 0;
        const BATCH_SIZE = 10;

        for (let i = 0; i < claimsToCheck.length; i += BATCH_SIZE) {
            const batch = claimsToCheck.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(claim => this.verifyClaim(projectId, claim, auditRunId))
            );

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    findings.push(result.value);
                } else if (result.status === 'rejected') {
                    this.logger.log(`Claim verification failed: ${result.reason}`);
                }
                verified++;
            }

            if (i + BATCH_SIZE < claimsToCheck.length) {
                this.logger.log(`Verified ${Math.min(i + BATCH_SIZE, claimsToCheck.length)}/${claimsToCheck.length} claims...`);
            }
        }

        // Count unique pages scanned
        const uniquePages = new Set(allClaims.map(c => c.sourcePageId));

        this.logger.log(`Conflict detection complete. Found ${findings.length} conflicts from ${verified} claims across ${uniquePages.size} pages`);

        return {
            findings,
            pagesScanned: uniquePages.size,
            claimsExtracted: allClaims.length,
            claimsVerified: verified,
        };
    }

    /**
     * Verify a single claim against Slack/Jira evidence
     */
    private async verifyClaim(
        projectId: string,
        claim: ExtractedClaim,
        auditRunId: string
    ): Promise<CreateDocAuditFindingType | null> {
        // Search Slack and Jira in PARALLEL
        const [slackResults, jiraResults] = await Promise.all([
            searchKnowledgeEmbeddings(projectId, claim.claimText, { limit: 5, provider: 'slack' }, this.logger),
            searchKnowledgeEmbeddings(projectId, claim.claimText, { limit: 3, provider: 'jira' }, this.logger),
        ]);

        // Filter by similarity threshold
        const relevantSlack = slackResults.filter(r => r.score >= this.config.similarityThreshold);
        const relevantJira = jiraResults.filter(r => r.score >= this.config.similarityThreshold);

        if (relevantSlack.length === 0 && relevantJira.length === 0) {
            return null; // No related evidence found
        }

        // Build evidence for LLM comparison
        const evidenceItems: Array<{ provider: string; text: string; title: string; url?: string; timestamp?: string; documentId: string; sourceType: string }> = [];

        for (const r of relevantSlack) {
            evidenceItems.push({
                provider: 'slack',
                text: r.content,
                title: r.title,
                url: r.metadata?.url,
                timestamp: r.metadata?.sourceCreatedAt,
                documentId: r.documentId,
                sourceType: r.sourceType,
            });
        }
        for (const r of relevantJira) {
            evidenceItems.push({
                provider: 'jira',
                text: r.content,
                title: r.title,
                url: r.metadata?.url,
                timestamp: r.metadata?.sourceCreatedAt,
                documentId: r.documentId,
                sourceType: r.sourceType,
            });
        }

        // Ask LLM to compare the claim against each piece of evidence
        const contradictionResult = await this.llmCompareClaim(claim, evidenceItems);

        if (!contradictionResult || contradictionResult.verdict === 'confirmed') {
            return null; // No contradiction found
        }

        // Build audit evidence — append section anchor for the Confluence source page
        const auditEvidence: AuditEvidenceType[] = evidenceItems.map(e => ({
            provider: e.provider as 'slack' | 'jira' | 'confluence',
            sourceType: e.sourceType,
            documentId: e.documentId,
            title: e.title,
            url: e.url,
            excerpt: e.text.substring(0, 400),
            timestamp: e.timestamp,
        }));

        // Deep-link: if claim has a source section, add anchor to matching Confluence evidence
        if (claim.sourceSection && claim.sourcePageUrl) {
            for (const ev of auditEvidence) {
                if (ev.provider === 'confluence' && ev.url === claim.sourcePageUrl) {
                    ev.url = appendConfluenceAnchor(ev.url, claim.sourceSection);
                }
            }
        }

        // Resolve relevant people
        const relevantPeople = await this.relationshipResolver.resolveForEvidence(
            projectId,
            auditEvidence,
            claim.relatedEntityNames
        );

        // Also resolve people for the Confluence page
        if (claim.sourcePageId) {
            const pagePeople = await this.relationshipResolver.resolveForConfluencePage(
                projectId,
                claim.sourcePageId
            );
            // Merge without duplicates
            for (const pp of pagePeople) {
                if (!relevantPeople.some(rp => rp.entityId === pp.entityId)) {
                    relevantPeople.push(pp);
                }
            }
        }

        const now = new Date().toISOString();
        const findingType = contradictionResult.verdict === 'contradicted' ? 'contradiction'
            : contradictionResult.verdict === 'outdated' ? 'outdated'
            : 'missing_update';

        // Update claim status
        await this.claimsRepo.updateClaimStatus(
            projectId,
            claim.id,
            'contradicted',
            contradictionResult.explanation,
            contradictionResult.counterEvidence
        );

        return {
            projectId,
            type: findingType,
            severity: contradictionResult.severity as 'high' | 'medium' | 'low',
            status: 'pending',
            title: `${claim.sourcePageTitle}: ${contradictionResult.summary}`,
            description: `Claim: "${claim.claimText}"\n\nEvidence says: ${contradictionResult.counterEvidence}\n\n${contradictionResult.explanation}`,
            suggestedFix: contradictionResult.suggestedFix,
            evidence: auditEvidence,
            confluencePageId: claim.sourcePageId,
            confluencePageTitle: claim.sourcePageTitle,
            confluencePageUrl: claim.sourcePageUrl,
            relatedPersonIds: relevantPeople.map(p => p.entityId),
            relatedPersonSlackIds: relevantPeople.map(p => p.slackUserId),
            auditRunId,
            detectedAt: now,
            smartQuestions: [],
        };
    }

    /**
     * Use LLM to compare a claim against evidence
     */
    private async llmCompareClaim(
        claim: ExtractedClaim,
        evidenceItems: Array<{ provider: string; text: string; title: string; timestamp?: string }>
    ): Promise<{
        verdict: 'confirmed' | 'contradicted' | 'outdated' | 'needs_update';
        severity: string;
        summary: string;
        explanation: string;
        counterEvidence: string;
        suggestedFix?: string;
    } | null> {
        const evidenceText = evidenceItems.map((e, i) =>
            `[${e.provider.toUpperCase()}-${i + 1}] ${e.title}${e.timestamp ? ` (${e.timestamp})` : ''}\n${e.text}`
        ).join('\n\n---\n\n');

        try {
            const { object } = await generateObject({
                model: openai('gpt-4o-mini'),
                schema: z.object({
                    verdict: z.enum(['confirmed', 'contradicted', 'outdated', 'needs_update']).describe(
                        "confirmed=evidence agrees; contradicted=evidence directly disagrees; outdated=evidence shows newer info; needs_update=evidence has additional info not in doc"
                    ),
                    severity: z.enum(['high', 'medium', 'low']).describe("high=factually wrong and could cause problems; medium=out of date; low=minor gap"),
                    summary: z.string().describe("Short summary of the issue (max 80 chars)"),
                    explanation: z.string().describe("Detailed explanation of why this is a conflict"),
                    counterEvidence: z.string().describe("The specific evidence that contradicts the claim"),
                    suggestedFix: z.string().optional().describe("What the documentation should say instead"),
                }),
                system: `You are a documentation auditor. Compare a specific claim from a documentation page against evidence from team discussions (Slack) and project tracking (Jira).

RULES:
- A claim is "contradicted" if evidence disagrees with or corrects it
- A claim is "outdated" if more recent evidence shows the situation has changed (new numbers, new owners, new status, etc.)
- A claim "needs_update" if evidence has significant new info the doc doesn't cover, or if the doc is vague and evidence has specifics
- A claim is "confirmed" ONLY if the evidence clearly supports what the doc says with no newer or conflicting info
- If the doc says one thing and Slack/Jira says something different (even slightly), that counts as a conflict
- The counter-evidence should be a SPECIFIC quote or fact from the evidence
- Include the source reference (e.g. "In SLACK-2, Matt said...") in the counterEvidence field`,
                prompt: `CLAIM from documentation page "${claim.sourcePageTitle}":
"${claim.claimText}"

(Claim type: ${claim.claimType}, page last modified: ${claim.pageLastModified})

EVIDENCE FROM SLACK/JIRA:
${evidenceText}

Compare the claim against the evidence. Is it still accurate?`,
            });

            if (object.verdict === 'confirmed') return null;
            return object as {
                verdict: 'confirmed' | 'contradicted' | 'outdated' | 'needs_update';
                severity: string;
                summary: string;
                explanation: string;
                counterEvidence: string;
                suggestedFix?: string;
            };
        } catch (error) {
            this.logger.log(`LLM claim comparison error: ${error}`);
            return null;
        }
    }
}
