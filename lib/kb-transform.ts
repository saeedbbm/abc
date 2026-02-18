/**
 * KB Page Transform
 * 
 * Transforms knowledge_pages (stored with HTML content, reviewableBlocks, citations)
 * into the KBDocument format with sections[] / paragraphs[] / citations[]
 * that the frontend renders natively.
 * 
 * Each citation carries an embedded `sourcePreview` so the inspector panel can
 * render instantly without a separate fetch.
 */

import { db } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

/* ── Helpers for content excerpts and conversation parsing ── */

function buildExcerpt(content: string, sourceType?: string): string {
    if (!content) return '';

    // For conversations, extract the actual messages portion
    if (sourceType === 'slack_conversation' || sourceType === 'slack_thread') {
        const convMarker = 'Full conversation:';
        const idx = content.indexOf(convMarker);
        if (idx !== -1) {
            const messagesText = content.substring(idx + convMarker.length).trim();
            return messagesText.length > 400 ? messagesText.substring(0, 400) + '…' : messagesText;
        }
    }

    // For channel/user metadata docs, skip
    if (sourceType === 'slack_channel' || sourceType === 'slack_user') {
        return content.length > 200 ? content.substring(0, 200) + '…' : content;
    }

    return content.length > 400 ? content.substring(0, 400) + '…' : content;
}

/** Replace <@userId> mentions in text with display names. */
function resolveUserMentions(text: string, userMap?: Map<string, string>): string {
    if (!userMap || userMap.size === 0) return text;
    return text.replace(/<@(\w+)>/g, (match, uid) => {
        const name = userMap.get(uid);
        return name ? `@${name}` : match;
    });
}

/**
 * Parse conversation content into individual message objects for rich rendering.
 * Content format: "[HH:MM:SS] <@userId> message text" or "[HH:MM:SS] message text"
 * 
 * @param userMap - Optional map of userId -> displayName for name resolution
 * @param messageAuthors - Optional ordered list of author names matching message order
 *                         (from looking up metadata.messageIds in DB)
 */
function parseConversationMessages(
    content: string,
    meta: any,
    userMap?: Map<string, string>,
    messageAuthors?: string[]
): Array<{ author: string; text: string; timestamp: string; avatarUrl?: string }> {
    const messages: Array<{ author: string; text: string; timestamp: string; avatarUrl?: string }> = [];

    const convMarker = 'Full conversation:';
    const idx = content.indexOf(convMarker);
    if (idx === -1) return messages;

    const conversationText = content.substring(idx + convMarker.length).trim();
    const lines = conversationText.split('\n');

    const lineRegex = /^\[(\d{2}:\d{2}:\d{2})\]\s*(?:<@(\w+)>\s*)?(.+)$/;
    let msgIndex = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const match = trimmed.match(lineRegex);
        if (match) {
            const [, time, userId, text] = match;
            // Priority: 1) resolve userId, 2) use pre-looked-up author, 3) inherit from prev
            let authorName: string;
            if (userId) {
                authorName = userMap?.get(userId) || userId;
            } else if (messageAuthors && msgIndex < messageAuthors.length) {
                authorName = messageAuthors[msgIndex];
            } else if (messages.length > 0) {
                authorName = messages[messages.length - 1].author;
            } else {
                authorName = 'Unknown';
            }
            messages.push({
                author: authorName,
                text: resolveUserMentions(text.trim(), userMap),
                timestamp: time,
            });
            msgIndex++;
        } else if (messages.length > 0) {
            messages[messages.length - 1].text += '\n' + resolveUserMentions(trimmed, userMap);
        }
    }

    return messages;
}

/**
 * Look up message authors from their document IDs.
 * Returns an ordered array of display names matching the messageIds order.
 */
async function lookupMessageAuthors(messageIds: string[]): Promise<string[]> {
    if (!messageIds || messageIds.length === 0) return [];
    try {
        const objectIds = messageIds.map(id => {
            try { return new ObjectId(id); } catch { return null; }
        }).filter(Boolean);

        const docs = await db.collection('knowledge_documents').find(
            { _id: { $in: objectIds } },
            { projection: { _id: 1, metadata: 1 } }
        ).toArray();

        const docMap = new Map<string, string>();
        for (const d of docs) {
            const name = d.metadata?.userProfile?.displayName
                || d.metadata?.userProfile?.realName
                || d.metadata?.authorName || '';
            docMap.set(d._id.toString(), name);
        }

        return messageIds.map(id => docMap.get(id) || '');
    } catch {
        return [];
    }
}

/**
 * Bulk-load slack user display names for a project.
 * Returns map of userId (sourceId) -> displayName.
 */
async function loadSlackUserMap(projectId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const users = await db.collection('knowledge_documents').find({
            projectId,
            provider: 'slack',
            sourceType: 'slack_user',
        }).project({ sourceId: 1, title: 1, metadata: 1 }).toArray();

        for (const u of users) {
            const name = u.metadata?.displayName || u.metadata?.realName || u.title;
            if (u.sourceId && name) {
                map.set(u.sourceId, name);
            }
        }
    } catch (err) {
        console.error('[kb-transform] Failed to load user map:', err);
    }
    return map;
}

export interface SourcePreview {
    provider: 'slack' | 'jira' | 'confluence';
    docId: string;
    title: string;
    excerpt: string;
    author?: string;
    date?: string;
    url?: string;
    // Slack-specific
    channelName?: string;
    reactions?: Array<{ name: string; count: number }>;
    messages?: Array<{ author: string; text: string; timestamp: string; avatarUrl?: string }>;
    // Jira-specific
    issueKey?: string;
    issueType?: string;
    status?: string;
    priority?: string;
    assignee?: string;
    // Confluence-specific
    spaceName?: string;
    breadcrumbs?: string[];
}

/**
 * Transform a knowledge_page into the KBDocument shape the frontend expects.
 * Optionally enriches citations with source previews from knowledge_documents.
 */
export async function transformPageToKBDocument(page: any, companySlug: string, enrichSources = false): Promise<any> {
    const html: string = page.content || '';
    const reviewableBlocks: any[] = page.reviewableBlocks || [];
    const pageCitations: any[] = page.citations || [];
    const pageSources: any[] = page.sources || [];

    const blockMap = new Map<string, any>();
    for (const block of reviewableBlocks) {
        blockMap.set(block.id, block);
    }

    // Build citation lookup by docId
    const citationByDocId = new Map<string, any>();
    for (const cit of pageCitations) {
        if (cit.docId) citationByDocId.set(cit.docId, cit);
    }

    // Collect all unique docIds from page citations for bulk fetch
    const allDocIds = new Set<string>();
    for (const cit of pageCitations) {
        if (cit.docId) allDocIds.add(cit.docId);
    }

    // Bulk fetch source documents for previews
    let sourcePreviewMap = new Map<string, SourcePreview>();
    if (enrichSources) {
        // Load slack user names for resolving @mentions in conversations
        const projectId = page.projectId;
        const userMap = projectId ? await loadSlackUserMap(projectId) : new Map<string, string>();

        if (allDocIds.size > 0) {
            sourcePreviewMap = await fetchSourcePreviews(Array.from(allDocIds), userMap);
        }
        // If no structured citations, resolve sources by title/provider lookup
        if (allDocIds.size === 0 && pageSources.length > 0) {
            if (projectId) {
                const resolved = await resolveSourcesByTitle(projectId, pageSources, userMap);
                for (const [key, preview] of resolved) {
                    sourcePreviewMap.set(key, preview);
                }
                // Also populate pageCitations from resolved sources (deduplicate by docId)
                const seenDocIds = new Set<string>(pageCitations.map((c: any) => c.docId).filter(Boolean));
                for (const src of pageSources) {
                    const key = `${src.provider}:${src.title}`;
                    const preview = resolved.get(key);
                    if (preview && !seenDocIds.has(preview.docId)) {
                        seenDocIds.add(preview.docId);
                        pageCitations.push({
                            id: `resolved-${preview.docId}`,
                            provider: src.provider,
                            docId: preview.docId,
                            label: src.title,
                            snippet: preview.excerpt?.substring(0, 100) || '',
                        });
                    }
                }
            }
        }
    }

    const sections = parseHtmlToSections(html, blockMap, pageCitations, pageSources, sourcePreviewMap, page.id || page._id?.toString());

    if (sections.length === 0 && html.trim().length > 0) {
        const plainText = stripHtml(html);
        if (plainText.length > 0) {
            const paragraphs = plainText
                .split(/\n\n+/)
                .filter(p => p.trim().length > 10)
                .map((text, i) => ({
                    text: text.trim(),
                    confidence: 'needs-verification' as const,
                    citations: buildCitationsFromSources(pageSources, pageCitations, sourcePreviewMap, page.id, i),
                }));

            sections.push({
                id: `section-${page.id}-0`,
                heading: page.title || 'Overview',
                paragraphs: paragraphs.length > 0 ? paragraphs : [{
                    text: plainText.substring(0, 500),
                    confidence: 'needs-verification' as const,
                    citations: buildCitationsFromSources(pageSources, pageCitations, sourcePreviewMap, page.id, 0),
                }],
            });
        }
    }

    const statusMap: Record<string, string> = {
        draft: 'new',
        in_review: 'needs-review',
        accepted: 'verified',
    };

    return {
        id: page.id || page._id?.toString(),
        _id: page.id || page._id?.toString(),
        title: page.title || 'Untitled',
        category: page.category || 'overview',
        status: statusMap[page.status] || 'new',
        lastUpdated: formatDate(page.updatedAt || page.createdAt || new Date().toISOString()),
        author: 'Pidrax',
        verifiedBy: reviewableBlocks.length > 0 && reviewableBlocks.every((b: any) => b.status === 'accepted')
            ? (reviewableBlocks[0]?.reviewedBy || undefined)
            : undefined,
        sections,
    };
}

/**
 * Bulk fetch knowledge_documents by IDs and build SourcePreview objects.
 */
async function fetchSourcePreviews(docIds: string[], userMap?: Map<string, string>): Promise<Map<string, SourcePreview>> {
    const map = new Map<string, SourcePreview>();
    if (docIds.length === 0) return map;

    try {
        const objectIds = docIds.map(id => {
            try { return new ObjectId(id); } catch { return null; }
        }).filter(Boolean);

        if (objectIds.length === 0) return map;

        const docs = await db.collection('knowledge_documents')
            .find({ _id: { $in: objectIds } })
            .project({
                _id: 1, provider: 1, title: 1, content: 1, sourceType: 1,
                sourceId: 1, metadata: 1, createdAt: 1, sourceCreatedAt: 1,
            })
            .toArray();

        for (const doc of docs) {
            const id = doc._id.toString();
            const meta = doc.metadata || {};
            const content = doc.content || '';
            const excerpt = buildExcerpt(content, doc.sourceType);

            const base: SourcePreview = {
                provider: doc.provider,
                docId: id,
                title: doc.title || 'Untitled',
                excerpt,
                author: meta.userProfile?.displayName || meta.userProfile?.realName
                    || meta.authorName || meta.author || meta.userId,
                date: doc.sourceCreatedAt || doc.createdAt,
            };

            if (doc.provider === 'slack') {
                base.channelName = meta.channelName || meta.channel;
                base.reactions = meta.reactions;
                base.url = meta.url || meta.permalink;
                // Resolve @mentions in excerpt
                if (userMap && userMap.size > 0) {
                    base.excerpt = resolveUserMentions(base.excerpt, userMap);
                }
                // For conversations, store individual messages for rich rendering
                if (doc.sourceType === 'slack_conversation' || doc.sourceType === 'slack_thread') {
                    const msgAuthors = await lookupMessageAuthors(meta.messageIds || []);
                    base.messages = parseConversationMessages(content, meta, userMap, msgAuthors);
                }
            } else if (doc.provider === 'jira') {
                base.issueKey = meta.issueKey || meta.key;
                base.issueType = meta.issueType || meta.type;
                base.status = meta.status;
                base.priority = meta.priority;
                base.assignee = meta.assignee;
                base.url = meta.url || meta.self;
            } else if (doc.provider === 'confluence') {
                base.spaceName = meta.spaceName || meta.spaceKey;
                base.breadcrumbs = meta.breadcrumbs;
                base.url = meta.url || meta.webUrl;
            }

            map.set(id, base);
        }
    } catch (err) {
        console.error('[kb-transform] Failed to fetch source previews:', err);
    }

    return map;
}

/**
 * Resolve page sources (which only have provider+title) to actual knowledge_documents
 * by searching for matching documents. Returns a map keyed by "provider:title".
 */
async function resolveSourcesByTitle(
    projectId: string,
    pageSources: any[],
    userMap?: Map<string, string>
): Promise<Map<string, SourcePreview>> {
    const map = new Map<string, SourcePreview>();
    if (pageSources.length === 0) return map;

    // Skip metadata-only document types — we want actual content
    const excludedTypes = new Set(['slack_channel', 'slack_user']);

    try {
        for (const src of pageSources) {
            if (!src.provider || !src.title) continue;

            const titleWords = src.title.split(/\s+/).filter((w: string) => w.length > 2);
            const escapedTitle = src.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const searchRegex = titleWords.length > 0
                ? titleWords.map((w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
                : escapedTitle;

            // Prefer conversation summaries, then messages, then anything with content
            const preferredTypes = src.provider === 'slack'
                ? ['slack_conversation', 'slack_message', 'slack_thread']
                : src.provider === 'jira'
                ? ['jira_issue', 'jira_comment']
                : ['confluence_page'];

            let doc = null;

            // Try preferred types first
            for (const sType of preferredTypes) {
                doc = await db.collection('knowledge_documents').findOne({
                    projectId,
                    provider: src.provider,
                    sourceType: sType,
                    $or: [
                        { title: { $regex: searchRegex, $options: 'i' } },
                        { content: { $regex: searchRegex, $options: 'i' } },
                        { 'metadata.authorName': { $regex: searchRegex, $options: 'i' } },
                    ],
                }, {
                    projection: {
                        _id: 1, provider: 1, title: 1, content: 1, sourceType: 1,
                        sourceId: 1, metadata: 1, createdAt: 1, sourceCreatedAt: 1,
                    },
                });
                if (doc) break;
            }

            // Fallback: any non-metadata doc
            if (!doc) {
                doc = await db.collection('knowledge_documents').findOne({
                    projectId,
                    provider: src.provider,
                    sourceType: { $nin: Array.from(excludedTypes) },
                    $or: [
                        { title: { $regex: searchRegex, $options: 'i' } },
                        { content: { $regex: searchRegex, $options: 'i' } },
                    ],
                }, {
                    projection: {
                        _id: 1, provider: 1, title: 1, content: 1, sourceType: 1,
                        sourceId: 1, metadata: 1, createdAt: 1, sourceCreatedAt: 1,
                    },
                });
            }

            if (doc) {
                const id = doc._id.toString();
                const meta = doc.metadata || {};
                const content = doc.content || '';
                const excerpt = buildExcerpt(content, doc.sourceType);

                // Resolve @mentions in excerpt for slack
                const resolvedExcerpt = (doc.provider === 'slack' && userMap && userMap.size > 0)
                    ? resolveUserMentions(excerpt, userMap)
                    : excerpt;

                const preview: SourcePreview = {
                    provider: doc.provider,
                    docId: id,
                    title: doc.title || src.title,
                    excerpt: resolvedExcerpt,
                    author: meta.userProfile?.displayName || meta.userProfile?.realName
                        || meta.authorName || meta.author || meta.userId,
                    date: doc.sourceCreatedAt || doc.createdAt,
                    url: meta.url || meta.permalink || meta.webUrl,
                    channelName: meta.channelName || meta.channel,
                    reactions: meta.reactions,
                    messages: (doc.sourceType === 'slack_conversation' || doc.sourceType === 'slack_thread')
                        ? parseConversationMessages(content, meta, userMap,
                            await lookupMessageAuthors(meta.messageIds || [])) : undefined,
                    issueKey: meta.issueKey,
                    issueType: meta.issueType,
                    status: meta.status,
                    priority: meta.priority,
                    assignee: meta.assignee,
                    spaceName: meta.spaceName,
                    breadcrumbs: meta.breadcrumbs,
                };

                map.set(`${src.provider}:${src.title}`, preview);
                // Also index by docId for the preview map
                map.set(id, preview);
            }
        }
    } catch (err) {
        console.error('[kb-transform] Failed to resolve sources by title:', err);
    }

    return map;
}

function parseHtmlToSections(
    html: string,
    blockMap: Map<string, any>,
    pageCitations: any[],
    pageSources: any[],
    sourcePreviewMap: Map<string, SourcePreview>,
    pageId: string
): any[] {
    const sections: any[] = [];
    const headerRegex = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/g;
    const headers: Array<{ title: string; index: number; endIndex: number }> = [];
    let match;

    while ((match = headerRegex.exec(html)) !== null) {
        headers.push({
            title: stripHtml(match[1]).trim(),
            index: match.index,
            endIndex: match.index + match[0].length,
        });
    }

    if (headers.length === 0) {
        const paragraphs = extractParagraphs(html, blockMap, pageCitations, pageSources, sourcePreviewMap, pageId);
        if (paragraphs.length > 0) {
            sections.push({
                id: `section-${pageId}-0`,
                heading: 'Overview',
                paragraphs,
            });
        }
        return sections;
    }

    if (headers[0].index > 0) {
        const preContent = html.substring(0, headers[0].index);
        const preParagraphs = extractParagraphs(preContent, blockMap, pageCitations, pageSources, sourcePreviewMap, pageId);
        if (preParagraphs.length > 0) {
            sections.push({
                id: `section-${pageId}-intro`,
                heading: 'Overview',
                paragraphs: preParagraphs,
            });
        }
    }

    for (let i = 0; i < headers.length; i++) {
        const contentStart = headers[i].endIndex;
        const contentEnd = i + 1 < headers.length ? headers[i + 1].index : html.length;
        const sectionContent = html.substring(contentStart, contentEnd);
        const paragraphs = extractParagraphs(sectionContent, blockMap, pageCitations, pageSources, sourcePreviewMap, pageId);

        sections.push({
            id: `section-${pageId}-${i}`,
            heading: headers[i].title,
            paragraphs: paragraphs.length > 0 ? paragraphs : [{
                text: 'No information available yet.',
                confidence: 'needs-verification' as const,
                citations: [],
            }],
        });
    }

    return sections;
}

function extractParagraphs(
    html: string,
    blockMap: Map<string, any>,
    pageCitations: any[],
    pageSources: any[],
    sourcePreviewMap: Map<string, SourcePreview>,
    pageId: string
): any[] {
    const paragraphs: any[] = [];
    let idx = 0;

    const contentRegex = /<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/g;
    let match;

    while ((match = contentRegex.exec(html)) !== null) {
        const innerHtml = match[1];
        const plainText = stripHtml(innerHtml).trim();
        if (plainText.length < 10) continue;

        const reviewIdMatch = innerHtml.match(/data-review-id="([^"]+)"/);
        let confidence: 'verified' | 'inferred' | 'needs-verification' = 'inferred';
        let blockText = plainText;

        if (reviewIdMatch) {
            const block = blockMap.get(reviewIdMatch[1]);
            if (block) {
                confidence = block.status === 'accepted' ? 'verified'
                    : block.status === 'edited' ? 'verified'
                    : 'needs-verification';
                if (block.status === 'edited' && block.editedText) {
                    blockText = block.editedText;
                }
            }
        }

        // Build citations with docId and sourcePreview
        const citations = buildCitationsFromSources(pageSources, pageCitations, sourcePreviewMap, pageId, idx);

        // Also extract inline <a> citations that may have specific URLs
        const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
        let linkMatch;
        while ((linkMatch = linkRegex.exec(innerHtml)) !== null) {
            const url = linkMatch[1];
            const linkText = stripHtml(linkMatch[2]).trim();
            if (!linkText || linkText.length < 3) continue;
            const provider = detectProviderFromUrl(url, linkText);

            // Check if this already matches an existing citation
            const alreadyHas = citations.some(c => c.label === linkText.replace(/^Source:\s*/i, ''));
            if (!alreadyHas) {
                citations.push({
                    id: `cite-${pageId}-${idx}-inline-${citations.length}`,
                    source: provider,
                    label: linkText.replace(/^Source:\s*/i, ''),
                    detail: linkText,
                    date: '',
                    docId: undefined,
                    url,
                    sourcePreview: undefined,
                });
            }
        }

        paragraphs.push({
            text: blockText,
            confidence,
            citations,
        });
        idx++;
    }

    if (paragraphs.length === 0) {
        const plainText = stripHtml(html).trim();
        const chunks = plainText.split(/\n\n+/).filter(c => c.trim().length > 10);
        for (const chunk of chunks) {
            paragraphs.push({
                text: chunk.trim(),
                confidence: 'needs-verification' as const,
                citations: buildCitationsFromSources(pageSources, pageCitations, sourcePreviewMap, pageId, idx++),
            });
        }
    }

    return paragraphs;
}

/**
 * Build citations from page-level sources and citations,
 * enriching with sourcePreview data for instant inspector rendering.
 */
function buildCitationsFromSources(
    pageSources: any[],
    pageCitations: any[],
    sourcePreviewMap: Map<string, SourcePreview>,
    pageId: string,
    index: number
): any[] {
    const citations: any[] = [];
    const seenDocIds = new Set<string>();

    // Use page-level structured citations (they have docId)
    if (pageCitations && pageCitations.length > 0) {
        // Distribute citations across paragraphs: each paragraph gets a rotating subset
        const perPara = Math.max(1, Math.ceil(pageCitations.length / 8));
        const start = (index * perPara) % pageCitations.length;

        for (let i = 0; i < Math.min(perPara, pageCitations.length); i++) {
            const cit = pageCitations[(start + i) % pageCitations.length];
            // Skip duplicates within the same paragraph
            const docKey = cit.docId || cit.id || `${cit.provider}-${cit.label}`;
            if (seenDocIds.has(docKey)) continue;
            seenDocIds.add(docKey);

            const preview = cit.docId ? sourcePreviewMap.get(cit.docId) : undefined;
            citations.push({
                // Always generate unique IDs per paragraph to avoid React key conflicts
                id: `cite-${pageId}-${index}-${i}`,
                source: cit.provider || 'confluence',
                label: cit.label || 'Source',
                detail: cit.snippet || cit.label || '',
                date: preview?.date || '',
                docId: cit.docId,
                url: preview?.url,
                sourcePreview: preview || undefined,
            });
        }
    }

    // Fallback: use page sources if no structured citations
    if (citations.length === 0 && pageSources && pageSources.length > 0) {
        for (const src of pageSources.slice(0, 2)) {
            const provider = (src.provider === 'slack' || src.provider === 'jira' || src.provider === 'confluence')
                ? src.provider : 'confluence';
            citations.push({
                id: `cite-${pageId}-${index}-src-${citations.length}`,
                source: provider,
                label: src.title || src.provider || 'Source',
                detail: src.title || '',
                date: '',
                url: src.url,
                docId: undefined,
                sourcePreview: undefined,
            });
        }
    }

    return citations;
}

function detectProviderFromUrl(url: string, text: string): 'slack' | 'jira' | 'confluence' {
    const combined = `${url} ${text}`.toLowerCase();
    if (combined.includes('slack')) return 'slack';
    if (combined.includes('jira')) return 'jira';
    if (combined.includes('confluence') || combined.includes('atlassian')) return 'confluence';
    return 'confluence';
}

function stripHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

export function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric'
        });
    } catch {
        return iso;
    }
}
