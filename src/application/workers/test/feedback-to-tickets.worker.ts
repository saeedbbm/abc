import { z } from "zod";
import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { buildTicketGenerationPrompt, GeneratedTicket } from "./prompts/ticket-prompt";
import { structuredGenerate } from "./structured-generate";

const MAX_CONTEXT_CHARS = 15000;

const GeneratedTicketSchema = z.object({
    type: z.enum(["epic", "story", "bug"]),
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
    priority: z.enum(["P0", "P1", "P2", "P3"]),
    priorityRationale: z.string(),
    assignedTo: z.string(),
    assignmentRationale: z.string(),
    customerFeedbackRefs: z.array(
        z.object({
            feedbackId: z.string(),
            customerName: z.string(),
            excerpt: z.string(),
            sentiment: z.enum(["positive", "negative", "neutral"]),
        })
    ),
    technicalConstraints: z.array(
        z.object({
            constraint: z.string(),
            source: z.string(),
            impact: z.string(),
        })
    ),
    affectedSystems: z.array(z.string()),
    estimatedComplexity: z.enum(["trivial", "small", "medium", "large", "xlarge"]),
    relatedJiraTickets: z.array(z.string()),
    backwardCompatibilityConcerns: z.array(z.string()),
    performanceRequirements: z.array(z.string()),
});

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n... (truncated)";
}

export class FeedbackToTicketsWorker {
    private docsRepo: MongoDBKnowledgeDocumentsRepository;
    private entitiesRepo: MongoDBKnowledgeEntitiesRepository;
    private logger: PrefixLogger;

    constructor(logger?: PrefixLogger) {
        this.docsRepo = new MongoDBKnowledgeDocumentsRepository();
        this.entitiesRepo = new MongoDBKnowledgeEntitiesRepository();
        this.logger = logger || new PrefixLogger("feedback-to-tickets");
    }

    async run(projectId: string): Promise<GeneratedTicket[]> {
        this.logger.log(`Starting ticket generation for project ${projectId}`);

        try {
            const feedbackSummary = await this.loadFeedbackDocs(projectId);
            const jiraSummary = await this.loadJiraContext(projectId);
            const githubSummary = await this.loadGithubContext(projectId);
            const entitySummary = await this.loadEntityContext(projectId);

            this.logger.log(
                `Context sizes — feedback: ${feedbackSummary.length}, jira: ${jiraSummary.length}, ` +
                `github: ${githubSummary.length}, entities: ${entitySummary.length}`
            );

            const { system, prompt } = buildTicketGenerationPrompt(
                feedbackSummary,
                jiraSummary,
                githubSummary,
                entitySummary
            );

            this.logger.log("Calling LLM for ticket generation...");
            const result = await structuredGenerate({
                model: getFastModel(),
                system,
                prompt,
                schema: z.object({
                    tickets: z.array(GeneratedTicketSchema),
                }),
                maxOutputTokens: 16384,
                logger: this.logger,
            });

            const tickets = Array.isArray(result) ? result : (result as any).tickets ?? [];
            if (!Array.isArray(tickets)) {
                this.logger.log("LLM returned invalid or non-array JSON — returning empty results");
                await this.storeResults(projectId, []);
                return [];
            }

            this.logger.log(`Generated ${tickets.length} tickets`);
            await this.storeResults(projectId, tickets);
            return tickets;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.log(`Ticket generation failed: ${msg}`);
            throw error;
        }
    }

    private async loadFeedbackDocs(projectId: string): Promise<string> {
        const { items } = await this.docsRepo.findByProjectId(projectId, {
            sourceType: "customer_feedback",
            limit: 200,
        });
        if (items.length === 0) return "No customer feedback found.";

        const lines = items.map((doc, i) => {
            const meta = doc.metadata as Record<string, any>;
            const customer = meta?.customerName || meta?.author || "Unknown";
            const sentiment = meta?.sentiment || "unknown";
            return `[${i + 1}] ID:${doc.id} | Customer: ${customer} | Sentiment: ${sentiment}\n${doc.title}\n${doc.content?.substring(0, 2000) || ""}`;
        });
        return truncate(lines.join("\n---\n"), MAX_CONTEXT_CHARS);
    }

    private async loadJiraContext(projectId: string): Promise<string> {
        const { items } = await this.docsRepo.findByProjectId(projectId, {
            sourceType: "jira_issue",
            limit: 200,
        });
        if (items.length === 0) return "No Jira issues found.";

        const lines = items.map((doc) => {
            const meta = doc.metadata as Record<string, any>;
            const status = meta?.status || "unknown";
            const priority = meta?.priority || "unknown";
            const assignee = meta?.assignee || "unassigned";
            return `${doc.title} | Status: ${status} | Priority: ${priority} | Assignee: ${assignee}\n${doc.content?.substring(0, 1000) || ""}`;
        });
        return truncate(lines.join("\n---\n"), MAX_CONTEXT_CHARS);
    }

    private async loadGithubContext(projectId: string): Promise<string> {
        const [files, prs] = await Promise.all([
            this.docsRepo.findByProjectId(projectId, { sourceType: "github_file", limit: 100 }),
            this.docsRepo.findByProjectId(projectId, { sourceType: "github_pr", limit: 100 }),
        ]);

        const parts: string[] = [];

        if (files.items.length > 0) {
            const fileSummary = files.items.map((doc) => {
                const meta = doc.metadata as Record<string, any>;
                return `${meta?.path || doc.title} (${meta?.repo || "unknown repo"})`;
            });
            parts.push("FILES:\n" + fileSummary.join("\n"));
        }

        if (prs.items.length > 0) {
            const prSummary = prs.items.map((doc) => {
                const meta = doc.metadata as Record<string, any>;
                return `PR: ${doc.title} | Author: ${meta?.author || "unknown"} | Status: ${meta?.state || "unknown"}\n${doc.content?.substring(0, 200) || ""}`;
            });
            parts.push("PULL REQUESTS:\n" + prSummary.join("\n---\n"));
        }

        if (parts.length === 0) return "No GitHub context available.";
        return truncate(parts.join("\n\n"), MAX_CONTEXT_CHARS);
    }

    private async loadEntityContext(projectId: string): Promise<string> {
        const people = await this.entitiesRepo.findByProject(projectId, "person");
        const systems = await this.entitiesRepo.findByProject(projectId, "system");

        const parts: string[] = [];

        if (people.length > 0) {
            const peopleSummary = people.map((e) => {
                const meta = e.metadata as Record<string, any>;
                const role = meta?.role || meta?.title || "";
                const teams = meta?.teams?.join(", ") || "";
                return `${e.name}${role ? ` — ${role}` : ""}${teams ? ` [${teams}]` : ""}`;
            });
            parts.push("PEOPLE:\n" + peopleSummary.join("\n"));
        }

        if (systems.length > 0) {
            const systemSummary = systems.map((e) => {
                const meta = e.metadata as Record<string, any>;
                const desc = meta?.description || "";
                const owner = meta?.owner || "";
                return `${e.name}${desc ? ` — ${desc.substring(0, 100)}` : ""}${owner ? ` (owner: ${owner})` : ""}`;
            });
            parts.push("SYSTEMS:\n" + systemSummary.join("\n"));
        }

        if (parts.length === 0) return "No organizational context available.";
        return truncate(parts.join("\n\n"), MAX_CONTEXT_CHARS);
    }

    private async storeResults(projectId: string, tickets: GeneratedTicket[]): Promise<void> {
        const collection = db.collection("test_results");
        await collection.insertOne({
            projectId,
            type: "tickets",
            results: tickets,
            createdAt: new Date().toISOString(),
        });
        this.logger.log(`Stored ${tickets.length} tickets in test_results`);
    }
}
