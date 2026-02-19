import { z } from "zod";
import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { buildOutdatedDetectionPrompt, OutdatedDoc } from "./prompts/outdated-prompt";
import { structuredGenerate } from "./structured-generate";

const MAX_DOCS_SUMMARY_CHARS = 15000;
const MAX_ACTIVITY_SUMMARY_CHARS = 15000;

const OutdatedDocSchema = z.object({
    documentTitle: z.string(),
    documentSource: z.string(),
    documentId: z.string(),
    severity: z.enum(["critical", "high", "medium", "low"]),
    outdatedItems: z.array(
        z.object({
            whatIsOutdated: z.string(),
            exactQuoteOrSection: z.string(),
            sectionReference: z.string(),
            currentReality: z.string(),
            evidenceSources: z.array(
                z.object({
                    sourceType: z.enum(["slack", "jira", "github", "confluence", "customer_feedback"]),
                    documentId: z.string(),
                    title: z.string(),
                    excerpt: z.string(),
                    timestamp: z.string().optional(),
                })
            ),
        })
    ),
    suggestedUpdate: z.string(),
    verificationQuestions: z.array(
        z.object({
            question: z.string(),
            whoToAsk: z.string(),
            whyThisPerson: z.string(),
        })
    ),
    lastKnownUpdateDate: z.string().optional(),
    staleSinceDays: z.number().optional(),
    outdatedCategory: z.enum([
        "deprecated_api",
        "removed_feature",
        "changed_team_structure",
        "outdated_architecture",
        "stale_runbook",
        "changed_sla",
        "outdated_dependency",
        "decommissioned_service",
        "changed_process",
        "outdated_config",
        "personnel_change",
        "infrastructure_change",
    ]),
});

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n... (truncated)";
}

export class OutdatedDetectorWorker {
    private docsRepo: MongoDBKnowledgeDocumentsRepository;
    private logger: PrefixLogger;

    constructor(logger?: PrefixLogger) {
        this.docsRepo = new MongoDBKnowledgeDocumentsRepository();
        this.logger = logger || new PrefixLogger("outdated-detector");
    }

    async run(projectId: string): Promise<OutdatedDoc[]> {
        this.logger.log(`Starting outdated detection for project ${projectId}`);

        try {
            const allDocsSummary = await this.buildDocsSummary(projectId);
            const recentActivitySummary = await this.buildRecentActivitySummary(projectId);

            this.logger.log(
                `Context sizes — docs: ${allDocsSummary.length}, activity: ${recentActivitySummary.length}`
            );

            const { system, prompt } = buildOutdatedDetectionPrompt(allDocsSummary, recentActivitySummary);

            this.logger.log("Calling LLM for outdated detection...");
            const result = await structuredGenerate({
                model: getFastModel(),
                system,
                prompt,
                schema: z.object({
                    outdatedDocs: z.array(OutdatedDocSchema),
                }),
                maxOutputTokens: 16384,
                logger: this.logger,
            });

            const results = Array.isArray(result) ? result : (result as any).outdatedDocs ?? [];
            if (!Array.isArray(results)) {
                this.logger.log("LLM returned invalid or non-array JSON — returning empty results");
                await this.storeResults(projectId, []);
                return [];
            }

            this.logger.log(`Detected ${results.length} outdated documents`);
            await this.storeResults(projectId, results);
            return results;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.log(`Outdated detection failed: ${msg}`);
            throw error;
        }
    }

    private async buildDocsSummary(projectId: string): Promise<string> {
        const { items: pages } = await this.docsRepo.findByProjectId(projectId, {
            sourceType: "confluence_page",
            limit: 200,
        });

        if (pages.length === 0) return "No Confluence pages found.";

        this.logger.log(`Loaded ${pages.length} confluence pages`);

        const lines = pages.map((doc) => {
            const meta = doc.metadata as Record<string, any>;
            const lastUpdated = doc.sourceUpdatedAt || doc.updatedAt || "unknown";
            const space = meta?.spaceKey || meta?.space || "unknown";

            const contentPreview = doc.content?.substring(0, 2000) || "";
            const sections = this.extractSections(contentPreview);

            return [
                `DOC ID: ${doc.id}`,
                `Title: ${doc.title}`,
                `Space: ${space} | Last Updated: ${lastUpdated}`,
                sections ? `Sections: ${sections}` : "",
                `Content Preview:\n${contentPreview}`,
            ]
                .filter(Boolean)
                .join("\n");
        });

        return truncate(lines.join("\n\n===\n\n"), MAX_DOCS_SUMMARY_CHARS);
    }

    private extractSections(content: string): string {
        const headingPattern = /^#{1,3}\s+(.+)$/gm;
        const headings: string[] = [];
        let match;
        while ((match = headingPattern.exec(content)) !== null) {
            headings.push(match[1].trim());
        }
        if (headings.length === 0) {
            const htmlHeadings = content.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi);
            if (htmlHeadings) {
                for (const h of htmlHeadings) {
                    const text = h.replace(/<[^>]+>/g, "").trim();
                    if (text) headings.push(text);
                }
            }
        }
        return headings.length > 0 ? headings.join(" > ") : "";
    }

    private async buildRecentActivitySummary(projectId: string): Promise<string> {
        const [slackDocs, jiraDocs, githubPrs, githubCommits] = await Promise.all([
            this.loadRecentSlack(projectId),
            this.loadRecentJira(projectId),
            this.loadRecentGithubPrs(projectId),
            this.loadRecentGithubCommits(projectId),
        ]);

        const parts: string[] = [];

        if (slackDocs.length > 0) {
            parts.push("RECENT SLACK CONVERSATIONS:\n" + slackDocs.join("\n---\n"));
        }
        if (jiraDocs.length > 0) {
            parts.push("RECENT JIRA UPDATES:\n" + jiraDocs.join("\n---\n"));
        }
        if (githubPrs.length > 0) {
            parts.push("RECENT GITHUB PULL REQUESTS:\n" + githubPrs.join("\n---\n"));
        }
        if (githubCommits.length > 0) {
            parts.push("RECENT GITHUB COMMITS:\n" + githubCommits.join("\n"));
        }

        if (parts.length === 0) return "No recent activity found.";
        return truncate(parts.join("\n\n"), MAX_ACTIVITY_SUMMARY_CHARS);
    }

    private async loadRecentSlack(projectId: string): Promise<string[]> {
        const { items } = await this.docsRepo.findByProjectId(projectId, {
            sourceType: "slack_conversation",
            limit: 50,
        });

        return items.map((doc) => {
            const meta = doc.metadata as Record<string, any>;
            const channel = meta?.channelName || meta?.channel || "unknown";
            const date = doc.sourceCreatedAt || doc.createdAt || "";
            return `Channel: #${channel} | Date: ${date}\nTopic: ${doc.title}\n${doc.content?.substring(0, 400) || ""}`;
        });
    }

    private async loadRecentJira(projectId: string): Promise<string[]> {
        const { items } = await this.docsRepo.findByProjectId(projectId, {
            sourceType: "jira_issue",
            limit: 50,
        });

        return items.map((doc) => {
            const meta = doc.metadata as Record<string, any>;
            const status = meta?.status || "unknown";
            const priority = meta?.priority || "";
            const updated = meta?.updatedAt || doc.updatedAt || "";
            return `${doc.title} | Status: ${status} | Priority: ${priority} | Updated: ${updated}\n${doc.content?.substring(0, 300) || ""}`;
        });
    }

    private async loadRecentGithubPrs(projectId: string): Promise<string[]> {
        const { items } = await this.docsRepo.findByProjectId(projectId, {
            sourceType: "github_pr",
            limit: 50,
        });

        return items.map((doc) => {
            const meta = doc.metadata as Record<string, any>;
            const author = meta?.author || "unknown";
            const state = meta?.state || "";
            const repo = meta?.repo || "";
            return `PR: ${doc.title} | Repo: ${repo} | Author: ${author} | State: ${state}\n${doc.content?.substring(0, 300) || ""}`;
        });
    }

    private async loadRecentGithubCommits(projectId: string): Promise<string[]> {
        const { items } = await this.docsRepo.findByProjectId(projectId, {
            sourceType: "github_commit",
            limit: 50,
        });

        return items.map((doc) => {
            const meta = doc.metadata as Record<string, any>;
            const sha = meta?.sha?.substring(0, 7) || "";
            const author = meta?.author || "unknown";
            return `${sha} ${doc.title} (${author})`;
        });
    }

    private async storeResults(projectId: string, docs: OutdatedDoc[]): Promise<void> {
        const collection = db.collection("test_results");
        await collection.insertOne({
            projectId,
            type: "outdated",
            results: docs,
            createdAt: new Date().toISOString(),
        });
        this.logger.log(`Stored ${docs.length} outdated findings in test_results`);
    }
}
