/**
 * Knowledge Embedding Service
 * 
 * Handles embedding of knowledge documents into Qdrant for semantic search.
 * Used by sync workers and real-time ingestion.
 */

import { embedMany } from 'ai';
import { embeddingModel } from '@/lib/embedding';
import { qdrantClient } from '@/lib/qdrant';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { PrefixLogger } from '@/lib/utils';
import { KnowledgeDocumentType } from '@/src/entities/models/knowledge-document';
import crypto from 'crypto';
import { smartChunk, SmartChunk } from './smart-chunker';

// Collection name for knowledge embeddings
export const KNOWLEDGE_COLLECTION = 'knowledge_embeddings';

// Text splitter for chunking documents
const splitter = new RecursiveCharacterTextSplitter({
    separators: ['\n\n', '\n', '. ', '.', ''],
    chunkSize: 512,
    chunkOverlap: 50,
});

export interface EmbeddingResult {
    documentId: string;
    chunksCreated: number;
    success: boolean;
    error?: string;
}

/**
 * Ensure the knowledge embeddings collection exists in Qdrant
 */
export async function ensureKnowledgeCollection(logger?: PrefixLogger): Promise<void> {
    const log = logger || new PrefixLogger('embedding-service');
    
    try {
        const collections = await qdrantClient.getCollections();
        const exists = collections.collections.some(c => c.name === KNOWLEDGE_COLLECTION);
        
        if (!exists) {
            log.log(`Creating collection: ${KNOWLEDGE_COLLECTION}`);
            await qdrantClient.createCollection(KNOWLEDGE_COLLECTION, {
                vectors: {
                    size: 1536, // text-embedding-3-small dimension
                    distance: 'Cosine',
                },
            });
            
            // Create payload indexes for filtering
            await qdrantClient.createPayloadIndex(KNOWLEDGE_COLLECTION, {
                field_name: 'projectId',
                field_schema: 'keyword',
            });
            await qdrantClient.createPayloadIndex(KNOWLEDGE_COLLECTION, {
                field_name: 'provider',
                field_schema: 'keyword',
            });
            await qdrantClient.createPayloadIndex(KNOWLEDGE_COLLECTION, {
                field_name: 'sourceType',
                field_schema: 'keyword',
            });
            await qdrantClient.createPayloadIndex(KNOWLEDGE_COLLECTION, {
                field_name: 'documentId',
                field_schema: 'keyword',
            });
            
            log.log(`Collection ${KNOWLEDGE_COLLECTION} created with indexes`);
        }
    } catch (error) {
        log.log(`Error ensuring collection: ${error}`);
        throw error;
    }
}

/**
 * Generate a deterministic point ID from document ID and chunk index
 */
function generatePointId(documentId: string, chunkIndex: number): string {
    const hash = crypto.createHash('md5').update(`${documentId}:${chunkIndex}`).digest('hex');
    // Convert to UUID format for Qdrant
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Compute content hash for a document (used for incremental embedding)
 */
function computeContentHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Check if a document's content hash matches the one already stored in Qdrant.
 * Returns true if the document is already embedded with the same content.
 */
async function isAlreadyEmbedded(documentId: string, contentHash: string): Promise<boolean> {
    try {
        // Check the first chunk's payload for this document
        const results = await qdrantClient.scroll(KNOWLEDGE_COLLECTION, {
            filter: {
                must: [
                    { key: 'documentId', match: { value: documentId } },
                    { key: 'chunkIndex', match: { value: 0 } },
                ],
            },
            limit: 1,
            with_payload: true,
        });

        if (results.points.length > 0) {
            const existingHash = (results.points[0].payload as any)?.contentHash;
            return existingHash === contentHash;
        }
        return false;
    } catch {
        return false; // If check fails, re-embed to be safe
    }
}

/**
 * Embed a single knowledge document.
 * Supports incremental embedding: if the content hash matches the existing
 * embedding, the document is skipped entirely.
 */
export async function embedKnowledgeDocument(
    document: KnowledgeDocumentType,
    logger?: PrefixLogger,
    options?: { skipHashCheck?: boolean }
): Promise<EmbeddingResult> {
    const log = logger || new PrefixLogger('embedding-service');
    
    try {
        // Skip empty documents
        if (!document.content || document.content.trim().length === 0) {
            return {
                documentId: document.id,
                chunksCreated: 0,
                success: true,
            };
        }

        // Ensure collection exists
        await ensureKnowledgeCollection(log);

        // Incremental check: skip if content hasn't changed
        const contentHash = computeContentHash(document.content);
        if (!options?.skipHashCheck) {
            const alreadyDone = await isAlreadyEmbedded(document.id, contentHash);
            if (alreadyDone) {
                return {
                    documentId: document.id,
                    chunksCreated: 0,
                    success: true,
                };
            }
        }

        // Smart chunk based on document type
        const smartChunks = await smartChunk(document.content, document.sourceType, document.metadata);
        const chunks = smartChunks.map(c => c.text);
        const chunkMetadata = smartChunks.map(c => c.metadata || {});
        
        if (chunks.length === 0) {
            return {
                documentId: document.id,
                chunksCreated: 0,
                success: true,
            };
        }

        // Generate embeddings for all chunks
        const { embeddings } = await embedMany({
            model: embeddingModel,
            values: chunks,
        });

        // Prepare points for Qdrant
        // For conversation documents, store full content in metadata for context retrieval
        const isConversation = document.sourceType === 'slack_conversation';
        
        const points = chunks.map((chunk, index) => ({
            id: generatePointId(document.id, index),
            vector: embeddings[index],
            payload: {
                projectId: document.projectId,
                documentId: document.id,
                provider: document.provider,
                sourceType: document.sourceType,
                sourceId: document.sourceId,
                title: document.title,
                content: chunk,
                chunkIndex: index,
                totalChunks: chunks.length,
                contentHash, // Store hash for incremental checks
                metadata: document.metadata,
                syncedAt: document.syncedAt,
                sourceCreatedAt: document.sourceCreatedAt,
                // Store full content for conversations to enable context retrieval
                ...(isConversation && { fullContent: document.content }),
                // Smart chunk metadata
                ...(chunkMetadata[index]?.sectionTitle && { sectionTitle: chunkMetadata[index].sectionTitle }),
                ...(chunkMetadata[index]?.fieldType && { fieldType: chunkMetadata[index].fieldType }),
                ...(chunkMetadata[index]?.messageType && { messageType: chunkMetadata[index].messageType }),
                chunkReason: chunkMetadata[index]?.chunkReason || 'legacy',
            },
        }));

        // Delete existing embeddings for this document first
        await qdrantClient.delete(KNOWLEDGE_COLLECTION, {
            filter: {
                must: [
                    { key: 'documentId', match: { value: document.id } },
                ],
            },
        });

        // Upsert new embeddings
        await qdrantClient.upsert(KNOWLEDGE_COLLECTION, {
            wait: true,
            points,
        });

        log.log(`Embedded document ${document.id} (${chunks.length} chunks)`);

        return {
            documentId: document.id,
            chunksCreated: chunks.length,
            success: true,
        };
    } catch (error) {
        log.log(`Error embedding document ${document.id}: ${error}`);
        return {
            documentId: document.id,
            chunksCreated: 0,
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Embed multiple knowledge documents in batch.
 * Uses incremental content hashing to skip unchanged documents.
 */
export async function embedKnowledgeDocuments(
    documents: KnowledgeDocumentType[],
    logger?: PrefixLogger
): Promise<EmbeddingResult[]> {
    const log = logger || new PrefixLogger('embedding-service');
    const results: EmbeddingResult[] = [];

    log.log(`Embedding ${documents.length} documents (incremental — unchanged docs will be skipped)...`);

    for (const doc of documents) {
        const result = await embedKnowledgeDocument(doc, log);
        results.push(result);
    }

    const successful = results.filter(r => r.success).length;
    const totalChunks = results.reduce((sum, r) => sum + r.chunksCreated, 0);
    const skipped = results.filter(r => r.success && r.chunksCreated === 0).length;
    log.log(`Embedded ${successful}/${documents.length} documents (${totalChunks} chunks created, ${skipped} skipped — unchanged)`);

    return results;
}

/**
 * Delete all embeddings for a document
 */
export async function deleteDocumentEmbeddings(
    documentId: string,
    logger?: PrefixLogger
): Promise<void> {
    const log = logger || new PrefixLogger('embedding-service');
    
    try {
        await qdrantClient.delete(KNOWLEDGE_COLLECTION, {
            filter: {
                must: [
                    { key: 'documentId', match: { value: documentId } },
                ],
            },
        });
        log.log(`Deleted embeddings for document ${documentId}`);
    } catch (error) {
        log.log(`Error deleting embeddings for document ${documentId}: ${error}`);
    }
}

/**
 * Delete all embeddings for a project
 */
export async function deleteProjectEmbeddings(
    projectId: string,
    logger?: PrefixLogger
): Promise<void> {
    const log = logger || new PrefixLogger('embedding-service');
    
    try {
        await qdrantClient.delete(KNOWLEDGE_COLLECTION, {
            filter: {
                must: [
                    { key: 'projectId', match: { value: projectId } },
                ],
            },
        });
        log.log(`Deleted all embeddings for project ${projectId}`);
    } catch (error) {
        log.log(`Error deleting embeddings for project ${projectId}: ${error}`);
    }
}

/**
 * Search knowledge embeddings by semantic similarity
 * 
 * IMPORTANT: This function diversifies results across providers (slack, jira, confluence)
 * to ensure we get relevant content from all sources, not just the one with highest scores.
 */
export async function searchKnowledgeEmbeddings(
    projectId: string,
    query: string,
    options: {
        limit?: number;
        provider?: string;
        sourceType?: string;
    } = {},
    logger?: PrefixLogger
): Promise<Array<{
    documentId: string;
    title: string;
    content: string;
    provider: string;
    sourceType: string;
    score: number;
    metadata: Record<string, any>;
}>> {
    const log = logger || new PrefixLogger('embedding-service');
    const { limit = 15, provider, sourceType } = options;

    try {
        // Ensure collection exists
        await ensureKnowledgeCollection(log);

        // Generate query embedding
        const { embeddings } = await embedMany({
            model: embeddingModel,
            values: [query],
        });

        // Minimal log — avoid flooding terminal on every search call
        log.log(`search: ${provider || 'all'} q="${query.substring(0, 40)}..." limit=${limit}`);

        // If a specific provider is requested, search only that provider
        if (provider) {
            const mustFilters: any[] = [
                { key: 'projectId', match: { value: projectId } },
                { key: 'provider', match: { value: provider } },
            ];
            if (sourceType) {
                mustFilters.push({ key: 'sourceType', match: { value: sourceType } });
            }

            const results = await qdrantClient.search(KNOWLEDGE_COLLECTION, {
                vector: embeddings[0],
                limit,
                filter: { must: mustFilters },
                with_payload: true,
            });

            return results.map(point => ({
                documentId: (point.payload as any).documentId,
                title: (point.payload as any).title,
                content: (point.payload as any).content,
                provider: (point.payload as any).provider,
                sourceType: (point.payload as any).sourceType,
                score: point.score,
                metadata: (point.payload as any).metadata || {},
            }));
        }

        // DIVERSIFIED SEARCH: Search each provider separately and combine results
        // This ensures we get content from Slack, Jira, AND Confluence, not just the highest-scoring one
        // Also search 'internal' provider for topic documents (entity-centric knowledge)
        const providers = ['slack', 'jira', 'confluence', 'internal'];
        const resultsPerProvider = Math.ceil(limit / providers.length); // e.g., 4 from each for limit=15
        
        const allResults: Array<{
            documentId: string;
            title: string;
            content: string;
            provider: string;
            sourceType: string;
            score: number;
            metadata: Record<string, any>;
        }> = [];

        // Search each provider in parallel
        const providerSearches = providers.map(async (prov) => {
            try {
                const mustFilters: any[] = [
                    { key: 'projectId', match: { value: projectId } },
                    { key: 'provider', match: { value: prov } },
                ];
                if (sourceType) {
                    mustFilters.push({ key: 'sourceType', match: { value: sourceType } });
                }

                const results = await qdrantClient.search(KNOWLEDGE_COLLECTION, {
                    vector: embeddings[0],
                    limit: resultsPerProvider,
                    filter: { must: mustFilters },
                    with_payload: true,
                });

                return results.map(point => ({
                    documentId: (point.payload as any).documentId,
                    title: (point.payload as any).title,
                    content: (point.payload as any).content,
                    provider: (point.payload as any).provider,
                    sourceType: (point.payload as any).sourceType,
                    score: point.score,
                    metadata: (point.payload as any).metadata || {},
                }));
            } catch (e) {
                log.log(`Error searching ${prov}: ${e}`);
                return [];
            }
        });

        const providerResults = await Promise.all(providerSearches);
        
        // Combine results from all providers
        for (const results of providerResults) {
            allResults.push(...results);
        }

        // Sort by score descending
        allResults.sort((a, b) => b.score - a.score);

        // Deduplicate by documentId (same document might appear from different chunks)
        const seen = new Set<string>();
        const deduped = allResults.filter(r => {
            const key = `${r.documentId}:${r.content.substring(0, 50)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Log provider distribution
        const providerDist = deduped.reduce((acc, r) => {
            acc[r.provider] = (acc[r.provider] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        log.log(`Diversified search results: ${JSON.stringify(providerDist)} (${deduped.length} total)`);

        // Return top 'limit' results
        return deduped.slice(0, limit);
    } catch (error) {
        log.log(`Error searching knowledge: ${error}`);
        return [];
    }
}

export interface ExpandedSearchResult {
    documentId: string;
    title: string;
    content: string;
    provider: string;
    sourceType: string;
    score: number;
    metadata: Record<string, any>;
    // Expanded context
    threadContext?: string;      // Full thread content if this is part of a thread
    conversationContext?: string; // Related conversation summary if available
    relatedMessages?: Array<{
        content: string;
        timestamp?: string;
    }>;
}

/**
 * Search knowledge embeddings with context expansion
 * 
 * This function not only searches for relevant content but also expands the context
 * for thread-related messages by including the full conversation.
 */
export async function searchKnowledgeWithContext(
    projectId: string,
    query: string,
    options: {
        limit?: number;
        expandContext?: boolean;
    } = {},
    logger?: PrefixLogger
): Promise<ExpandedSearchResult[]> {
    const log = logger || new PrefixLogger('embedding-service');
    const { limit = 15, expandContext = true } = options;

    // First, do the regular diversified search
    const results = await searchKnowledgeEmbeddings(projectId, query, { limit }, log);
    
    if (!expandContext || results.length === 0) {
        return results.map(r => ({
            ...r,
            threadContext: undefined,
            conversationContext: undefined,
            relatedMessages: undefined,
        }));
    }

    // Also search directly for conversation summaries that match the query
    // This ensures we get the full conversation context even if individual messages scored lower
    let relevantConversations: Array<{
        documentId: string;
        content: string;
        score: number;
        metadata: Record<string, any>;
    }> = [];
    try {
        // Generate query embedding using the same method as searchKnowledgeEmbeddings
        const { embeddings: queryEmbeddings } = await embedMany({
            model: embeddingModel,
            values: [query],
        });
        const convSearch = await qdrantClient.search(KNOWLEDGE_COLLECTION, {
            vector: queryEmbeddings[0],
            limit: 10, // Get top 10 most relevant conversations
            filter: {
                must: [
                    { key: 'projectId', match: { value: projectId } },
                    { key: 'sourceType', match: { value: 'slack_conversation' } },
                ],
            },
            with_payload: true,
        });
        relevantConversations = convSearch.map(point => ({
            documentId: (point.payload as any).documentId,
            // Use fullContent if available (contains entire conversation), otherwise fall back to chunk
            content: (point.payload as any).fullContent || (point.payload as any).content,
            score: point.score,
            metadata: (point.payload as any).metadata || {},
        }));
        log.log(`Found ${relevantConversations.length} directly relevant conversation summaries`);
        if (relevantConversations.length > 0) {
            log.log(`Top conversation topics: ${relevantConversations.map(c => c.metadata?.topic || 'unknown').join(', ')}`);
        }
    } catch (e) {
        log.log(`Error searching conversations directly: ${e}`);
    }

    // Pre-fetch all conversation summaries for this project (they're small)
    let allConversations: Array<{ content: string; messageIds: string[]; topic: string }> = [];
    try {
        const conversationSearch = await qdrantClient.scroll(KNOWLEDGE_COLLECTION, {
            filter: {
                must: [
                    { key: 'projectId', match: { value: projectId } },
                    { key: 'provider', match: { value: 'slack' } },
                    { key: 'sourceType', match: { value: 'slack_conversation' } },
                ],
            },
            limit: 100, // Get all conversations
            with_payload: true,
        });
        
        allConversations = conversationSearch.points.map(point => ({
            // Use fullContent if available (contains entire conversation), otherwise fall back to chunk content
            content: (point.payload as any).fullContent || (point.payload as any).content,
            messageIds: (point.payload as any).metadata?.messageIds || [],
            topic: (point.payload as any).metadata?.topic || 'unknown',
        }));
        log.log(`Found ${allConversations.length} conversation summaries for context expansion`);
        
        // Debug: Log conversation topics and message counts
        if (allConversations.length > 0) {
            const topicSummary = allConversations.map(c => 
                `"${c.topic}" (${c.messageIds.length} msgs)`
            ).slice(0, 5);
            log.log(`Sample conversations: ${topicSummary.join(', ')}`);
        }
    } catch (e) {
        log.log(`Error fetching conversations: ${e}`);
    }

    // Now expand context for each result
    const expandedResults: ExpandedSearchResult[] = [];
    
    for (const result of results) {
        let threadContext: string | undefined;
        let conversationContext: string | undefined;
        const relatedMessages: Array<{ content: string; timestamp?: string }> = [];

        // If this is already a conversation summary, the content IS the context
        if (result.sourceType === 'slack_conversation') {
            conversationContext = result.content;
        }
        // For Slack messages or threads, look for conversation containing this message
        else if (result.provider === 'slack' && (result.sourceType === 'slack_message' || result.sourceType === 'slack_thread')) {
            // Find conversation that contains this message's document ID
            for (const conv of allConversations) {
                if (conv.messageIds.includes(result.documentId)) {
                    conversationContext = conv.content;
                    log.log(`Found conversation context for doc ${result.documentId} in "${conv.topic}"`);
                    break;
                }
            }
            
            // If no conversation found, log debug info
            if (!conversationContext) {
                log.log(`No conversation found for doc ${result.documentId} (${result.sourceType}), title: "${result.title?.substring(0, 50)}"`);
                // Check if any conversation has similar message count
                const docIdStart = result.documentId.substring(0, 8);
                const partialMatches = allConversations.filter(c => 
                    c.messageIds.some(id => id.startsWith(docIdStart))
                );
                if (partialMatches.length > 0) {
                    log.log(`Partial ID matches in ${partialMatches.length} conversations`);
                }
            }
        }

        expandedResults.push({
            ...result,
            threadContext,
            conversationContext,
            relatedMessages: relatedMessages.length > 0 ? relatedMessages : undefined,
        });
    }

    // Add directly searched conversation summaries if they're not already in results
    // This ensures we always include highly relevant conversation context
    const existingConvIds = new Set(expandedResults.filter(r => r.sourceType === 'slack_conversation').map(r => r.documentId));
    for (const conv of relevantConversations) {
        if (!existingConvIds.has(conv.documentId)) {
            expandedResults.push({
                documentId: conv.documentId,
                title: `Conversation: ${conv.metadata?.topic || 'Team Discussion'}`,
                content: conv.content,
                provider: 'slack',
                sourceType: 'slack_conversation',
                score: conv.score,
                metadata: conv.metadata,
                conversationContext: conv.content,
            });
            log.log(`Added relevant conversation summary: ${conv.metadata?.topic}`);
        }
    }

    // KEYWORD-BASED FALLBACK: Also include conversations that contain key query terms
    // This helps catch conversations that semantic search might miss due to different phrasing
    // These are INSERTED at position 10 (after top results) to ensure they don't get sliced off
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 3); // Words > 3 chars
    
    const keywordMatches: ExpandedSearchResult[] = [];
    
    for (const conv of allConversations) {
        const convContentLower = conv.content.toLowerCase();
        const convTopic = conv.topic.toLowerCase();
        
        // Check if conversation contains query terms
        const matchesQuery = queryTerms.some(term => 
            convContentLower.includes(term) || convTopic.includes(term)
        );
        
        // Also check for numeric values that might be corrections/updates (like "350", "400")
        const hasNumericValues = /\b\d{2,4}(ms|milliseconds?)?\b/i.test(conv.content);
        
        if (matchesQuery && hasNumericValues && !existingConvIds.has(conv.messageIds[0])) {
            // Create a pseudo-document ID from the conversation
            const pseudoId = `conv:${conv.topic.replace(/\s+/g, '_').substring(0, 30)}`;
            if (!existingConvIds.has(pseudoId)) {
                existingConvIds.add(pseudoId);
                keywordMatches.push({
                    documentId: pseudoId,
                    title: `Conversation: ${conv.topic}`,
                    content: conv.content,
                    provider: 'slack',
                    sourceType: 'slack_conversation',
                    score: 0.75, // Higher score for keyword matches with numeric values
                    metadata: { topic: conv.topic, messageIds: conv.messageIds },
                    conversationContext: conv.content,
                });
                log.log(`Found keyword-matched conversation: ${conv.topic} (has 350: ${conv.content.includes('350')})`);
            }
        }
    }
    
    // Insert keyword matches at position 10 (after top semantic results, before lower-ranked ones)
    // This ensures they don't get sliced off when we take top N results
    if (keywordMatches.length > 0) {
        log.log(`Inserting ${keywordMatches.length} keyword-matched conversations at position 10`);
        expandedResults.splice(10, 0, ...keywordMatches);
    }

    return expandedResults;
}

/**
 * Get embedding stats for a project
 */
export async function getProjectEmbeddingStats(
    projectId: string,
    logger?: PrefixLogger
): Promise<{ totalPoints: number; byProvider: Record<string, number> }> {
    const log = logger || new PrefixLogger('embedding-service');

    try {
        await ensureKnowledgeCollection(log);

        // Count total points for project
        const countResult = await qdrantClient.count(KNOWLEDGE_COLLECTION, {
            filter: {
                must: [
                    { key: 'projectId', match: { value: projectId } },
                ],
            },
            exact: true,
        });

        // This is a simplified version - in production you'd want to aggregate by provider
        return {
            totalPoints: countResult.count,
            byProvider: {},
        };
    } catch (error) {
        log.log(`Error getting embedding stats: ${error}`);
        return { totalPoints: 0, byProvider: {} };
    }
}
