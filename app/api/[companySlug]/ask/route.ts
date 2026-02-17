import { NextRequest } from "next/server";
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { embed, streamText, tool } from "ai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { db } from "@/lib/mongodb";
import { resolveCompanySlug } from "@/lib/company-resolver";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { SlackClient } from "@/src/application/lib/integrations/slack";
import { JiraClient, ConfluenceClient, getValidAtlassianToken } from "@/src/application/lib/integrations/atlassian";
import { searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge";
import { logLowConfidenceQuery } from "@/src/application/lib/knowledge/gap-feedback";

// Initialize repositories
const oauthTokensRepository = new MongoDBOAuthTokensRepository();
const knowledgeEntitiesRepository = new MongoDBKnowledgeEntitiesRepository();
const knowledgeDocumentsRepository = new MongoDBKnowledgeDocumentsRepository();

// Initialize Qdrant client
const qdrantClient = new QdrantClient({
    url: process.env.QDRANT_URL || "http://localhost:6333",
    apiKey: process.env.QDRANT_API_KEY,
    checkCompatibility: false,
});

// Embedding model
const embeddingModel = openai.embedding("text-embedding-3-small");

// Request schema
const AskRequest = z.object({
    message: z.string().min(1),
});

export const maxDuration = 60;

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    // Parse request
    let data;
    try {
        const body = await req.json();
        data = AskRequest.parse(body);
    } catch (e) {
        return Response.json({ error: "Invalid request" }, { status: 400 });
    }

    const { message } = data;

    try {
        // Verify project exists
        const project = await db.collection('projects').findOne({ _id: projectId });
        if (!project) {
            return Response.json({ error: "Project not found" }, { status: 404 });
        }

        // Get OAuth tokens for integrations
        const slackToken = await oauthTokensRepository.fetchByProjectAndProvider(projectId, 'slack');
        
        // Get Atlassian token with auto-refresh
        const atlassianToken = await getValidAtlassianToken(projectId);

        console.log(`[Ask] Connected integrations - Slack: ${slackToken ? 'yes' : 'no'}, Atlassian: ${atlassianToken ? 'yes' : 'no'}`);
        
        // Debug: Log Atlassian metadata
        if (atlassianToken) {
            console.log(`[Ask] Atlassian cloudId: ${atlassianToken.metadata?.cloudId}`);
            console.log(`[Ask] Atlassian siteUrl: ${atlassianToken.metadata?.siteUrl}`);
            console.log(`[Ask] Atlassian token expires: ${atlassianToken.expiresAt}`);
        }

        // Initialize clients
        const slackClient = slackToken ? new SlackClient(slackToken.accessToken) : null;
        const jiraClient = atlassianToken && atlassianToken.metadata?.cloudId 
            ? new JiraClient(atlassianToken.accessToken, atlassianToken.metadata.cloudId as string) : null;
        const confluenceClient = atlassianToken && atlassianToken.metadata?.cloudId 
            ? new ConfluenceClient(atlassianToken.accessToken, atlassianToken.metadata.cloudId as string) : null;

        // Search entities
        const entities = await knowledgeEntitiesRepository.searchByName(projectId, message, { limit: 5 });
        const entitiesContext = entities.length > 0 ? entities.map(e => {
            const meta = e.metadata as Record<string, any>;
            const lines = [`${e.type}: ${e.name}`];
            if (e.aliases.length > 0) lines.push(`  Aliases: ${e.aliases.join(', ')}`);
            if (meta.role) lines.push(`  Role: ${meta.role}`);
            if (meta.team) lines.push(`  Team: ${meta.team}`);
            if (meta.responsibilities?.length > 0) lines.push(`  Responsibilities: ${meta.responsibilities.join(', ')}`);
            if (meta.workingOn?.length > 0) lines.push(`  Working on: ${meta.workingOn.join(', ')}`);
            if (meta.status) lines.push(`  Status: ${meta.status}`);
            if (meta.description) lines.push(`  Description: ${meta.description}`);
            return lines.join('\n');
        }).join('\n\n') : "";

        // Search knowledge documents using vector similarity (semantic search)
        console.log('[Ask] Searching knowledge embeddings for:', message);
        const knowledgeResults = await searchKnowledgeEmbeddings(projectId, message, { limit: 10 });
        console.log('[Ask] Found', knowledgeResults.length, 'relevant knowledge chunks');

        // Track queries with poor results for gap detection feedback loop
        const maxKnowledgeScore = knowledgeResults.length > 0
            ? Math.max(...knowledgeResults.map(r => r.score))
            : 0;
        if (knowledgeResults.length < 3 || maxKnowledgeScore < 0.5) {
            // Low-confidence result: log for gap detection
            logLowConfidenceQuery(projectId, message, knowledgeResults.length, maxKnowledgeScore)
                .catch(() => {}); // Fire and forget
        }

        const docsContext = knowledgeResults.length > 0 ? knowledgeResults.map(r => {
            const meta = r.metadata as Record<string, any>;
            const sourceInfo = [];
            if (r.provider === 'slack') {
                if (meta.channelName) sourceInfo.push(`#${meta.channelName}`);
                if (meta.userId) sourceInfo.push(`from user ${meta.userId}`);
            }
            return `[${r.provider}/${r.sourceType}: ${r.title}${sourceInfo.length > 0 ? ` (${sourceInfo.join(', ')})` : ''}]\n${r.content}`;
        }).join('\n\n---\n\n') : "";

        // Build available integrations list
        const integrations: string[] = [];
        if (slackClient) integrations.push("Slack (list channels, send messages)");
        if (jiraClient) integrations.push("Jira (list projects, search issues, get issue details, create issues)");
        if (confluenceClient) integrations.push("Confluence (list spaces, get pages, search content)");

        // Build the system prompt
        const systemPrompt = `You are a helpful AI assistant for a company. You can answer questions about the team and company based on the knowledge base, and you can also interact with connected tools.

${entitiesContext ? `## Entity Information\n${entitiesContext}\n` : ""}
${docsContext ? `## Knowledge Documents\n${docsContext}\n` : ""}

## Available Integrations
${integrations.length > 0 ? integrations.map(i => `- ${i}`).join('\n') : "No integrations connected yet."}

## Instructions
- Answer questions accurately and helpfully based on the knowledge base
- Use the available tools when the user asks about Slack channels, Jira projects/issues, or Confluence spaces/pages
- Be concise but complete
- If you use a tool, summarize the results in a friendly way
- When asked about a person, include their role, team, and what they're working on
- When asked about a project, include its status and who's involved
- When creating a Jira issue and assigning it to someone, FIRST use jira_search_users to find their accountId, THEN use jira_create_issue with that accountId
- For Jira issue types, use: Task, Bug, Story, Epic (not "Feature" - use Story instead)`;

        // Define tools
        const tools: Record<string, any> = {};

        // Slack tools
        if (slackClient) {
            tools.slack_list_channels = tool({
                description: "List all Slack channels in the workspace",
                parameters: z.object({}),
                execute: async () => {
                    try {
                        const channels: any[] = [];
                        for await (const channel of slackClient.listAllChannels()) {
                            channels.push({
                                id: channel.id,
                                name: channel.name,
                                isPrivate: channel.is_private,
                                memberCount: channel.num_members,
                                topic: channel.topic?.value,
                            });
                            if (channels.length >= 20) break;
                        }
                        return { channels, count: channels.length };
                    } catch (error) {
                        return { error: `Failed to list channels: ${error}` };
                    }
                },
            });

            tools.slack_send_message = tool({
                description: "Send a message to a Slack channel",
                parameters: z.object({
                    channel: z.string().describe("The channel ID or name to send to"),
                    text: z.string().describe("The message text to send"),
                }),
                execute: async ({ channel, text }) => {
                    try {
                        const result = await slackClient.postMessage(channel, text);
                        return { success: true, ts: result.ts, channel: result.channel };
                    } catch (error) {
                        return { error: `Failed to send message: ${error}` };
                    }
                },
            });

            tools.slack_read_messages = tool({
                description: "Read recent messages from a Slack channel. Use this to see what people are talking about or working on.",
                parameters: z.object({
                    channel: z.string().describe("The channel ID (e.g., C0123456789) - get from slack_list_channels"),
                    limit: z.number().optional().default(20).describe("Number of messages to fetch (max 100)"),
                }),
                execute: async ({ channel, limit }) => {
                    try {
                        console.log('[Ask] Reading Slack messages from channel:', channel);
                        const { messages } = await slackClient.getChannelHistory(channel, { limit: limit || 20 });
                        console.log('[Ask] Got', messages.length, 'messages');
                        
                        return messages.map(m => ({
                            user: m.user,
                            text: m.text,
                            timestamp: m.ts,
                            threadTs: m.thread_ts,
                            reactions: m.reactions?.map((r: any) => `${r.name}(${r.count})`),
                        }));
                    } catch (error) {
                        console.error('[Ask] slack_read_messages ERROR:', error);
                        return { error: `Failed to read messages: ${error}` };
                    }
                },
            });

            tools.slack_get_user_info = tool({
                description: "Get information about a Slack user by their ID",
                parameters: z.object({
                    userId: z.string().describe("The Slack user ID (e.g., U0123456789)"),
                }),
                execute: async ({ userId }) => {
                    try {
                        const user = await slackClient.getUserInfo(userId);
                        return {
                            id: user.id,
                            name: user.name,
                            realName: user.real_name,
                            displayName: user.profile?.display_name,
                            email: user.profile?.email,
                            title: user.profile?.title,
                            isBot: user.is_bot,
                        };
                    } catch (error) {
                        return { error: `Failed to get user: ${error}` };
                    }
                },
            });

            tools.slack_list_users = tool({
                description: "List all users/team members in the Slack workspace",
                parameters: z.object({}),
                execute: async () => {
                    try {
                        console.log('[Ask] Listing Slack users...');
                        const users: any[] = [];
                        for await (const user of slackClient.listAllUsers()) {
                            // Skip bots and deleted users
                            if (!user.is_bot && !user.deleted) {
                                users.push({
                                    id: user.id,
                                    name: user.name,
                                    realName: user.real_name,
                                    displayName: user.profile?.display_name,
                                    email: user.profile?.email,
                                    title: user.profile?.title,
                                    isAdmin: user.is_admin,
                                    isOwner: user.is_owner,
                                });
                            }
                            if (users.length >= 50) break;
                        }
                        console.log('[Ask] Found', users.length, 'Slack users');
                        return { users, count: users.length };
                    } catch (error) {
                        console.error('[Ask] slack_list_users ERROR:', error);
                        return { error: `Failed to list users: ${error}` };
                    }
                },
            });
        }

        // Jira tools
        if (jiraClient) {
            tools.jira_list_projects = tool({
                description: "List all Jira projects accessible to the user",
                parameters: z.object({}),
                execute: async () => {
                    try {
                        console.log('[Ask] Calling jira_list_projects...');
                        const projects = await jiraClient.listProjects();
                        console.log('[Ask] jira_list_projects returned', projects.length, 'projects');
                        return projects.map(p => ({
                            key: p.key,
                            name: p.name,
                            lead: p.lead?.displayName,
                            type: p.projectTypeKey,
                        }));
                    } catch (error) {
                        console.error('[Ask] jira_list_projects ERROR:', error);
                        return { error: `Failed to list projects: ${error}` };
                    }
                },
            });

            tools.jira_search_issues = tool({
                description: "Search for Jira issues using JQL query",
                parameters: z.object({
                    jql: z.string().describe("JQL query string. Examples: 'type = Bug', 'project = PROJ AND status = Open'"),
                    maxResults: z.number().optional().default(20).describe("Maximum number of results"),
                }),
                execute: async ({ jql, maxResults }) => {
                    try {
                        console.log('[Ask] Calling jira_search_issues with JQL:', jql);
                        const result = await jiraClient.searchIssues(jql, { 
                            maxResults: maxResults || 20,
                            fields: ['key', 'summary', 'status', 'issuetype', 'priority', 'assignee'],
                        });
                        const issues = result.issues || [];
                        console.log('[Ask] jira_search_issues returned', issues.length, 'issues');
                        if (issues.length > 0) {
                            console.log('[Ask] First issue:', JSON.stringify(issues[0]).substring(0, 500));
                        }
                        return {
                            total: issues.length,
                            isLast: result.isLast,
                            issues: issues.map(i => ({
                                key: i.key,
                                summary: i.fields?.summary,
                                status: i.fields?.status?.name,
                                assignee: i.fields?.assignee?.displayName,
                                type: i.fields?.issuetype?.name,
                                priority: i.fields?.priority?.name,
                            })),
                        };
                    } catch (error) {
                        console.error('[Ask] jira_search_issues ERROR:', error);
                        return { error: `Failed to search issues: ${error}` };
                    }
                },
            });

            tools.jira_get_issue = tool({
                description: "Get details of a specific Jira issue by its key",
                parameters: z.object({
                    issueKey: z.string().describe("The issue key like PROJ-123"),
                }),
                execute: async ({ issueKey }) => {
                    try {
                        const issue = await jiraClient.getIssue(issueKey);
                        return {
                            key: issue.key,
                            summary: issue.fields.summary,
                            description: issue.fields.description,
                            status: issue.fields.status?.name,
                            assignee: issue.fields.assignee?.displayName,
                            reporter: issue.fields.reporter?.displayName,
                            type: issue.fields.issuetype?.name,
                            priority: issue.fields.priority?.name,
                            labels: issue.fields.labels,
                            created: issue.fields.created,
                            updated: issue.fields.updated,
                        };
                    } catch (error) {
                        return { error: `Failed to get issue: ${error}` };
                    }
                },
            });

            tools.jira_create_issue = tool({
                description: "Create a new Jira issue. To assign to someone, first use jira_search_users to get their accountId.",
                parameters: z.object({
                    projectKey: z.string().describe("The project key (e.g., 'KAN')"),
                    summary: z.string().describe("Issue title/summary"),
                    description: z.string().optional().describe("Issue description"),
                    issueType: z.string().optional().default("Task").describe("Issue type: Task, Bug, Story, Feature, etc."),
                    assigneeAccountId: z.string().optional().describe("The accountId of the user to assign (get from jira_search_users)"),
                }),
                execute: async ({ projectKey, summary, description, issueType, assigneeAccountId }) => {
                    try {
                        console.log('[Ask] Creating Jira issue:', { projectKey, summary, issueType, assigneeAccountId });
                        const result = await jiraClient.createIssue({
                            projectKey,
                            summary,
                            description,
                            issueType: issueType || "Task",
                            assigneeAccountId,
                        });
                        console.log('[Ask] Created Jira issue:', result.key);
                        return { success: true, key: result.key, id: result.id, url: `https://pidrax-demo.atlassian.net/browse/${result.key}` };
                    } catch (error) {
                        console.error('[Ask] jira_create_issue ERROR:', error);
                        return { error: `Failed to create issue: ${error}` };
                    }
                },
            });

            tools.jira_search_users = tool({
                description: "Search for Jira users by name or email. Returns accountId which can be used for assignment.",
                parameters: z.object({
                    query: z.string().describe("Search query - name or email of the user"),
                }),
                execute: async ({ query }) => {
                    try {
                        console.log('[Ask] Searching Jira users with query:', query);
                        const users = await jiraClient.searchUsers(query, 0, 10);
                        console.log('[Ask] Found', users.length, 'users');
                        return users.map(u => ({
                            accountId: u.accountId,
                            displayName: u.displayName,
                            emailAddress: u.emailAddress,
                            active: u.active,
                        }));
                    } catch (error) {
                        console.error('[Ask] jira_search_users ERROR:', error);
                        return { error: `Failed to search users: ${error}` };
                    }
                },
            });

            tools.jira_list_all_users = tool({
                description: "List all users/team members in Jira",
                parameters: z.object({}),
                execute: async () => {
                    try {
                        console.log('[Ask] Listing all Jira users...');
                        const users = await jiraClient.searchUsers('', 0, 50);
                        console.log('[Ask] Found', users.length, 'Jira users');
                        return {
                            users: users.map(u => ({
                                accountId: u.accountId,
                                displayName: u.displayName,
                                emailAddress: u.emailAddress,
                                active: u.active,
                            })),
                            count: users.length,
                        };
                    } catch (error) {
                        console.error('[Ask] jira_list_all_users ERROR:', error);
                        return { error: `Failed to list users: ${error}` };
                    }
                },
            });
        }

        // Confluence tools
        if (confluenceClient) {
            tools.confluence_list_spaces = tool({
                description: "List all Confluence spaces",
                parameters: z.object({}),
                execute: async () => {
                    try {
                        console.log('[Ask] Calling confluence_list_spaces...');
                        const spaces: any[] = [];
                        for await (const space of confluenceClient.listAllSpaces()) {
                            spaces.push({
                                id: space.id,
                                key: space.key,
                                name: space.name,
                                type: space.type,
                            });
                            if (spaces.length >= 20) break;
                        }
                        console.log('[Ask] confluence_list_spaces returned', spaces.length, 'spaces');
                        return { spaces, count: spaces.length };
                    } catch (error) {
                        console.error('[Ask] confluence_list_spaces ERROR:', error);
                        return { error: `Failed to list spaces: ${error}` };
                    }
                },
            });

            tools.confluence_search = tool({
                description: "Search Confluence content using CQL",
                parameters: z.object({
                    cql: z.string().describe("CQL query string. Example: 'text ~ \"keyword\"'"),
                    limit: z.number().optional().default(10).describe("Maximum results"),
                }),
                execute: async ({ cql, limit }) => {
                    try {
                        console.log('[Ask] Calling confluence_search with CQL:', cql);
                        const result = await confluenceClient.search(cql, { limit: limit || 10 });
                        console.log('[Ask] confluence_search returned', result.results.length, 'results');
                        return result.results.map(r => ({
                            title: r.title,
                            excerpt: r.excerpt,
                            url: r.url,
                            lastModified: r.lastModified,
                        }));
                    } catch (error) {
                        console.error('[Ask] confluence_search ERROR:', error);
                        return { error: `Failed to search: ${error}` };
                    }
                },
            });

            tools.confluence_get_page = tool({
                description: "Get the content of a specific Confluence page",
                parameters: z.object({
                    pageId: z.string().describe("The Confluence page ID"),
                }),
                execute: async ({ pageId }) => {
                    try {
                        const page = await confluenceClient.getPage(pageId);
                        return {
                            id: page.id,
                            title: page.title,
                            body: page.body?.storage?.value?.substring(0, 2000),
                            version: page.version?.number,
                            url: page._links?.webui,
                        };
                    } catch (error) {
                        return { error: `Failed to get page: ${error}` };
                    }
                },
            });
        }

        // Stream the response with tools
        const result = streamText({
            model: openai("gpt-4o-mini"),
            system: systemPrompt,
            prompt: message,
            tools: Object.keys(tools).length > 0 ? tools : undefined,
            maxSteps: 5,
        });

        // Create SSE stream
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    for await (const chunk of result.textStream) {
                        controller.enqueue(
                            encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`)
                        );
                    }
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`)
                    );
                } catch (error) {
                    console.error("Stream error:", error);
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify({ error: "Stream failed" })}\n\n`)
                    );
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });
    } catch (error) {
        console.error("Ask API error:", error);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }
}
