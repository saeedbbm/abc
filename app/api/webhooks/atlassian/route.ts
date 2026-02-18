/**
 * Atlassian Webhook Handler
 * 
 * POST /api/webhooks/atlassian
 * 
 * Receives real-time events from Jira and Confluence when issues/pages
 * are created, updated, or deleted. This eliminates the need for polling.
 * 
 * Jira events: jira:issue_created, jira:issue_updated, jira:issue_deleted,
 *              comment_created, comment_updated, comment_deleted
 * Confluence events: page_created, page_updated, page_removed,
 *                    comment_created, comment_updated, comment_removed
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { embedKnowledgeDocument, ensureKnowledgeCollection } from "@/src/application/lib/knowledge";
import { matchAndVerifyClaims } from "@/src/application/lib/knowledge/claim-matcher";
import { PrefixLogger } from "@/lib/utils";

const knowledgeDocumentsRepository = new MongoDBKnowledgeDocumentsRepository();
const logger = new PrefixLogger('atlassian-webhook');

// Simple dedup cache
const processedEvents = new Map<string, number>();
const CACHE_TTL = 60_000;

function isDuplicate(eventKey: string): boolean {
    const ts = processedEvents.get(eventKey);
    if (ts && Date.now() - ts < CACHE_TTL) return true;
    processedEvents.set(eventKey, Date.now());
    if (processedEvents.size > 500) {
        const now = Date.now();
        for (const [k, t] of processedEvents) {
            if (now - t > CACHE_TTL) processedEvents.delete(k);
        }
    }
    return false;
}

/**
 * Find the projectId from the Atlassian cloudId stored in oauth_tokens.
 */
async function findProjectByCloudId(cloudId: string): Promise<string | null> {
    const token = await db.collection('oauth_tokens').findOne({
        provider: 'atlassian',
        'metadata.cloudId': cloudId,
    });
    return token ? token.projectId : null;
}

export async function POST(req: NextRequest): Promise<Response> {
    let payload: any;
    try {
        payload = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const webhookEvent = payload.webhookEvent || payload.eventType || '';
    logger.log(`Received event: ${webhookEvent}`);

    // Route to the right handler
    if (webhookEvent.startsWith('jira:issue') || webhookEvent.startsWith('comment_')) {
        handleJiraEvent(payload).catch(err => logger.log(`Error handling Jira event: ${err}`));
    } else if (
        webhookEvent.startsWith('page_') ||
        webhookEvent.startsWith('comment_') ||
        webhookEvent === 'page:created' ||
        webhookEvent === 'page:updated' ||
        webhookEvent === 'page:removed'
    ) {
        handleConfluenceEvent(payload).catch(err => logger.log(`Error handling Confluence event: ${err}`));
    } else {
        logger.log(`Unhandled event type: ${webhookEvent}`);
    }

    return NextResponse.json({ ok: true });
}

// ─── Jira Event Handler ──────────────────────────────────────────────────

async function handleJiraEvent(payload: any) {
    const event = payload.webhookEvent;
    const issue = payload.issue;
    const comment = payload.comment;

    if (!issue) {
        logger.log('No issue in Jira payload, skipping');
        return;
    }

    // Determine the cloudId — Jira webhook payloads may not include it directly,
    // but the issue self URL contains it. Extract from payload or use registered context.
    const selfUrl = issue.self || '';
    const cloudIdMatch = selfUrl.match(/\/ex\/jira\/([^/]+)\//);
    let cloudId = cloudIdMatch?.[1];

    // Fallback: check if we registered the webhook with a specific cloudId
    if (!cloudId && payload._pidraxCloudId) {
        cloudId = payload._pidraxCloudId;
    }
    if (!cloudId) {
        // Try to extract from the base URL pattern
        const baseMatch = selfUrl.match(/https:\/\/([^.]+)\.atlassian\.net/);
        if (baseMatch) {
            // Look up by site
            const token = await db.collection('oauth_tokens').findOne({
                provider: 'atlassian',
            });
            cloudId = token?.metadata?.cloudId;
        }
    }

    if (!cloudId) {
        logger.log('Cannot determine cloudId from Jira webhook payload');
        return;
    }

    const projectId = await findProjectByCloudId(cloudId);
    if (!projectId) {
        logger.log(`No project found for cloudId ${cloudId}`);
        return;
    }

    const issueKey = issue.key;
    const eventKey = `jira:${issueKey}:${event}:${payload.timestamp || Date.now()}`;
    if (isDuplicate(eventKey)) {
        logger.log(`Duplicate event, skipping: ${eventKey}`);
        return;
    }

    logger.log(`Processing ${event} for ${issueKey} (project: ${projectId})`);

    if (event === 'jira:issue_deleted') {
        const existing = await knowledgeDocumentsRepository.findBySourceId(projectId, 'jira', issueKey);
        if (existing) {
            await knowledgeDocumentsRepository.delete(existing.id);
            logger.log(`Deleted document for ${issueKey}`);
        }
        return;
    }

    // Build content from issue fields
    const fields = issue.fields || {};
    const contentLines = [
        `Issue: ${issueKey}`,
        `Summary: ${fields.summary || ''}`,
        `Type: ${fields.issuetype?.name || ''}`,
        `Status: ${fields.status?.name || ''}`,
        `Priority: ${fields.priority?.name || ''}`,
        `Assignee: ${fields.assignee?.displayName || 'Unassigned'}`,
        `Reporter: ${fields.reporter?.displayName || 'Unknown'}`,
    ];
    if (fields.labels?.length) contentLines.push(`Labels: ${fields.labels.join(', ')}`);
    if (fields.description) {
        const descText = typeof fields.description === 'string'
            ? fields.description
            : extractADFText(fields.description);
        contentLines.push('', 'Description:', descText);
    }

    const content = contentLines.join('\n');
    const metadata = {
        issueKey,
        projectKey: fields.project?.key,
        issueType: fields.issuetype?.name,
        status: fields.status?.name,
        priority: fields.priority?.name,
        assignee: fields.assignee?.displayName,
        reporter: fields.reporter?.displayName,
        labels: fields.labels || [],
        webUrl: `https://${cloudId}.atlassian.net/browse/${issueKey}`,
    };

    const existing = await knowledgeDocumentsRepository.findBySourceId(projectId, 'jira', issueKey);

    let doc;
    if (existing) {
        if (existing.content !== content) {
            doc = await knowledgeDocumentsRepository.update(existing.id, {
                content,
                metadata,
                sourceUpdatedAt: new Date().toISOString(),
            });
            logger.log(`Updated ${issueKey}`);
        } else {
            logger.log(`${issueKey} unchanged, skipping`);
            return;
        }
    } else {
        doc = await knowledgeDocumentsRepository.create({
            projectId,
            provider: 'jira',
            sourceType: 'jira_issue',
            sourceId: issueKey,
            title: `[${issueKey}] ${fields.summary || ''}`,
            content,
            metadata,
            entityRefs: [],
            syncedAt: new Date().toISOString(),
            sourceCreatedAt: fields.created,
        });
        logger.log(`Created ${issueKey}`);
    }

    // Embed
    await ensureKnowledgeCollection(logger);
    const result = await embedKnowledgeDocument(doc, logger);
    // Event-driven claim verification
    matchAndVerifyClaims(projectId, doc).catch(err => {
        logger.log(`Claim matching failed: ${err}`);
    });
    logger.log(`Embedded ${issueKey}: ${result.success ? result.chunksCreated + ' chunks' : result.error}`);

    // Handle comment if present
    if (comment && (event.includes('comment_created') || event.includes('comment_updated'))) {
        await ingestJiraComment(projectId, issueKey, comment, cloudId);
    }
}

async function ingestJiraComment(projectId: string, issueKey: string, comment: any, cloudId: string) {
    const commentId = comment.id;
    const sourceId = `${issueKey}:comment:${commentId}`;
    const authorName = comment.author?.displayName || 'Unknown';
    const bodyText = typeof comment.body === 'string'
        ? comment.body
        : extractADFText(comment.body);

    const content = `Comment on ${issueKey} by ${authorName}:\n${bodyText}`;
    const metadata = {
        issueKey,
        commentId,
        authorName,
        authorAccountId: comment.author?.accountId,
    };

    const existing = await knowledgeDocumentsRepository.findBySourceId(projectId, 'jira', sourceId);

    let doc;
    if (existing) {
        doc = await knowledgeDocumentsRepository.update(existing.id, { content, metadata, sourceUpdatedAt: new Date().toISOString() });
    } else {
        doc = await knowledgeDocumentsRepository.create({
            projectId,
            provider: 'jira',
            sourceType: 'jira_comment',
            sourceId,
            title: `Comment on ${issueKey}`,
            content,
            metadata,
            entityRefs: [],
            parentSourceId: issueKey,
            syncedAt: new Date().toISOString(),
            sourceCreatedAt: comment.created,
        });
    }

    await ensureKnowledgeCollection(logger);
    await embedKnowledgeDocument(doc, logger);
    // Event-driven claim verification
    matchAndVerifyClaims(projectId, doc).catch(err => {
        logger.log(`Claim matching failed: ${err}`);
    });
    logger.log(`Ingested comment ${commentId} on ${issueKey}`);
}

// ─── Confluence Event Handler ────────────────────────────────────────────

async function handleConfluenceEvent(payload: any) {
    const event = payload.webhookEvent || payload.eventType || '';
    const page = payload.page || payload.content;

    if (!page) {
        logger.log('No page in Confluence payload, skipping');
        return;
    }

    // Find the projectId
    const selfUrl = page.self || page._links?.self || '';
    const cloudIdMatch = selfUrl.match(/\/ex\/confluence\/([^/]+)\//);
    let cloudId = cloudIdMatch?.[1];

    if (!cloudId) {
        const token = await db.collection('oauth_tokens').findOne({ provider: 'atlassian' });
        cloudId = token?.metadata?.cloudId;
    }

    if (!cloudId) {
        logger.log('Cannot determine cloudId from Confluence webhook payload');
        return;
    }

    const projectId = await findProjectByCloudId(cloudId);
    if (!projectId) {
        logger.log(`No project found for cloudId ${cloudId}`);
        return;
    }

    const pageId = String(page.id);
    const eventKey = `confluence:${pageId}:${event}:${payload.timestamp || Date.now()}`;
    if (isDuplicate(eventKey)) return;

    logger.log(`Processing ${event} for page ${pageId} (project: ${projectId})`);

    if (event.includes('removed') || event.includes('deleted')) {
        const existing = await knowledgeDocumentsRepository.findBySourceId(projectId, 'confluence', pageId);
        if (existing) {
            await knowledgeDocumentsRepository.delete(existing.id);
            logger.log(`Deleted document for Confluence page ${pageId}`);
        }
        return;
    }

    const title = page.title || 'Untitled';
    const spaceKey = page.space?.key || page.spaceKey || '';
    const spaceName = page.space?.name || spaceKey;

    // Extract text content from the page body
    let bodyText = '';
    if (page.body?.storage?.value) {
        bodyText = stripHtml(page.body.storage.value);
    } else if (page.body?.atlas_doc_format?.value) {
        try {
            const adf = typeof page.body.atlas_doc_format.value === 'string'
                ? JSON.parse(page.body.atlas_doc_format.value)
                : page.body.atlas_doc_format.value;
            bodyText = extractADFText(adf);
        } catch {
            bodyText = String(page.body.atlas_doc_format?.value || '');
        }
    } else if (page.body?.view?.value) {
        bodyText = stripHtml(page.body.view.value);
    }

    const content = `Page: ${title}\nSpace: ${spaceName}\n\n${bodyText}`.trim();
    const metadata = {
        spaceKey,
        spaceName,
        pageId,
        webUrl: page._links?.webui
            ? `https://${cloudId}.atlassian.net/wiki${page._links.webui}`
            : undefined,
        version: page.version?.number,
        lastModifiedBy: page.version?.by?.displayName,
    };

    const existing = await knowledgeDocumentsRepository.findBySourceId(projectId, 'confluence', pageId);

    let doc;
    if (existing) {
        if (existing.content !== content) {
            doc = await knowledgeDocumentsRepository.update(existing.id, {
                title,
                content,
                metadata,
                sourceUpdatedAt: new Date().toISOString(),
            });
            logger.log(`Updated Confluence page ${pageId}`);
        } else {
            logger.log(`Confluence page ${pageId} unchanged, skipping`);
            return;
        }
    } else {
        doc = await knowledgeDocumentsRepository.create({
            projectId,
            provider: 'confluence',
            sourceType: 'confluence_page',
            sourceId: pageId,
            title,
            content,
            metadata,
            entityRefs: [],
            syncedAt: new Date().toISOString(),
            sourceCreatedAt: page.createdDate || page.created,
        });
        logger.log(`Created Confluence page ${pageId}`);
    }

    await ensureKnowledgeCollection(logger);
    const result = await embedKnowledgeDocument(doc, logger);
    // Event-driven claim verification
    matchAndVerifyClaims(projectId, doc).catch(err => {
        logger.log(`Claim matching failed: ${err}`);
    });
    logger.log(`Embedded Confluence page ${pageId}: ${result.success ? result.chunksCreated + ' chunks' : result.error}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Extract plain text from Atlassian Document Format (ADF) */
function extractADFText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.type === 'text') return node.text || '';
    if (Array.isArray(node.content)) {
        return node.content.map(extractADFText).join(
            node.type === 'paragraph' || node.type === 'heading' ? '\n' : ''
        );
    }
    return '';
}

/** Strip HTML tags to extract plain text */
function stripHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/?(h[1-6])[^>]*>/gi, '\n')
        .replace(/<li>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
