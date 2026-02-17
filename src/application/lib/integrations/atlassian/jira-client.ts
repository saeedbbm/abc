import { 
    JiraProjectType, 
    JiraIssueTypeSchema, 
    JiraCommentType,
    JiraSearchResponseType,
    AtlassianUserType,
} from './types';
import { atlassianRateLimiter } from './rate-limiter';

const JIRA_API_VERSION = '3';

export class JiraClient {
    private accessToken: string;
    private cloudId: string;
    private baseUrl: string;

    constructor(accessToken: string, cloudId: string) {
        this.accessToken = accessToken;
        this.cloudId = cloudId;
        this.baseUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/${JIRA_API_VERSION}`;
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

        console.log(`[JiraClient] ${method} ${url}`);
        if (body) {
            console.log('[JiraClient] Request body:', JSON.stringify(body));
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
        
        console.log(`[JiraClient] Response status: ${response.status}`);

        // Handle rate limiting
        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
            atlassianRateLimiter.setRetryAfter(this.cloudId, retryAfter);
            throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
        }

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Jira API error (${response.status}): ${error}`);
        }

        // Handle empty responses
        const text = await response.text();
        if (!text) {
            return {} as T;
        }

        const parsed = JSON.parse(text);
        console.log('[JiraClient] Response keys:', Object.keys(parsed));
        return parsed as T;
    }

    /**
     * List all accessible projects
     */
    async listProjects(): Promise<JiraProjectType[]> {
        const response = await this.request<JiraProjectType[]>('/project', {
            params: { expand: 'lead,description' },
        });
        return response;
    }

    /**
     * Get a single project
     */
    async getProject(projectKeyOrId: string): Promise<JiraProjectType> {
        return await this.request<JiraProjectType>(`/project/${projectKeyOrId}`, {
            params: { expand: 'lead,description' },
        });
    }

    /**
     * Search issues using JQL
     * Note: Uses the new /search/jql endpoint (the old /search was deprecated)
     * Trying GET with query parameters as POST was returning 400
     */
    async searchIssues(
        jql: string,
        options: {
            startAt?: number;
            maxResults?: number;
            fields?: string[];
            expand?: string;  // Should be comma-separated string
        } = {}
    ): Promise<JiraSearchResponseType> {
        const { startAt = 0, maxResults = 50, fields, expand } = options;
        
        // Use GET with query parameters
        const params: Record<string, any> = {
            jql,
            startAt,
            maxResults,
        };
        
        // Fields as comma-separated string for query params
        if (fields && fields.length > 0) {
            params.fields = fields.join(',');
        }
        
        if (expand) {
            params.expand = expand;
        }
        
        return await this.request<JiraSearchResponseType>('/search/jql', {
            method: 'GET',
            params,
        });
    }

    /**
     * Search all issues with pagination
     */
    async *searchAllIssues(
        jql: string,
        options: {
            fields?: string[];
            expand?: string;  // Should be comma-separated string
        } = {}
    ): AsyncGenerator<JiraIssueTypeSchema> {
        let startAt = 0;
        const maxResults = 100;
        let total = Infinity;

        while (startAt < total) {
            const response = await this.searchIssues(jql, {
                startAt,
                maxResults,
                ...options,
            });

            total = response.total ?? 0;

            for (const issue of response.issues) {
                yield issue;
            }

            startAt += response.issues.length;
            
            if (response.issues.length === 0) {
                break;
            }
        }
    }

    /**
     * Get a single issue
     */
    async getIssue(issueKeyOrId: string, expand?: string[]): Promise<JiraIssueTypeSchema> {
        return await this.request<JiraIssueTypeSchema>(`/issue/${issueKeyOrId}`, {
            params: {
                expand: expand?.join(',') || 'changelog',
                fields: 'summary,description,status,issuetype,priority,assignee,reporter,creator,created,updated,labels,project,parent,subtasks,comment',
            },
        });
    }

    /**
     * Get issue comments
     */
    async getIssueComments(
        issueKeyOrId: string,
        options: {
            startAt?: number;
            maxResults?: number;
        } = {}
    ): Promise<{ comments: JiraCommentType[]; total: number }> {
        const { startAt = 0, maxResults = 50 } = options;
        
        const response = await this.request<{
            startAt: number;
            maxResults: number;
            total: number;
            comments: JiraCommentType[];
        }>(`/issue/${issueKeyOrId}/comment`, {
            params: { startAt, maxResults },
        });

        return {
            comments: response.comments,
            total: response.total,
        };
    }

    /**
     * Get all comments for an issue
     */
    async getAllIssueComments(issueKeyOrId: string): Promise<JiraCommentType[]> {
        const allComments: JiraCommentType[] = [];
        let startAt = 0;
        const maxResults = 100;
        let total = Infinity;

        while (startAt < total) {
            const response = await this.getIssueComments(issueKeyOrId, { startAt, maxResults });
            total = response.total ?? 0;
            allComments.push(...response.comments);
            startAt += response.comments.length;

            if (response.comments.length === 0) {
                break;
            }
        }

        return allComments;
    }

    /**
     * Search users
     */
    async searchUsers(query?: string, startAt: number = 0, maxResults: number = 50): Promise<AtlassianUserType[]> {
        const response = await this.request<AtlassianUserType[]>('/users/search', {
            params: {
                query: query || '',
                startAt,
                maxResults,
            },
        });
        return response;
    }

    /**
     * Search all users with pagination
     */
    async *searchAllUsers(query?: string): AsyncGenerator<AtlassianUserType> {
        let startAt = 0;
        const maxResults = 100;
        let hasMore = true;

        while (hasMore) {
            const users = await this.searchUsers(query, startAt, maxResults);
            
            for (const user of users) {
                yield user;
            }

            hasMore = users.length === maxResults;
            startAt += users.length;
        }
    }

    /**
     * Create an issue
     */
    async createIssue(data: {
        projectKey: string;
        summary: string;
        description?: string;
        issueType: string;
        assigneeAccountId?: string;
        labels?: string[];
        priority?: string;
    }): Promise<{ id: string; key: string; self: string }> {
        const fields: Record<string, any> = {
            project: { key: data.projectKey },
            summary: data.summary,
            issuetype: { name: data.issueType },
        };

        if (data.description) {
            // Use Atlassian Document Format (ADF) for description
            fields.description = {
                type: 'doc',
                version: 1,
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: data.description },
                        ],
                    },
                ],
            };
        }

        if (data.assigneeAccountId) {
            fields.assignee = { accountId: data.assigneeAccountId };
        }

        if (data.labels) {
            fields.labels = data.labels;
        }

        if (data.priority) {
            fields.priority = { name: data.priority };
        }

        return await this.request<{ id: string; key: string; self: string }>('/issue', {
            method: 'POST',
            body: { fields },
        });
    }

    /**
     * Add a comment to an issue
     */
    async addComment(issueKeyOrId: string, body: string): Promise<JiraCommentType> {
        return await this.request<JiraCommentType>(`/issue/${issueKeyOrId}/comment`, {
            method: 'POST',
            body: {
                body: {
                    type: 'doc',
                    version: 1,
                    content: [
                        {
                            type: 'paragraph',
                            content: [
                                { type: 'text', text: body },
                            ],
                        },
                    ],
                },
            },
        });
    }

    /**
     * Update an issue
     */
    async updateIssue(
        issueKeyOrId: string,
        fields: {
            summary?: string;
            description?: string;
            assigneeAccountId?: string;
            labels?: string[];
            priority?: string;
        }
    ): Promise<void> {
        const updateFields: Record<string, any> = {};

        if (fields.summary) {
            updateFields.summary = fields.summary;
        }

        if (fields.description) {
            updateFields.description = {
                type: 'doc',
                version: 1,
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: fields.description },
                        ],
                    },
                ],
            };
        }

        if (fields.assigneeAccountId) {
            updateFields.assignee = { accountId: fields.assigneeAccountId };
        }

        if (fields.labels) {
            updateFields.labels = fields.labels;
        }

        if (fields.priority) {
            updateFields.priority = { name: fields.priority };
        }

        await this.request<void>(`/issue/${issueKeyOrId}`, {
            method: 'PUT',
            body: { fields: updateFields },
        });
    }
}
