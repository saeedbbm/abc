import { z } from "zod";
import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { buildHowToPrompt, HowToImplementDoc } from "./prompts/howto-prompt";
import { GeneratedTicket } from "./prompts/ticket-prompt";
import { structuredGenerate } from "./structured-generate";

const MAX_CONTEXT_CHARS = 15000;

const HowToImplementDocSchema = z.object({
    ticketTitle: z.string(),
    ticketType: z.string(),
    repoPathsToChange: z.array(
        z.object({
            repo: z.string(),
            filePath: z.string(),
            changeType: z.enum(["create", "modify", "delete", "rename"]),
            description: z.string(),
        })
    ),
    codeLevelSteps: z.array(
        z.object({
            stepNumber: z.number(),
            title: z.string(),
            description: z.string(),
            filePath: z.string(),
            whatToChange: z.string(),
            codeSnippet: z.string(),
            patternsToFollow: z.string(),
            testingNote: z.string(),
        })
    ),
    operationalSteps: z.array(
        z.object({
            stepNumber: z.number(),
            title: z.string(),
            description: z.string(),
            commands: z.array(z.string()),
            rollbackCommands: z.array(z.string()),
            verificationCheck: z.string(),
            riskLevel: z.enum(["low", "medium", "high"]),
        })
    ),
    architecturalDecisions: z.array(
        z.object({
            decision: z.string(),
            why: z.string(),
            alternatives: z.array(
                z.object({
                    option: z.string(),
                    prosAndCons: z.string(),
                })
            ),
            tradeoffs: z.string(),
            sourcedFrom: z.string(),
        })
    ),
    claudeCodePrompt: z.string(),
    estimatedComplexity: z.enum(["trivial", "small", "medium", "large", "xlarge"]),
    estimatedHours: z.number(),
    risks: z.array(
        z.object({
            risk: z.string(),
            likelihood: z.enum(["low", "medium", "high"]),
            impact: z.enum(["low", "medium", "high"]),
            mitigation: z.string(),
        })
    ),
    testingStrategy: z.object({
        unitTests: z.array(z.string()),
        integrationTests: z.array(z.string()),
        e2eTests: z.array(z.string()),
        manualTestingSteps: z.array(z.string()),
        performanceTests: z.array(z.string()),
        loadTestScenarios: z.array(z.string()),
    }),
    prerequisites: z.array(z.string()),
    rolloutStrategy: z.string(),
    rollbackPlan: z.string(),
});

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n... (truncated)";
}

function buildTicketSummary(ticket: GeneratedTicket): string {
    const criteria = ticket.acceptanceCriteria.slice(0, 5).map((c) => `  - ${c}`).join("\n");
    const systems = ticket.affectedSystems.join(", ");
    return [
        `Title: ${ticket.title}`,
        `Type: ${ticket.type} | Priority: ${ticket.priority} | Complexity: ${ticket.estimatedComplexity}`,
        `Description: ${ticket.description.substring(0, 500)}`,
        `Affected Systems: ${systems}`,
        `Acceptance Criteria:\n${criteria}`,
        ticket.technicalConstraints.length > 0
            ? `Constraints: ${ticket.technicalConstraints.map((c) => c.constraint).join("; ")}`
            : "",
    ]
        .filter(Boolean)
        .join("\n");
}

export class HowToGeneratorWorker {
    private docsRepo: MongoDBKnowledgeDocumentsRepository;
    private logger: PrefixLogger;

    constructor(logger?: PrefixLogger) {
        this.docsRepo = new MongoDBKnowledgeDocumentsRepository();
        this.logger = logger || new PrefixLogger("howto-generator");
    }

    async run(projectId: string, tickets: GeneratedTicket[]): Promise<HowToImplementDoc[]> {
        this.logger.log(`Starting how-to generation for ${tickets.length} tickets in project ${projectId}`);

        try {
            const githubContext = await this.loadGithubContext(projectId);
            this.logger.log(`Loaded github context: ${githubContext.length} chars`);

            const results: HowToImplementDoc[] = [];

            for (let i = 0; i < tickets.length; i++) {
                const ticket = tickets[i];
                this.logger.log(`Processing ticket ${i + 1}/${tickets.length}: ${ticket.title}`);

                try {
                    const doc = await this.processTicket(projectId, ticket, githubContext);
                    if (doc) {
                        results.push(doc);
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    this.logger.log(`Failed to process ticket "${ticket.title}": ${msg}`);
                }
            }

            this.logger.log(`Generated ${results.length}/${tickets.length} how-to docs`);
            await this.storeResults(projectId, results);
            return results;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.log(`How-to generation failed: ${msg}`);
            throw error;
        }
    }

    private async processTicket(
        projectId: string,
        ticket: GeneratedTicket,
        githubContext: string
    ): Promise<HowToImplementDoc | null> {
        const ticketSummary = buildTicketSummary(ticket);
        const searchQuery = `${ticket.title} ${ticket.affectedSystems.join(" ")}`;

        const [slackResults, jiraResults] = await Promise.all([
            searchKnowledgeEmbeddings(projectId, searchQuery, { provider: "slack", limit: 10 }, this.logger),
            searchKnowledgeEmbeddings(projectId, searchQuery, { provider: "jira", limit: 10 }, this.logger),
        ]);

        const slackContext = this.buildSearchResultSummary(slackResults, "Slack");
        const jiraContext = this.buildSearchResultSummary(jiraResults, "Jira");

        const relevantGithub = await this.findRelevantGithubFiles(projectId, ticket);
        const ticketGithubContext = relevantGithub
            ? truncate(`${relevantGithub}\n\n${githubContext}`, MAX_CONTEXT_CHARS * 2)
            : githubContext;

        const { system, prompt } = buildHowToPrompt(ticketSummary, ticketGithubContext, slackContext, jiraContext);

        const result = await structuredGenerate({
            model: getFastModel(),
            system,
            prompt,
            schema: HowToImplementDocSchema,
            maxOutputTokens: 16384,
            logger: this.logger,
        });

        if (!result) {
            this.logger.log(`Failed to parse how-to doc for ticket: ${ticket.title}`);
            return null;
        }

        return result as HowToImplementDoc;
    }

    private async loadGithubContext(projectId: string): Promise<string> {
        const [files, prs, commits] = await Promise.all([
            this.docsRepo.findByProjectId(projectId, { sourceType: "github_file", limit: 150 }),
            this.docsRepo.findByProjectId(projectId, { sourceType: "github_pr", limit: 100 }),
            this.docsRepo.findByProjectId(projectId, { sourceType: "github_commit", limit: 100 }),
        ]);

        const parts: string[] = [];

        if (files.items.length > 0) {
            const fileSummary = files.items.map((doc) => {
                const meta = doc.metadata as Record<string, any>;
                return `${meta?.path || doc.title} (${meta?.repo || "unknown"})`;
            });
            parts.push("REPOSITORY FILES:\n" + fileSummary.join("\n"));
        }

        if (prs.items.length > 0) {
            const prSummary = prs.items.slice(0, 30).map((doc) => {
                const meta = doc.metadata as Record<string, any>;
                return `PR: ${doc.title} | Author: ${meta?.author || "unknown"} | ${meta?.state || ""}\n${doc.content?.substring(0, 200) || ""}`;
            });
            parts.push("RECENT PULL REQUESTS:\n" + prSummary.join("\n---\n"));
        }

        if (commits.items.length > 0) {
            const commitSummary = commits.items.slice(0, 30).map((doc) => {
                const meta = doc.metadata as Record<string, any>;
                return `${meta?.sha?.substring(0, 7) || ""} ${doc.title} (${meta?.author || "unknown"})`;
            });
            parts.push("RECENT COMMITS:\n" + commitSummary.join("\n"));
        }

        if (parts.length === 0) return "No GitHub context available.";
        return truncate(parts.join("\n\n"), MAX_CONTEXT_CHARS * 2);
    }

    private async findRelevantGithubFiles(
        projectId: string,
        ticket: GeneratedTicket
    ): Promise<string | null> {
        const query = `${ticket.title} ${ticket.affectedSystems.join(" ")} implementation code`;
        const results = await searchKnowledgeEmbeddings(
            projectId,
            query,
            { provider: "github", limit: 10 },
            this.logger
        );

        if (results.length === 0) return null;

        const fileSummary = results.map((r) => {
            return `${r.title} (score: ${r.score.toFixed(2)})\n${r.content.substring(0, 300)}`;
        });
        return "MOST RELEVANT FILES FOR THIS TICKET:\n" + fileSummary.join("\n---\n");
    }

    private buildSearchResultSummary(
        results: Array<{ title: string; content: string; score: number; sourceType: string }>,
        label: string
    ): string {
        if (results.length === 0) return `No relevant ${label} context found.`;

        const lines = results.map((r) => {
            return `[${r.sourceType}] ${r.title} (relevance: ${r.score.toFixed(2)})\n${r.content.substring(0, 400)}`;
        });
        return truncate(`${label} CONTEXT:\n` + lines.join("\n---\n"), MAX_CONTEXT_CHARS);
    }

    private async storeResults(projectId: string, docs: HowToImplementDoc[]): Promise<void> {
        const collection = db.collection("test_results");
        await collection.insertOne({
            projectId,
            type: "howto",
            results: docs,
            createdAt: new Date().toISOString(),
        });
        this.logger.log(`Stored ${docs.length} how-to docs in test_results`);
    }
}
