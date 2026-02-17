import { z } from "zod";

// Slack API response types

export const SlackUser = z.object({
    id: z.string(),
    team_id: z.string().optional(),
    name: z.string(),
    deleted: z.boolean().optional(),
    real_name: z.string().optional(),
    profile: z.object({
        title: z.string().optional(),
        phone: z.string().optional(),
        real_name: z.string().optional(),
        real_name_normalized: z.string().optional(),
        display_name: z.string().optional(),
        display_name_normalized: z.string().optional(),
        email: z.string().optional(),
        image_24: z.string().optional(),
        image_32: z.string().optional(),
        image_48: z.string().optional(),
        image_72: z.string().optional(),
        image_192: z.string().optional(),
        image_512: z.string().optional(),
        team: z.string().optional(),
    }).optional(),
    is_admin: z.boolean().optional(),
    is_owner: z.boolean().optional(),
    is_bot: z.boolean().optional(),
    is_app_user: z.boolean().optional(),
    updated: z.number().optional(),
});

export type SlackUserType = z.infer<typeof SlackUser>;

export const SlackChannel = z.object({
    id: z.string(),
    name: z.string(),
    is_channel: z.boolean().optional(),
    is_group: z.boolean().optional(),
    is_im: z.boolean().optional(),
    is_mpim: z.boolean().optional(),
    is_private: z.boolean().optional(),
    is_archived: z.boolean().optional(),
    is_general: z.boolean().optional(),
    creator: z.string().optional(),
    name_normalized: z.string().optional(),
    topic: z.object({
        value: z.string(),
        creator: z.string().optional(),
        last_set: z.number().optional(),
    }).optional(),
    purpose: z.object({
        value: z.string(),
        creator: z.string().optional(),
        last_set: z.number().optional(),
    }).optional(),
    num_members: z.number().optional(),
    members: z.array(z.string()).optional(),
});

export type SlackChannelType = z.infer<typeof SlackChannel>;

export const SlackMessage = z.object({
    type: z.string(),
    subtype: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    text: z.string().optional(),
    ts: z.string(),
    thread_ts: z.string().optional(),
    reply_count: z.number().optional(),
    reply_users_count: z.number().optional(),
    latest_reply: z.string().optional(),
    reply_users: z.array(z.string()).optional(),
    reactions: z.array(z.object({
        name: z.string(),
        count: z.number(),
        users: z.array(z.string()),
    })).optional(),
    attachments: z.array(z.any()).optional(),
    blocks: z.array(z.any()).optional(),
    files: z.array(z.any()).optional(),
});

export type SlackMessageType = z.infer<typeof SlackMessage>;

export const SlackApiResponse = z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    response_metadata: z.object({
        next_cursor: z.string().optional(),
    }).optional(),
});

export const SlackUsersListResponse = SlackApiResponse.extend({
    members: z.array(SlackUser).optional(),
});

export const SlackConversationsListResponse = SlackApiResponse.extend({
    channels: z.array(SlackChannel).optional(),
});

export const SlackConversationsHistoryResponse = SlackApiResponse.extend({
    messages: z.array(SlackMessage).optional(),
    has_more: z.boolean().optional(),
});

export const SlackConversationsRepliesResponse = SlackApiResponse.extend({
    messages: z.array(SlackMessage).optional(),
    has_more: z.boolean().optional(),
});

export const SlackConversationsMembersResponse = SlackApiResponse.extend({
    members: z.array(z.string()).optional(),
});

export const SlackPostMessageResponse = SlackApiResponse.extend({
    channel: z.string().optional(),
    ts: z.string().optional(),
    message: SlackMessage.optional(),
});

// OAuth types
export const SlackOAuthResponse = z.object({
    ok: z.boolean(),
    access_token: z.string().optional(),
    token_type: z.string().optional(),
    scope: z.string().optional(),
    bot_user_id: z.string().optional(),
    app_id: z.string().optional(),
    team: z.object({
        name: z.string().optional(),
        id: z.string().optional(),
    }).optional(),
    authed_user: z.object({
        id: z.string().optional(),
        scope: z.string().optional(),
        access_token: z.string().optional(),
        token_type: z.string().optional(),
    }).optional(),
    error: z.string().optional(),
});

export type SlackOAuthResponseType = z.infer<typeof SlackOAuthResponse>;
