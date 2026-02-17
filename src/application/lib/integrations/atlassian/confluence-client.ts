import { 
    ConfluenceSpaceType, 
    ConfluencePageType,
    AtlassianUserType,
} from './types';
import { atlassianRateLimiter } from './rate-limiter';

// Using v2 API - requires granular OAuth scopes:
// read:space:confluence, read:page:confluence, write:page:confluence
const CONFLUENCE_API_VERSION = 'v2';

export class ConfluenceClient {
    private accessToken: string;
    private cloudId: string;
    private baseUrl: string;

    constructor(accessToken: string, cloudId: string) {
        this.accessToken = accessToken;
        this.cloudId = cloudId;
        this.baseUrl = `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/${CONFLUENCE_API_VERSION}`;
    }

    private async request<T>(
        endpoint: string, 
        options: {
            method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
            params?: Record<string, any>;
            body?: any;
        } = {}
    ): Promise<T> {
        await atlassianRateLimiter.waitForToken(this.cloudId);

        const { method = 'GET', params, body } = options;
        
        let url = `${this.baseUrl}${endpoint}`;
        if (params) {
            const searchParams = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    if (Array.isArray(value)) {
                        value.forEach(v => searchParams.append(key, String(v)));
                    } else {
                        searchParams.append(key, String(value));
                    }
                }
            });
            url += `?${searchParams.toString()}`;
        }

        const response = await fetch(url, {
            method,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Accept': 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });

        // Handle rate limiting
        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
            atlassianRateLimiter.setRetryAfter(this.cloudId, retryAfter);
            throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Confluence API error (${response.status}): ${error}`);
        }

        // Handle empty responses
        const text = await response.text();
        if (!text) {
            return {} as T;
        }

        return JSON.parse(text) as T;
    }

    /**
     * List all spaces (v2 API - requires granular scopes)
     */
    async listSpaces(cursor?: string, limit: number = 25): Promise<{ 
        spaces: ConfluenceSpaceType[]; 
        nextCursor?: string;
    }> {
        const response = await this.request<{
            results: ConfluenceSpaceType[];
            _links?: { next?: string };
        }>('/spaces', {
            params: {
                cursor,
                limit,
            },
        });

        // Extract cursor from next link if present
        let nextCursor: string | undefined;
        if (response._links?.next) {
            const url = new URL(response._links.next, this.baseUrl);
            nextCursor = url.searchParams.get('cursor') || undefined;
        }

        return {
            spaces: response.results || [],
            nextCursor,
        };
    }

    /**
     * List all spaces with pagination
     */
    async *listAllSpaces(): AsyncGenerator<ConfluenceSpaceType> {
        let cursor: string | undefined;
        do {
            const { spaces, nextCursor } = await this.listSpaces(cursor);
            for (const space of spaces) {
                yield space;
            }
            cursor = nextCursor;
        } while (cursor);
    }

    /**
     * Get a single space by ID
     */
    async getSpace(spaceId: string): Promise<ConfluenceSpaceType> {
        return await this.request<ConfluenceSpaceType>(`/spaces/${spaceId}`);
    }

    /**
     * List pages in a space (v2 API)
     */
    async listPages(
        options: {
            spaceId?: string;
            cursor?: string;
            limit?: number;
            status?: 'current' | 'archived' | 'draft' | 'trashed';
            sort?: 'id' | '-id' | 'title' | '-title' | 'created-date' | '-created-date' | 'modified-date' | '-modified-date';
        } = {}
    ): Promise<{ 
        pages: ConfluencePageType[]; 
        nextCursor?: string;
    }> {
        const { spaceId, cursor, limit = 25, status = 'current', sort = '-modified-date' } = options;

        const params: Record<string, any> = {
            cursor,
            limit,
            status,
            sort,
            'body-format': 'storage',
        };

        if (spaceId) {
            params['space-id'] = spaceId;
        }

        const response = await this.request<{
            results: ConfluencePageType[];
            _links?: { next?: string };
        }>('/pages', { params });

        // Extract cursor from next link if present
        let nextCursor: string | undefined;
        if (response._links?.next) {
            const url = new URL(response._links.next, this.baseUrl);
            nextCursor = url.searchParams.get('cursor') || undefined;
        }

        return {
            pages: response.results || [],
            nextCursor,
        };
    }

    /**
     * List all pages with pagination
     */
    async *listAllPages(options: {
        spaceId?: string;
        status?: 'current' | 'archived' | 'draft' | 'trashed';
    } = {}): AsyncGenerator<ConfluencePageType> {
        let cursor: string | undefined;
        do {
            const { pages, nextCursor } = await this.listPages({ ...options, cursor });
            for (const page of pages) {
                yield page;
            }
            cursor = nextCursor;
        } while (cursor);
    }

    /**
     * Get a single page (v2 API)
     */
    async getPage(pageId: string, bodyFormat: 'storage' | 'atlas_doc_format' | 'view' = 'storage'): Promise<ConfluencePageType> {
        return await this.request<ConfluencePageType>(`/pages/${pageId}`, {
            params: { 'body-format': bodyFormat },
        });
    }

    /**
     * Get child pages of a page (v2 API)
     */
    async getChildPages(
        parentId: string,
        cursor?: string,
        limit: number = 25
    ): Promise<{ 
        pages: ConfluencePageType[]; 
        nextCursor?: string;
    }> {
        const response = await this.request<{
            results: ConfluencePageType[];
            _links?: { next?: string };
        }>(`/pages/${parentId}/children`, {
            params: { cursor, limit },
        });

        // Extract cursor from next link if present
        let nextCursor: string | undefined;
        if (response._links?.next) {
            const url = new URL(response._links.next, this.baseUrl);
            nextCursor = url.searchParams.get('cursor') || undefined;
        }

        return {
            pages: response.results || [],
            nextCursor,
        };
    }

    /**
     * Get all child pages recursively
     */
    async *getAllChildPages(parentId: string): AsyncGenerator<ConfluencePageType> {
        let cursor: string | undefined;
        do {
            const { pages, nextCursor } = await this.getChildPages(parentId, cursor);
            for (const page of pages) {
                yield page;
                // Recursively get children
                for await (const childPage of this.getAllChildPages(page.id)) {
                    yield childPage;
                }
            }
            cursor = nextCursor;
        } while (cursor);
    }

    /**
     * Search content using CQL (Confluence Query Language)
     */
    async search(
        cql: string,
        options: {
            cursor?: string;
            limit?: number;
        } = {}
    ): Promise<{
        results: Array<{
            content?: ConfluencePageType;
            title?: string;
            excerpt?: string;
            url?: string;
            lastModified?: string;
        }>;
        nextCursor?: string;
    }> {
        const { cursor, limit = 25 } = options;

        // Note: CQL search uses v1 API
        const v1BaseUrl = `https://api.atlassian.com/ex/confluence/${this.cloudId}/wiki/rest/api`;
        
        await atlassianRateLimiter.waitForToken(this.cloudId);

        const params = new URLSearchParams({
            cql,
            limit: String(limit),
            ...(cursor ? { cursor } : {}),
        });

        const response = await fetch(`${v1BaseUrl}/content/search?${params.toString()}`, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Confluence search error (${response.status}): ${error}`);
        }

        const data = await response.json();
        
        // Extract cursor from next link if present
        let nextCursor: string | undefined;
        if (data._links?.next) {
            const url = new URL(data._links.next, v1BaseUrl);
            nextCursor = url.searchParams.get('cursor') || undefined;
        }

        return {
            results: data.results?.map((r: any) => ({
                content: r,
                title: r.title,
                excerpt: r.excerpt,
                url: r._links?.webui,
                lastModified: r.version?.when,
            })) || [],
            nextCursor,
        };
    }

    /**
     * Create a page (v2 API)
     */
    async createPage(data: {
        spaceId: string;
        title: string;
        body: string;
        parentId?: string;
    }): Promise<ConfluencePageType> {
        return await this.request<ConfluencePageType>('/pages', {
            method: 'POST',
            body: {
                spaceId: data.spaceId,
                status: 'current',
                title: data.title,
                parentId: data.parentId,
                body: {
                    representation: 'storage',
                    value: data.body,
                },
            },
        });
    }

    /**
     * Update a page (v2 API)
     */
    async updatePage(
        pageId: string,
        data: {
            title?: string;
            body?: string;
            version: number; // Current version number (will be incremented)
        }
    ): Promise<ConfluencePageType> {
        const updateBody: Record<string, any> = {
            id: pageId,
            status: 'current',
            version: {
                number: data.version + 1,
            },
        };

        if (data.title) {
            updateBody.title = data.title;
        }

        if (data.body) {
            updateBody.body = {
                representation: 'storage',
                value: data.body,
            };
        }

        return await this.request<ConfluencePageType>(`/pages/${pageId}`, {
            method: 'PUT',
            body: updateBody,
        });
    }

    /**
     * Create a page as a draft (v2 API) — visible only to creator, not published
     * The reviewer can then publish it after review.
     */
    async createProposalPage(data: {
        spaceId: string;
        title: string;
        body: string;
        parentId?: string;
    }): Promise<ConfluencePageType> {
        return await this.request<ConfluencePageType>('/pages', {
            method: 'POST',
            body: {
                spaceId: data.spaceId,
                status: 'current',
                title: data.title,
                parentId: data.parentId,
                body: {
                    representation: 'storage',
                    value: data.body,
                },
            },
        });
    }

    /**
     * Add a footer comment to a page (v2 API)
     * Requires write:comment:confluence scope
     */
    async addPageComment(
        pageId: string,
        body: string
    ): Promise<{ id: string }> {
        return this.request<{ id: string }>('/footer-comments', {
            method: 'POST',
            body: {
                pageId,
                body: {
                    representation: 'storage',
                    value: body,
                },
            },
        });
    }

    /**
     * Get the web URL for a page.
     * Uses the /spaces/KEY/pages/ID/TITLE format for proper clickable links.
     */
    getPageWebUrl(siteUrl: string, pageId: string, spaceKey?: string, pageTitle?: string): string {
        if (spaceKey && pageTitle) {
            const encodedTitle = pageTitle.replace(/\s+/g, '+').replace(/[^\w+\-]/g, '');
            return `${siteUrl}/wiki/spaces/${spaceKey}/pages/${pageId}/${encodedTitle}`;
        }
        return `${siteUrl}/wiki/pages/${pageId}`;
    }

    /**
     * Get page by title in a space (using search)
     */
    async getPageByTitle(spaceKey: string, title: string): Promise<ConfluencePageType | null> {
        const { results } = await this.search(`space = "${spaceKey}" AND title = "${title}"`, { limit: 1 });
        if (results.length > 0 && results[0].content) {
            // Get full page content
            return await this.getPage(results[0].content.id);
        }
        return null;
    }

    /**
     * Create a new Confluence space (v1 API).
     * Returns the space ID and key.
     */
    async createSpace(key: string, name: string, description: string = ''): Promise<{ id: string; key: string }> {
        const v1BaseUrl = `https://api.atlassian.com/ex/confluence/${this.cloudId}/wiki/rest/api`;

        await atlassianRateLimiter.waitForToken(this.cloudId);

        const response = await fetch(`${v1BaseUrl}/space`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                key,
                name,
                description: {
                    plain: {
                        value: description,
                        representation: 'plain',
                    },
                },
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Confluence create space error (${response.status}): ${error}`);
        }

        const data = await response.json();
        return { id: String(data.id), key: data.key };
    }
}
