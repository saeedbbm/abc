/**
 * Knowledge Page Model
 * 
 * Represents a bot-generated documentation page stored in our own system.
 * These are NOT Confluence pages — they live on our platform and are the
 * company's knowledge base managed by PidraxBot.
 * 
 * Each page has reviewable blocks: sections that need human verification.
 * Reviewable blocks are rendered with yellow highlight and can be accepted or edited.
 */

import { z } from "zod";

export const PageCategory = z.enum([
    'overview', 'system', 'person', 'project', 'customer', 'process', 'incident',
]);
export type PageCategoryType = z.infer<typeof PageCategory>;

export const PageStatus = z.enum([
    'draft',       // Just created, no reviews yet
    'in_review',   // At least one reviewer has been assigned
    'accepted',    // All reviewable blocks have been accepted
]);
export type PageStatusType = z.infer<typeof PageStatus>;

export const ReviewBlockStatus = z.enum([
    'pending',     // Needs review (shown as yellow highlight)
    'accepted',    // Reviewer confirmed it's correct (highlight removed)
    'edited',      // Reviewer provided corrected text (highlight removed, text replaced)
]);

export const ReviewableBlock = z.object({
    id: z.string(),                       // UUID for this block
    originalText: z.string(),             // The bot-generated text
    status: ReviewBlockStatus.default('pending'),
    editedText: z.string().optional(),    // If status=edited, the corrected text
    reviewedBy: z.string().optional(),    // Name of person who reviewed
    reviewedAt: z.string().datetime().optional(),
    sourceRefs: z.array(z.string()).default([]), // Source descriptions for this block
});
export type ReviewableBlockType = z.infer<typeof ReviewableBlock>;

export const PageReviewer = z.object({
    name: z.string(),
    slackUserId: z.string().optional(),
    status: z.enum(['pending', 'approved']).default('pending'),
    assignedAt: z.string().datetime(),
    reviewedAt: z.string().datetime().optional(),
});
export type PageReviewerType = z.infer<typeof PageReviewer>;

export const PageSource = z.object({
    provider: z.string(),     // 'slack' | 'jira' | 'confluence' | 'inferred'
    title: z.string(),
    url: z.string().optional(),
});
export type PageSourceType = z.infer<typeof PageSource>;

export const PageCitation = z.object({
    id: z.string(),
    provider: z.enum(['slack', 'jira', 'confluence']),
    docId: z.string(),        // knowledge_document ID for Context Inspector lookup
    label: z.string(),        // e.g., "Slack · #backend-ops · Aug 2025"
    snippet: z.string(),      // the cited text
});
export type PageCitationType = z.infer<typeof PageCitation>;

export const KnowledgePage = z.object({
    id: z.string(),
    projectId: z.string(),
    companySlug: z.string(),              // URL-friendly company name, e.g. "bix"
    
    // Content
    category: PageCategory,
    title: z.string(),                     // e.g. "kserve", "Matt Smith", "ACME CORP"
    content: z.string(),                   // HTML content (clean HTML, not Confluence storage format)
    entityName: z.string(),                // The entity this page documents
    entityType: z.string(),                // 'system' | 'person' | etc.
    
    // Status
    status: PageStatus.default('draft'),
    
    // Review workflow
    reviewers: z.array(PageReviewer).default([]),
    reviewableBlocks: z.array(ReviewableBlock).default([]),
    
    // Sources used to generate this page
    sources: z.array(PageSource).default([]),
    
    // Structured citations for inline source chips in the UI
    citations: z.array(PageCitation).default([]),
    
    // Stats
    totalBlocks: z.number().default(0),
    reviewedBlocks: z.number().default(0),
    
    // Timestamps
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});
export type KnowledgePageType = z.infer<typeof KnowledgePage>;

// Create schema (omit auto-generated fields)
export const CreateKnowledgePageSchema = KnowledgePage.omit({
    id: true,
    status: true,
    reviewedBlocks: true,
    createdAt: true,
    updatedAt: true,
});
export type CreateKnowledgePageType = z.infer<typeof CreateKnowledgePageSchema>;

// Update schema
export const UpdateKnowledgePageSchema = z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    status: PageStatus.optional(),
    reviewers: z.array(PageReviewer).optional(),
    reviewableBlocks: z.array(ReviewableBlock).optional(),
    reviewedBlocks: z.number().optional(),
});
export type UpdateKnowledgePageType = z.infer<typeof UpdateKnowledgePageSchema>;
