import { z } from "zod";

// --- Audit Finding Types ---

export const AuditFindingType = z.enum([
    'contradiction',   // Doc says X, but Slack/Jira evidence says Y
    'outdated',        // Doc describes something that has since changed
    'missing_update',  // New info from Slack/Jira not reflected in doc
    'undocumented',    // Topic discussed in Slack/Jira with no Confluence page
]);

export const AuditFindingSeverity = z.enum(['high', 'medium', 'low']);

export const AuditFindingStatus = z.enum([
    'pending',         // Just detected, not yet notified
    'notified',        // Slack notification sent
    'proposal_created', // Confluence page/comment created
    'review_requested', // Reviewer has been pinged
    'accepted',        // Reviewer accepted the proposal
    'rejected',        // Reviewer rejected the proposal
    'dismissed',       // Finding was dismissed as not relevant
]);

// Evidence source linking a finding to its origin
export const AuditEvidence = z.object({
    provider: z.enum(['slack', 'jira', 'confluence']),
    sourceType: z.string(),
    documentId: z.string(),           // KnowledgeDocument ID
    title: z.string(),
    url: z.string().optional(),       // Web URL to the source
    excerpt: z.string(),              // Relevant text excerpt
    timestamp: z.string().datetime().optional(),
});

export type AuditEvidenceType = z.infer<typeof AuditEvidence>;

// A suggested change to a Confluence page
export const ProposedChange = z.object({
    confluencePageId: z.string().optional(),       // Existing page being changed (null for new docs)
    confluencePageTitle: z.string(),
    confluenceSpaceId: z.string(),
    confluenceSpaceKey: z.string().optional(),
    
    // For edits: the proposed new content
    proposedBody: z.string().optional(),           // HTML body of proposed page
    
    // For new docs: child page or new page created
    proposalPageId: z.string().optional(),         // ID of the created proposal page
    proposalPageUrl: z.string().optional(),        // URL to the proposal page
    
    // Change summary
    changeSummary: z.string(),                     // Human-readable summary of what changed
});

export type ProposedChangeType = z.infer<typeof ProposedChange>;

// Slack notification tracking
export const SlackNotification = z.object({
    channelId: z.string(),
    channelName: z.string(),
    messageTs: z.string(),             // Main message timestamp
    threadTs: z.string().optional(),   // Thread timestamp for follow-ups
    mentionedUsers: z.array(z.string()), // Slack user IDs mentioned
    sentAt: z.string().datetime(),
});

export type SlackNotificationType = z.infer<typeof SlackNotification>;

// Smart question asked in a thread
export const SmartQuestion = z.object({
    question: z.string(),
    targetUserId: z.string(),          // Slack user ID
    targetUserName: z.string(),
    reason: z.string(),                // Why this person was asked
    answered: z.boolean().default(false),
    answer: z.string().optional(),
    answeredAt: z.string().datetime().optional(),
});

export type SmartQuestionType = z.infer<typeof SmartQuestion>;

// --- Main Audit Finding Schema ---

export const DocAuditFinding = z.object({
    id: z.string(),
    projectId: z.string(),
    
    // Finding classification
    type: AuditFindingType,
    severity: AuditFindingSeverity,
    status: AuditFindingStatus,
    
    // What was found
    title: z.string(),                 // Short description of the finding
    description: z.string(),           // Detailed description
    suggestedFix: z.string().optional(), // What should be changed
    
    // Source evidence
    evidence: z.array(AuditEvidence),
    
    // Related Confluence page (for conflicts/outdated)
    confluencePageId: z.string().optional(),
    confluencePageTitle: z.string().optional(),
    confluencePageUrl: z.string().optional(),
    
    // Proposed changes on Confluence
    proposedChange: ProposedChange.optional(),
    
    // Slack notifications
    slackNotification: SlackNotification.optional(),
    
    // Smart questions asked
    smartQuestions: z.array(SmartQuestion).default([]),
    
    // Related entities (people, teams, topics)
    relatedPersonIds: z.array(z.string()).default([]),   // KnowledgeEntity IDs
    relatedPersonSlackIds: z.array(z.string()).default([]), // Slack user IDs for mentions
    
    // Audit run tracking
    auditRunId: z.string(),            // Groups findings from the same audit run
    
    // Timestamps
    detectedAt: z.string().datetime(),
    notifiedAt: z.string().datetime().optional(),
    resolvedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type DocAuditFindingType = z.infer<typeof DocAuditFinding>;

// Schema for creating a new finding
export const CreateDocAuditFindingSchema = DocAuditFinding.omit({
    id: true,
    createdAt: true,
    updatedAt: true,
});

export type CreateDocAuditFindingType = z.infer<typeof CreateDocAuditFindingSchema>;

// Schema for updating a finding
export const UpdateDocAuditFindingSchema = z.object({
    status: AuditFindingStatus.optional(),
    proposedChange: ProposedChange.optional(),
    slackNotification: SlackNotification.optional(),
    smartQuestions: z.array(SmartQuestion).optional(),
    notifiedAt: z.string().datetime().optional(),
    resolvedAt: z.string().datetime().optional(),
});

export type UpdateDocAuditFindingType = z.infer<typeof UpdateDocAuditFindingSchema>;

// --- Audit Run Schema ---
// Tracks each execution of the doc audit

export const DocAuditRunStatus = z.enum([
    'running',
    'completed',
    'failed',
]);

export const DocAuditRun = z.object({
    id: z.string(),
    projectId: z.string(),
    status: DocAuditRunStatus,
    
    // What was audited
    confluencePagesScanned: z.number().default(0),
    slackConversationsScanned: z.number().default(0),
    jiraIssuesScanned: z.number().default(0),
    
    // Results
    conflictsFound: z.number().default(0),
    gapsFound: z.number().default(0),
    proposalsCreated: z.number().default(0),
    notificationsSent: z.number().default(0),
    
    // Error tracking
    error: z.string().optional(),
    
    // Timestamps
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type DocAuditRunType = z.infer<typeof DocAuditRun>;

// --- Audit Config Schema ---
// Per-project configuration for doc auditing

export const DocAuditConfig = z.object({
    id: z.string(),
    projectId: z.string(),
    
    enabled: z.boolean().default(false),
    
    // Schedule
    cronExpression: z.string().default('0 9 * * 1-5'), // Weekdays at 9 AM
    
    // Notification channel
    slackChannelName: z.string().default('documentation'),
    slackChannelId: z.string().optional(), // Resolved channel ID
    
    // What to audit
    auditConflicts: z.boolean().default(true),
    auditGaps: z.boolean().default(true),
    
    // Confluence settings
    targetSpaceIds: z.array(z.string()).default([]),  // Empty = all spaces
    proposalSpaceId: z.string().optional(),           // Where to create new docs
    
    // Pidrax Knowledge Base space
    pidraxSpaceKey: z.string().default('PK'),         // Space key for auto-generated docs
    pidraxSpaceId: z.string().optional(),             // Resolved space ID
    pidraxCategoryPages: z.record(z.string()).default({}), // Category -> page ID mapping
    
    // Thresholds
    conflictSimilarityThreshold: z.number().default(0.7),  // Min score to consider related
    gapSimilarityThreshold: z.number().default(0.5),       // Max score to consider undocumented
    minTopicMentions: z.number().default(3),                // Min mentions before flagging as gap
    
    // Discovery caching
    lastDiscoveryAt: z.string().datetime().optional(),      // When discovery was last run (for TTL caching)
    discoveryTtlMinutes: z.number().default(60),            // How long to cache discovery results (default: 1 hour)
    
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type DocAuditConfigType = z.infer<typeof DocAuditConfig>;
