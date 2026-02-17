import { z } from "zod";

// Source types for each provider
export const SlackSourceTypes = z.enum([
    'slack_user',
    'slack_channel', 
    'slack_message',
    'slack_thread',
    'slack_conversation',
]);

export const JiraSourceTypes = z.enum([
    'jira_user',
    'jira_project',
    'jira_issue',
    'jira_comment',
    'jira_changelog',
]);

export const ConfluenceSourceTypes = z.enum([
    'confluence_space',
    'confluence_page',
    'confluence_user',
]);

export const InternalSourceTypes = z.enum([
    'topic_document',
    'company_profile',
]);

export const KnowledgeDocumentSourceType = z.union([
    SlackSourceTypes,
    JiraSourceTypes,
    ConfluenceSourceTypes,
    InternalSourceTypes,
]);

// Version history entry for documents
export const DocumentVersionEntry = z.object({
    version: z.number(),
    content: z.string(),
    metadata: z.record(z.any()),
    updatedAt: z.string().datetime(),
    sourceUpdatedAt: z.string().datetime().optional(),
});

export type DocumentVersionEntryType = z.infer<typeof DocumentVersionEntry>;

// Main Knowledge Document schema
export const KnowledgeDocument = z.object({
    id: z.string(),
    projectId: z.string(),
    provider: z.enum(['slack', 'jira', 'confluence', 'internal']),
    sourceType: KnowledgeDocumentSourceType,
    sourceId: z.string(), // External ID from the source system
    
    // Content
    title: z.string(),
    content: z.string(),
    
    // Metadata (provider-specific)
    metadata: z.record(z.any()),
    
    // Entity references extracted from this document
    entityRefs: z.array(z.string()).default([]), // linked entity IDs
    
    // Hierarchy (for threads, sub-pages, issue comments)
    parentId: z.string().optional(), // KnowledgeDocument ID
    parentSourceId: z.string().optional(), // Source system's parent ID
    
    // Timestamps
    syncedAt: z.string().datetime(),
    sourceCreatedAt: z.string().datetime().optional(),
    sourceUpdatedAt: z.string().datetime().optional(),
    
    // Versioning
    version: z.number().default(1),
    previousVersions: z.array(DocumentVersionEntry).default([]),
    
    // Processing status
    embeddingStatus: z.enum(['pending', 'ready', 'error']).default('pending'),
    embeddingError: z.string().optional(),
    
    // Timestamps for our system
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    
    // Soft delete
    deletedAt: z.string().datetime().optional(),
});

export type KnowledgeDocumentType = z.infer<typeof KnowledgeDocument>;

// Schema for creating a new document
export const CreateKnowledgeDocumentSchema = KnowledgeDocument.omit({
    id: true,
    version: true,
    previousVersions: true,
    embeddingStatus: true,
    embeddingError: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
});

export type CreateKnowledgeDocumentType = z.infer<typeof CreateKnowledgeDocumentSchema>;

// Schema for updating a document
export const UpdateKnowledgeDocumentSchema = z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    metadata: z.record(z.any()).optional(),
    entityRefs: z.array(z.string()).optional(),
    sourceUpdatedAt: z.string().datetime().optional(),
    embeddingStatus: z.enum(['pending', 'ready', 'error']).optional(),
    embeddingError: z.string().optional(),
});

export type UpdateKnowledgeDocumentType = z.infer<typeof UpdateKnowledgeDocumentSchema>;

// Slack-specific metadata
export const SlackMessageMetadata = z.object({
    channelId: z.string(),
    channelName: z.string().optional(),
    userId: z.string().optional(),
    userName: z.string().optional(),
    threadTs: z.string().optional(),
    replyCount: z.number().optional(),
    reactions: z.array(z.object({
        name: z.string(),
        count: z.number(),
    })).optional(),
    mentions: z.array(z.string()).optional(), // user IDs mentioned
    isThreadReply: z.boolean().default(false),
});

export const SlackChannelMetadata = z.object({
    channelId: z.string(),
    isPrivate: z.boolean().default(false),
    isArchived: z.boolean().default(false),
    memberCount: z.number().optional(),
    topic: z.string().optional(),
    purpose: z.string().optional(),
    creator: z.string().optional(),
});

export const SlackUserMetadata = z.object({
    userId: z.string(),
    email: z.string().optional(),
    displayName: z.string().optional(),
    realName: z.string().optional(),
    title: z.string().optional(),
    isBot: z.boolean().default(false),
    isAdmin: z.boolean().default(false),
    teamId: z.string().optional(),
});

// Jira-specific metadata
export const JiraIssueMetadata = z.object({
    issueId: z.string(),
    issueKey: z.string(),
    projectKey: z.string(),
    projectName: z.string().optional(),
    issueType: z.string(),
    status: z.string(),
    priority: z.string().optional(),
    assigneeId: z.string().optional(),
    assigneeName: z.string().optional(),
    reporterId: z.string().optional(),
    reporterName: z.string().optional(),
    labels: z.array(z.string()).optional(),
    linkedIssues: z.array(z.string()).optional(), // issue keys
});

export const JiraCommentMetadata = z.object({
    commentId: z.string(),
    issueKey: z.string(),
    authorId: z.string().optional(),
    authorName: z.string().optional(),
});

export const JiraProjectMetadata = z.object({
    projectId: z.string(),
    projectKey: z.string(),
    projectType: z.string().optional(),
    leadId: z.string().optional(),
    leadName: z.string().optional(),
});

// Confluence-specific metadata
export const ConfluencePageMetadata = z.object({
    pageId: z.string(),
    spaceId: z.string(),
    spaceKey: z.string().optional(),
    spaceName: z.string().optional(),
    authorId: z.string().optional(),
    authorName: z.string().optional(),
    parentPageId: z.string().optional(),
    parentPageTitle: z.string().optional(),
    versionNumber: z.number().optional(),
    webUrl: z.string().optional(),
});

export const ConfluenceSpaceMetadata = z.object({
    spaceId: z.string(),
    spaceKey: z.string(),
    spaceType: z.string().optional(),
    homepageId: z.string().optional(),
});
