/**
 * Knowledge Base API — List & Delete pages
 * 
 * GET    /api/[companySlug]/kb  — List all KB pages (or raw documents as fallback)
 * DELETE /api/[companySlug]/kb  — Delete all KB pages for this project
 */

import { resolveCompanySlug } from "@/lib/company-resolver";
import { MongoDBKnowledgePagesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-pages.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { PageCategoryType } from "@/src/entities/models/knowledge-page";
import { transformPageToKBDocument, formatDate } from "@/lib/kb-transform";

const pagesRepo = new MongoDBKnowledgePagesRepository();
const docsRepo = new MongoDBKnowledgeDocumentsRepository();

/**
 * Transform raw knowledge_documents into the KBDocument shape the frontend expects.
 * Groups by provider/sourceType into categories and creates browsable pages.
 */
function transformDocumentsToKBPages(
    docs: any[],
    companySlug: string
): any[] {
    const significantTypes = new Set([
        'slack_conversation', 'slack_message', 'slack_thread',
        'confluence_page',
        'jira_issue', 'jira_comment',
    ]);

    const significant = docs.filter(d => significantTypes.has(d.sourceType));

    if (significant.length === 0) return [];

    const categoryMap: Record<string, string> = {
        'slack_conversation': 'Slack Conversations',
        'slack_message': 'Slack Messages',
        'slack_thread': 'Slack Threads',
        'confluence_page': 'Confluence Pages',
        'jira_issue': 'Jira Issues',
        'jira_comment': 'Jira Comments',
    };

    const providerMap: Record<string, 'slack' | 'confluence' | 'jira'> = {
        'slack_conversation': 'slack',
        'slack_message': 'slack',
        'slack_thread': 'slack',
        'confluence_page': 'confluence',
        'jira_issue': 'jira',
        'jira_comment': 'jira',
    };

    // Prefer conversation summaries over raw messages
    const conversations = significant.filter(d => d.sourceType === 'slack_conversation');
    const hasConversations = conversations.length > 0;

    const filtered = hasConversations
        ? significant.filter(d => d.sourceType !== 'slack_message' && d.sourceType !== 'slack_thread')
        : significant;

    return filtered.map(doc => {
        const provider = providerMap[doc.sourceType] || 'slack';
        const category = categoryMap[doc.sourceType] || 'Other';

        // Split content into paragraphs for the section view
        const contentParagraphs = (doc.content || '')
            .split('\n\n')
            .filter((p: string) => p.trim().length > 0)
            .map((text: string, i: number) => ({
                text: text.trim(),
                confidence: 'inferred' as const,
                citations: [{
                    id: `cite-${doc.id}-${i}`,
                    source: provider,
                    label: buildCitationLabel(doc),
                    detail: doc.title,
                    date: doc.sourceCreatedAt || doc.syncedAt || doc.createdAt,
                    docId: doc.id,
                }],
            }));

        // If content is short, keep as single paragraph
        const paragraphs = contentParagraphs.length > 0
            ? contentParagraphs
            : [{
                text: doc.content || '(empty)',
                confidence: 'inferred' as const,
                citations: [{
                    id: `cite-${doc.id}-0`,
                    source: provider,
                    label: buildCitationLabel(doc),
                    detail: doc.title,
                    date: doc.sourceCreatedAt || doc.syncedAt || doc.createdAt,
                    docId: doc.id,
                }],
            }];

        const updated = doc.sourceUpdatedAt || doc.updatedAt || doc.createdAt;

        return {
            id: doc.id,
            _id: doc.id,
            title: doc.title || 'Untitled',
            category,
            status: 'new' as const,
            lastUpdated: formatDate(updated),
            author: doc.metadata?.authorName || doc.metadata?.userId || 'Pidrax Sync',
            sections: [{
                id: `section-${doc.id}`,
                heading: doc.title || 'Content',
                paragraphs,
            }],
        };
    });
}

function buildCitationLabel(doc: any): string {
    const provider = doc.provider;
    if (provider === 'slack') {
        const channel = doc.metadata?.channelName;
        return channel ? `Slack · #${channel}` : 'Slack';
    }
    if (provider === 'confluence') {
        const space = doc.metadata?.spaceName || doc.metadata?.spaceKey;
        return space ? `Confluence · ${space}` : 'Confluence';
    }
    if (provider === 'jira') {
        const key = doc.metadata?.issueKey || doc.metadata?.projectKey;
        return key ? `Jira · ${key}` : 'Jira';
    }
    return provider;
}

export async function GET(
    req: Request,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    const url = new URL(req.url);
    const category = url.searchParams.get('category') as PageCategoryType | null;
    const status = url.searchParams.get('status');

    try {
        // First try knowledge_pages (generated by doc-audit pipeline)
        const { pages, total } = await pagesRepo.findByProject(projectId, {
            category: category || undefined,
            status: status || undefined,
        });

        if (pages.length > 0) {
            const stats = await pagesRepo.getStats(projectId);
            // Transform each knowledge_page into the KBDocument format the frontend expects
            const transformed = await Promise.all(
                pages.map(page => transformPageToKBDocument(page, companySlug, true))
            );
            return Response.json({ pages: transformed, total, stats });
        }

        // No knowledge_pages yet — fall back to raw knowledge_documents
        const allDocs: any[] = [];

        for (const provider of ['slack', 'jira', 'confluence']) {
            const { items } = await docsRepo.findByProjectAndProvider(projectId, provider);
            allDocs.push(...items);
        }

        if (allDocs.length > 0) {
            const transformed = transformDocumentsToKBPages(allDocs, companySlug);
            return Response.json({
                pages: transformed,
                total: transformed.length,
                stats: {
                    totalPages: transformed.length,
                    byCategory: transformed.reduce((acc: Record<string, number>, p: any) => {
                        acc[p.category] = (acc[p.category] || 0) + 1;
                        return acc;
                    }, {}),
                    byStatus: { new: transformed.length },
                    totalBlocks: 0,
                    reviewedBlocks: 0,
                },
                source: 'documents',
            });
        }

        return Response.json({
            pages: [],
            total: 0,
            stats: { totalPages: 0, byCategory: {}, byStatus: {}, totalBlocks: 0, reviewedBlocks: 0 },
        });
    } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        const deletedCount = await pagesRepo.deleteByProject(projectId);
        return Response.json({ success: true, deletedCount });
    } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
    }
}
