/**
 * Topic-Centric Knowledge Service
 * 
 * This service implements an entity/topic-centric approach to knowledge management.
 * Instead of just storing individual messages, it maintains "topic documents" that
 * aggregate ALL mentions of a topic across time and sources.
 * 
 * For example, a topic "postgres_latency" would contain:
 * - All mentions of postgres latency from Slack (400ms, 350ms, 240ms, etc.)
 * - Related Jira tickets (KAN-5)
 * - Related Confluence docs (Q1 Plan with 100ms goal)
 * 
 * This mimics how human memory works - associative, not temporal.
 */

import { generateText } from 'ai';
import { getPrimaryModel } from '@/lib/ai-model';
import { MongoDBKnowledgeDocumentsRepository } from '@/src/infrastructure/repositories/mongodb.knowledge-documents.repository';
import { PrefixLogger } from '@/lib/utils';
import { embedKnowledgeDocument } from './embedding-service';

const knowledgeDocumentsRepository = new MongoDBKnowledgeDocumentsRepository();

export interface TopicMention {
    value: string;           // The actual value/fact mentioned (e.g., "400ms")
    source: string;          // Where it came from (slack/jira/confluence)
    sourceId: string;        // Document ID of the source
    author?: string;         // Who said it
    timestamp: Date;         // When it was mentioned
    context?: string;        // Surrounding context
    url?: string;            // Link to source
}

export interface TopicDocument {
    topicId: string;         // Normalized topic identifier (e.g., "postgres_latency")
    topicName: string;       // Human-readable name (e.g., "PostgreSQL Latency")
    mentions: TopicMention[]; // All mentions, chronologically ordered
    relatedTopics: string[]; // Related topic IDs
    lastUpdated: Date;
}

/**
 * Extract topics from a piece of text using LLM
 */
export async function extractTopics(
    text: string,
    logger?: PrefixLogger
): Promise<Array<{ topicId: string; topicName: string; value?: string }>> {
    const log = logger || new PrefixLogger('topic-knowledge');
    
    try {
        const result = await generateText({
            model: getPrimaryModel(),
            messages: [
                {
                    role: 'system',
                    content: `You are a topic extractor. Extract key topics/entities from the text.
For each topic, provide:
- topicId: lowercase_underscore format (e.g., "postgres_latency", "user_authentication")
- topicName: Human readable (e.g., "PostgreSQL Latency", "User Authentication")
- value: Any specific value mentioned for this topic (e.g., "400ms", "in progress", "$5000")

Focus on:
- Technical metrics (latency, performance, costs)
- Systems/services (postgres, auth, billing)
- People assignments/responsibilities
- Project statuses

Return JSON array. Example:
[{"topicId": "postgres_latency", "topicName": "PostgreSQL Latency", "value": "400ms"}]

If no clear topics, return empty array [].`
                },
                {
                    role: 'user',
                    content: text.substring(0, 2000) // Limit input size
                }
            ],
            temperature: 0,
        });
        
        // Parse JSON from response
        const jsonMatch = result.text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const topics = JSON.parse(jsonMatch[0]);
            log.log(`Extracted ${topics.length} topics from text`);
            return topics;
        }
        
        return [];
    } catch (e) {
        log.log(`Error extracting topics: ${e}`);
        return [];
    }
}

/**
 * Update or create a topic document with a new mention
 */
export async function updateTopicDocument(
    projectId: string,
    topicId: string,
    topicName: string,
    mention: TopicMention,
    logger?: PrefixLogger
): Promise<void> {
    const log = logger || new PrefixLogger('topic-knowledge');
    
    const sourceId = `topic:${topicId}`;
    
    try {
        // Find existing topic document
        const existing = await knowledgeDocumentsRepository.findBySourceId(projectId, 'internal', sourceId);
        
        let mentions: TopicMention[] = [];
        let relatedTopics: string[] = [];
        
        if (existing) {
            // Parse existing mentions
            const metadata = existing.metadata as any;
            mentions = metadata?.mentions || [];
            relatedTopics = metadata?.relatedTopics || [];
        }
        
        // Check if this exact mention already exists (by sourceId)
        const existingMentionIdx = mentions.findIndex(m => m.sourceId === mention.sourceId);
        if (existingMentionIdx >= 0) {
            // Update existing mention
            mentions[existingMentionIdx] = mention;
        } else {
            // Add new mention
            mentions.push(mention);
        }
        
        // Sort by timestamp
        mentions.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        
        // Build content that includes ALL mentions chronologically
        const content = buildTopicContent(topicName, mentions);
        
        const metadata = {
            topicId,
            topicName,
            mentions,
            relatedTopics,
            mentionCount: mentions.length,
            lastValue: mentions[mentions.length - 1]?.value,
            firstMentioned: mentions[0]?.timestamp,
            lastUpdated: new Date().toISOString(),
        };
        
        if (existing) {
            await knowledgeDocumentsRepository.update(existing.id, {
                content,
                metadata,
                sourceUpdatedAt: new Date().toISOString(),
            });
            log.log(`Updated topic "${topicName}" with new mention (now ${mentions.length} mentions)`);
        } else {
            await knowledgeDocumentsRepository.create({
                projectId,
                provider: 'internal',
                sourceType: 'topic_document',
                sourceId,
                title: `Topic: ${topicName}`,
                content,
                metadata,
                entityRefs: [],
                syncedAt: new Date().toISOString(),
            });
            log.log(`Created new topic document for "${topicName}"`);
        }
        
        // Re-embed the topic document
        const doc = await knowledgeDocumentsRepository.findBySourceId(projectId, 'internal', sourceId);
        if (doc) {
            await embedKnowledgeDocument({
                id: doc.id,
                projectId: doc.projectId,
                provider: doc.provider,
                sourceType: doc.sourceType,
                sourceId: doc.sourceId,
                title: doc.title,
                content: doc.content,
                metadata: doc.metadata,
                entityRefs: doc.entityRefs || [],
                syncedAt: doc.syncedAt,
            }, log);
        }
        
    } catch (e) {
        log.log(`Error updating topic document: ${e}`);
    }
}

/**
 * Build human-readable content from topic mentions
 */
function buildTopicContent(topicName: string, mentions: TopicMention[]): string {
    const lines: string[] = [];
    
    lines.push(`=== ${topicName} ===`);
    lines.push(`Total mentions: ${mentions.length}`);
    lines.push('');
    lines.push('Timeline of mentions:');
    lines.push('');
    
    for (const mention of mentions) {
        const date = new Date(mention.timestamp).toISOString().split('T')[0];
        const time = new Date(mention.timestamp).toISOString().split('T')[1].split('.')[0];
        const author = mention.author ? ` (${mention.author})` : '';
        const source = mention.source.charAt(0).toUpperCase() + mention.source.slice(1);
        
        lines.push(`[${date} ${time}] ${source}${author}: ${mention.value}`);
        if (mention.context) {
            lines.push(`  Context: ${mention.context.substring(0, 200)}`);
        }
        if (mention.url) {
            lines.push(`  URL: ${mention.url}`);
        }
        lines.push('');
    }
    
    // Add summary
    if (mentions.length > 1) {
        lines.push('---');
        lines.push(`First value: ${mentions[0].value} (${new Date(mentions[0].timestamp).toISOString().split('T')[0]})`);
        lines.push(`Latest value: ${mentions[mentions.length - 1].value} (${new Date(mentions[mentions.length - 1].timestamp).toISOString().split('T')[0]})`);
    }
    
    return lines.join('\n');
}

/**
 * Process a new message and extract/update topics
 */
export async function processMessageForTopics(
    projectId: string,
    messageId: string,
    content: string,
    source: 'slack' | 'jira' | 'confluence',
    metadata: {
        author?: string;
        timestamp: Date;
        url?: string;
        context?: string;
    },
    logger?: PrefixLogger
): Promise<string[]> {
    const log = logger || new PrefixLogger('topic-knowledge');
    
    // Extract topics from the message
    const topics = await extractTopics(content, log);
    
    if (topics.length === 0) {
        return [];
    }
    
    const updatedTopics: string[] = [];
    
    for (const topic of topics) {
        if (!topic.topicId || !topic.topicName) continue;
        
        const mention: TopicMention = {
            value: topic.value || content.substring(0, 100),
            source,
            sourceId: messageId,
            author: metadata.author,
            timestamp: metadata.timestamp,
            context: metadata.context || content.substring(0, 200),
            url: metadata.url,
        };
        
        await updateTopicDocument(projectId, topic.topicId, topic.topicName, mention, log);
        updatedTopics.push(topic.topicId);
    }
    
    return updatedTopics;
}

/**
 * Rebuild all topic documents from existing messages
 * This is useful for initial setup or re-indexing
 */
export async function rebuildTopicDocuments(
    projectId: string,
    logger?: PrefixLogger
): Promise<{ topicsCreated: number; mentionsProcessed: number }> {
    const log = logger || new PrefixLogger('topic-knowledge');
    
    log.log('Rebuilding topic documents from existing messages...');
    
    // First, delete existing topic documents
    const { items: existingTopics } = await knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'internal');
    const topicDocs = existingTopics.filter(d => d.sourceType === 'topic_document');
    
    if (topicDocs.length > 0) {
        log.log(`Deleting ${topicDocs.length} existing topic documents...`);
        for (const doc of topicDocs) {
            await knowledgeDocumentsRepository.delete(doc.id);
        }
    }
    
    // Get all Slack messages
    const { items: slackDocs } = await knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'slack');
    const messages = slackDocs.filter(d => d.sourceType === 'slack_message' || d.sourceType === 'slack_thread');
    
    // Get Jira issues
    const { items: jiraDocs } = await knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'jira');
    
    // Get Confluence pages
    const { items: confluenceDocs } = await knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'confluence');
    
    let mentionsProcessed = 0;
    const topicsFound = new Set<string>();
    
    // Process Slack messages
    log.log(`Processing ${messages.length} Slack messages...`);
    for (const msg of messages) {
        const topics = await processMessageForTopics(
            projectId,
            msg.id,
            msg.content,
            'slack',
            {
                author: (msg.metadata as any)?.userName || (msg.metadata as any)?.userId,
                timestamp: new Date(msg.sourceCreatedAt || msg.syncedAt),
                url: (msg.metadata as any)?.url,
                context: msg.content.substring(0, 200),
            },
            log
        );
        
        topics.forEach(t => topicsFound.add(t));
        mentionsProcessed++;
        
        if (mentionsProcessed % 20 === 0) {
            log.log(`Processed ${mentionsProcessed} messages, found ${topicsFound.size} unique topics`);
        }
    }
    
    // Process Jira issues
    log.log(`Processing ${jiraDocs.length} Jira issues...`);
    for (const issue of jiraDocs) {
        if (issue.sourceType !== 'jira_issue') continue;
        
        const topics = await processMessageForTopics(
            projectId,
            issue.id,
            issue.content,
            'jira',
            {
                author: (issue.metadata as any)?.assignee || (issue.metadata as any)?.reporter,
                timestamp: new Date(issue.sourceCreatedAt || issue.syncedAt),
                url: (issue.metadata as any)?.url,
                context: issue.title,
            },
            log
        );
        
        topics.forEach(t => topicsFound.add(t));
        mentionsProcessed++;
    }
    
    // Process Confluence pages (limited - just titles and summaries)
    log.log(`Processing ${confluenceDocs.length} Confluence pages...`);
    for (const page of confluenceDocs) {
        if (page.sourceType !== 'confluence_page') continue;
        
        // Only process first 500 chars to avoid rate limits
        const topics = await processMessageForTopics(
            projectId,
            page.id,
            page.content.substring(0, 500),
            'confluence',
            {
                timestamp: new Date(page.sourceCreatedAt || page.syncedAt),
                url: (page.metadata as any)?.url,
                context: page.title,
            },
            log
        );
        
        topics.forEach(t => topicsFound.add(t));
        mentionsProcessed++;
    }
    
    log.log(`Rebuild complete: ${topicsFound.size} topics, ${mentionsProcessed} sources processed`);
    
    return {
        topicsCreated: topicsFound.size,
        mentionsProcessed,
    };
}
