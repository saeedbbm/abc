/**
 * Topic Clustering Service
 * 
 * Groups related messages into conversations/topics for better context-aware embedding.
 * Uses semantic similarity and LLM-based topic detection to group messages that:
 * - Are in the same thread
 * - Are semantically related (Q&A patterns, follow-ups)
 * - Discuss the same topic even across time
 */

import { generateText, embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';
import { embeddingModel } from '@/lib/embedding';
import { PrefixLogger } from '@/lib/utils';
import { KnowledgeDocumentType } from '@/src/entities/models/knowledge-document';
import crypto from 'crypto';

/**
 * Generate a deterministic cluster ID from message IDs
 */
function generateClusterId(messageIds: string[], prefix: string = 'cluster'): string {
    const sortedIds = [...messageIds].sort();
    const hash = crypto.createHash('md5').update(sortedIds.join(':')).digest('hex').substring(0, 12);
    return `${prefix}:${hash}`;
}

export interface MessageForClustering {
    id: string;
    content: string;
    channelId: string;
    channelName: string;
    userId?: string;
    timestamp: Date;
    threadTs?: string;
    isThreadReply?: boolean;
    parentSourceId?: string;
}

export interface TopicCluster {
    id: string;
    topic: string;
    summary: string;
    messages: MessageForClustering[];
    channelId: string;
    channelName: string;
    startTime: Date;
    endTime: Date;
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Group messages by thread - messages with the same thread_ts belong together
 */
export function groupByThread(messages: MessageForClustering[]): Map<string, MessageForClustering[]> {
    const threads = new Map<string, MessageForClustering[]>();
    
    for (const msg of messages) {
        // Use thread_ts if it exists, otherwise use message's own timestamp as key
        const threadKey = msg.threadTs || `standalone:${msg.id}`;
        
        if (!threads.has(threadKey)) {
            threads.set(threadKey, []);
        }
        threads.get(threadKey)!.push(msg);
    }
    
    // Sort messages within each thread by timestamp
    for (const [key, msgs] of threads) {
        msgs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }
    
    return threads;
}

/**
 * Generate a meaningful topic name for a thread using LLM.
 * Produces a 3-6 word descriptive subject, not a container description.
 */
async function generateThreadTopicName(
    messages: MessageForClustering[],
    logger?: PrefixLogger
): Promise<string> {
    const log = logger || new PrefixLogger('topic-clustering');
    
    // For very short messages or single short messages, just extract keywords
    if (messages.length === 0) return 'General Discussion';
    
    // Build a preview of the thread (first 3 messages, max 200 chars each)
    const preview = messages.slice(0, 4).map(m => 
        m.content.substring(0, 200)
    ).join('\n---\n');
    
    try {
        const { text } = await generateText({
            model: openai('gpt-4o-mini'),
            prompt: `Read these Slack messages from a thread and output ONLY a short topic name (3-6 words) that describes the SUBJECT MATTER being discussed. Do NOT describe the container (e.g., no "Thread in #general", no "Slack conversation about"). Just the subject.

Examples of GOOD topic names: "Dashboard Invoice Loading Performance", "Redis Connection Pool Issue", "Q1 Release Code Freeze Schedule", "Acme Corp Billing Integration", "PostgreSQL Latency Optimization"
Examples of BAD topic names: "Thread conversation", "Discussion in #general", "Slack thread about work", "Team conversation"

Messages:
${preview}

Topic name:`,
            maxTokens: 30,
        });
        
        const cleaned = text.trim().replace(/^["']|["']$/g, '').replace(/^Topic:\s*/i, '').trim();
        if (cleaned && cleaned.length > 2 && cleaned.length < 100) {
            return cleaned;
        }
        return 'General Discussion';
    } catch (error) {
        log.log(`Error generating topic name: ${error}`);
        // Fallback: use first message content truncated
        const firstContent = messages[0].content.substring(0, 50).trim();
        return firstContent.length > 5 ? firstContent : 'General Discussion';
    }
}

/**
 * Cluster messages by semantic similarity using embeddings
 */
export async function clusterBySimilarity(
    messages: MessageForClustering[],
    similarityThreshold: number = 0.75,
    logger?: PrefixLogger
): Promise<MessageForClustering[][]> {
    const log = logger || new PrefixLogger('topic-clustering');
    
    if (messages.length === 0) return [];
    if (messages.length === 1) return [[messages[0]]];
    
    // Generate embeddings for all messages
    const contents = messages.map(m => m.content);
    const { embeddings } = await embedMany({
        model: embeddingModel,
        values: contents,
    });
    
    // Build similarity matrix and cluster using simple greedy approach
    const clusters: MessageForClustering[][] = [];
    const assigned = new Set<number>();
    
    for (let i = 0; i < messages.length; i++) {
        if (assigned.has(i)) continue;
        
        const cluster: MessageForClustering[] = [messages[i]];
        assigned.add(i);
        
        for (let j = i + 1; j < messages.length; j++) {
            if (assigned.has(j)) continue;
            
            const similarity = cosineSimilarity(embeddings[i], embeddings[j]);
            if (similarity >= similarityThreshold) {
                cluster.push(messages[j]);
                assigned.add(j);
            }
        }
        
        clusters.push(cluster);
    }
    
    log.log(`Clustered ${messages.length} messages into ${clusters.length} groups by similarity`);
    return clusters;
}

/**
 * Use LLM to identify topics and group messages that discuss the same thing
 */
export async function groupByTopicWithLLM(
    messages: MessageForClustering[],
    logger?: PrefixLogger
): Promise<TopicCluster[]> {
    const log = logger || new PrefixLogger('topic-clustering');
    
    if (messages.length === 0) return [];
    
    // Only skip LLM grouping for a single message
    if (messages.length === 1) {
        return [{
            id: `cluster:standalone:${messages[0].id}`,
            topic: 'Conversation',
            summary: messages[0].content,
            messages: [messages[0]],
            channelId: messages[0].channelId,
            channelName: messages[0].channelName,
            startTime: messages[0].timestamp,
            endTime: messages[0].timestamp,
        }];
    }
    
    // Format messages for LLM
    const formattedMessages = messages.map((m, i) => 
        `[${i}] ${m.timestamp.toISOString().split('T')[1].split('.')[0]} - ${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`
    ).join('\n');
    
    // Ask LLM to identify topic groups
    const prompt = `Analyze these Slack messages and group them by topic/conversation.

Messages:
${formattedMessages}

Output JSON with this format:
{
  "groups": [
    {
      "topic": "Short topic name",
      "message_indices": [0, 2, 5],
      "summary": "Brief summary of what this conversation is about"
    }
  ]
}

Rules:
- Group messages that are clearly discussing the same topic
- A message can belong to MULTIPLE groups if it relates to multiple topics
- Include Q&A pairs together (question + answer)
- Messages replying to each other should be grouped
- If a message corrects or updates information from another, group them together
- Be liberal with grouping - better to over-group than under-group

Output ONLY valid JSON, no explanation.`;

    try {
        const { text } = await generateText({
            model: openai('gpt-4o-mini'),
            prompt,
            maxTokens: 1000,
        });
        
        // Parse LLM response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            log.log('LLM did not return valid JSON, falling back to thread grouping');
            return groupByTopicWithLLM(messages.slice(0, 3), logger); // Fallback
        }
        
        const result = JSON.parse(jsonMatch[0]);
        const clusters: TopicCluster[] = [];
        
        for (const group of result.groups || []) {
            const groupMessages = (group.message_indices || [])
                .filter((i: number) => i >= 0 && i < messages.length)
                .map((i: number) => messages[i]);
            
            if (groupMessages.length === 0) continue;
            
            // Sort by timestamp
            groupMessages.sort((a: MessageForClustering, b: MessageForClustering) => 
                a.timestamp.getTime() - b.timestamp.getTime()
            );
            
            // Generate deterministic ID from message IDs so clusters can be updated on re-sync
            const clusterMessageIds = groupMessages.map((m: MessageForClustering) => m.id);
            clusters.push({
                id: generateClusterId(clusterMessageIds, 'topic'),
                topic: group.topic || 'Conversation',
                summary: group.summary || '',
                messages: groupMessages,
                channelId: groupMessages[0].channelId,
                channelName: groupMessages[0].channelName,
                startTime: groupMessages[0].timestamp,
                endTime: groupMessages[groupMessages.length - 1].timestamp,
            });
        }
        
        log.log(`LLM grouped ${messages.length} messages into ${clusters.length} topics`);
        return clusters;
        
    } catch (error) {
        log.log(`Error in LLM topic grouping: ${error}`);
        // Fallback to thread-based grouping
        const threadGroups = groupByThread(messages);
        return Array.from(threadGroups.values()).map((msgs, i) => ({
            id: generateClusterId(msgs.map(m => m.id), 'fallback'),
            topic: 'Conversation',
            summary: msgs.map(m => m.content).join('\n'),
            messages: msgs,
            channelId: msgs[0].channelId,
            channelName: msgs[0].channelName,
            startTime: msgs[0].timestamp,
            endTime: msgs[msgs.length - 1].timestamp,
        }));
    }
}

/**
 * Create enriched content for a message that includes its conversation context
 */
export function createContextualContent(
    message: MessageForClustering,
    cluster: TopicCluster
): string {
    const lines: string[] = [];
    
    // Add topic/conversation header
    if (cluster.topic && cluster.topic !== 'Conversation') {
        lines.push(`[Topic: ${cluster.topic}]`);
    }
    
    // Add context from other messages in the cluster
    const otherMessages = cluster.messages.filter(m => m.id !== message.id);
    if (otherMessages.length > 0) {
        lines.push('[Conversation context:]');
        for (const other of otherMessages) {
            const timeStr = other.timestamp.toISOString().split('T')[1].split('.')[0];
            const preview = other.content.substring(0, 150);
            lines.push(`  ${timeStr}: ${preview}${other.content.length > 150 ? '...' : ''}`);
        }
        lines.push('');
    }
    
    // Add the main message
    lines.push('[This message:]');
    lines.push(message.content);
    
    return lines.join('\n');
}

/**
 * Create a conversation summary document content
 */
export function createConversationSummaryContent(cluster: TopicCluster): string {
    const lines: string[] = [];
    
    lines.push(`Topic: ${cluster.topic}`);
    lines.push(`Channel: #${cluster.channelName}`);
    lines.push(`Time: ${cluster.startTime.toISOString()} - ${cluster.endTime.toISOString()}`);
    lines.push('');
    
    if (cluster.summary) {
        lines.push(`Summary: ${cluster.summary}`);
        lines.push('');
    }
    
    lines.push('Full conversation:');
    for (const msg of cluster.messages) {
        const timeStr = msg.timestamp.toISOString().split('T')[1].split('.')[0];
        lines.push(`[${timeStr}] ${msg.content}`);
    }
    
    return lines.join('\n');
}

/**
 * Process messages from a channel and create topic clusters
 */
export async function clusterChannelMessages(
    messages: MessageForClustering[],
    options: {
        batchSize?: number;
        useLLM?: boolean;
        similarityThreshold?: number;
    } = {},
    logger?: PrefixLogger
): Promise<TopicCluster[]> {
    const log = logger || new PrefixLogger('topic-clustering');
    const { batchSize = 20, useLLM = true, similarityThreshold = 0.7 } = options;
    
    if (messages.length === 0) return [];
    
    // Sort by timestamp
    const sorted = [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    // First, group by thread (this is always correct)
    const threadGroups = groupByThread(sorted);
    const allClusters: TopicCluster[] = [];
    
    // Process each thread group
    for (const [threadKey, threadMessages] of threadGroups) {
        if (threadKey.startsWith('standalone:')) {
            // Standalone message - will be processed with other standalone messages
            continue;
        }
        
        // Use LLM to generate a meaningful topic name from the thread content
        let topic = await generateThreadTopicName(threadMessages, log);
        
        // Thread messages form a natural cluster
        allClusters.push({
            id: generateClusterId(threadMessages.map(m => m.id), 'thread'),
            topic,
            summary: '',
            messages: threadMessages,
            channelId: threadMessages[0].channelId,
            channelName: threadMessages[0].channelName,
            startTime: threadMessages[0].timestamp,
            endTime: threadMessages[threadMessages.length - 1].timestamp,
        });
    }
    
    // Get standalone messages (not part of a thread)
    const standaloneMessages = sorted.filter(m => !m.threadTs || m.threadTs === m.id);
    
    if (standaloneMessages.length > 0) {
        if (useLLM && standaloneMessages.length >= 2) {
            // Process in batches for LLM grouping
            for (let i = 0; i < standaloneMessages.length; i += batchSize) {
                const batch = standaloneMessages.slice(i, i + batchSize);
                const batchClusters = await groupByTopicWithLLM(batch, log);
                allClusters.push(...batchClusters);
            }
        } else {
            // Use similarity-based clustering
            const similarityClusters = await clusterBySimilarity(standaloneMessages, similarityThreshold, log);
            for (let i = 0; i < similarityClusters.length; i++) {
                const msgs = similarityClusters[i];
                allClusters.push({
                    id: generateClusterId(msgs.map(m => m.id), 'similarity'),
                    topic: 'Related messages',
                    summary: '',
                    messages: msgs,
                    channelId: msgs[0].channelId,
                    channelName: msgs[0].channelName,
                    startTime: msgs[0].timestamp,
                    endTime: msgs[msgs.length - 1].timestamp,
                });
            }
        }
    }
    
    // POST-PROCESSING: Merge orphaned 1-message clusters into nearby thread/topic clusters
    const orphaned: TopicCluster[] = [];
    const viable: TopicCluster[] = [];
    
    for (const cluster of allClusters) {
        if (cluster.messages.length === 1) {
            orphaned.push(cluster);
        } else {
            viable.push(cluster);
        }
    }
    
    if (orphaned.length > 0 && viable.length > 0) {
        log.log(`Found ${orphaned.length} orphaned 1-message clusters, attempting to merge into nearby conversations`);
        
        for (const orphan of orphaned) {
            const orphanTime = orphan.messages[0].timestamp.getTime();
            const orphanContent = orphan.messages[0].content.toLowerCase();
            
            // Find the closest viable cluster by time proximity (within 2 hours)
            let bestMatch: TopicCluster | null = null;
            let bestTimeDiff = 2 * 60 * 60 * 1000; // 2 hours max
            
            for (const candidate of viable) {
                // Must be in the same channel
                if (candidate.channelId !== orphan.channelId) continue;
                
                const startDiff = Math.abs(orphanTime - candidate.startTime.getTime());
                const endDiff = Math.abs(orphanTime - candidate.endTime.getTime());
                const minDiff = Math.min(startDiff, endDiff);
                
                if (minDiff < bestTimeDiff) {
                    bestTimeDiff = minDiff;
                    bestMatch = candidate;
                }
            }
            
            if (bestMatch) {
                log.log(`Merging orphan "${orphan.messages[0].content.substring(0, 40)}" into cluster "${bestMatch.topic}" (time diff: ${Math.round(bestTimeDiff / 1000)}s)`);
                bestMatch.messages.push(orphan.messages[0]);
                // Re-sort messages by timestamp
                bestMatch.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
                // Update time range
                bestMatch.startTime = bestMatch.messages[0].timestamp;
                bestMatch.endTime = bestMatch.messages[bestMatch.messages.length - 1].timestamp;
                // Regenerate cluster ID since messages changed
                bestMatch.id = generateClusterId(bestMatch.messages.map(m => m.id), 'merged');
            } else {
                // No nearby cluster found, keep the orphan as-is
                viable.push(orphan);
            }
        }
    } else if (orphaned.length > 0) {
        // No viable clusters to merge into, keep orphans
        viable.push(...orphaned);
    }
    
    log.log(`Created ${viable.length} topic clusters from ${messages.length} messages`);
    return viable;
}
