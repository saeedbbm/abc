/**
 * Critic Agent — Quality Gate for KB Pages
 * 
 * Before a generated KB page reaches human reviewers, the critic checks:
 * 1. Citation coverage — does every paragraph have evidence?
 * 2. Evidence quality — does the evidence actually support the claims?
 * 3. Conflict check — does any paragraph contradict verified claims?
 * 
 * Output: a score (0-100) and a list of issues.
 * If score < 60, the page is sent back to the drafter with feedback.
 */

import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { PrefixLogger } from "@/lib/utils";
import { MongoDBClaimsRepository, ExtractedClaim } from "@/src/infrastructure/repositories/mongodb.claims.repository";

const logger = new PrefixLogger('critic-agent');

export interface CriticIssue {
    type: 'uncited' | 'weak-evidence' | 'contradicts-claim' | 'vague' | 'hallucination';
    paragraphIndex: number;
    paragraphText: string;
    detail: string;
    severity: 'high' | 'medium' | 'low';
}

export interface CriticResult {
    score: number;           // 0-100
    issues: CriticIssue[];
    summary: string;
    passesThreshold: boolean; // score >= 60
}

/**
 * Review a generated KB page before human review.
 */
export async function criticReview(
    html: string,
    evidence: Array<{ provider: string; title: string; excerpt: string; url?: string }>,
    projectId: string,
    pageTitle: string
): Promise<CriticResult> {
    const claimsRepo = new MongoDBClaimsRepository();
    const issues: CriticIssue[] = [];

    // Extract paragraphs from the HTML
    const paragraphs = extractParagraphs(html);
    if (paragraphs.length === 0) {
        return { score: 50, issues: [], summary: 'No paragraphs found in content', passesThreshold: false };
    }

    // 1. Citation Coverage — check which paragraphs reference evidence
    const evidenceTexts = evidence.map(e => `${e.title}: ${e.excerpt}`).join('\n\n');
    const citationCoverage = checkCitationCoverage(paragraphs, html);
    for (const uncited of citationCoverage.uncitedParagraphs) {
        issues.push({
            type: 'uncited',
            paragraphIndex: uncited.index,
            paragraphText: uncited.text.substring(0, 100),
            detail: 'This paragraph has no citation or source reference.',
            severity: 'medium',
        });
    }

    // 2. Evidence Quality — use LLM to check if evidence supports claims
    try {
        const qualityResult = await checkEvidenceQuality(paragraphs, evidenceTexts, pageTitle);
        for (const issue of qualityResult) {
            issues.push(issue);
        }
    } catch (err) {
        logger.log(`Evidence quality check failed: ${err}`);
    }

    // 3. Conflict check against verified claims
    try {
        const verifiedClaims = await claimsRepo.getActiveClaims(projectId);
        const humanVerified = verifiedClaims.filter(c => c.status === 'verified');
        if (humanVerified.length > 0) {
            const conflictIssues = await checkAgainstClaims(paragraphs, humanVerified, pageTitle);
            for (const issue of conflictIssues) {
                issues.push(issue);
            }
        }
    } catch (err) {
        logger.log(`Claim conflict check failed: ${err}`);
    }

    // Calculate score
    const totalParagraphs = paragraphs.length;
    const highIssues = issues.filter(i => i.severity === 'high').length;
    const mediumIssues = issues.filter(i => i.severity === 'medium').length;
    const lowIssues = issues.filter(i => i.severity === 'low').length;

    // Scoring: start at 100, deduct per issue
    let score = 100;
    score -= highIssues * 15;
    score -= mediumIssues * 8;
    score -= lowIssues * 3;

    // Citation coverage bonus/penalty
    const citationRate = citationCoverage.citedCount / Math.max(totalParagraphs, 1);
    if (citationRate < 0.3) score -= 20;
    else if (citationRate < 0.5) score -= 10;
    else if (citationRate > 0.8) score += 5;

    score = Math.max(0, Math.min(100, score));

    const summary = `Score: ${score}/100. ${issues.length} issues found (${highIssues} high, ${mediumIssues} medium, ${lowIssues} low). Citation coverage: ${Math.round(citationRate * 100)}%.`;

    logger.log(`Critic review for "${pageTitle}": ${summary}`);

    return {
        score,
        issues,
        summary,
        passesThreshold: score >= 60,
    };
}

/**
 * Extract paragraphs from HTML content.
 */
function extractParagraphs(html: string): Array<{ index: number; text: string }> {
    const paragraphs: Array<{ index: number; text: string }> = [];
    const regex = /<p[^>]*>([\s\S]*?)<\/p>/g;
    let match;
    let index = 0;

    while ((match = regex.exec(html)) !== null) {
        const text = match[1].replace(/<[^>]+>/g, '').trim();
        if (text.length >= 20) { // Skip very short paragraphs (labels etc.)
            paragraphs.push({ index, text });
        }
        index++;
    }

    return paragraphs;
}

/**
 * Check which paragraphs have citations (links, source references).
 */
function checkCitationCoverage(paragraphs: Array<{ index: number; text: string }>, html: string) {
    const citedIndices = new Set<number>();

    // Check for data-review-id spans with source references
    const reviewSpans = html.match(/<span[^>]*data-review-id[^>]*>[\s\S]*?<\/span>/g) || [];

    // Check for <a> tags (citations/source links) near paragraphs
    const paragraphsInHtml = html.match(/<p[^>]*>[\s\S]*?<\/p>/g) || [];
    for (let i = 0; i < paragraphsInHtml.length; i++) {
        const p = paragraphsInHtml[i];
        if (p.includes('<a ') || p.includes('Source:') || p.includes('data-source') || p.includes('href=')) {
            citedIndices.add(i);
        }
    }

    const uncitedParagraphs = paragraphs.filter(p => !citedIndices.has(p.index));

    return {
        citedCount: citedIndices.size,
        uncitedParagraphs,
    };
}

/**
 * Use LLM to check if the evidence actually supports the generated content.
 */
async function checkEvidenceQuality(
    paragraphs: Array<{ index: number; text: string }>,
    evidenceTexts: string,
    pageTitle: string
): Promise<CriticIssue[]> {
    // Only check a sample of paragraphs to control cost
    const sampleSize = Math.min(paragraphs.length, 5);
    const sample = paragraphs.slice(0, sampleSize);
    const issues: CriticIssue[] = [];

    try {
        const { object } = await generateObject({
            model: openai('gpt-4o-mini'),
            schema: z.object({
                paragraphReviews: z.array(z.object({
                    paragraphIndex: z.number(),
                    supported: z.boolean().describe('Is this paragraph supported by the evidence?'),
                    issue: z.string().optional().describe('If not supported, what is the problem?'),
                    severity: z.enum(['high', 'medium', 'low']),
                })),
            }),
            system: `You are a documentation quality reviewer. For each paragraph, determine if it is supported by the provided evidence. Flag paragraphs that:
- Make claims not found in any evidence (hallucination)
- Twist or exaggerate what the evidence says
- Are too vague to be useful
Only flag actual problems. If a paragraph is a reasonable summary/synthesis of the evidence, mark it as supported.`,
            prompt: `Page title: "${pageTitle}"

PARAGRAPHS TO REVIEW:
${sample.map((p, i) => `[${p.index}] ${p.text}`).join('\n\n')}

AVAILABLE EVIDENCE:
${evidenceTexts.substring(0, 3000)}

For each paragraph, is it well-supported by the evidence?`,
        });

        for (const review of object.paragraphReviews) {
            if (!review.supported && review.issue) {
                issues.push({
                    type: review.issue.toLowerCase().includes('hallucin') ? 'hallucination' : 'weak-evidence',
                    paragraphIndex: review.paragraphIndex,
                    paragraphText: sample.find(p => p.index === review.paragraphIndex)?.text.substring(0, 100) || '',
                    detail: review.issue,
                    severity: review.severity,
                });
            }
        }
    } catch (err) {
        logger.log(`Evidence quality LLM call failed: ${err}`);
    }

    return issues;
}

/**
 * Check if any generated paragraphs contradict verified claims.
 */
async function checkAgainstClaims(
    paragraphs: Array<{ index: number; text: string }>,
    verifiedClaims: ExtractedClaim[],
    pageTitle: string
): Promise<CriticIssue[]> {
    const issues: CriticIssue[] = [];

    // Only check if we have a reasonable number of claims
    if (verifiedClaims.length === 0 || verifiedClaims.length > 100) {
        return issues;
    }

    const claimsSummary = verifiedClaims
        .slice(0, 30)
        .map(c => `- ${c.claimText} (from: ${c.sourcePageTitle}, status: ${c.status})`)
        .join('\n');

    const paragraphText = paragraphs
        .slice(0, 5)
        .map(p => `[${p.index}] ${p.text}`)
        .join('\n\n');

    try {
        const { object } = await generateObject({
            model: openai('gpt-4o-mini'),
            schema: z.object({
                conflicts: z.array(z.object({
                    paragraphIndex: z.number(),
                    claimText: z.string(),
                    explanation: z.string(),
                })),
            }),
            system: `You are a fact-checker. Compare generated paragraphs against verified claims. Only flag REAL contradictions — if a paragraph says something different from a verified claim, that's a conflict.`,
            prompt: `GENERATED PARAGRAPHS (page: "${pageTitle}"):
${paragraphText}

VERIFIED CLAIMS (human-confirmed facts):
${claimsSummary}

Are any paragraphs contradicting the verified claims?`,
        });

        for (const conflict of object.conflicts) {
            issues.push({
                type: 'contradicts-claim',
                paragraphIndex: conflict.paragraphIndex,
                paragraphText: paragraphs.find(p => p.index === conflict.paragraphIndex)?.text.substring(0, 100) || '',
                detail: `Contradicts verified claim: "${conflict.claimText}" — ${conflict.explanation}`,
                severity: 'high',
            });
        }
    } catch (err) {
        logger.log(`Claims conflict check LLM call failed: ${err}`);
    }

    return issues;
}
