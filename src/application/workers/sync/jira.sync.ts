import { JiraClient } from "@/src/application/lib/integrations/atlassian";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { MongoDBSyncStateRepository } from "@/src/infrastructure/repositories/mongodb.sync-state.repository";
import { 
    JiraProjectType, 
    JiraIssueTypeSchema, 
    JiraCommentType,
    AtlassianUserType,
} from "@/src/application/lib/integrations/atlassian/types";
import { PrefixLogger } from "@/lib/utils";
import { embedKnowledgeDocuments, ensureKnowledgeCollection } from "@/src/application/lib/knowledge";

export interface JiraSyncOptions {
    projectId: string;
    // How far back to sync issues (in days)
    issueDays?: number;
    // Specific Jira project keys to sync (empty = all)
    projectKeys?: string[];
    // Whether to sync comments
    includeComments?: boolean;
    // Whether to generate embeddings (default: true)
    generateEmbeddings?: boolean;
}

export class JiraSyncWorker {
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
        this.logger = logger || new PrefixLogger('jira-sync');
    }

    async sync(options: JiraSyncOptions): Promise<{
        users: number;
        projects: number;
        issues: number;
        comments: number;
        embedded: number;
    }> {
        const { projectId, issueDays = 7, projectKeys = [], includeComments = true, generateEmbeddings = true } = options;
        
        this.logger.log(`Starting Jira sync for project ${projectId}`);

        // Update sync state to 'syncing'
        await this.syncStateRepository.upsert(projectId, 'jira', {
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

        // Get site URL for constructing browse links
        const siteUrl = token.metadata?.siteUrl || `https://your-site.atlassian.net`;

        const client = new JiraClient(token.accessToken, cloudId);

        let stats = {
            users: 0,
            projects: 0,
            issues: 0,
            comments: 0,
            embedded: 0,
        };

        // Ensure embedding collection exists
        if (generateEmbeddings) {
            await ensureKnowledgeCollection(this.logger);
        }

        // Sync users
        this.logger.log('Syncing users...');
        stats.users = await this.syncUsers(client, projectId);
        this.logger.log(`Synced ${stats.users} users`);

        // Sync projects
        this.logger.log('Syncing projects...');
        const projects = await this.syncProjects(client, projectId, projectKeys);
        stats.projects = projects.length;
        this.logger.log(`Synced ${stats.projects} projects`);

        // Sync issues
        this.logger.log('Syncing issues...');
        const oldest = new Date();
        oldest.setDate(oldest.getDate() - issueDays);
        const { issues, comments } = await this.syncIssues(client, projectId, oldest, projects, includeComments, siteUrl);
        stats.issues = issues;
        stats.comments = comments;
        this.logger.log(`Synced ${stats.issues} issues and ${stats.comments} comments`);

        // Generate embeddings for all Jira documents
        if (generateEmbeddings) {
            this.logger.log(`Fetching all Jira documents for embedding...`);
            const { items: jiraDocs } = await this.knowledgeDocumentsRepository.findByProjectAndProvider(projectId, 'jira');
            
            if (jiraDocs.length > 0) {
                this.logger.log(`Generating embeddings for ${jiraDocs.length} documents...`);
                const embeddingResults = await embedKnowledgeDocuments(jiraDocs, this.logger);
                stats.embedded = embeddingResults.filter(r => r.success).reduce((sum, r) => sum + r.chunksCreated, 0);
                this.logger.log(`Created ${stats.embedded} embedding chunks`);
            }
        }

        // Update sync state on success
        this.logger.log(`Updating sync state: totalDocuments=${stats.projects + stats.issues + stats.comments}, totalEmbeddings=${stats.embedded}`);
        await this.syncStateRepository.upsert(projectId, 'jira', {
            status: 'idle',
            lastSyncedAt: new Date().toISOString(),
            totalDocuments: stats.projects + stats.issues + stats.comments,
            totalEmbeddings: stats.embedded,
            lastError: null,
            consecutiveErrors: 0,
        });
        this.logger.log(`Sync state updated successfully`);

        this.logger.log(`Jira sync completed for project ${projectId}`);
        return stats;
        } catch (error) {
            // Update sync state on error
            const prevState = await this.syncStateRepository.fetch(projectId, 'jira');
            await this.syncStateRepository.upsert(projectId, 'jira', {
                status: 'error',
                lastError: String(error),
                consecutiveErrors: (prevState?.consecutiveErrors || 0) + 1,
            });
            throw error;
        }
    }

    private async syncUsers(client: JiraClient, projectId: string): Promise<number> {
        let count = 0;

        for await (const user of client.searchAllUsers()) {
            try {
                await this.upsertJiraUser(projectId, user);
                count++;
            } catch (error) {
                this.logger.log(`Error syncing user ${user.accountId}: ${error}`);
            }
        }

        return count;
    }

    private async upsertJiraUser(projectId: string, user: AtlassianUserType): Promise<void> {
        const sourceId = user.accountId;
        
        const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'jira', sourceId);
        
        const content = this.formatUserContent(user);
        const metadata = {
            accountId: user.accountId,
            accountType: user.accountType,
            email: user.emailAddress,
            displayName: user.displayName,
            active: user.active,
        };

        if (existing) {
            if (existing.content !== content) {
                await this.knowledgeDocumentsRepository.update(existing.id, {
                    content,
                    metadata,
                    sourceUpdatedAt: new Date().toISOString(),
                });
            }
        } else {
            await this.knowledgeDocumentsRepository.create({
                projectId,
                provider: 'jira',
                sourceType: 'jira_user',
                sourceId,
                title: user.displayName || user.accountId,
                content,
                metadata,
                entityRefs: [],
                syncedAt: new Date().toISOString(),
            });
        }

        // Create/update person entity
        if (user.displayName) {
            await this.knowledgeEntitiesRepository.bulkUpsert([{
                projectId,
                type: 'person',
                name: user.displayName,
                aliases: user.emailAddress ? [user.emailAddress] : [],
                metadata: {
                    email: user.emailAddress,
                    jiraAccountId: user.accountId,
                },
                sources: [{
                    provider: 'jira',
                    sourceType: 'user',
                    sourceId: user.accountId,
                    lastSeen: new Date().toISOString(),
                    confidence: 1,
                }],
            }]);
        }
    }

    private formatUserContent(user: AtlassianUserType): string {
        const lines = [
            `Name: ${user.displayName || user.accountId}`,
        ];
        
        if (user.emailAddress) {
            lines.push(`Email: ${user.emailAddress}`);
        }
        if (user.accountType) {
            lines.push(`Type: ${user.accountType}`);
        }

        return lines.join('\n');
    }

    private async syncProjects(
        client: JiraClient, 
        projectId: string, 
        filterKeys: string[]
    ): Promise<JiraProjectType[]> {
        const allProjects = await client.listProjects();
        
        const projects = filterKeys.length > 0 
            ? allProjects.filter(p => filterKeys.includes(p.key))
            : allProjects;

        for (const project of projects) {
            try {
                await this.upsertJiraProject(projectId, project);
            } catch (error) {
                this.logger.log(`Error syncing project ${project.key}: ${error}`);
            }
        }

        return projects;
    }

    private async upsertJiraProject(projectId: string, project: JiraProjectType): Promise<void> {
        const sourceId = project.id;
        
        const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'jira', sourceId);
        
        const content = this.formatProjectContent(project);
        const metadata = {
            projectId: project.id,
            projectKey: project.key,
            projectType: project.projectTypeKey,
            leadId: project.lead?.accountId,
            leadName: project.lead?.displayName,
        };

        if (existing) {
            if (existing.content !== content) {
                await this.knowledgeDocumentsRepository.update(existing.id, {
                    content,
                    metadata,
                    sourceUpdatedAt: new Date().toISOString(),
                });
            }
        } else {
            await this.knowledgeDocumentsRepository.create({
                projectId,
                provider: 'jira',
                sourceType: 'jira_project',
                sourceId,
                title: `${project.key}: ${project.name}`,
                content,
                metadata,
                entityRefs: [],
                syncedAt: new Date().toISOString(),
            });
        }

        // Create project entity
        await this.knowledgeEntitiesRepository.bulkUpsert([{
            projectId,
            type: 'project',
            name: project.name,
            aliases: [project.key],
            metadata: {
                jiraKey: project.key,
                jiraProjectId: project.id,
                description: project.description,
                lead: project.lead?.displayName,
                status: 'active',
            },
            sources: [{
                provider: 'jira',
                sourceType: 'project',
                sourceId: project.id,
                lastSeen: new Date().toISOString(),
                confidence: 1,
            }],
        }]);
    }

    private formatProjectContent(project: JiraProjectType): string {
        const lines = [
            `Project: ${project.name} (${project.key})`,
        ];
        
        if (project.description) {
            lines.push(`Description: ${project.description}`);
        }
        if (project.lead?.displayName) {
            lines.push(`Lead: ${project.lead.displayName}`);
        }
        if (project.projectTypeKey) {
            lines.push(`Type: ${project.projectTypeKey}`);
        }

        return lines.join('\n');
    }

    private async syncIssues(
        client: JiraClient,
        projectId: string,
        oldest: Date,
        projects: JiraProjectType[],
        includeComments: boolean,
        siteUrl: string
    ): Promise<{ issues: number; comments: number }> {
        let issueCount = 0;
        let commentCount = 0;

        // Build JQL for all projects
        const projectKeys = projects.map(p => p.key);
        const jql = projectKeys.length > 0
            ? `project IN (${projectKeys.join(',')}) AND updated >= "${oldest.toISOString().split('T')[0]}" ORDER BY updated DESC`
            : `updated >= "${oldest.toISOString().split('T')[0]}" ORDER BY updated DESC`;

        const issueFields = [
            'summary', 'description', 'status', 'issuetype', 'priority', 
            'assignee', 'reporter', 'creator', 'created', 'updated', 
            'labels', 'project', 'parent', 'subtasks', 'comment'
        ];
        
        for await (const issue of client.searchAllIssues(jql, { fields: issueFields })) {
            try {
                await this.upsertJiraIssue(projectId, issue, siteUrl);
                issueCount++;

                // Sync comments if requested
                if (includeComments && issue.fields.comment?.comments) {
                    for (const comment of issue.fields.comment.comments) {
                        await this.upsertJiraComment(projectId, issue.key, comment);
                        commentCount++;
                    }
                }
            } catch (error) {
                this.logger.log(`Error syncing issue ${issue.key}: ${error}`);
            }
        }

        return { issues: issueCount, comments: commentCount };
    }

    private async upsertJiraIssue(projectId: string, issue: JiraIssueTypeSchema, siteUrl: string): Promise<void> {
        const sourceId = issue.id;
        
        const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'jira', sourceId);
        
        const content = this.formatIssueContent(issue);
        
        // Construct issue URL using the site URL
        const issueUrl = `${siteUrl}/browse/${issue.key}`;
        
        const metadata = {
            issueId: issue.id,
            issueKey: issue.key,
            projectKey: issue.fields.project?.key,
            projectName: issue.fields.project?.name,
            issueType: issue.fields.issuetype?.name,
            status: issue.fields.status?.name,
            priority: issue.fields.priority?.name,
            assigneeId: issue.fields.assignee?.accountId,
            assigneeName: issue.fields.assignee?.displayName,
            reporterId: issue.fields.reporter?.accountId,
            reporterName: issue.fields.reporter?.displayName,
            labels: issue.fields.labels,
            linkedIssues: this.extractLinkedIssues(issue),
            url: issueUrl,
            // Store raw ADF for rich rendering in Context Inspector
            descriptionAdf: issue.fields.description || undefined,
        };

        const sourceUpdatedAt = issue.fields.updated || new Date().toISOString();

        if (existing) {
            await this.knowledgeDocumentsRepository.update(existing.id, {
                content,
                metadata,
                sourceUpdatedAt,
            });
        } else {
            await this.knowledgeDocumentsRepository.create({
                projectId,
                provider: 'jira',
                sourceType: 'jira_issue',
                sourceId,
                title: `${issue.key}: ${issue.fields.summary}`,
                content,
                metadata,
                entityRefs: [],
                syncedAt: new Date().toISOString(),
                sourceCreatedAt: issue.fields.created,
                sourceUpdatedAt,
            });
        }
    }

    private formatIssueContent(issue: JiraIssueTypeSchema): string {
        const lines = [
            `Issue: ${issue.key}`,
            `Summary: ${issue.fields.summary}`,
            `Type: ${issue.fields.issuetype?.name || 'Unknown'}`,
            `Status: ${issue.fields.status?.name || 'Unknown'}`,
        ];
        
        if (issue.fields.priority?.name) {
            lines.push(`Priority: ${issue.fields.priority.name}`);
        }
        if (issue.fields.assignee?.displayName) {
            lines.push(`Assignee: ${issue.fields.assignee.displayName}`);
        }
        if (issue.fields.reporter?.displayName) {
            lines.push(`Reporter: ${issue.fields.reporter.displayName}`);
        }
        if (issue.fields.labels && issue.fields.labels.length > 0) {
            lines.push(`Labels: ${issue.fields.labels.join(', ')}`);
        }
        if (issue.fields.description) {
            const desc = this.adfToText(issue.fields.description);
            if (desc) {
                lines.push(`\nDescription:\n${desc}`);
            }
        }

        return lines.join('\n');
    }

    private extractLinkedIssues(issue: JiraIssueTypeSchema): string[] {
        const linked: string[] = [];
        
        // Extract from parent
        if (issue.fields.parent?.key) {
            linked.push(issue.fields.parent.key);
        }
        
        // Extract from subtasks
        if (issue.fields.subtasks) {
            linked.push(...issue.fields.subtasks.map(s => s.key));
        }
        
        // Extract issue keys mentioned in description
        if (issue.fields.description) {
            const descText = this.adfToText(issue.fields.description);
            const matches = descText.match(/[A-Z]+-\d+/g);
            if (matches) {
                linked.push(...matches);
            }
        }

        return [...new Set(linked)];
    }

    private async upsertJiraComment(projectId: string, issueKey: string, comment: JiraCommentType): Promise<void> {
        const sourceId = comment.id;
        
        const existing = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'jira', sourceId);
        
        const content = this.adfToText(comment.body);
        const metadata = {
            commentId: comment.id,
            issueKey,
            authorId: comment.author?.accountId,
            authorName: comment.author?.displayName,
            // Store raw ADF for rich rendering
            commentAdf: comment.body || undefined,
        };

        // Find parent issue document
        const issueDoc = await this.knowledgeDocumentsRepository.findBySourceId(projectId, 'jira', issueKey);

        if (existing) {
            if (existing.content !== content) {
                await this.knowledgeDocumentsRepository.update(existing.id, {
                    content,
                    metadata,
                    sourceUpdatedAt: comment.updated || comment.created,
                });
            }
        } else {
            await this.knowledgeDocumentsRepository.create({
                projectId,
                provider: 'jira',
                sourceType: 'jira_comment',
                sourceId,
                title: `Comment on ${issueKey}`,
                content,
                metadata,
                entityRefs: [],
                parentId: issueDoc?.id,
                parentSourceId: issueKey,
                syncedAt: new Date().toISOString(),
                sourceCreatedAt: comment.created,
                sourceUpdatedAt: comment.updated,
            });
        }
    }

    /**
     * Convert Atlassian Document Format (ADF) to plain text
     */
    private adfToText(adf: any): string {
        if (!adf) return '';
        if (typeof adf === 'string') return adf;
        
        if (adf.type === 'doc' && adf.content) {
            return adf.content.map((node: any) => this.adfNodeToText(node)).join('\n');
        }
        
        return '';
    }

    private adfNodeToText(node: any): string {
        if (!node) return '';
        
        switch (node.type) {
            case 'paragraph':
            case 'heading':
                return node.content?.map((n: any) => this.adfNodeToText(n)).join('') || '';
            case 'text':
                return node.text || '';
            case 'hardBreak':
                return '\n';
            case 'bulletList':
            case 'orderedList':
                return node.content?.map((n: any) => `- ${this.adfNodeToText(n)}`).join('\n') || '';
            case 'listItem':
                return node.content?.map((n: any) => this.adfNodeToText(n)).join('') || '';
            case 'codeBlock':
                return `\`\`\`\n${node.content?.map((n: any) => this.adfNodeToText(n)).join('')}\n\`\`\``;
            case 'mention':
                return `@${node.attrs?.text || node.attrs?.id || ''}`;
            case 'inlineCard':
            case 'blockCard':
                return node.attrs?.url || '';
            default:
                if (node.content) {
                    return node.content.map((n: any) => this.adfNodeToText(n)).join('');
                }
                return '';
        }
    }
}
