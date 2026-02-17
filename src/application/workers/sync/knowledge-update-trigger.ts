/**
 * Knowledge Update Trigger
 * 
 * Called after sync workers process new data. Triggers incremental
 * knowledge graph updates for newly ingested documents.
 * 
 * This enables event-driven updates rather than waiting for full 
 * discovery runs. When a new Slack message, Jira ticket, or 
 * Confluence page is synced, this trigger:
 * 
 * 1. Checks if the document mentions known entities
 * 2. Updates topic documents with new mentions
 * 3. Checks if it contradicts any tracked claims
 * 4. Logs if it might indicate a new entity (system, customer, project)
 */

import { PrefixLogger } from "@/lib/utils";
import { KnowledgeDocumentType } from "@/src/entities/models/knowledge-document";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { MongoDBClaimsRepository } from "@/src/infrastructure/repositories/mongodb.claims.repository";
import { searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { Collection, ObjectId } from "mongodb";
import { db } from "@/lib/mongodb";

const PENDING_UPDATES_COLLECTION = "knowledge_pending_updates";

export interface PendingKnowledgeUpdate {
    projectId: string;
    triggerType: 'new_document' | 'entity_mention' | 'possible_contradiction' | 'new_entity_hint';
    documentId: string;
    documentTitle: string;
    provider: string;
    details: string;
    priority: 'high' | 'medium' | 'low';
    processed: boolean;
    createdAt: string;
}

/**
 * Process a newly synced document for knowledge graph implications
 */
export async function triggerKnowledgeUpdate(
    projectId: string,
    document: KnowledgeDocumentType,
    logger?: PrefixLogger
): Promise<void> {
    const log = logger || new PrefixLogger('knowledge-trigger');
    
    try {
        const entitiesRepo = new MongoDBKnowledgeEntitiesRepository();
        const claimsRepo = new MongoDBClaimsRepository();
        
        const pendingUpdates: PendingKnowledgeUpdate[] = [];
        const contentLower = document.content.toLowerCase();
        const now = new Date().toISOString();

        // 1. Check if document mentions known entities
        const entities = await entitiesRepo.findByProjectId(projectId, { limit: 200 });
        for (const entity of entities.items) {
            const nameLower = entity.name.toLowerCase();
            const aliasesLower = entity.aliases.map(a => a.toLowerCase());
            
            const mentioned = contentLower.includes(nameLower) ||
                aliasesLower.some(a => contentLower.includes(a));
            
            if (mentioned && entity.type !== 'topic') {
                // Add entity ref to the document if not already there
                pendingUpdates.push({
                    projectId,
                    triggerType: 'entity_mention',
                    documentId: document.id,
                    documentTitle: document.title,
                    provider: document.provider,
                    details: `Mentions ${entity.type} "${entity.name}"`,
                    priority: 'low',
                    processed: false,
                    createdAt: now,
                });
            }
        }

        // 2. Check for possible claim contradictions (if from Slack/Jira)
        if (document.provider !== 'confluence') {
            const claims = await claimsRepo.getActiveClaims(projectId);
            
            for (const claim of claims.slice(0, 50)) {
                // Quick relevance check: do they share entity names?
                const claimEntitiesLower = claim.relatedEntityNames.map(n => n.toLowerCase());
                const hasOverlap = claimEntitiesLower.some(e => contentLower.includes(e));
                
                if (hasOverlap) {
                    pendingUpdates.push({
                        projectId,
                        triggerType: 'possible_contradiction',
                        documentId: document.id,
                        documentTitle: document.title,
                        provider: document.provider,
                        details: `May contradict claim: "${claim.claimText.substring(0, 100)}" from "${claim.sourcePageTitle}"`,
                        priority: 'medium',
                        processed: false,
                        createdAt: now,
                    });
                }
            }
        }

        // 3. Check for hints of new entities (systems, customers, projects)
        // Look for patterns that suggest new entities
        const newEntityPatterns = [
            { pattern: /new service|new system|launched|deployed/i, type: 'system' },
            { pattern: /new customer|new client|signed|onboarded/i, type: 'customer' },
            { pattern: /new project|kicked off|starting work on/i, type: 'project' },
            { pattern: /new process|new workflow|now we do|going forward/i, type: 'process' },
        ];

        for (const { pattern, type } of newEntityPatterns) {
            if (pattern.test(document.content)) {
                pendingUpdates.push({
                    projectId,
                    triggerType: 'new_entity_hint',
                    documentId: document.id,
                    documentTitle: document.title,
                    provider: document.provider,
                    details: `May describe a new ${type}`,
                    priority: 'medium',
                    processed: false,
                    createdAt: now,
                });
            }
        }

        // Store pending updates
        if (pendingUpdates.length > 0) {
            const collection = db.collection(PENDING_UPDATES_COLLECTION);
            await collection.insertMany(pendingUpdates.map(u => ({
                ...u,
                _id: new ObjectId(),
            })));
            log.log(`Queued ${pendingUpdates.length} knowledge updates for document "${document.title}"`);
        }
    } catch (error) {
        // Non-fatal: don't break sync
        log?.log(`Error in knowledge update trigger: ${error}`);
    }
}

/**
 * Get unprocessed pending updates for a project
 */
export async function getPendingUpdates(
    projectId: string,
    limit: number = 50
): Promise<PendingKnowledgeUpdate[]> {
    const collection = db.collection(PENDING_UPDATES_COLLECTION);
    
    const docs = await collection.find({
        projectId,
        processed: false,
    }).sort({ priority: 1, createdAt: 1 }).limit(limit).toArray();

    return docs.map(d => ({
        projectId: d.projectId,
        triggerType: d.triggerType,
        documentId: d.documentId,
        documentTitle: d.documentTitle,
        provider: d.provider,
        details: d.details,
        priority: d.priority,
        processed: d.processed,
        createdAt: d.createdAt,
    }));
}

/**
 * Mark pending updates as processed
 */
export async function markUpdatesProcessed(
    projectId: string,
    documentIds: string[]
): Promise<void> {
    const collection = db.collection(PENDING_UPDATES_COLLECTION);
    
    await collection.updateMany(
        { projectId, documentId: { $in: documentIds } },
        { $set: { processed: true } }
    );
}
