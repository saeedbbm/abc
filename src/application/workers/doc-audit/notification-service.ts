/**
 * Documentation Audit Notification Service v3
 * 
 * Two-channel strategy:
 * - #documentation channel: Conflicts/updates to EXISTING Confluence pages (short message + inline comment)
 * - #knowledge-base channel: NEW docs created on our platform (short message + link to our KB)
 * 
 * Slack messages are ONE LINE. All detail lives in the Confluence comment or KB page.
 * New docs are saved to our MongoDB knowledge_pages collection, NOT Confluence.
 */

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { PrefixLogger } from "@/lib/utils";
import { SlackClient } from "@/src/application/lib/integrations/slack";
import { ConfluenceClient } from "@/src/application/lib/integrations/atlassian/confluence-client";
import { DocAuditFindingType, SlackNotificationType, SmartQuestionType } from "@/src/entities/models/doc-audit";
import { MongoDBDocAuditFindingsRepository } from "@/src/infrastructure/repositories/mongodb.doc-audit.repository";
import { MongoDBKnowledgePagesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-pages.repository";
import { getTemplateForEntityType, buildGenerationPrompt, DocumentCategory } from "./document-templates";
import { CreateKnowledgePageType, PageCategoryType } from "@/src/entities/models/knowledge-page";

const MAX_SLACK_POSTS_PER_RUN = 40;

export class DocAuditNotificationService {
    private slackClient: SlackClient;
    private confluenceClient: ConfluenceClient | null;
    private findingsRepo: MongoDBDocAuditFindingsRepository;
    private kbPagesRepo: MongoDBKnowledgePagesRepository;
    private logger: PrefixLogger;
    private siteUrl: string;
    private appBaseUrl: string; // Our app URL for KB page links
    private projectId: string;
    private companySlug: string;
    private postsThisRun: number = 0;

    constructor(
        slackClient: SlackClient,
        confluenceClient: ConfluenceClient | null,
        findingsRepo: MongoDBDocAuditFindingsRepository,
        kbPagesRepo: MongoDBKnowledgePagesRepository,
        siteUrl: string,
        projectId: string,
        companySlug: string,
        logger: PrefixLogger
    ) {
        this.slackClient = slackClient;
        this.confluenceClient = confluenceClient;
        this.findingsRepo = findingsRepo;
        this.kbPagesRepo = kbPagesRepo;
        this.siteUrl = siteUrl;
        this.projectId = projectId;
        this.companySlug = companySlug;
        this.logger = logger;

        // Derive app base URL: prefer NEXT_PUBLIC_BASE_URL (Cloudflare tunnel), fall back to localhost
        this.appBaseUrl = (process.env.NEXT_PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`).trim();
    }

    /**
     * Get or create a Slack channel by name
     */
    async getChannel(channelName: string): Promise<{ id: string; name: string } | null> {
        try {
            const channel = await this.slackClient.findChannelByName(channelName);
            if (channel) return { id: channel.id, name: channel.name };
            try {
                const created = await this.slackClient.createChannel(channelName);
                return { id: created.id, name: created.name };
            } catch (e) {
                this.logger.log(`Could not create channel #${channelName}: ${e}`);
                return null;
            }
        } catch (e) {
            this.logger.log(`Error finding/creating channel #${channelName}: ${e}`);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // CONFLICTS: Notify in #documentation (existing Confluence page updates)
    // -------------------------------------------------------------------------

    /**
     * Process a conflict/outdated/missing_update finding.
     * Adds an inline comment to the Confluence page and sends a short Slack message.
     */
    async notifyConflictFinding(
        finding: DocAuditFindingType,
        channelId: string
    ): Promise<void> {
        if (this.postsThisRun >= MAX_SLACK_POSTS_PER_RUN) return;

        // 1. Add inline comment on the Confluence page
        let commentAdded = false;
        if (this.confluenceClient && finding.confluencePageId) {
            try {
                this.logger.log(`Adding comment to Confluence page "${finding.confluencePageTitle}" (ID: ${finding.confluencePageId})...`);
                await this.addConflictComment(finding);
                commentAdded = true;
                this.logger.log(`Successfully added comment to Confluence page ${finding.confluencePageId}`);
            } catch (error) {
                this.logger.log(`Failed to add Confluence comment to page ${finding.confluencePageId}: ${error instanceof Error ? error.message : error}`);
            }
        } else {
            this.logger.log(`Skipping Confluence comment: confluenceClient=${!!this.confluenceClient}, pageId="${finding.confluencePageId || '(empty)'}"`);
        }

        // 2. Send short Slack message to #documentation
        const mentions = finding.relatedPersonSlackIds.slice(0, 3).map(id => `<@${id}>`).join(' ');
        const pageLink = finding.confluencePageUrl
            ? `<${finding.confluencePageUrl}|${finding.confluencePageTitle || 'View page'}>`
            : finding.confluencePageTitle || 'Unknown page';

        const msg = `:memo: Found an issue on ${pageLink}${commentAdded ? ' — comment added with suggested fix' : ''}. ${mentions ? mentions + ' please review.' : ''}`;

        const { ts: messageTs, channel } = await this.slackClient.postMessage(channelId, msg);
        this.postsThisRun++;

        // 3. Update finding
        await this.findingsRepo.update(finding.id, {
            status: commentAdded ? 'proposal_created' : 'notified',
            slackNotification: {
                channelId: channel,
                channelName: 'documentation',
                messageTs,
                mentionedUsers: finding.relatedPersonSlackIds,
                sentAt: new Date().toISOString(),
            } satisfies SlackNotificationType,
            notifiedAt: new Date().toISOString(),
        });
    }

    /**
     * Add a detailed comment on the existing Confluence page with source links.
     */
    private async addConflictComment(finding: DocAuditFindingType): Promise<void> {
        if (!this.confluenceClient || !finding.confluencePageId) return;

        const typeLabel = finding.type === 'contradiction' ? 'Conflict Detected'
            : finding.type === 'outdated' ? 'Outdated Information'
            : 'Update Needed';

        let html = `<p><strong>[PidraxBot] ${typeLabel}</strong> [${finding.severity.toUpperCase()}]</p>\n`;
        html += `<p>${this.esc(finding.description)}</p>\n`;

        if (finding.suggestedFix) {
            html += `<p><strong>Suggested change:</strong> ${this.esc(finding.suggestedFix)}</p>\n`;
        }

        if (finding.evidence.length > 0) {
            html += `<p><strong>Evidence:</strong></p><ul>`;
            for (const e of finding.evidence.slice(0, 5)) {
                html += `<li>[${e.provider}] ${this.esc(e.title)}`;
                if (e.url) html += ` — <a href="${e.url}">view source</a>`;
                html += `</li>`;
            }
            html += `</ul>`;
        }

        await this.confluenceClient.addPageComment(finding.confluencePageId, html);
        this.logger.log(`Added comment to Confluence page ${finding.confluencePageId}`);
    }

    // -------------------------------------------------------------------------
    // GAPS: Create KB page on our platform + notify in #knowledge-base
    // -------------------------------------------------------------------------

    /**
     * Create a KB page for an undocumented entity (no Slack message).
     * Returns page info for the batch summary.
     */
    async createGapPage(
        finding: DocAuditFindingType
    ): Promise<{ name: string; url: string; mentions: string[] } | null> {
        this.logger.log(`Creating page for gap: ${finding.title}`);

        const category = this.detectCategory(finding.title);
        const entityName = finding.title.replace(/^\[(System|Project|Customer|Process|Incident|Person|Overview)\]\s*/, '');

        // 1. Generate document HTML content
        const docHtml = await this.generateDocumentContent(finding, category);

        // 2. Extract reviewable blocks from the generated HTML
        const { processedHtml, blocks } = this.extractReviewableBlocks(docHtml);

        // 3. Build sources list
        const sources = finding.evidence.map(e => ({
            provider: e.provider,
            title: e.title,
            url: e.url,
        }));

        // 4. Build reviewers list
        const reviewers = finding.smartQuestions
            ?.map(q => q.targetUserName)
            .filter((name, i, arr) => name && arr.indexOf(name) === i)
            .slice(0, 3)
            .map(name => ({
                name: name!,
                slackUserId: finding.relatedPersonSlackIds.find((_, idx) =>
                    finding.smartQuestions?.[idx]?.targetUserName === name
                ),
                status: 'pending' as const,
                assignedAt: new Date().toISOString(),
            })) || [];

        // 5. Upsert in our knowledge_pages collection
        let kbPage;
        const existing = await this.kbPagesRepo.findByEntityName(this.projectId, entityName, category as PageCategoryType);

        if (existing) {
            await this.kbPagesRepo.update(existing.id, {
                content: processedHtml,
                reviewableBlocks: blocks,
                reviewedBlocks: 0,
                status: 'draft',
                reviewers,
            });
            kbPage = await this.kbPagesRepo.fetch(existing.id);
            this.logger.log(`Updated existing KB page "${entityName}": ${existing.id}`);
        } else {
            const createData: CreateKnowledgePageType = {
                projectId: this.projectId,
                companySlug: this.companySlug,
                category: category as PageCategoryType,
                title: entityName,
                content: processedHtml,
                entityName,
                entityType: category,
                reviewers,
                reviewableBlocks: blocks,
                sources,
                totalBlocks: blocks.length,
            };
            kbPage = await this.kbPagesRepo.create(createData);
            this.logger.log(`Created KB page "${entityName}": ${kbPage.id}`);
        }

        if (!kbPage) {
            this.logger.log(`Failed to create/update KB page for "${entityName}"`);
            return null;
        }

        const pageUrl = `${this.appBaseUrl}/c/${this.projectId}/company/${this.companySlug}/page/${kbPage.id}`;
        const mentions = finding.relatedPersonSlackIds.slice(0, 3);

        // Update finding status
        await this.findingsRepo.update(finding.id, {
            status: 'proposal_created',
            notifiedAt: new Date().toISOString(),
            proposedChange: {
                confluencePageTitle: entityName,
                confluenceSpaceId: '',
                proposalPageId: kbPage.id,
                proposalPageUrl: pageUrl,
                changeSummary: `Auto-generated ${category} documentation for: ${entityName}`,
            },
        });

        return { name: entityName, url: pageUrl, mentions };
    }

    /**
     * Send ONE Slack message summarizing all created KB pages.
     */
    async sendGapSummary(
        pages: Array<{ name: string; url: string; mentions: string[] }>,
        channelId: string
    ): Promise<void> {
        const kbListUrl = `${this.appBaseUrl}/c/${this.projectId}/company/${this.companySlug}`;

        // Build a single message with all pages grouped
        const lines: string[] = [
            `:books: *PidraxBot created ${pages.length} new knowledge base pages.* <${kbListUrl}|View all>`,
            '',
        ];

        for (const page of pages) {
            const mentionStr = page.mentions.length > 0
                ? ` — ${page.mentions.map(id => `<@${id}>`).join(' ')}`
                : '';
            lines.push(`• <${page.url}|${page.name}>${mentionStr}`);
        }

        lines.push('');
        lines.push('_Click any link to review and verify the content._');

        const msg = lines.join('\n');
        await this.slackClient.postMessage(channelId, msg);
        this.postsThisRun++;
        this.logger.log(`Sent gap summary with ${pages.length} pages to Slack`);
    }

    // -------------------------------------------------------------------------
    // Document generation
    // -------------------------------------------------------------------------

    /**
     * Generate clean HTML content (NOT Confluence storage format).
     * Uses the template system + LLM.
     */
    private async generateDocumentContent(
        finding: DocAuditFindingType,
        category: DocumentCategory
    ): Promise<string> {
        const categoryToType: Record<string, string> = {
            customer: 'customer', system: 'system', project: 'project',
            process: 'process', incident: 'system', person: 'person', overview: 'overview',
        };
        const template = getTemplateForEntityType(categoryToType[category] || category);
        const entityName = finding.title.replace(/^\[(System|Project|Customer|Process|Incident|Person|Overview)\]\s*/, '');

        const evidenceText = finding.evidence.map((e, i) => {
            const url = e.url ? ` (${e.url})` : '';
            return `[${e.provider.toUpperCase()}-${i + 1}] ${e.title}${url}\n${e.excerpt}`;
        }).join('\n\n---\n\n');

        if (template) {
            // Override LLM instructions to produce clean HTML (not Confluence storage format)
            const cleanInstructions = template.llmInstructions + `

CRITICAL FORMAT RULES:
- Output CLEAN HTML only: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>, <table>, <tr>, <th>, <td>, <code>
- Do NOT use Confluence macros like <ac:structured-macro> or <ac:rich-text-body>.
- For each claim or inference, wrap it in <span data-review-id="REVIEW_[number]" class="needs-review">[text]</span> where [number] is sequential (1, 2, 3...).
- Wrap EVERY factual claim, inference, or guess in a review span. This lets reviewers verify each piece individually.
- Source citations: use <a href="URL">Source: provider title</a> format with real URLs from the evidence.
- Do not include a banner or meta-info — just the content sections.`;

            const prompt = buildGenerationPrompt(template, entityName, evidenceText);

            const maxTokens = category === 'overview' ? 6000
                : category === 'project' ? 5000
                : category === 'customer' ? 4000
                : category === 'system' ? 4000
                : category === 'person' ? 2500
                : 3000;

            try {
                const { text } = await generateText({
                    model: openai('gpt-4o-mini'),
                    system: cleanInstructions,
                    prompt,
                    maxTokens,
                });
                return text;
            } catch (error) {
                this.logger.log(`Error generating document content: ${error}`);
            }
        }

        // Fallback
        return this.buildFallbackDocument(finding, entityName, evidenceText);
    }

    /**
     * Extract reviewable blocks from generated HTML.
     * Looks for <span data-review-id="REVIEW_N" class="needs-review">text</span> markers.
     * Replaces sequential IDs with UUIDs for DB storage.
     */
    private extractReviewableBlocks(html: string): {
        processedHtml: string;
        blocks: Array<{
            id: string;
            originalText: string;
            status: 'pending';
            sourceRefs: string[];
        }>;
    } {
        const blocks: Array<{
            id: string;
            originalText: string;
            status: 'pending';
            sourceRefs: string[];
        }> = [];

        let processedHtml = html;
        const regex = /<span[^>]*data-review-id="(REVIEW_\d+)"[^>]*>([\s\S]*?)<\/span>/g;
        let match;

        while ((match = regex.exec(html)) !== null) {
            const [fullMatch, reviewId, text] = match;
            const uuid = crypto.randomUUID();

            blocks.push({
                id: uuid,
                originalText: text.replace(/<[^>]+>/g, '').trim(), // Strip inner HTML for display
                status: 'pending',
                sourceRefs: [],
            });

            // Replace the placeholder ID with the real UUID
            processedHtml = processedHtml.replace(
                `data-review-id="${reviewId}"`,
                `data-review-id="${uuid}"`
            );
        }

        // If the LLM didn't add any review markers, auto-detect paragraphs with claims
        if (blocks.length === 0) {
            // Wrap every <p> that contains factual content in a review span
            let counter = 0;
            processedHtml = processedHtml.replace(
                /<p>((?:(?!<\/p>)[\s\S])+)<\/p>/g,
                (full, inner) => {
                    const text = inner.replace(/<[^>]+>/g, '').trim();
                    if (text.length < 20) return full; // Skip short paragraphs (labels, etc.)
                    const uuid = crypto.randomUUID();
                    blocks.push({
                        id: uuid,
                        originalText: text,
                        status: 'pending',
                        sourceRefs: [],
                    });
                    counter++;
                    return `<p><span data-review-id="${uuid}" class="needs-review">${inner}</span></p>`;
                }
            );
        }

        return { processedHtml, blocks };
    }

    private buildFallbackDocument(
        finding: DocAuditFindingType,
        entityName: string,
        evidenceText: string
    ): string {
        let html = `<h2>${this.esc(entityName)}</h2>\n`;
        html += `<p>${this.esc(finding.suggestedFix || finding.description)}</p>\n`;
        html += `<h3>Evidence</h3><ul>`;
        for (const e of finding.evidence) {
            html += `<li><strong>[${e.provider}]</strong> ${this.esc(e.title)}`;
            if (e.url) html += ` — <a href="${e.url}">View source</a>`;
            html += `<br/><em>${this.esc(e.excerpt.substring(0, 300))}</em></li>`;
        }
        html += `</ul>`;
        if (finding.smartQuestions?.length) {
            html += `<h3>Open Questions</h3><ul>`;
            for (const q of finding.smartQuestions) {
                html += `<li><strong>${this.esc(q.targetUserName)}:</strong> ${this.esc(q.question)}</li>`;
            }
            html += `</ul>`;
        }
        return html;
    }

    // -------------------------------------------------------------------------
    // "What I Understand" page — internal KB only (no Confluence)
    // -------------------------------------------------------------------------

    async createUnderstandingPage(htmlContent: string): Promise<{ pageId: string; url: string } | null> {
        // Save to our KB
        const existing = await this.kbPagesRepo.findByEntityName(this.projectId, 'What PidraxBot Understands', 'overview');
        
        // Convert Confluence storage format to clean HTML for our KB
        const cleanHtml = htmlContent
            .replace(/<ac:structured-macro[^>]*>[\s\S]*?<\/ac:structured-macro>/g, '')
            .replace(/<ac:rich-text-body>/g, '')
            .replace(/<\/ac:rich-text-body>/g, '');

        let kbPageId: string;
        if (existing) {
            await this.kbPagesRepo.update(existing.id, {
                content: cleanHtml,
                status: 'draft',
            });
            kbPageId = existing.id;
        } else {
            const created = await this.kbPagesRepo.create({
                projectId: this.projectId,
                companySlug: this.companySlug,
                category: 'overview',
                title: 'What PidraxBot Understands',
                content: cleanHtml,
                entityName: 'What PidraxBot Understands',
                entityType: 'overview',
                reviewers: [],
                reviewableBlocks: [],
                sources: [],
                totalBlocks: 0,
            });
            kbPageId = created.id;
        }

        // Build the KB URL on our platform (this is the only link)
        const kbUrl = `${this.appBaseUrl}/c/${this.projectId}/company/${this.companySlug}/page/${kbPageId}`;

        return { pageId: kbPageId, url: kbUrl };
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private detectCategory(title: string): DocumentCategory {
        if (title.startsWith('[System]')) return 'system';
        if (title.startsWith('[Customer]')) return 'customer';
        if (title.startsWith('[Project]')) return 'project';
        if (title.startsWith('[Process]')) return 'process';
        if (title.startsWith('[Incident]')) return 'incident';
        if (title.startsWith('[Person]')) return 'person';
        if (title.startsWith('[Overview]')) return 'overview';
        return 'system';
    }

    private esc(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
