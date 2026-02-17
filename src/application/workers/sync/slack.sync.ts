import { SlackClient } from "@/src/application/lib/integrations/slack";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { MongoDBSyncStateRepository } from "@/src/infrastructure/repositories/mongodb.sync-state.repository";
import { 
    SlackUserType, 
    SlackChannelType, 
    SlackMessageType 
} from "@/src/application/lib/integrations/slack/types";
import { PrefixLogger } from "@/lib/utils";
import { embedKnowledgeDocuments, ensureKnowledgeCollection } from "@/src/application/lib/knowledge";
import { KnowledgeDocumentType } from "@/src/entities/models/knowledge-document";
import { 
    MessageForClustering, 
    TopicCluster, 
    clusterChannelMessages, 
    createConversationSummaryContent 
} from "@/src/application/lib/knowledge/topic-clustering";

export interface SlackSyncOptions {
    projectId: string;
    // How far back to sync messages (in days)
    messageDays?: number;
    // Whether to sync private channels
    includePrivate?: boolean;
    // Whether to sync thread replies
    includeThreadReplies?: boolean;
    // Whether to generate embeddings (default: true)
    generateEmbeddings?: boolean;
    // Force full sync even if we have previous sync state
    fullSync?: boolean;
    // Whether to create topic-clustered conversation summaries (default: true)
    createConversationSummaries?: boolean;
}

export class SlackSyncWorker {
    private oauthTokensRepository: MongoDBOAuthTokensRepository;
    private knowledgeDocumentsRepository: MongoDBKnowledgeDocumentsRepository;
    private knowledgeEntitiesRepository: MongoDBKnowledgeEntitiesRepository;
    private syncStateRepository: MongoDBSyncStateRepository;
    private logger: PrefixLogger;

    constructor(
        oauthTokensRepository: MongoDBOAuthTokensRepository,
        knowledgeDocumentsRepository: MongoDBKnowledgeDocumentsRepository,
        knowledgeEntitiesRepository: MongoDBKnowledgeEntitiesRepository,
        logger?: PrefixLogger
    ) {
        this.oauthTokensRepository = oauthTokensRepository;
        this.knowledgeDocumentsRepository = knowledgeDocumentsRepository;
        this.knowledgeEntitiesRepository = knowledgeEntitiesRepository;
        this.syncStateRepository = new MongoDBSyncStateRepository();
        this.logger = logger || new PrefixLogger('slack-sync');
    }

    async sync(options: SlackSyncOptions): Promise<{
        users: number;
        channels: number;
        messages: number;
        threads: number;
        conversations: number;
        embedded: number;
    }> {
        const { projectId, messageDays = 7, includePrivate = true, includeThreadReplies = true, generateEmbeddings = true, fullSync = false, createConversationSummaries = true } = options;
        
        this.logger.log(`Starting Slack sync for project ${projectId}`);

        // Update sync state to 'syncing'
        await this.syncStateRepository.upsert(projectId, 'slack', {
            status: 'syncing',
            lastError: null,
        });

        try {
            // Get OAuth token
            const token = await this.oauthTokensRepository.fetchByProjectAndProvider(projectId, 'slack');
            if (!token) {
                throw new Error('Slack not connected for this project');
            }

            const client = new SlackClient(token.accessToken, token.metadata?.teamId);

            let stats = {
                users: 0,
                channels: 0,
                messages: 0,
                threads: 0,
                conversations: 0,
                embedded: 0,
            };

            // Ensure embedding collection exists
            if (generateEmbeddings) {
                await ensureKnowledgeCollection(this.logger);
            }

            // Get previous sync state for incremental sync
            const prevState = await this.syncStateRepository.fetch(projectId, 'slack');
            
            // Determine oldest message timestamp to sync from
            let oldest: Date;
            if (!fullSync && prevState?.lastCursor) {
                // Incremental sync: start from last cursor
                oldest = new Date(parseFloat(prevState.lastCursor) * 1000);
                this.logger.log(`Incremental sync from: ${oldest.toISOString()}`);
            } else {
                // Full sync: go back messageDays
                oldest = new Date();
                oldest.setDate(oldest.getDate() - messageDays);
                this.logger.log(`Full sync from: ${oldest.toISOString()}`);
            }

            // Sync users
            this.logger.log('Syncing users...');
            stats.users = await this.syncUsers(client, projectId);
            this.logger.log(`Synced ${stats.users} users`);

            // Sync channels
            this.logger.log('Syncing channels...');
            const channelTypes = includePrivate ? 'public_channel,private_channel' : 'public_channel';
            stats.channels = await this.syncChannels(client, projectId, channelTypes);
            this.logger.log(`Synced ${stats.channels} channels`);

            // Auto-join public channels to ensure we can read message history
            this.logger.log('Joining public channels...');
            const { joined, failed } = await client.joinAllPublicChannels();
            if (joined > 0) {
                this.logger.log(`Joined ${joined} channels (${failed} could not be joined)`);
            }

            // Sync messages
            this.logger.log('Syncing messages...');
            const { messages, threads, latestTimestamp } = await this.syncMessages(client, projectId, oldest, includeThreadReplies);
            stats.messages = messages;
            stats.threads = threads;
            this.logger.log(`Synced ${stats.messages} messages and ${stats.threads} threads`);

            // Create conversation summaries by clustering related messages
            if (createConversationSummaries && stats.messages > 0) {
                this.logger.log('Creating conversation summaries...');
                stats.conversations = await this.createConversationSummaries(projectId);
                this.logger.log(`Created ${stats.conversations} conversation summaries`);
            }

            // Generate embeddings for all Slack documents
            if (generateEmbeddings) {
                this.logger.log(`Fetching all Slack documents for embedding...`);
                const { items: slackDocs } = await this.knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'slack');
                
                if (slackDocs.length > 0) {
                    this.logger.log(`Generating embeddings for ${slackDocs.length} documents...`);
                    const embeddingResults = await embedKnowledgeDocuments(slackDocs, this.logger);
                    stats.embedded = embeddingResults.filter(r => r.success).reduce((sum, r) => sum + r.chunksCreated, 0);
                    this.logger.log(`Created ${stats.embedded} embedding chunks`);
                }
            }

            // Update sync state with success
            const docCount = await this.knowledgeDocumentsRepository.countByProjectId(projectId, { provider: 'slack' });
            await this.syncStateRepository.upsert(projectId, 'slack', {
                status: 'idle',
                lastSyncedAt: new Date().toISOString(),
                lastCursor: latestTimestamp || prevState?.lastCursor || null,
                totalDocuments: docCount,
                totalEmbeddings: stats.embedded,
                consecutiveErrors: 0,
                lastError: null,
            });

            this.logger.log(`Slack sync completed for project ${projectId}`);
            return stats;
        } catch (error) {
            // Update sync state with error
            const prevState = await this.syncStateRepository.fetch(projectId, 'slack');
            await this.syncStateRepository.upsert(projectId, 'slack', {
                status: 'error',
                lastError: error instanceof Error ? error.message : String(error),
                consecutiveErrors: (prevState?.consecutiveErrors || 0) + 1,
            });
            
            throw error;
        }
    }

    private async syncUsers(client: SlackClient, projectId: string): Promise<number> {
        let count = 0;

        for await (const user of client.listAllUsers()) {
            // Skip bots and deleted users
            if (user.is_bot || user.deleted) continue;

            try {
                await this.upsertSlackUser(projectId, user);
                count++;
            } catch (error) {
                this.logger.log(`Error syncing user ${user.id}: ${error}`);
            }
        }

        return count;
    }

    private async upsertSlackUser(projectId: string, user: SlackUserType): Promise<void> {
        const sourceId = user.id;
        
        // Check if user document already exists
        const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'slack', sourceId);
        
        const content = this.formatUserContent(user);
        const metadata = {
            userId: user.id,
            email: user.profile?.email,
            displayName: user.profile?.display_name || user.profile?.real_name,
            realName: user.profile?.real_name,
            title: user.profile?.title,
            isBot: user.is_bot || false,
            isAdmin: user.is_admin || false,
            teamId: user.team_id,
            avatarUrl: user.profile?.image_192 || user.profile?.image_72,
        };

        if (existing) {
            // Update if content changed
            if (existing.content !== content) {
                await this.knowledgeDocumentsRepository.update(existing.id, {
                    content,
                    metadata,
                    sourceUpdatedAt: new Date().toISOString(),
                });
            }
        } else {
            await this.knowledgeDocumentsRepository.create({
                projectId,
                provider: 'slack',
                sourceType: 'slack_user',
                sourceId,
                title: user.profile?.real_name || user.name,
                content,
                metadata,
                entityRefs: [],
                syncedAt: new Date().toISOString(),
            });
        }

        // Also create/update entity
        await this.knowledgeEntitiesRepository.bulkUpsert([{
            projectId,
            type: 'person',
            name: user.profile?.real_name || user.name,
            aliases: [
                user.name,
                user.profile?.display_name,
                user.profile?.email,
            ].filter(Boolean) as string[],
            metadata: {
                email: user.profile?.email,
                slackUserId: user.id,
                role: user.profile?.title,
                slackDisplayName: user.profile?.display_name,
                avatarUrl: user.profile?.image_192,
            },
            sources: [{
                provider: 'slack',
                sourceType: 'user',
                sourceId: user.id,
                lastSeen: new Date().toISOString(),
                confidence: 1,
            }],
        }]);
    }

    private formatUserContent(user: SlackUserType): string {
        const lines = [
            `Name: ${user.profile?.real_name || user.name}`,
        ];
        
        if (user.profile?.display_name) {
            lines.push(`Display Name: ${user.profile.display_name}`);
        }
        if (user.profile?.email) {
            lines.push(`Email: ${user.profile.email}`);
        }
        if (user.profile?.title) {
            lines.push(`Title: ${user.profile.title}`);
        }
        if (user.is_admin) {
            lines.push('Role: Admin');
        }

        return lines.join('\n');
    }

    private async syncChannels(client: SlackClient, projectId: string, types: string): Promise<number> {
        let count = 0;

        for await (const channel of client.listAllChannels(types)) {
            // Skip archived channels
            if (channel.is_archived) continue;

            try {
                await this.upsertSlackChannel(client, projectId, channel);
                count++;
            } catch (error) {
                this.logger.log(`Error syncing channel ${channel.id}: ${error}`);
            }
        }

        return count;
    }

    private async upsertSlackChannel(client: SlackClient, projectId: string, channel: SlackChannelType): Promise<void> {
        const sourceId = channel.id;
        
        // Get channel members
        let members: string[] = [];
        try {
            members = await client.getAllChannelMembers(channel.id);
        } catch (error) {
            this.logger.log(`Error getting members for channel ${channel.id}: ${error}`);
        }

        const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'slack', sourceId);
        
        const content = this.formatChannelContent(channel, members);
        const metadata = {
            channelId: channel.id,
            isPrivate: channel.is_private || false,
            isArchived: channel.is_archived || false,
            memberCount: members.length,
            topic: channel.topic?.value,
            purpose: channel.purpose?.value,
            creator: channel.creator,
        };

        if (existing) {
            if (existing.content !== content) {
                await this.knowledgeDocumentsRepository.update(existing.id, {
                    content,
                    metadata,
                    sourceUpdatedAt: new Date().toISOString(),
                });
            }
        } else {
            await this.knowledgeDocumentsRepository.create({
                projectId,
                provider: 'slack',
                sourceType: 'slack_channel',
                sourceId,
                title: `#${channel.name}`,
                content,
                metadata,
                entityRefs: [],
                syncedAt: new Date().toISOString(),
            });
        }

        // Create team entity if this looks like a team channel
        if (channel.name.includes('team') || channel.purpose?.value?.toLowerCase().includes('team')) {
            await this.knowledgeEntitiesRepository.bulkUpsert([{
                projectId,
                type: 'team',
                name: channel.name.replace(/[-_]/g, ' ').replace('team', '').trim() || channel.name,
                aliases: [`#${channel.name}`],
                metadata: {
                    slackChannel: `#${channel.name}`,
                    slackChannelId: channel.id,
                    responsibilities: channel.purpose?.value ? [channel.purpose.value] : [],
                },
                sources: [{
                    provider: 'slack',
                    sourceType: 'channel',
                    sourceId: channel.id,
                    lastSeen: new Date().toISOString(),
                    confidence: 0.7,
                }],
            }]);
        }
    }

    private formatChannelContent(channel: SlackChannelType, members: string[]): string {
        const lines = [
            `Channel: #${channel.name}`,
            `Type: ${channel.is_private ? 'Private' : 'Public'}`,
        ];
        
        if (channel.topic?.value) {
            lines.push(`Topic: ${channel.topic.value}`);
        }
        if (channel.purpose?.value) {
            lines.push(`Purpose: ${channel.purpose.value}`);
        }
        lines.push(`Members: ${members.length}`);

        return lines.join('\n');
    }

    private async syncMessages(
        client: SlackClient, 
        projectId: string, 
        oldest: Date,
        includeThreadReplies: boolean
    ): Promise<{ messages: number; threads: number; latestTimestamp: string | null }> {
        let messageCount = 0;
        let threadCount = 0;
        let latestTimestamp: string | null = null;

        // Get all channels
        for await (const channel of client.listAllChannels()) {
            if (channel.is_archived) continue;

            try {
                for await (const message of client.getChannelMessages(channel.id, oldest)) {
                    // Skip bot messages and system messages
                    if (message.subtype && message.subtype !== 'thread_broadcast') continue;
                    if (!message.user) continue;

                    await this.upsertSlackMessage(projectId, channel, message);
                    messageCount++;

                    // Track the latest timestamp for incremental sync
                    if (!latestTimestamp || message.ts > latestTimestamp) {
                        latestTimestamp = message.ts;
                    }

                    // Sync thread replies if this is a thread parent
                    if (includeThreadReplies && message.reply_count && message.reply_count > 0 && message.thread_ts) {
                        const replies = await client.getAllThreadReplies(channel.id, message.thread_ts);
                        
                        // If any message in the thread involves PidraxBot, skip the entire thread
                        const threadHasBot = replies.some(r => SlackSyncWorker.isBotRelatedMessage(r));
                        if (threadHasBot) {
                            this.logger.log(`[Bot Filter] Skipping entire thread in #${channel.name} (thread_ts: ${message.thread_ts}) — contains bot interaction`);
                            continue;
                        }
                        
                        for (const reply of replies) {
                            // Skip the parent message (it's included in replies)
                            if (reply.ts === message.thread_ts) continue;
                            if (!reply.user) continue;

                            await this.upsertSlackMessage(projectId, channel, reply, message.ts);
                            threadCount++;

                            // Track the latest timestamp
                            if (!latestTimestamp || reply.ts > latestTimestamp) {
                                latestTimestamp = reply.ts;
                            }
                        }
                    }
                }
            } catch (error) {
                this.logger.log(`Error syncing messages for channel ${channel.id}: ${error}`);
            }
        }

        return { messages: messageCount, threads: threadCount, latestTimestamp };
    }

    /**
     * Check if a message should be excluded from ingestion.
     * Filters:
     *   - Messages authored by PidraxBot (bot_id, user ID, subtype)
     *   - Messages that mention/tag PidraxBot (someone asking the bot a question)
     *   - Messages containing the bot's name
     * Returns true if the message should be SKIPPED.
     */
    private static isBotRelatedMessage(message: { bot_id?: string; user?: string; subtype?: string; text?: string }): boolean {
        // 1. Authored by a bot (bot_id field set by Slack API)
        if (message.bot_id) return true;

        // 2. From known PidraxBot user ID
        if (message.user === 'U0ADKQNTY7P') return true;

        // 3. Is a bot_message subtype
        if (message.subtype === 'bot_message') return true;

        // 4. Message tags/mentions PidraxBot (someone asking it a question)
        const text = message.text || '';
        if (text.includes('<@U0ADKQNTY7P>')) return true;

        // 5. Message contains the bot name (any casing)
        const lower = text.toLowerCase();
        if (lower.includes('pidraxbot')) return true;
        if (lower.includes('pidrax knowledge bot')) return true;

        return false;
    }

    private async upsertSlackMessage(
        projectId: string, 
        channel: SlackChannelType, 
        message: SlackMessageType,
        parentTs?: string
    ): Promise<void> {
        // Skip messages authored by PidraxBot or mentioning/tagging PidraxBot
        if (SlackSyncWorker.isBotRelatedMessage(message)) {
            this.logger.log(`[Bot Filter] Skipping bot-related message in #${channel.name}: ${(message.text || '').substring(0, 60)}...`);
            return;
        }
        
        const content = message.text || '';
        const sourceId = `${channel.id}:${message.ts}`;
        
        const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'slack', sourceId);
        // Construct Slack message URL (format: https://workspace.slack.com/archives/CHANNEL/pTIMESTAMP)
        // Timestamp needs to have the dot removed for the URL
        const messageUrl = message.ts 
            ? `https://slack.com/archives/${channel.id}/p${message.ts.replace('.', '')}`
            : undefined;
        
        // Denormalize user profile onto message for rich rendering
        const userProfile = await this.resolveUserProfile(projectId, message.user);

        const metadata = {
            channelId: channel.id,
            channelName: channel.name,
            userId: message.user,
            threadTs: message.thread_ts,
            replyCount: message.reply_count,
            reactions: message.reactions?.map(r => ({ name: r.name, count: r.count })),
            mentions: this.extractMentions(message.text || ''),
            isThreadReply: !!parentTs,
            url: messageUrl,
            // Rich content for UI rendering
            blocks: message.blocks || undefined,
            attachments: message.attachments || undefined,
            files: message.files?.map(f => ({
                id: f.id,
                name: f.name,
                mimetype: f.mimetype,
                url: f.url_private,
                thumb: f.thumb_360 || f.thumb_80,
                size: f.size,
            })) || undefined,
            // Denormalized user info
            userProfile: userProfile || undefined,
        };

        // Calculate parent document ID if this is a thread reply
        let parentId: string | undefined;
        if (parentTs) {
            const parentSourceId = `${channel.id}:${parentTs}`;
            const parentDoc = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'slack', parentSourceId);
            parentId = parentDoc?.id;
        }

        const timestamp = new Date(parseFloat(message.ts) * 1000);

        if (existing) {
            if (existing.content !== content) {
                await this.knowledgeDocumentsRepository.update(existing.id, {
                    content,
                    metadata,
                    sourceUpdatedAt: timestamp.toISOString(),
                });
            }
        } else {
            await this.knowledgeDocumentsRepository.create({
                projectId,
                provider: 'slack',
                sourceType: parentTs ? 'slack_thread' : 'slack_message',
                sourceId,
                title: `Message in #${channel.name}`,
                content,
                metadata,
                entityRefs: [],
                parentId,
                parentSourceId: parentTs ? `${channel.id}:${parentTs}` : undefined,
                syncedAt: new Date().toISOString(),
                sourceCreatedAt: timestamp.toISOString(),
            });
        }
    }

    // User profile cache for denormalization onto messages
    private userProfileCache = new Map<string, { displayName: string; realName: string; avatarUrl?: string } | null>();

    private async resolveUserProfile(projectId: string, userId: string): Promise<{ displayName: string; realName: string; avatarUrl?: string } | null> {
        if (!userId) return null;
        if (this.userProfileCache.has(userId)) {
            return this.userProfileCache.get(userId) || null;
        }

        try {
            const userDoc = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'slack', userId);
            if (userDoc?.metadata) {
                const profile = {
                    displayName: userDoc.metadata.displayName || userDoc.metadata.realName || userId,
                    realName: userDoc.metadata.realName || userDoc.metadata.displayName || userId,
                    avatarUrl: userDoc.metadata.avatarUrl,
                };
                this.userProfileCache.set(userId, profile);
                return profile;
            }
        } catch {
            // Ignore lookup failures
        }
        this.userProfileCache.set(userId, null);
        return null;
    }

    private extractMentions(text: string): string[] {
        const mentionRegex = /<@([A-Z0-9]+)>/g;
        const mentions: string[] = [];
        let match;
        while ((match = mentionRegex.exec(text)) !== null) {
            mentions.push(match[1]);
        }
        return mentions;
    }

    /**
     * Create conversation summary documents by clustering related messages
     */
    private async createConversationSummaries(projectId: string): Promise<number> {
        // Get all Slack messages
        const { items: allDocs } = await this.knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'slack');
        
        // First, delete existing conversation summaries so we rebuild them fresh
        const existingConversations = allDocs.filter(doc => doc.sourceType === 'slack_conversation');
        if (existingConversations.length > 0) {
            this.logger.log(`Deleting ${existingConversations.length} existing conversation summaries...`);
            for (const conv of existingConversations) {
                await this.knowledgeDocumentsRepository.delete(conv.id);
            }
        }
        
        // Filter to only messages, excluding any that mention/tag PidraxBot
        const messageDocs = allDocs.filter(doc => {
            if (doc.sourceType !== 'slack_message' && doc.sourceType !== 'slack_thread') return false;
            const content = (doc.content || '').toLowerCase();
            if (content.includes('<@u0adkqnty7p>') || content.includes('pidraxbot') || content.includes('pidrax knowledge bot')) {
                this.logger.log(`[Bot Filter] Excluding bot-related doc from conversation summaries: ${doc.title}`);
                return false;
            }
            return true;
        });
        
        if (messageDocs.length === 0) {
            return 0;
        }

        // Build a map of docId -> url for attaching to conversation summaries
        const docUrlMap = new Map<string, string>();
        for (const doc of messageDocs) {
            if (doc.metadata?.url) {
                docUrlMap.set(doc.id, doc.metadata.url);
            }
        }

        // Convert to clustering format
        const messages: MessageForClustering[] = messageDocs.map(doc => ({
            id: doc.id,
            content: doc.content,
            channelId: doc.metadata?.channelId || '',
            channelName: doc.metadata?.channelName || '',
            userId: doc.metadata?.userId,
            timestamp: new Date(doc.sourceCreatedAt || doc.syncedAt),
            threadTs: doc.metadata?.threadTs,
            isThreadReply: doc.metadata?.isThreadReply || false,
            parentSourceId: doc.parentSourceId,
        }));

        // Group by channel first
        const byChannel = new Map<string, MessageForClustering[]>();
        for (const msg of messages) {
            if (!byChannel.has(msg.channelId)) {
                byChannel.set(msg.channelId, []);
            }
            byChannel.get(msg.channelId)!.push(msg);
        }

        let totalConversations = 0;

        // Process each channel
        for (const [channelId, channelMessages] of byChannel) {
            if (channelMessages.length < 2) continue; // Need at least 2 messages for a conversation
            
            this.logger.log(`Clustering ${channelMessages.length} messages from channel ${channelId}...`);
            
            try {
                // Cluster messages by topic
                const clusters = await clusterChannelMessages(channelMessages, {
                    batchSize: 15,
                    useLLM: true,
                }, this.logger);
                
                // Create conversation summary documents for clusters with 2+ messages
                for (const cluster of clusters) {
                    if (cluster.messages.length < 2) continue;
                    
                    const sourceId = `conversation:${cluster.id}`;
                    
                    // Check if this conversation already exists
                    const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'slack', sourceId);
                    
                    const content = createConversationSummaryContent(cluster);
                    
                    // Collect message URLs for this conversation
                    const messageUrls = cluster.messages
                        .map(m => docUrlMap.get(m.id))
                        .filter((url): url is string => !!url);
                    
                    const metadata = {
                        clusterId: cluster.id,
                        topic: cluster.topic,
                        channelId: cluster.channelId,
                        channelName: cluster.channelName,
                        messageCount: cluster.messages.length,
                        messageIds: cluster.messages.map(m => m.id),
                        messageUrls, // URLs of individual messages in this conversation
                        url: messageUrls[0], // Primary URL for the conversation (first message)
                        startTime: cluster.startTime.toISOString(),
                        endTime: cluster.endTime.toISOString(),
                    };
                    
                    if (existing) {
                        // Update if content changed
                        if (existing.content !== content) {
                            await this.knowledgeDocumentsRepository.update(existing.id, {
                                content,
                                metadata,
                                sourceUpdatedAt: new Date().toISOString(),
                            });
                        }
                    } else {
                        await this.knowledgeDocumentsRepository.create({
                            projectId,
                            provider: 'slack',
                            sourceType: 'slack_conversation',
                            sourceId,
                            title: `Conversation: ${cluster.topic} in #${cluster.channelName}`,
                            content,
                            metadata,
                            entityRefs: [],
                            syncedAt: new Date().toISOString(),
                            sourceCreatedAt: cluster.startTime.toISOString(),
                        });
                        totalConversations++;
                    }
                }
            } catch (error) {
                this.logger.log(`Error clustering channel ${channelId}: ${error}`);
            }
        }

        return totalConversations;
    }
}
