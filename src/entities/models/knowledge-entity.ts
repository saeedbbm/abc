import { z } from "zod";

// Metadata schemas for different entity types

export const PersonMetadata = z.object({
    email: z.string().email().optional(),
    slackUserId: z.string().optional(),
    jiraAccountId: z.string().optional(),
    role: z.string().optional(),
    team: z.string().optional(),
    responsibilities: z.array(z.string()).default([]),
    workingOn: z.array(z.string()).default([]), // project entity refs
    skills: z.array(z.string()).default([]),
    manager: z.string().optional(), // entity ref
    reportsTo: z.string().optional(), // entity ref
    slackDisplayName: z.string().optional(),
    avatarUrl: z.string().optional(),
});

export type PersonMetadataType = z.infer<typeof PersonMetadata>;

export const ProjectMetadata = z.object({
    jiraKey: z.string().optional(),
    jiraProjectId: z.string().optional(),
    confluenceSpaceKey: z.string().optional(),
    confluenceSpaceId: z.string().optional(),
    slackChannels: z.array(z.string()).default([]),
    lead: z.string().optional(), // entity ref
    members: z.array(z.string()).default([]), // entity refs
    status: z.enum(['active', 'completed', 'on-hold', 'planning', 'unknown']).default('unknown'),
    technologies: z.array(z.string()).default([]),
    description: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
});

export type ProjectMetadataType = z.infer<typeof ProjectMetadata>;

export const TeamMetadata = z.object({
    slackChannel: z.string().optional(),
    slackChannelId: z.string().optional(),
    members: z.array(z.string()).default([]), // entity refs
    lead: z.string().optional(), // entity ref
    ownedSystems: z.array(z.string()).default([]),
    responsibilities: z.array(z.string()).default([]),
    parentTeam: z.string().optional(), // entity ref
});

export type TeamMetadataType = z.infer<typeof TeamMetadata>;

export const SystemMetadata = z.object({
    owner: z.string().optional(), // entity ref (person or team)
    team: z.string().optional(), // entity ref
    description: z.string().optional(),
    technologies: z.array(z.string()).default([]),
    dependencies: z.array(z.string()).default([]), // system entity refs
    dependents: z.array(z.string()).default([]), // system entity refs
    repository: z.string().optional(),
    documentation: z.string().optional(), // confluence page URL
    jiraComponent: z.string().optional(),
});

export type SystemMetadataType = z.infer<typeof SystemMetadata>;

export const TopicMetadata = z.object({
    description: z.string().optional(),
    keywords: z.array(z.string()).default([]),
    relatedEntities: z.array(z.string()).default([]), // entity refs
    confluencePages: z.array(z.string()).default([]), // page IDs
});

export type TopicMetadataType = z.infer<typeof TopicMetadata>;

export const CustomerMetadata = z.object({
    companyName: z.string().optional(),
    industry: z.string().optional(),
    contractType: z.string().optional(),           // e.g. "enterprise", "startup", "trial"
    keyContacts: z.array(z.object({
        name: z.string(),
        role: z.string().optional(),
        attitude: z.string().optional(),            // e.g. "friendly", "demanding", "technical"
        authority: z.string().optional(),            // e.g. "decision-maker", "influencer", "user"
        email: z.string().optional(),
    })).default([]),
    accountOwner: z.string().optional(),            // entity ref (person)
    projects: z.array(z.string()).default([]),       // entity refs (project)
    issueHistory: z.array(z.object({
        summary: z.string(),
        severity: z.string().optional(),
        resolvedAt: z.string().datetime().optional(),
        jiraKey: z.string().optional(),
    })).default([]),
    healthStatus: z.enum(['healthy', 'at-risk', 'churned', 'onboarding', 'unknown']).default('unknown'),
    notes: z.string().optional(),
    slackChannels: z.array(z.string()).default([]),  // dedicated customer channels
    confluencePages: z.array(z.string()).default([]),
});

export type CustomerMetadataType = z.infer<typeof CustomerMetadata>;

export const ProcessMetadata = z.object({
    description: z.string().optional(),
    steps: z.array(z.string()).default([]),
    owner: z.string().optional(),                   // entity ref (person or team)
    frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'ad-hoc', 'unknown']).default('unknown'),
    relatedSystems: z.array(z.string()).default([]), // entity refs (system)
    documentationLinks: z.array(z.string()).default([]), // URLs
    lastExecutedAt: z.string().datetime().optional(),
    participants: z.array(z.string()).default([]),   // entity refs (person)
    prerequisites: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),          // tool/system names
    category: z.enum([
        'deployment', 'release', 'onboarding', 'incident-response',
        'on-call', 'code-review', 'testing', 'monitoring',
        'security', 'compliance', 'other'
    ]).default('other'),
});

export type ProcessMetadataType = z.infer<typeof ProcessMetadata>;

// Entity source tracking
export const EntitySource = z.object({
    provider: z.enum(['slack', 'jira', 'confluence', 'manual']),
    sourceType: z.string(), // 'user', 'channel', 'issue', 'page', 'comment', etc.
    sourceId: z.string(),
    lastSeen: z.string().datetime(),
    confidence: z.number().default(1),
    extractedFields: z.array(z.string()).default([]), // which fields came from this source
});

export type EntitySourceType = z.infer<typeof EntitySource>;

// Version history entry
export const EntityVersionEntry = z.object({
    version: z.number(),
    metadata: z.record(z.any()),
    updatedAt: z.string().datetime(),
    reason: z.string().optional(), // why the change was made
    changedFields: z.array(z.string()).default([]), // which fields changed
});

export type EntityVersionEntryType = z.infer<typeof EntityVersionEntry>;

// Main Knowledge Entity schema
export const KnowledgeEntity = z.object({
    id: z.string(),
    projectId: z.string(),
    type: z.enum(['person', 'team', 'project', 'system', 'topic', 'customer', 'process']),
    name: z.string(),
    aliases: z.array(z.string()).default([]),
    metadata: z.union([
        PersonMetadata,
        ProjectMetadata,
        TeamMetadata,
        SystemMetadata,
        TopicMetadata,
        CustomerMetadata,
        ProcessMetadata,
        z.record(z.any()),
    ]),
    sources: z.array(EntitySource).default([]),
    version: z.number().default(1),
    previousVersions: z.array(EntityVersionEntry).default([]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    // For soft deletes
    deletedAt: z.string().datetime().optional(),
});

export type KnowledgeEntityType = z.infer<typeof KnowledgeEntity>;

// Schema for creating a new entity
export const CreateKnowledgeEntitySchema = KnowledgeEntity.omit({
    id: true,
    version: true,
    previousVersions: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
});

export type CreateKnowledgeEntityType = z.infer<typeof CreateKnowledgeEntitySchema>;

// Schema for updating an entity
export const UpdateKnowledgeEntitySchema = z.object({
    name: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    metadata: z.record(z.any()).optional(),
    sources: z.array(EntitySource).optional(),
});

export type UpdateKnowledgeEntityType = z.infer<typeof UpdateKnowledgeEntitySchema>;
