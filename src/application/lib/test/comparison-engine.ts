import { z } from "zod";
import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { structuredGenerate } from "@/src/application/workers/test/structured-generate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatchDetail {
    generatedIndex: number;
    groundTruthIndex: number | null;
    classification: 'TP' | 'FP' | 'FN';
    similarityScore: number;
    fieldScores: Record<string, number>;
    matchReason: string;
}

export interface CategoryAnalysis {
    category: 'gaps' | 'tickets' | 'howto' | 'conflicts' | 'outdated';
    totalGenerated: number;
    totalGroundTruth: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
    f1Score: number;
    avgFieldScore: number;
    matchDetails: MatchDetail[];
}

export interface FullAnalysis {
    categories: CategoryAnalysis[];
    overallPrecision: number;
    overallRecall: number;
    overallF1: number;
    analyzedAt: string;
}

export interface GroundTruth {
    gaps: string;
    tickets: string;
    howto: string;
    conflicts: string;
    outdated: string;
}

interface ParsedItem {
    title: string;
    content: string;
}

// ---------------------------------------------------------------------------
// Zod schemas for structured LLM responses
// ---------------------------------------------------------------------------

const ParsedItemsSchema = z.object({
    items: z.array(z.object({
        title: z.string().describe("Short identifying name for this item"),
        content: z.string().describe("Full text/description of this item"),
    })),
});

const BatchMatchSchema = z.object({
    matches: z.array(z.object({
        generatedIndex: z.number().describe("0-based index of the generated item"),
        bestGroundTruthIndex: z.number().nullable().describe("0-based index of the best-matching ground truth item, or null if no match"),
        similarityScore: z.number().describe("How well the generated item matches the ground truth item (0=no match, 1=perfect)"),
        matchReason: z.string().describe("Brief explanation of why this match was or was not made"),
        fieldScores: z.array(z.object({
            field: z.string().describe("Field name (e.g. title, severity, description)"),
            score: z.number().describe("Quality score 0-1 for this field"),
        })).describe("Per-field quality scores for TP matches. Empty array for FP items."),
    })),
});

// ---------------------------------------------------------------------------
// Category config: how to extract title/content from each result type
// ---------------------------------------------------------------------------

type CategoryKey = 'gaps' | 'tickets' | 'howto' | 'conflicts' | 'outdated';

const CATEGORY_CONFIGS: Record<CategoryKey, {
    resultType: string;
    extractItem: (item: Record<string, any>) => ParsedItem;
}> = {
    gaps: {
        resultType: 'gaps',
        extractItem: (item) => ({
            title: item.projectTitle || 'Untitled Gap',
            content: [
                item.whatTheyDid,
                item.architectureChosen,
                ...(item.decisionsAndWhy || []).map((d: any) => `${d.decision}: ${d.whyChosen}`),
            ].filter(Boolean).join(' | '),
        }),
    },
    tickets: {
        resultType: 'tickets',
        extractItem: (item) => ({
            title: item.title || 'Untitled Ticket',
            content: [
                `[${item.type}] ${item.priority}`,
                item.description,
                ...(item.acceptanceCriteria || []).slice(0, 3),
            ].filter(Boolean).join(' | '),
        }),
    },
    howto: {
        resultType: 'howto',
        extractItem: (item) => ({
            title: item.ticketTitle || 'Untitled How-To',
            content: [
                item.ticketType,
                ...(item.codeLevelSteps || []).slice(0, 3).map((s: any) => s.title),
                ...(item.operationalSteps || []).slice(0, 2).map((s: any) => s.title),
            ].filter(Boolean).join(' | '),
        }),
    },
    conflicts: {
        resultType: 'conflicts',
        extractItem: (item) => ({
            title: item.conflictTitle || 'Untitled Conflict',
            content: [
                `[${item.severity}] ${item.topic}`,
                item.whyItsAConflict,
                item.conflictCategory,
            ].filter(Boolean).join(' | '),
        }),
    },
    outdated: {
        resultType: 'outdated',
        extractItem: (item) => ({
            title: item.documentTitle || 'Untitled Outdated Doc',
            content: [
                `[${item.severity}] ${item.documentSource}`,
                item.outdatedCategory,
                item.suggestedUpdate,
            ].filter(Boolean).join(' | '),
        }),
    },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 3) + "...";
}

function computeF1(precision: number, recall: number): number {
    if (precision + recall === 0) return 0;
    return (2 * precision * recall) / (precision + recall);
}

// ---------------------------------------------------------------------------
// LLM-powered parsing & matching
// ---------------------------------------------------------------------------

async function parseGroundTruthItems(
    rawText: string,
    category: CategoryKey,
    logger: PrefixLogger,
): Promise<ParsedItem[]> {
    if (!rawText.trim()) return [];

    try {
        const result = await structuredGenerate({
            model: getFastModel(),
            schema: ParsedItemsSchema,
            system: `You are a ground truth parser. Extract individual items from the user-provided ground truth document for the "${category}" category.`,
            prompt: `Parse this ground truth document into individual items. Each item should have a short identifying 'title' and the full 'content' of that item.\n\nGround truth:\n${truncate(rawText, 12000)}`,
            logger,
        });
        const items = (result as any).items ?? [];
        logger.log(`Parsed ${items.length} ground truth items for ${category}`);
        return items;
    } catch (error) {
        logger.log(`Failed to parse ground truth for ${category}: ${error}`);
        return [];
    }
}

async function batchMatch(
    generatedItems: ParsedItem[],
    groundTruthItems: ParsedItem[],
    category: CategoryKey,
    logger: PrefixLogger,
): Promise<MatchDetail[]> {
    if (generatedItems.length === 0 && groundTruthItems.length === 0) {
        return [];
    }

    if (generatedItems.length === 0) {
        return groundTruthItems.map((_, idx) => ({
            generatedIndex: -1,
            groundTruthIndex: idx,
            classification: 'FN' as const,
            similarityScore: 0,
            fieldScores: {},
            matchReason: 'No generated item exists for this ground truth item',
        }));
    }

    if (groundTruthItems.length === 0) {
        return generatedItems.map((_, idx) => ({
            generatedIndex: idx,
            groundTruthIndex: null,
            classification: 'FP' as const,
            similarityScore: 0,
            fieldScores: {},
            matchReason: 'No ground truth items to match against',
        }));
    }

    const generatedList = generatedItems
        .map((item, i) => `[GEN-${i}] ${item.title}\n${truncate(item.content, 500)}`)
        .join('\n\n');

    const groundTruthList = groundTruthItems
        .map((item, i) => `[GT-${i}] ${item.title}\n${truncate(item.content, 500)}`)
        .join('\n\n');

    try {
        const result = await structuredGenerate({
            model: getFastModel(),
            schema: BatchMatchSchema,
            system: `You are an evaluation engine comparing generated outputs against ground truth for the "${category}" category.

Rules:
- Each generated item should be matched to at most ONE ground truth item.
- Each ground truth item can be matched to at most ONE generated item.
- A match requires semantic similarity — the items must be about the same topic/issue.
- Score each match 0-1 where 0=completely unrelated, 1=perfect match.
- For items that match (score > 0.5), provide per-field quality scores for key fields like title accuracy, severity, description completeness, etc.
- If a generated item has no good match (all scores ≤ 0.5), set bestGroundTruthIndex to null.
- You must return exactly one entry per generated item.`,
            prompt: `Match each generated item to the best ground truth item (if any).

GENERATED ITEMS:
${generatedList}

GROUND TRUTH ITEMS:
${groundTruthList}`,
            maxOutputTokens: 16384,
            logger,
        });

        const matches = (result as any).matches ?? [];
        const matchDetails: MatchDetail[] = [];
        const matchedGtIndices = new Set<number>();

        for (const match of matches) {
            const isTP = match.bestGroundTruthIndex !== null && match.similarityScore > 0.5;

            if (isTP && match.bestGroundTruthIndex !== null) {
                matchedGtIndices.add(match.bestGroundTruthIndex);
            }

            const fieldScoresRecord: Record<string, number> = {};
            const rawScores = match.fieldScores ?? [];
            if (Array.isArray(rawScores)) {
                for (const fs of rawScores) {
                    if (fs.field && typeof fs.score === 'number') {
                        fieldScoresRecord[fs.field] = fs.score;
                    }
                }
            } else if (typeof rawScores === 'object') {
                Object.assign(fieldScoresRecord, rawScores);
            }

            matchDetails.push({
                generatedIndex: match.generatedIndex,
                groundTruthIndex: isTP ? match.bestGroundTruthIndex : null,
                classification: isTP ? 'TP' : 'FP',
                similarityScore: match.similarityScore,
                fieldScores: fieldScoresRecord,
                matchReason: match.matchReason,
            });
        }

        for (let i = 0; i < groundTruthItems.length; i++) {
            if (!matchedGtIndices.has(i)) {
                matchDetails.push({
                    generatedIndex: -1,
                    groundTruthIndex: i,
                    classification: 'FN',
                    similarityScore: 0,
                    fieldScores: {},
                    matchReason: `Ground truth item "${groundTruthItems[i].title}" was not matched by any generated item`,
                });
            }
        }

        logger.log(`Batch match for ${category}: ${matchDetails.length} details produced`);
        return matchDetails;
    } catch (error) {
        logger.log(`Batch match failed for ${category}: ${error}`);
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Category analysis
// ---------------------------------------------------------------------------

async function analyzeCategory(
    projectId: string,
    category: CategoryKey,
    groundTruthText: string,
    logger: PrefixLogger,
): Promise<CategoryAnalysis> {
    const config = CATEGORY_CONFIGS[category];
    logger.log(`Analyzing category: ${category}`);

    const resultDoc = await db.collection("test_results").findOne({
        projectId,
        type: config.resultType,
    });

    const rawResults: Record<string, any>[] = resultDoc?.results ?? [];
    const generatedItems = rawResults.map(config.extractItem);
    logger.log(`${category}: ${generatedItems.length} generated items`);

    const groundTruthItems = await parseGroundTruthItems(groundTruthText, category, logger);
    logger.log(`${category}: ${groundTruthItems.length} ground truth items`);

    const matchDetails = await batchMatch(generatedItems, groundTruthItems, category, logger);

    const truePositives = matchDetails.filter(m => m.classification === 'TP').length;
    const falsePositives = matchDetails.filter(m => m.classification === 'FP').length;
    const falseNegatives = matchDetails.filter(m => m.classification === 'FN').length;

    const precision = truePositives + falsePositives > 0
        ? truePositives / (truePositives + falsePositives)
        : 0;
    const recall = truePositives + falseNegatives > 0
        ? truePositives / (truePositives + falseNegatives)
        : 0;
    const f1Score = computeF1(precision, recall);

    const tpDetails = matchDetails.filter(m => m.classification === 'TP');
    const avgFieldScore = tpDetails.length > 0
        ? tpDetails.reduce((sum, m) => {
            const scores = Object.values(m.fieldScores);
            return sum + (scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0);
        }, 0) / tpDetails.length
        : 0;

    logger.log(`${category}: TP=${truePositives} FP=${falsePositives} FN=${falseNegatives} P=${precision.toFixed(2)} R=${recall.toFixed(2)} F1=${f1Score.toFixed(2)}`);

    return {
        category,
        totalGenerated: generatedItems.length,
        totalGroundTruth: groundTruthItems.length,
        truePositives,
        falsePositives,
        falseNegatives,
        precision,
        recall,
        f1Score,
        avgFieldScore,
        matchDetails,
    };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runComparison(
    projectId: string,
    groundTruth: GroundTruth,
): Promise<FullAnalysis> {
    const logger = new PrefixLogger("comparison-engine");
    logger.log(`Starting comparison for project ${projectId}`);

    const categories: CategoryKey[] = ['gaps', 'tickets', 'howto', 'conflicts', 'outdated'];
    const categoryResults: CategoryAnalysis[] = [];

    for (const category of categories) {
        try {
            const analysis = await analyzeCategory(projectId, category, groundTruth[category], logger);
            categoryResults.push(analysis);
        } catch (error) {
            logger.log(`Category ${category} analysis failed: ${error}`);
            categoryResults.push({
                category,
                totalGenerated: 0,
                totalGroundTruth: 0,
                truePositives: 0,
                falsePositives: 0,
                falseNegatives: 0,
                precision: 0,
                recall: 0,
                f1Score: 0,
                avgFieldScore: 0,
                matchDetails: [],
            });
        }
    }

    const totalTP = categoryResults.reduce((s, c) => s + c.truePositives, 0);
    const totalFP = categoryResults.reduce((s, c) => s + c.falsePositives, 0);
    const totalFN = categoryResults.reduce((s, c) => s + c.falseNegatives, 0);

    const overallPrecision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 0;
    const overallRecall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 0;
    const overallF1 = computeF1(overallPrecision, overallRecall);

    const fullAnalysis: FullAnalysis = {
        categories: categoryResults,
        overallPrecision,
        overallRecall,
        overallF1,
        analyzedAt: new Date().toISOString(),
    };

    logger.log(`Overall: P=${overallPrecision.toFixed(2)} R=${overallRecall.toFixed(2)} F1=${overallF1.toFixed(2)}`);

    await db.collection("test_analysis").insertOne({
        projectId,
        ...fullAnalysis,
        createdAt: new Date().toISOString(),
    });
    logger.log("Analysis stored in test_analysis collection");

    return fullAnalysis;
}
