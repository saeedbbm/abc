import { ConfluenceClient } from "@/src/application/lib/integrations/atlassian";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { MongoDBSyncStateRepository } from "@/src/infrastructure/repositories/mongodb.sync-state.repository";
import { 
    ConfluenceSpaceType, 
    ConfluencePageType,
} from "@/src/application/lib/integrations/atlassian/types";
import { PrefixLogger } from "@/lib/utils";
import { embedKnowledgeDocuments, ensureKnowledgeCollection } from "@/src/application/lib/knowledge";

export interface ConfluenceSyncOptions {
    projectId: string;
    // Specific space keys to sync (empty = all)
    spaceKeys?: string[];
    // Whether to sync archived pages
    includeArchived?: boolean;
    // Maximum depth for page hierarchy
    maxDepth?: number;
    // Whether to generate embeddings (default: true)
    generateEmbeddings?: boolean;
}

export class ConfluenceSyncWorker {
    private oauthTokensRepository: MongoDBOAuthTokensRepository;
    private knowledgeDocumentsRepository: MongoDBKnowledgeDocumentsRepository;
    private knowledgeEntitiesRepository: MongoDBKnowledgeEntitiesRepository;
    private syncStateRepository: MongoDBSyncStateRepository;
    private logger: PrefixLogger;

    constructor(
        oauthTokensRepository: MongoDBOAuthTokensRepository,
        knowledgeDocumentsRepository: MongoDBKnowledgeDocumentsRepository,
        knowledgeEntitiesRepository: MongoDBKnowledgeEntitiesRepository,
        logger?: PrefixLogger
    ) {
        this.oauthTokensRepository = oauthTokensRepository;
        this.knowledgeDocumentsRepository = knowledgeDocumentsRepository;
        this.knowledgeEntitiesRepository = knowledgeEntitiesRepository;
        this.syncStateRepository = new MongoDBSyncStateRepository();
        this.logger = logger || new PrefixLogger('confluence-sync');
    }

    async sync(options: ConfluenceSyncOptions): Promise<{
        spaces: number;
        pages: number;
        embedded: number;
    }> {
        const { projectId, spaceKeys = [], includeArchived = false, generateEmbeddings = true } = options;
        
        this.logger.log(`Starting Confluence sync for project ${projectId}`);

        // Update sync state to 'syncing'
        await this.syncStateRepository.upsert(projectId, 'confluence', {
            status: 'syncing',
            lastError: null,
        });

        try {
        // Get OAuth token
        const token = await this.oauthTokensRepository.fetchByProjectAndProvider(projectId, 'atlassian');
        if (!token) {
            throw new Error('Atlassian not connected for this project');
        }

        const cloudId = token.metadata?.cloudId;
        if (!cloudId) {
            throw new Error('Missing Atlassian cloudId');
        }

        // Get site URL for constructing page links
        const siteUrl = token.metadata?.siteUrl || `https://your-site.atlassian.net`;

        const client = new ConfluenceClient(token.accessToken, cloudId);

        let stats = {
            spaces: 0,
            pages: 0,
            embedded: 0,
        };

        // Ensure embedding collection exists
        if (generateEmbeddings) {
            await ensureKnowledgeCollection(this.logger);
        }

        // Sync spaces
        this.logger.log('Syncing spaces...');
        const spaces = await this.syncSpaces(client, projectId, spaceKeys, siteUrl);
        stats.spaces = spaces.length;
        this.logger.log(`Synced ${stats.spaces} spaces`);

        // Sync pages for each space
        this.logger.log('Syncing pages...');
        for (const space of spaces) {
            try {
                const pageCount = await this.syncPagesForSpace(client, projectId, space, includeArchived, siteUrl);
                stats.pages += pageCount;
                this.logger.log(`Synced ${pageCount} pages from space ${space.key}`);
            } catch (error) {
                this.logger.log(`Error syncing pages for space ${space.key}: ${error}`);
            }
        }

        // Generate embeddings for all Confluence documents
        if (generateEmbeddings) {
            this.logger.log(`Fetching all Confluence documents for embedding...`);
            const { items: confluenceDocs } = await this.knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'confluence');
            
            if (confluenceDocs.length > 0) {
                this.logger.log(`Generating embeddings for ${confluenceDocs.length} documents...`);
                const embeddingResults = await embedKnowledgeDocuments(confluenceDocs, this.logger);
                stats.embedded = embeddingResults.filter(r => r.success).reduce((sum, r) => sum + r.chunksCreated, 0);
                this.logger.log(`Created ${stats.embedded} embedding chunks`);
            }
        }

        // Update sync state on success
        await this.syncStateRepository.upsert(projectId, 'confluence', {
            status: 'idle',
            lastSyncedAt: new Date().toISOString(),
            totalDocuments: stats.spaces + stats.pages,
            totalEmbeddings: stats.embedded,
            lastError: null,
            consecutiveErrors: 0,
        });

        this.logger.log(`Confluence sync completed for project ${projectId}`);
        return stats;
        } catch (error) {
            // Update sync state on error
            const prevState = await this.syncStateRepository.fetch(projectId, 'confluence');
            await this.syncStateRepository.upsert(projectId, 'confluence', {
                status: 'error',
                lastError: String(error),
                consecutiveErrors: (prevState?.consecutiveErrors || 0) + 1,
            });
            throw error;
        }
    }

    private async syncSpaces(
        client: ConfluenceClient, 
        projectId: string, 
        filterKeys: string[],
        siteUrl: string
    ): Promise<ConfluenceSpaceType[]> {
        const spaces: ConfluenceSpaceType[] = [];

        for await (const space of client.listAllSpaces()) {
            // Filter by keys if specified
            if (filterKeys.length > 0 && !filterKeys.includes(space.key)) {
                continue;
            }

            try {
                await this.upsertConfluenceSpace(projectId, space, siteUrl);
                spaces.push(space);
            } catch (error) {
                this.logger.log(`Error syncing space ${space.key}: ${error}`);
            }
        }

        return spaces;
    }

    private async upsertConfluenceSpace(projectId: string, space: ConfluenceSpaceType, siteUrl: string): Promise<void> {
        const sourceId = space.id;
        
        const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'confluence', sourceId);
        
        const content = this.formatSpaceContent(space);
        const spaceUrl = `${siteUrl}/wiki/spaces/${space.key}/overview`;
        const metadata = {
            spaceId: space.id,
            spaceKey: space.key,
            spaceType: space.type,
            homepageId: space.homepageId,
            url: spaceUrl,
        };

        if (existing) {
            const contentChanged = existing.content !== content;
            const urlChanged = (existing.metadata as any)?.url !== spaceUrl;
            
            if (contentChanged || urlChanged) {
                await this.knowledgeDocumentsRepository.update(existing.id, {
                    content,
                    metadata,
                    sourceUpdatedAt: new Date().toISOString(),
                });
            }
        } else {
            await this.knowledgeDocumentsRepository.create({
                projectId,
                provider: 'confluence',
                sourceType: 'confluence_space',
                sourceId,
                title: space.name,
                content,
                metadata,
                entityRefs: [],
                syncedAt: new Date().toISOString(),
            });
        }

        // Spaces might map to projects or topics
        await this.knowledgeEntitiesRepository.bulkUpsert([{
            projectId,
            type: 'project',
            name: space.name,
            aliases: [space.key],
            metadata: {
                confluenceSpaceKey: space.key,
                confluenceSpaceId: space.id,
                description: space.description?.plain?.value,
            },
            sources: [{
                provider: 'confluence',
                sourceType: 'space',
                sourceId: space.id,
                lastSeen: new Date().toISOString(),
                confidence: 0.8,
            }],
        }]);
    }

    private formatSpaceContent(space: ConfluenceSpaceType): string {
        const lines = [
            `Space: ${space.name} (${space.key})`,
        ];
        
        if (space.description?.plain?.value) {
            lines.push(`Description: ${space.description.plain.value}`);
        }
        if (space.type) {
            lines.push(`Type: ${space.type}`);
        }

        return lines.join('\n');
    }

    private async syncPagesForSpace(
        client: ConfluenceClient,
        projectId: string,
        space: ConfluenceSpaceType,
        includeArchived: boolean,
        siteUrl: string
    ): Promise<number> {
        let count = 0;
        const status = includeArchived ? undefined : 'current';

        for await (const page of client.listAllPages({ spaceId: space.id, status })) {
            try {
                await this.upsertConfluencePage(client, projectId, space, page, siteUrl);
                count++;
            } catch (error) {
                this.logger.log(`Error syncing page ${page.id}: ${error}`);
            }
        }

        return count;
    }

    private async upsertConfluencePage(
        client: ConfluenceClient,
        projectId: string,
        space: ConfluenceSpaceType,
        page: ConfluencePageType,
        siteUrl: string
    ): Promise<void> {
        const sourceId = page.id;
        
        // Get full page content if not already included
        let fullPage = page;
        if (!page.body?.storage?.value) {
            try {
                fullPage = await client.getPage(page.id, 'storage');
            } catch (error) {
                this.logger.log(`Error fetching full page content for ${page.id}: ${error}`);
            }
        }
        
        const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'confluence', sourceId);
        
        const content = this.formatPageContent(fullPage, space);
        
        // Construct full URL using the site URL and the relative webui path
        // Confluence webui links are like "/spaces/SD/pages/123" - we need to add "/wiki" prefix
        let relativeUrl = page._links?.webui || `/spaces/${space.key}/pages/${page.id}`;
        // Ensure /wiki prefix is present
        if (!relativeUrl.startsWith('/wiki')) {
            relativeUrl = `/wiki${relativeUrl}`;
        }
        const webUrl = `${siteUrl}${relativeUrl}`;
        
        // Store raw HTML storage format for rich rendering in Context Inspector
        const storageHtml = fullPage.body?.storage?.value || '';

        const metadata = {
            pageId: page.id,
            spaceId: space.id,
            spaceKey: space.key,
            spaceName: space.name,
            authorId: page.authorId,
            parentPageId: page.parentId,
            versionNumber: page.version?.number,
            url: webUrl,
            webUrl: webUrl,
            // Raw HTML for rendering in Context Inspector
            storageHtml: storageHtml || undefined,
        };

        // Find parent document if exists
        let parentId: string | undefined;
        if (page.parentId) {
            const parentDoc = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'confluence', page.parentId);
            parentId = parentDoc?.id;
        }

        const sourceUpdatedAt = page.version?.createdAt || new Date().toISOString();

        if (existing) {
            // Update if content, version, or URL changed
            const contentChanged = existing.content !== content;
            const versionChanged = (existing.metadata as any)?.versionNumber !== page.version?.number;
            const urlChanged = (existing.metadata as any)?.url !== webUrl;
            
            if (contentChanged || versionChanged || urlChanged) {
                await this.knowledgeDocumentsRepository.update(existing.id, {
                    content,
                    metadata,
                    sourceUpdatedAt,
                });
            }
        } else {
            await this.knowledgeDocumentsRepository.create({
                projectId,
                provider: 'confluence',
                sourceType: 'confluence_page',
                sourceId,
                title: page.title,
                content,
                metadata,
                entityRefs: [],
                parentId,
                parentSourceId: page.parentId || undefined,
                syncedAt: new Date().toISOString(),
                sourceCreatedAt: page.createdAt,
                sourceUpdatedAt,
            });
        }

        // Extract entities from page content
        await this.extractEntitiesFromPage(projectId, fullPage, space);
    }

    private formatPageContent(page: ConfluencePageType, space: ConfluenceSpaceType): string {
        const lines = [
            `Page: ${page.title}`,
            `Space: ${space.name} (${space.key})`,
        ];
        
        if (page.version?.number) {
            lines.push(`Version: ${page.version.number}`);
        }

        // Convert HTML storage format to text
        const bodyHtml = page.body?.storage?.value || '';
        const bodyText = this.htmlToText(bodyHtml);
        
        if (bodyText) {
            lines.push(`\nContent:\n${bodyText}`);
        }

        return lines.join('\n');
    }

    private async extractEntitiesFromPage(
        projectId: string,
        page: ConfluencePageType,
        space: ConfluenceSpaceType
    ): Promise<void> {
        const content = page.body?.storage?.value || '';
        const title = page.title.toLowerCase();
        
        // Check if this looks like a team directory or organizational page
        if (
            title.includes('team') ||
            title.includes('directory') ||
            title.includes('who is') ||
            title.includes('org') ||
            title.includes('roster')
        ) {
            // Try to extract people mentioned in the page
            const peopleMatches = content.match(/<ac:parameter[^>]*>([^<]+)<\/ac:parameter>/g);
            // This is a simple heuristic - real extraction would use LLM
        }

        // Check if this looks like system documentation
        if (
            title.includes('architecture') ||
            title.includes('system') ||
            title.includes('service') ||
            title.includes('api')
        ) {
            // Could extract system entities
            await this.knowledgeEntitiesRepository.bulkUpsert([{
                projectId,
                type: 'topic',
                name: page.title,
                aliases: [],
                metadata: {
                    description: `Documentation page in ${space.name}`,
                    confluencePages: [page.id],
                },
                sources: [{
                    provider: 'confluence',
                    sourceType: 'page',
                    sourceId: page.id,
                    lastSeen: new Date().toISOString(),
                    confidence: 0.6,
                }],
            }]);
        }
    }

    /**
     * Convert HTML/Confluence storage format to plain text
     */
    private htmlToText(html: string): string {
        if (!html) return '';

        let text = html
            // Remove script and style tags
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            // Handle common Confluence macros
            .replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi, '\n```\n$1\n```\n')
            .replace(/<ac:structured-macro[^>]*ac:name="info"[^>]*>[\s\S]*?<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>[\s\S]*?<\/ac:structured-macro>/gi, '\n[INFO] $1\n')
            .replace(/<ac:structured-macro[^>]*ac:name="warning"[^>]*>[\s\S]*?<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>[\s\S]*?<\/ac:structured-macro>/gi, '\n[WARNING] $1\n')
            // Handle user mentions
            .replace(/<ac:link><ri:user ri:account-id="([^"]+)"[^>]*\/><ac:plain-text-link-body><!\[CDATA\[([^\]]+)\]\]><\/ac:plain-text-link-body><\/ac:link>/gi, '@$2')
            .replace(/<ri:user ri:account-id="([^"]+)"[^>]*\/>/gi, '@user')
            // Handle page links
            .replace(/<ac:link[^>]*><ri:page[^>]*ri:content-title="([^"]+)"[^>]*\/>.*?<\/ac:link>/gi, '[$1]')
            // Replace headings
            .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n## $1\n')
            // Replace lists
            .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
            // Replace line breaks and paragraphs
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<p[^>]*>/gi, '')
            // Remove remaining Confluence/Atlassian specific tags
            .replace(/<ac:[^>]*>/gi, '')
            .replace(/<\/ac:[^>]*>/gi, '')
            .replace(/<ri:[^>]*>/gi, '')
            .replace(/<\/ri:[^>]*>/gi, '')
            // Remove remaining HTML tags
            .replace(/<[^>]+>/g, '')
            // Decode HTML entities
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            // Clean up whitespace
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return text;
    }
}
