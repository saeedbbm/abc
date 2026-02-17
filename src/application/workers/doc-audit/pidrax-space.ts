/**
 * Pidrax Knowledge Base Space Manager
 * 
 * Manages the dedicated Confluence space where auto-generated documentation lives.
 * Creates the space and category parent pages on first run.
 */

import { PrefixLogger } from "@/lib/utils";
import { ConfluenceClient } from "@/src/application/lib/integrations/atlassian/confluence-client";
import { DocumentCategory } from "./document-templates";

export interface SpaceInfo {
    spaceId: string;
    spaceKey: string;
    categoryPages: Record<string, string>; // category -> page ID
}

const CATEGORY_PAGES: Array<{ category: DocumentCategory; title: string; description: string }> = [
    {
        category: 'overview',
        title: 'Company Overview',
        description: 'High-level company overview: what we do, org structure, tech stack, products, customers, and key processes.',
    },
    {
        category: 'person',
        title: 'People',
        description: 'Individual profiles for each team member: role, responsibilities, expertise, and current work.',
    },
    {
        category: 'system',
        title: 'Systems & Services',
        description: 'Documentation for internal systems, services, and infrastructure components.',
    },
    {
        category: 'project',
        title: 'Projects',
        description: 'Documentation for past and current projects, including decisions, timelines, and lessons learned.',
    },
    {
        category: 'customer',
        title: 'Customers',
        description: 'Customer profiles including contacts, relationship history, and project details.',
    },
    {
        category: 'process',
        title: 'Processes',
        description: 'Step-by-step guides for company processes: deployments, releases, onboarding, etc.',
    },
    {
        category: 'incident',
        title: 'Incidents',
        description: 'Post-mortems and incident reports with root causes and prevention measures.',
    },
];

export class PidraxSpaceManager {
    private confluenceClient: ConfluenceClient;
    private siteUrl: string;
    private logger: PrefixLogger;

    constructor(confluenceClient: ConfluenceClient, siteUrl: string, logger?: PrefixLogger) {
        this.confluenceClient = confluenceClient;
        this.siteUrl = siteUrl;
        this.logger = logger || new PrefixLogger('pidrax-space');
    }

    /**
     * Ensure the Pidrax Knowledge Base space and category pages exist.
     * Creates the space if it doesn't exist.
     * Returns space info with page IDs for each category.
     */
    async ensureSpace(spaceKey: string = 'PidraxBot'): Promise<SpaceInfo | null> {
        try {
            // Try to find existing space by key
            let spaceId: string | null = null;

            try {
                const spaces = await this.confluenceClient.listSpaces();
                const existing = spaces.spaces.find(s => {
                    const meta = s as any;
                    return meta.key === spaceKey;
                });
                if (existing) {
                    spaceId = existing.id;
                    this.logger.log(`Found existing PidraxBot space: ${spaceId}`);
                }
            } catch (error) {
                this.logger.log(`Error searching for space: ${error}`);
            }

            // If space doesn't exist, create it
            if (!spaceId) {
                this.logger.log(`PidraxBot space "${spaceKey}" not found. Creating it...`);
                try {
                    const created = await this.confluenceClient.createSpace(
                        spaceKey,
                        'PidraxBot',
                        'Auto-generated knowledge base maintained by PidraxBot. Documents are created from Slack, Jira, and Confluence data.'
                    );
                    spaceId = created.id;
                    this.logger.log(`Created PidraxBot space: ${spaceId} (key: ${created.key})`);
                } catch (createError) {
                    this.logger.log(`Could not create space: ${createError}. Falling back to first available space.`);
                    // Fallback: use the first available space
                    const spaces = await this.confluenceClient.listSpaces();
                    if (spaces.spaces.length > 0) {
                        spaceId = spaces.spaces[0].id;
                        this.logger.log(`Using existing space ${spaceId} as fallback`);
                    } else {
                        this.logger.log('No Confluence spaces available');
                        return null;
                    }
                }
            }

            // Ensure category pages exist
            const categoryPages: Record<string, string> = {};

            for (const cat of CATEGORY_PAGES) {
                try {
                    // Search for existing category page
                    const existingPage = await this.findCategoryPage(spaceId, cat.title);
                    if (existingPage) {
                        categoryPages[cat.category] = existingPage;
                        this.logger.log(`Found category page "${cat.title}": ${existingPage}`);
                    } else {
                        // Create category page
                        const page = await this.confluenceClient.createPage({
                            spaceId,
                            title: `[PidraxBot] ${cat.title}`,
                            body: this.buildCategoryPageHtml(cat.title, cat.description),
                        });
                        categoryPages[cat.category] = page.id;
                        this.logger.log(`Created category page "${cat.title}": ${page.id}`);
                    }
                } catch (error) {
                    this.logger.log(`Error creating category page "${cat.title}": ${error}`);
                }
            }

            return {
                spaceId,
                spaceKey,
                categoryPages,
            };
        } catch (error) {
            this.logger.log(`Error ensuring Pidrax KB space: ${error}`);
            return null;
        }
    }

    /**
     * Create or update a document page under the appropriate category.
     * All pages get [PidraxBot] prefix in their title.
     * If a page with this title already exists, it will be updated with the new content.
     */
    async createDocumentPage(
        spaceInfo: SpaceInfo,
        category: DocumentCategory,
        title: string,
        body: string
    ): Promise<{ pageId: string; url: string } | null> {
        const parentPageId = spaceInfo.categoryPages[category];
        const fullTitle = `[PidraxBot] ${title}`;
        
        try {
            // First, check if a page with this title already exists
            const existingPage = await this.findPageByTitle(spaceInfo.spaceId, fullTitle);
            
            if (existingPage) {
                // Update the existing page
                const currentVersion = (existingPage as any).version?.number || 1;
                await this.confluenceClient.updatePage(existingPage.id, {
                    title: fullTitle,
                    body,
                    version: currentVersion,
                });
                const url = this.confluenceClient.getPageWebUrl(this.siteUrl, existingPage.id, spaceInfo.spaceKey, fullTitle);
                this.logger.log(`Updated existing page "${fullTitle}" under ${category}: ${existingPage.id}`);
                return { pageId: existingPage.id, url };
            }

            // Create new page
            const page = await this.confluenceClient.createProposalPage({
                spaceId: spaceInfo.spaceId,
                title: fullTitle,
                body,
                parentId: parentPageId,
            });

            const url = this.confluenceClient.getPageWebUrl(this.siteUrl, page.id, spaceInfo.spaceKey, fullTitle);
            this.logger.log(`Created document page "${fullTitle}" under ${category}: ${page.id}`);

            return {
                pageId: page.id,
                url,
            };
        } catch (error) {
            this.logger.log(`Error creating document page "${title}": ${error}`);
            return null;
        }
    }

    /**
     * Find a page by exact title within a space.
     * Returns full page object including version info.
     */
    private async findPageByTitle(spaceId: string, title: string): Promise<{ id: string; version?: { number: number } } | null> {
        try {
            for await (const page of this.confluenceClient.listAllPages({ spaceId })) {
                if (page.title === title) {
                    return page;
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    private async findCategoryPage(spaceId: string, title: string): Promise<string | null> {
        try {
            const searchTitle = `[PidraxBot] ${title}`;

            for await (const page of this.confluenceClient.listAllPages({ spaceId })) {
                // Match both old prefix [Pidrax KB] and new prefix [PidraxBot]
                if (page.title === searchTitle || page.title === `[Pidrax KB] ${title}`) {
                    return page.id;
                }
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    private buildCategoryPageHtml(title: string, description: string): string {
        return `<ac:structured-macro ac:name="info"><ac:rich-text-body>
<p><strong>PidraxBot</strong> — This page and its children are auto-generated and maintained by PidraxBot.</p>
</ac:rich-text-body></ac:structured-macro>

<h2>${title}</h2>
<p>${description}</p>

<p>Documents below are auto-generated from information found in Slack, Jira, and Confluence. 
Each document is marked with what is known vs. what needs verification.</p>

<ac:structured-macro ac:name="children">
<ac:parameter ac:name="all">true</ac:parameter>
</ac:structured-macro>`;
    }
}
