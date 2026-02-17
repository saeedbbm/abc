import { 
    SlackUserType, 
    SlackChannelType, 
    SlackMessageType,
    SlackUsersListResponse,
    SlackConversationsListResponse,
    SlackConversationsHistoryResponse,
    SlackConversationsRepliesResponse,
    SlackConversationsMembersResponse,
    SlackPostMessageResponse,
} from './types';
import { slackRateLimiter, SlackApiTier } from './rate-limiter';

const SLACK_API_BASE = 'https://slack.com/api';

// Endpoint to tier mapping
const ENDPOINT_TIERS: Record<string, SlackApiTier> = {
    'users.list': 2,
    'users.info': 4,
    'conversations.list': 2,
    'conversations.info': 3,
    'conversations.history': 3,
    'conversations.replies': 3,
    'conversations.members': 3,
    'conversations.join': 3,
    'conversations.create': 2,
    'chat.postMessage': 1,
};

export class SlackClient {
    private accessToken: string;
    private teamId?: string;

    constructor(accessToken: string, teamId?: string) {
        this.accessToken = accessToken;
        this.teamId = teamId;
    }

    private async request<T>(
        endpoint: string, 
        params: Record<string, any> = {},
        method: 'GET' | 'POST' = 'GET'
    ): Promise<T> {
        const tier = ENDPOINT_TIERS[endpoint] || 3;
        await slackRateLimiter.waitForToken(endpoint, tier);

        const url = new URL(`${SLACK_API_BASE}/${endpoint}`);
        
        let response: Response;
        if (method === 'GET') {
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined) {
                    url.searchParams.append(key, String(value));
                }
            });
            response = await fetch(url.toString(), {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                },
            });
        } else {
            response = await fetch(url.toString(), {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json; charset=utf-8',
                },
                body: JSON.stringify(params),
            });
        }

        // Handle rate limiting
        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
            slackRateLimiter.setRetryAfter(endpoint, retryAfter);
            throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }

        const data = await response.json();
        
        if (!data.ok) {
            throw new Error(`Slack API error: ${data.error}`);
        }

        return data as T;
    }

    /**
     * List all users in the workspace
     */
    async listUsers(cursor?: string): Promise<{ users: SlackUserType[]; nextCursor?: string }> {
        const response = await this.request<{ members: SlackUserType[]; response_metadata?: { next_cursor?: string } }>(
            'users.list',
            { cursor, limit: 200 }
        );
        
        return {
            users: response.members || [],
            nextCursor: response.response_metadata?.next_cursor || undefined,
        };
    }

    /**
     * List all users with pagination
     */
    async *listAllUsers(): AsyncGenerator<SlackUserType> {
        let cursor: string | undefined;
        do {
            const { users, nextCursor } = await this.listUsers(cursor);
            for (const user of users) {
                yield user;
            }
            cursor = nextCursor;
        } while (cursor);
    }

    /**
     * List all channels (public and private that bot is in)
     */
    async listChannels(cursor?: string, types: string = 'public_channel,private_channel'): Promise<{ channels: SlackChannelType[]; nextCursor?: string }> {
        const response = await this.request<{ channels: SlackChannelType[]; response_metadata?: { next_cursor?: string } }>(
            'conversations.list',
            { cursor, limit: 200, types }
        );
        
        return {
            channels: response.channels || [],
            nextCursor: response.response_metadata?.next_cursor || undefined,
        };
    }

    /**
     * List all channels with pagination
     */
    async *listAllChannels(types: string = 'public_channel,private_channel'): AsyncGenerator<SlackChannelType> {
        let cursor: string | undefined;
        do {
            const { channels, nextCursor } = await this.listChannels(cursor, types);
            for (const channel of channels) {
                yield channel;
            }
            cursor = nextCursor;
        } while (cursor);
    }

    /**
     * Get channel members
     */
    async getChannelMembers(channelId: string, cursor?: string): Promise<{ members: string[]; nextCursor?: string }> {
        const response = await this.request<{ members: string[]; response_metadata?: { next_cursor?: string } }>(
            'conversations.members',
            { channel: channelId, cursor, limit: 200 }
        );
        
        return {
            members: response.members || [],
            nextCursor: response.response_metadata?.next_cursor || undefined,
        };
    }

    /**
     * Get all channel members with pagination
     */
    async getAllChannelMembers(channelId: string): Promise<string[]> {
        const allMembers: string[] = [];
        let cursor: string | undefined;
        do {
            const { members, nextCursor } = await this.getChannelMembers(channelId, cursor);
            allMembers.push(...members);
            cursor = nextCursor;
        } while (cursor);
        return allMembers;
    }

    /**
     * Get channel history (messages)
     */
    async getChannelHistory(
        channelId: string, 
        options: {
            cursor?: string;
            oldest?: string; // Unix timestamp
            latest?: string; // Unix timestamp
            limit?: number;
        } = {}
    ): Promise<{ messages: SlackMessageType[]; hasMore: boolean; nextCursor?: string }> {
        const response = await this.request<{ messages: SlackMessageType[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
            'conversations.history',
            { 
                channel: channelId, 
                cursor: options.cursor,
                oldest: options.oldest,
                latest: options.latest,
                limit: options.limit || 100,
            }
        );
        
        return {
            messages: response.messages || [],
            hasMore: response.has_more || false,
            nextCursor: response.response_metadata?.next_cursor,
        };
    }

    /**
     * Get all messages from a channel within a time range
     */
    async *getChannelMessages(
        channelId: string,
        oldest?: Date,
        latest?: Date
    ): AsyncGenerator<SlackMessageType> {
        let cursor: string | undefined;
        let hasMore = true;

        while (hasMore) {
            const { messages, hasMore: more, nextCursor } = await this.getChannelHistory(channelId, {
                cursor,
                oldest: oldest ? String(oldest.getTime() / 1000) : undefined,
                latest: latest ? String(latest.getTime() / 1000) : undefined,
            });
            
            for (const message of messages) {
                yield message;
            }
            
            hasMore = more;
            cursor = nextCursor;
        }
    }

    /**
     * Get thread replies
     */
    async getThreadReplies(
        channelId: string,
        threadTs: string,
        cursor?: string
    ): Promise<{ messages: SlackMessageType[]; hasMore: boolean; nextCursor?: string }> {
        const response = await this.request<{ messages: SlackMessageType[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
            'conversations.replies',
            { 
                channel: channelId, 
                ts: threadTs,
                cursor,
                limit: 100,
            }
        );
        
        return {
            messages: response.messages || [],
            hasMore: response.has_more || false,
            nextCursor: response.response_metadata?.next_cursor,
        };
    }

    /**
     * Get all thread replies
     */
    async getAllThreadReplies(channelId: string, threadTs: string): Promise<SlackMessageType[]> {
        const allMessages: SlackMessageType[] = [];
        let cursor: string | undefined;
        let hasMore = true;

        while (hasMore) {
            const { messages, hasMore: more, nextCursor } = await this.getThreadReplies(channelId, threadTs, cursor);
            allMessages.push(...messages);
            hasMore = more;
            cursor = nextCursor;
        }

        return allMessages;
    }

    /**
     * Post a message to a channel
     */
    async postMessage(
        channelId: string,
        text: string,
        options: {
            threadTs?: string;
            unfurlLinks?: boolean;
            unfurlMedia?: boolean;
        } = {}
    ): Promise<{ ts: string; channel: string }> {
        const response = await this.request<{ ts: string; channel: string }>(
            'chat.postMessage',
            {
                channel: channelId,
                text,
                thread_ts: options.threadTs,
                unfurl_links: options.unfurlLinks ?? false,
                unfurl_media: options.unfurlMedia ?? false,
            },
            'POST'
        );
        
        return {
            ts: response.ts,
            channel: response.channel,
        };
    }

    /**
     * Get user info
     */
    async getUserInfo(userId: string): Promise<SlackUserType> {
        const response = await this.request<{ user: SlackUserType }>(
            'users.info',
            { user: userId }
        );
        return response.user;
    }

    /**
     * Get channel info
     */
    async getChannelInfo(channelId: string): Promise<SlackChannelType> {
        const response = await this.request<{ channel: SlackChannelType }>(
            'conversations.info',
            { channel: channelId }
        );
        return response.channel;
    }

    /**
     * Join a channel
     */
    async joinChannel(channelId: string): Promise<{ channel: SlackChannelType }> {
        const response = await this.request<{ channel: SlackChannelType }>(
            'conversations.join',
            { channel: channelId },
            'POST'
        );
        return { channel: response.channel };
    }

    /**
     * Find a channel by name. Returns the channel or null if not found.
     */
    async findChannelByName(name: string): Promise<SlackChannelType | null> {
        for await (const channel of this.listAllChannels('public_channel,private_channel')) {
            if (channel.name === name || channel.name === name.replace('#', '')) {
                return channel;
            }
        }
        return null;
    }

    /**
     * Create a public channel. Returns the channel.
     */
    async createChannel(name: string): Promise<SlackChannelType> {
        const response = await this.request<{ channel: SlackChannelType }>(
            'conversations.create',
            { name: name.replace('#', ''), is_private: false },
            'POST'
        );
        return response.channel;
    }

    /**
     * Auto-join all public channels
     * Useful for ensuring the bot can read message history
     */
    async joinAllPublicChannels(): Promise<{ joined: number; failed: number }> {
        let joined = 0;
        let failed = 0;

        for await (const channel of this.listAllChannels('public_channel')) {
            if (channel.is_member) continue; // Already a member
            
            try {
                await this.joinChannel(channel.id);
                joined++;
            } catch (error) {
                // Silently fail for channels we can't join
                failed++;
            }
        }

        return { joined, failed };
    }
}
