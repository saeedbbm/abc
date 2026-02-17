import { z } from "zod";

// Atlassian common types

export const AtlassianUser = z.object({
    accountId: z.string(),
    accountType: z.string().optional(),
    emailAddress: z.string().optional(),
    displayName: z.string().optional(),
    active: z.boolean().optional(),
    avatarUrls: z.record(z.string()).optional(),
    self: z.string().optional(),
});

export type AtlassianUserType = z.infer<typeof AtlassianUser>;

// Jira types

export const JiraProject = z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string().optional(),
    lead: AtlassianUser.optional(),
    projectTypeKey: z.string().optional(),
    simplified: z.boolean().optional(),
    style: z.string().optional(),
    isPrivate: z.boolean().optional(),
    self: z.string().optional(),
});

export type JiraProjectType = z.infer<typeof JiraProject>;

export const JiraIssueStatus = z.object({
    self: z.string().optional(),
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    statusCategory: z.object({
        id: z.number().optional(),
        key: z.string().optional(),
        name: z.string().optional(),
        colorName: z.string().optional(),
    }).optional(),
});

export const JiraIssueType = z.object({
    self: z.string().optional(),
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    subtask: z.boolean().optional(),
    iconUrl: z.string().optional(),
});

export const JiraIssuePriority = z.object({
    self: z.string().optional(),
    id: z.string().optional(),
    name: z.string(),
    iconUrl: z.string().optional(),
});

export const JiraIssue = z.object({
    id: z.string(),
    key: z.string(),
    self: z.string().optional(),
    fields: z.object({
        summary: z.string(),
        description: z.any().optional(), // Can be ADF or string
        status: JiraIssueStatus.optional(),
        issuetype: JiraIssueType.optional(),
        priority: JiraIssuePriority.optional(),
        assignee: AtlassianUser.nullable().optional(),
        reporter: AtlassianUser.nullable().optional(),
        creator: AtlassianUser.nullable().optional(),
        created: z.string().optional(),
        updated: z.string().optional(),
        resolutiondate: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        project: z.object({
            id: z.string().optional(),
            key: z.string().optional(),
            name: z.string().optional(),
        }).optional(),
        parent: z.object({
            id: z.string().optional(),
            key: z.string().optional(),
        }).optional(),
        subtasks: z.array(z.object({
            id: z.string(),
            key: z.string(),
        })).optional(),
        comment: z.object({
            comments: z.array(z.object({
                id: z.string(),
                author: AtlassianUser.optional(),
                body: z.any().optional(),
                created: z.string().optional(),
                updated: z.string().optional(),
            })).optional(),
            total: z.number().optional(),
        }).optional(),
    }),
    changelog: z.object({
        histories: z.array(z.object({
            id: z.string(),
            author: AtlassianUser.optional(),
            created: z.string(),
            items: z.array(z.object({
                field: z.string(),
                fieldtype: z.string().optional(),
                from: z.string().nullable().optional(),
                fromString: z.string().nullable().optional(),
                to: z.string().nullable().optional(),
                toString: z.string().nullable().optional(),
            })),
        })).optional(),
    }).optional(),
});

export type JiraIssueTypeSchema = z.infer<typeof JiraIssue>;

export const JiraComment = z.object({
    id: z.string(),
    author: AtlassianUser.optional(),
    body: z.any(), // Can be ADF or string
    created: z.string().optional(),
    updated: z.string().optional(),
    self: z.string().optional(),
});

export type JiraCommentType = z.infer<typeof JiraComment>;

// New /search/jql API returns different format than old /search
export const JiraSearchResponse = z.object({
    issues: z.array(JiraIssue),
    isLast: z.boolean().optional(),
    // Old API fields (may not be present in new API)
    expand: z.string().optional(),
    startAt: z.number().optional(),
    maxResults: z.number().optional(),
    total: z.number().optional(),
});

export type JiraSearchResponseType = z.infer<typeof JiraSearchResponse>;

// Confluence types

export const ConfluenceSpace = z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    type: z.string().optional(),
    status: z.string().optional(),
    description: z.object({
        plain: z.object({
            value: z.string(),
            representation: z.string(),
        }).optional(),
    }).optional(),
    homepageId: z.string().optional(),
    _links: z.object({
        webui: z.string().optional(),
        self: z.string().optional(),
    }).optional(),
});

export type ConfluenceSpaceType = z.infer<typeof ConfluenceSpace>;

export const ConfluencePage = z.object({
    id: z.string(),
    title: z.string(),
    status: z.string().optional(),
    spaceId: z.string().optional(),
    parentId: z.string().nullable().optional(),
    parentType: z.string().optional(),
    position: z.number().nullable().optional(),
    authorId: z.string().optional(),
    ownerId: z.string().optional(),
    createdAt: z.string().optional(),
    version: z.object({
        number: z.number(),
        message: z.string().optional(),
        createdAt: z.string().optional(),
        authorId: z.string().optional(),
    }).optional(),
    body: z.object({
        storage: z.object({
            value: z.string(),
            representation: z.string(),
        }).optional(),
        atlas_doc_format: z.object({
            value: z.string(),
            representation: z.string(),
        }).optional(),
    }).optional(),
    _links: z.object({
        webui: z.string().optional(),
        editui: z.string().optional(),
        tinyui: z.string().optional(),
    }).optional(),
});

export type ConfluencePageType = z.infer<typeof ConfluencePage>;

export const ConfluenceSearchResult = z.object({
    results: z.array(z.object({
        content: ConfluencePage.optional(),
        title: z.string().optional(),
        excerpt: z.string().optional(),
        url: z.string().optional(),
        lastModified: z.string().optional(),
        space: z.object({
            key: z.string().optional(),
            name: z.string().optional(),
        }).optional(),
    })),
    start: z.number().optional(),
    limit: z.number().optional(),
    size: z.number().optional(),
    totalSize: z.number().optional(),
    _links: z.object({
        next: z.string().optional(),
    }).optional(),
});

// OAuth types

export const AtlassianOAuthTokenResponse = z.object({
    access_token: z.string(),
    token_type: z.string(),
    expires_in: z.number(),
    refresh_token: z.string().optional(),
    scope: z.string(),
});

export type AtlassianOAuthTokenResponseType = z.infer<typeof AtlassianOAuthTokenResponse>;

export const AtlassianAccessibleResource = z.object({
    id: z.string(), // cloudId
    url: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
    avatarUrl: z.string().optional(),
});

export type AtlassianAccessibleResourceType = z.infer<typeof AtlassianAccessibleResource>;
