/**
 * Event-Driven Claim Matcher
 * 
 * When new data is ingested (via webhook or sync), this module
 * searches for existing claims that might be affected by the new data,
 * then triggers targeted LLM re-verification only for those claims.
 * 
 * This replaces the batch "verify 200 random claims" approach with
 * targeted, event-driven verification.
 */

import { generateObject } from "ai";
import { getPrimaryModel } from "@/lib/ai-model";
import { z } from "zod";
import { PrefixLogger } from "@/lib/utils";
import { searchKnowledgeEmbeddings } from "./embedding-service";
import { MongoDBClaimsRepository, ExtractedClaim } from "@/src/infrastructure/repositories/mongodb.claims.repository";
import { MongoDBDocAuditFindingsRepository } from "@/src/infrastructure/repositories/mongodb.doc-audit.repository";

const claimsRepo = new MongoDBClaimsRepository();
const findingsRepo = new MongoDBDocAuditFindingsRepository();
const logger = new PrefixLogger('claim-matcher');

const SIMILARITY_THRESHOLD = 0.55;
const MAX_CLAIMS_TO_CHECK = 5;
const SKIP_IF_VERIFIED_WITHIN_MS = 60 * 60 * 1000; // 1 hour

interface MatchResult {
    claimsChecked: number;
    conflictsFound: number;
    errors: number;
}

/**
 * After a document is embedded, check if any existing claims
 * are affected by the new/updated content.
 */
export async function matchAndVerifyClaims(
    projectId: string,
    document: { id: string; content: string; provider: string; sourceType: string; title: string; sourceId: string }
): Promise<MatchResult> {
    const result: MatchResult = { claimsChecked: 0, conflictsFound: 0, errors: 0 };

    try {
        if (!document.content || document.content.trim().length < 30) {
            return result;
        }

        // Search for claims whose text is semantically similar to the new document content
        // We search the claims collection in MongoDB since we can't do vector search on claims
        // Instead, use the new document's content to search Qdrant for related Confluence content,
        // then find claims from those Confluence pages
        const allActiveClaims = await claimsRepo.getActiveClaims(projectId);
        if (allActiveClaims.length === 0) {
            return result;
        }

        // Find claims that mention similar topics by embedding the new content
        // and checking which claims' text overlaps semantically
        const relatedResults = await searchKnowledgeEmbeddings(
            projectId,
            document.content.substring(0, 500), // Use first 500 chars as query
            { limit: 10, provider: 'confluence' },
            logger
        );

        if (relatedResults.length === 0) {
            return result;
        }

        // Find claims from the related Confluence pages
        const relatedPageIds = new Set(relatedResults.map(r => r.metadata?.sourceId || r.documentId));
        const affectedClaims = allActiveClaims.filter(claim => {
            // Check if claim is from a related page
            if (relatedPageIds.has(claim.sourcePageId)) return true;
            // Also check if claim text has keyword overlap with document content
            const docWords = new Set(document.content.toLowerCase().split(/\s+/).filter(w => w.length > 4));
            const claimWords = claim.claimText.toLowerCase().split(/\s+/).filter(w => w.length > 4);
            const overlap = claimWords.filter(w => docWords.has(w)).length;
            return overlap >= 2; // At least 2 meaningful words in common
        }).slice(0, MAX_CLAIMS_TO_CHECK);

        if (affectedClaims.length === 0) {
            return result;
        }

        logger.log(`Found ${affectedClaims.length} claims potentially affected by ${document.provider}/${document.sourceType} "${document.title}"`);

        // Verify each affected claim
        for (const claim of affectedClaims) {
            // Skip if recently verified
            if (claim.lastVerifiedAt) {
                const lastVerified = new Date(claim.lastVerifiedAt).getTime();
                if (Date.now() - lastVerified < SKIP_IF_VERIFIED_WITHIN_MS) {
                    continue;
                }
            }

            result.claimsChecked++;

            try {
                const verdict = await verifyClaimAgainstNewData(claim, document);
                if (verdict && verdict.verdict !== 'confirmed') {
                    result.conflictsFound++;

                    // Create a finding
                    await findingsRepo.createFinding({
                        projectId,
                        type: verdict.verdict === 'contradicted' ? 'contradiction' : 'outdated',
                        severity: verdict.severity as 'high' | 'medium' | 'low',
                        status: 'pending',
                        title: `${claim.sourcePageTitle}: ${verdict.summary}`,
                        description: `Claim: "${claim.claimText}"\n\nNew evidence from ${document.provider}: ${verdict.counterEvidence}\n\n${verdict.explanation}`,
                        suggestedFix: verdict.suggestedFix,
                        evidence: [{
                            provider: document.provider as any,
                            sourceType: document.sourceType,
                            documentId: document.id,
                            title: document.title,
                            excerpt: document.content.substring(0, 400),
                            timestamp: new Date().toISOString(),
                        }],
                        confluencePageId: claim.sourcePageId,
                        confluencePageTitle: claim.sourcePageTitle,
                        confluencePageUrl: claim.sourcePageUrl,
                        relatedPersonIds: [],
                        relatedPersonSlackIds: [],
                        auditRunId: `event-${Date.now()}`,
                        detectedAt: new Date().toISOString(),
                        smartQuestions: [],
                    });

                    // Update claim status
                    await claimsRepo.updateClaimStatus(
                        projectId,
                        claim.id,
                        'contradicted',
                        verdict.counterEvidence,
                        `${document.provider}:${document.sourceId}`
                    );

                    logger.log(`Conflict found: "${claim.claimText}" contradicted by "${document.title}"`);
                }
            } catch (err) {
                result.errors++;
                logger.log(`Error verifying claim "${claim.claimText}": ${err}`);
            }
        }

        logger.log(`Claim matching complete: ${result.claimsChecked} checked, ${result.conflictsFound} conflicts`);
    } catch (err) {
        logger.log(`matchAndVerifyClaims error: ${err}`);
        result.errors++;
    }

    return result;
}

/**
 * Use LLM to compare a claim against new evidence from a single document.
 */
async function verifyClaimAgainstNewData(
    claim: ExtractedClaim,
    document: { content: string; provider: string; title: string }
): Promise<{
    verdict: 'confirmed' | 'contradicted' | 'outdated' | 'needs_update';
    severity: string;
    summary: string;
    explanation: string;
    counterEvidence: string;
    suggestedFix?: string;
} | null> {
    try {
        const { object } = await generateObject({
            model: getPrimaryModel(),
            schema: z.object({
                verdict: z.enum(['confirmed', 'contradicted', 'outdated', 'needs_update']).describe(
                    "confirmed=evidence agrees; contradicted=evidence directly disagrees; outdated=evidence shows newer info; needs_update=evidence has additional info not in doc"
                ),
                severity: z.enum(['high', 'medium', 'low']),
                summary: z.string().describe("Short summary of the issue (max 80 chars)"),
                explanation: z.string(),
                counterEvidence: z.string().describe("The specific evidence that contradicts the claim"),
                suggestedFix: z.string().optional(),
            }),
            system: `You are a documentation auditor. Compare a claim from a documentation page against new evidence. 
Only flag real contradictions — if the evidence is unrelated, say "confirmed".
Be precise about what specifically changed or contradicts.`,
            prompt: `CLAIM from "${claim.sourcePageTitle}" (type: ${claim.claimType}):
"${claim.claimText}"

NEW EVIDENCE from ${document.provider} — "${document.title}":
${document.content.substring(0, 1500)}

Does this new evidence contradict, update, or confirm the claim?`,
        });

        return object as {
            verdict: 'confirmed' | 'contradicted' | 'outdated' | 'needs_update';
            severity: string;
            summary: string;
            explanation: string;
            counterEvidence: string;
            suggestedFix?: string;
        };
    } catch (error) {
        logger.log(`LLM claim verification error: ${error}`);
        return null;
    }
}
