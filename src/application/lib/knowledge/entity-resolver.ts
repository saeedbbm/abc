/**
 * Entity Resolver — Deduplication and Alias Mapping
 * 
 * Before creating a new entity, this module checks for existing entities
 * using deterministic anchors (Slack ID, Jira ID, email) and fuzzy name matching.
 * 
 * This ensures "Jake_R", "Jake Rivera", and "the lead backend engineer" 
 * are recognized as the same person.
 */

import { PrefixLogger } from "@/lib/utils";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";

const logger = new PrefixLogger('entity-resolver');

interface EntityCandidate {
    name: string;
    type: string;
    projectId: string;
    metadata?: Record<string, any>;
    slackUserId?: string;
    jiraAccountId?: string;
    email?: string;
    aliases?: string[];
}

interface ResolvedEntity {
    existingId: string | null;  // null = create new, otherwise merge into this
    mergedMetadata?: Record<string, any>;
}

/**
 * Resolve an entity candidate against existing entities.
 * Returns the existing entity ID to merge into, or null to create new.
 */
export async function resolveEntity(
    candidate: EntityCandidate,
    entitiesRepo: MongoDBKnowledgeEntitiesRepository
): Promise<ResolvedEntity> {
    const existing = await entitiesRepo.findByProject(candidate.projectId, candidate.type);

    // 1. Deterministic anchor check: Slack User ID
    if (candidate.slackUserId) {
        const match = existing.find(e => 
            (e.metadata as any)?.slackUserId === candidate.slackUserId
        );
        if (match) {
            logger.log(`Resolved "${candidate.name}" by Slack ID ${candidate.slackUserId} -> "${match.name}"`);
            return { existingId: match.id, mergedMetadata: mergeMetadata(match.metadata as any, candidate.metadata) };
        }
    }

    // 2. Deterministic anchor check: Jira Account ID
    if (candidate.jiraAccountId) {
        const match = existing.find(e => 
            (e.metadata as any)?.jiraAccountId === candidate.jiraAccountId
        );
        if (match) {
            logger.log(`Resolved "${candidate.name}" by Jira ID ${candidate.jiraAccountId} -> "${match.name}"`);
            return { existingId: match.id, mergedMetadata: mergeMetadata(match.metadata as any, candidate.metadata) };
        }
    }

    // 3. Deterministic anchor check: Email
    if (candidate.email) {
        const match = existing.find(e => {
            const meta = e.metadata as any;
            const existingEmail = meta?.email || meta?.emailAddress;
            return existingEmail && existingEmail.toLowerCase() === candidate.email!.toLowerCase();
        });
        if (match) {
            logger.log(`Resolved "${candidate.name}" by email ${candidate.email} -> "${match.name}"`);
            return { existingId: match.id, mergedMetadata: mergeMetadata(match.metadata as any, candidate.metadata) };
        }
    }

    // 4. Fuzzy name matching
    const normalizedName = normalizeName(candidate.name);
    if (normalizedName.length >= 3) {
        for (const entity of existing) {
            const normalizedExisting = normalizeName(entity.name);
            
            // Exact normalized match
            if (normalizedExisting === normalizedName) {
                logger.log(`Resolved "${candidate.name}" by exact normalized name match -> "${entity.name}"`);
                return { existingId: entity.id, mergedMetadata: mergeMetadata(entity.metadata as any, candidate.metadata) };
            }
            
            // Check aliases
            const aliases = (entity.metadata as any)?.aliases || [];
            for (const alias of aliases) {
                if (normalizeName(alias) === normalizedName) {
                    logger.log(`Resolved "${candidate.name}" by alias match -> "${entity.name}"`);
                    return { existingId: entity.id, mergedMetadata: mergeMetadata(entity.metadata as any, candidate.metadata) };
                }
            }
            
            // Levenshtein distance check (for minor typos)
            if (normalizedName.length >= 5 && normalizedExisting.length >= 5) {
                const distance = levenshteinDistance(normalizedName, normalizedExisting);
                if (distance <= 2) {
                    logger.log(`Resolved "${candidate.name}" by fuzzy match (distance ${distance}) -> "${entity.name}"`);
                    return { existingId: entity.id, mergedMetadata: mergeMetadata(entity.metadata as any, candidate.metadata) };
                }
            }
            
            // Jaccard similarity on word tokens (for name reordering: "John Smith" vs "Smith, John")
            if (normalizedName.includes(' ') && normalizedExisting.includes(' ')) {
                const similarity = jaccardSimilarity(normalizedName, normalizedExisting);
                if (similarity > 0.7) {
                    logger.log(`Resolved "${candidate.name}" by Jaccard similarity (${similarity.toFixed(2)}) -> "${entity.name}"`);
                    return { existingId: entity.id, mergedMetadata: mergeMetadata(entity.metadata as any, candidate.metadata) };
                }
            }
        }
    }

    // No match found — create new
    return { existingId: null };
}

/**
 * Batch deduplication sweep for a project.
 * Finds and merges duplicate entities that slipped through real-time checks.
 */
export async function deduplicateEntities(
    projectId: string,
    entitiesRepo: MongoDBKnowledgeEntitiesRepository
): Promise<{ merged: number; total: number }> {
    let merged = 0;
    const entityTypes = ['person', 'project', 'system', 'customer', 'process', 'topic'];

    for (const type of entityTypes) {
        const entities = await entitiesRepo.findByProject(projectId, type);
        const seen = new Map<string, typeof entities[0]>();

        for (const entity of entities) {
            const normalizedName = normalizeName(entity.name);
            let matchKey: string | null = null;

            // Check deterministic anchors first
            const meta = entity.metadata as any;
            if (meta?.slackUserId) {
                matchKey = `slack:${meta.slackUserId}`;
            } else if (meta?.jiraAccountId) {
                matchKey = `jira:${meta.jiraAccountId}`;
            } else if (meta?.email) {
                matchKey = `email:${meta.email.toLowerCase()}`;
            }

            if (matchKey && seen.has(matchKey)) {
                // Merge into existing
                const target = seen.get(matchKey)!;
                await mergeEntities(target, entity, entitiesRepo);
                merged++;
                continue;
            }

            // Fuzzy name check against seen entities
            let fuzzyMatch: typeof entities[0] | null = null;
            for (const [, seenEntity] of seen) {
                const seenNorm = normalizeName(seenEntity.name);
                if (seenNorm === normalizedName || levenshteinDistance(seenNorm, normalizedName) <= 2) {
                    fuzzyMatch = seenEntity;
                    break;
                }
            }

            if (fuzzyMatch) {
                await mergeEntities(fuzzyMatch, entity, entitiesRepo);
                merged++;
                continue;
            }

            // No match — record for future comparisons
            if (matchKey) seen.set(matchKey, entity);
            seen.set(`name:${normalizedName}`, entity);
        }
    }

    logger.log(`Deduplication sweep for ${projectId}: merged ${merged} entities`);
    return { merged, total: merged };
}

/**
 * Merge entity B into entity A (A is kept, B is deleted).
 */
async function mergeEntities(
    target: any,
    duplicate: any,
    entitiesRepo: MongoDBKnowledgeEntitiesRepository
): Promise<void> {
    const mergedMeta = mergeMetadata(target.metadata, duplicate.metadata);
    
    // Add duplicate's name as an alias
    const aliases = new Set<string>(mergedMeta.aliases || []);
    aliases.add(duplicate.name);
    if (target.name !== duplicate.name) aliases.add(duplicate.name);
    mergedMeta.aliases = Array.from(aliases);

    // Merge mentions
    if (duplicate.metadata?.mentionedIn) {
        const mentions = new Set<string>(mergedMeta.mentionedIn || []);
        for (const m of duplicate.metadata.mentionedIn) mentions.add(m);
        mergedMeta.mentionedIn = Array.from(mentions);
    }

    // Update target with merged metadata
    await entitiesRepo.updateMetadata(target.id, target.projectId, mergedMeta);
    
    // Delete the duplicate
    await entitiesRepo.delete(duplicate.id, duplicate.projectId);
    
    logger.log(`Merged entity "${duplicate.name}" into "${target.name}"`);
}

// --- Utility functions ---

function normalizeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[._\-]/g, ' ')      // Replace dots, underscores, hyphens with spaces
        .replace(/[^a-z0-9\s]/g, '')    // Remove special chars
        .replace(/\s+/g, ' ')           // Collapse whitespace
        .trim();
}

function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b[i - 1] === a[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(' '));
    const setB = new Set(b.split(' '));
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}

function mergeMetadata(existing?: Record<string, any>, incoming?: Record<string, any>): Record<string, any> {
    const result = { ...(existing || {}) };
    if (!incoming) return result;
    
    for (const [key, value] of Object.entries(incoming)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value) && Array.isArray(result[key])) {
            // Merge arrays without duplicates
            result[key] = Array.from(new Set([...result[key], ...value]));
        } else if (!result[key]) {
            result[key] = value;
        }
        // Don't overwrite existing non-null values (keep the first)
    }
    
    return result;
}
