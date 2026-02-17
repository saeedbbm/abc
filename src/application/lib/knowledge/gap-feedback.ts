/**
 * Knowledge Gap Feedback Tracker
 * 
 * Tracks queries that the RAG system couldn't answer well.
 * When multiple similar failed queries accumulate for the same topic,
 * it signals a documentation gap that should be addressed.
 */

import { Collection, ObjectId } from "mongodb";
import { db } from "@/lib/mongodb";
import { PrefixLogger } from "@/lib/utils";

const COLLECTION_NAME = "knowledge_gap_queries";

interface GapQuery {
    _id?: ObjectId;
    projectId: string;
    query: string;
    ragResultCount: number;        // How many results the search returned
    maxScore: number;              // Highest relevance score
    timestamp: string;
    resolved: boolean;             // Whether a doc was eventually created
    resolvedAt?: string;
}

/**
 * Log a query that had poor RAG results
 */
export async function logLowConfidenceQuery(
    projectId: string,
    query: string,
    resultCount: number,
    maxScore: number
): Promise<void> {
    try {
        const collection = db.collection(COLLECTION_NAME);
        
        await collection.insertOne({
            projectId,
            query,
            ragResultCount: resultCount,
            maxScore,
            timestamp: new Date().toISOString(),
            resolved: false,
        });
    } catch (error) {
        // Non-fatal: don't break the ask flow
        console.error('[gap-feedback] Error logging query:', error);
    }
}

/**
 * Get frequently asked unanswered topics.
 * Groups similar queries and returns topics with N+ failed queries.
 */
export async function getFrequentGaps(
    projectId: string,
    minQueries: number = 3,
    logger?: PrefixLogger
): Promise<Array<{ topic: string; queryCount: number; latestQuery: string }>> {
    try {
        const collection = db.collection(COLLECTION_NAME);

        // Get all unresolved low-confidence queries from the last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const queries = await collection.find({
            projectId,
            resolved: false,
            timestamp: { $gte: thirtyDaysAgo.toISOString() },
        }).sort({ timestamp: -1 }).limit(200).toArray();

        if (queries.length === 0) return [];

        // Simple keyword-based grouping (future: use embeddings for semantic grouping)
        const groups = new Map<string, { queries: string[]; latestQuery: string }>();

        for (const q of queries) {
            const query = q.query as string;
            // Normalize: lowercase, remove punctuation, take key words
            const normalized = query.toLowerCase()
                .replace(/[?!.,;:'"]/g, '')
                .trim();
            
            // Find if any existing group is similar (shares 50%+ words)
            const words = normalized.split(/\s+/).filter(w => w.length > 3);
            let matched = false;
            
            for (const [key, group] of groups) {
                const keyWords = key.split(/\s+/);
                const overlap = words.filter(w => keyWords.includes(w)).length;
                if (overlap >= Math.min(words.length, keyWords.length) * 0.5) {
                    group.queries.push(query);
                    group.latestQuery = query;
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                groups.set(normalized, { queries: [query], latestQuery: query });
            }
        }

        // Return groups with enough queries
        return Array.from(groups.entries())
            .filter(([_, group]) => group.queries.length >= minQueries)
            .map(([topic, group]) => ({
                topic,
                queryCount: group.queries.length,
                latestQuery: group.latestQuery,
            }))
            .sort((a, b) => b.queryCount - a.queryCount);
    } catch (error) {
        logger?.log(`Error getting frequent gaps: ${error}`);
        return [];
    }
}

/**
 * Mark queries as resolved when documentation is created
 */
export async function markGapResolved(
    projectId: string,
    querySubstring: string
): Promise<number> {
    try {
        const collection = db.collection(COLLECTION_NAME);
        
        const result = await collection.updateMany(
            {
                projectId,
                resolved: false,
                query: { $regex: new RegExp(querySubstring, 'i') },
            },
            {
                $set: {
                    resolved: true,
                    resolvedAt: new Date().toISOString(),
                },
            }
        );

        return result.modifiedCount;
    } catch (error) {
        console.error('[gap-feedback] Error marking resolved:', error);
        return 0;
    }
}
