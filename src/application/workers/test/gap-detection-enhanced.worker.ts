import { z } from "zod";
import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { buildGapDetectionPrompt, DetectedGap } from "./prompts/gap-prompt";
import { structuredGenerate } from "./structured-generate";

const PROVIDER_DOC_CHAR_LIMIT = 15000;
const CUSTOMER_FEEDBACK_CHAR_LIMIT = 10000;
const ENTITIES_CHAR_LIMIT = 5000;

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 3) + "...";
}

const DetectedGapSchema = z.object({
    projectTitle: z.string(),
    ownerAndCollaborators: z.array(z.string()),
    whatTheyDid: z.string(),
    decisionsAndWhy: z.array(
        z.object({
            decision: z.string(),
            alternativesConsidered: z.array(z.string()),
            whyChosen: z.string(),
        })
    ),
    tradeoffs: z.array(z.string()),
    architectureChosen: z.string(),
    codeLocations: z.array(
        z.object({
            repo: z.string(),
            path: z.string(),
            description: z.string(),
        })
    ),
    citations: z.array(
        z.object({
            sourceType: z.enum(["slack", "jira", "confluence", "github", "customer_feedback"]),
            documentId: z.string(),
            title: z.string(),
            excerpt: z.string(),
            timestamp: z.string().optional(),
        })
    ),
    verificationQuestions: z.array(
        z.object({
            question: z.string(),
            whoToAsk: z.string(),
            whyThisPerson: z.string(),
        })
    ),
});

export class EnhancedGapDetectorWorker {
    private docsRepo: MongoDBKnowledgeDocumentsRepository;
    private entitiesRepo: MongoDBKnowledgeEntitiesRepository;
    private logger: PrefixLogger;

    constructor() {
        this.docsRepo = new MongoDBKnowledgeDocumentsRepository();
        this.entitiesRepo = new MongoDBKnowledgeEntitiesRepository();
        this.logger = new PrefixLogger("EnhancedGapDetector");
    }

    async run(projectId: string): Promise<DetectedGap[]> {
        this.logger.log(`Starting enhanced gap detection for project ${projectId}`);

        try {
            const [allDocs, allEntities] = await Promise.all([
                this.loadAllDocuments(projectId),
                this.loadAllEntities(projectId),
            ]);

            this.logger.log(
                `Loaded ${allDocs.length} documents, ${allEntities.length} entities`
            );

            const allDocsSummary = this.buildAllDocsSummary(allDocs);
            const entitiesSummary = this.buildEntitiesSummary(allEntities);

            const { system, prompt } = buildGapDetectionPrompt(
                allDocsSummary,
                entitiesSummary
            );

            this.logger.log("Calling LLM for gap detection...");
            const result = await structuredGenerate({
                model: getFastModel(),
                system,
                prompt,
                schema: z.object({
                    gaps: z.array(DetectedGapSchema),
                }),
                maxOutputTokens: 16384,
                logger: this.logger,
            });

            const gaps = Array.isArray(result) ? result : (result as any).gaps ?? [];
            this.logger.log(`Detected ${gaps.length} gaps`);

            await this.storeResults(projectId, gaps);

            return gaps;
        } catch (error) {
            this.logger.log(`Enhanced gap detection failed: ${error}`);
            throw error;
        }
    }

    private async loadAllDocuments(projectId: string) {
        const providers = ["confluence", "slack", "jira", "github", "customer_feedback"] as const;
        const allDocs: Array<{
            provider: string;
            title: string;
            content: string;
            sourceType: string;
            metadata: Record<string, any>;
        }> = [];

        for (const provider of providers) {
            let cursor: string | undefined;
            let hasMore = true;

            while (hasMore) {
                const result = await this.docsRepo.findByProjectId(projectId, {
                    provider,
                    limit: 200,
                    cursor,
                });
                for (const doc of result.items) {
                    allDocs.push({
                        provider: doc.provider,
                        title: doc.title,
                        content: doc.content,
                        sourceType: doc.sourceType,
                        metadata: doc.metadata as Record<string, any>,
                    });
                }
                cursor = result.nextCursor;
                hasMore = !!cursor;
            }
        }

        return allDocs;
    }

    private async loadAllEntities(projectId: string) {
        const types = ["person", "system", "project", "process", "customer", "team", "topic"];
        const allEntities: Array<{
            name: string;
            type: string;
            aliases: string[];
            metadata: Record<string, any>;
        }> = [];

        for (const type of types) {
            const result = await this.entitiesRepo.findByProjectId(projectId, {
                type,
                limit: 200,
            });
            for (const entity of result.items) {
                allEntities.push({
                    name: entity.name,
                    type: entity.type,
                    aliases: entity.aliases || [],
                    metadata: entity.metadata as Record<string, any>,
                });
            }
        }

        return allEntities;
    }

    private buildAllDocsSummary(
        docs: Array<{
            provider: string;
            title: string;
            content: string;
            sourceType: string;
            metadata: Record<string, any>;
        }>
    ): string {
        const sections: string[] = [];

        const confluenceDocs = docs.filter((d) => d.provider === "confluence");
        if (confluenceDocs.length > 0) {
            const lines = confluenceDocs.map((d) => {
                const excerpt = d.content.substring(0, 1500).replace(/\n/g, " ");
                return `- [${d.sourceType}] "${d.title}": ${excerpt}`;
            });
            sections.push(
                `=== CONFLUENCE (${confluenceDocs.length} docs) ===\n${truncate(lines.join("\n"), PROVIDER_DOC_CHAR_LIMIT)}`
            );
        }

        const jiraDocs = docs.filter((d) => d.provider === "jira");
        if (jiraDocs.length > 0) {
            const lines = jiraDocs.map((d) => {
                const meta = d.metadata;
                const key = meta.issueKey || "";
                const status = meta.status || "";
                const assignee = meta.assigneeName || "";
                return `- ${key} "${d.title}" [${status}]${assignee ? ` assigned:${assignee}` : ""}`;
            });
            sections.push(
                `=== JIRA (${jiraDocs.length} docs) ===\n${truncate(lines.join("\n"), PROVIDER_DOC_CHAR_LIMIT)}`
            );
        }

        const slackDocs = docs.filter((d) => d.provider === "slack");
        if (slackDocs.length > 0) {
            const lines = slackDocs.map((d) => {
                const meta = d.metadata;
                const channel = meta.channelName || "";
                const excerpt = d.content.substring(0, 1500).replace(/\n/g, " ");
                return `- [${d.sourceType}]${channel ? ` #${channel}` : ""} "${d.title}": ${excerpt}`;
            });
            sections.push(
                `=== SLACK (${slackDocs.length} docs) ===\n${truncate(lines.join("\n"), PROVIDER_DOC_CHAR_LIMIT)}`
            );
        }

        const githubDocs = docs.filter((d) => d.provider === "github");
        if (githubDocs.length > 0) {
            const lines = githubDocs.map((d) => {
                const excerpt = d.content.substring(0, 1500).replace(/\n/g, " ");
                return `- [${d.sourceType}] "${d.title}": ${excerpt}`;
            });
            sections.push(
                `=== GITHUB (${githubDocs.length} docs) ===\n${truncate(lines.join("\n"), PROVIDER_DOC_CHAR_LIMIT)}`
            );
        }

        const feedbackDocs = docs.filter((d) => d.provider === "customer_feedback");
        if (feedbackDocs.length > 0) {
            const lines = feedbackDocs.map((d) => {
                const excerpt = d.content.substring(0, 1000).replace(/\n/g, " ");
                return `- "${d.title}": ${excerpt}`;
            });
            sections.push(
                `=== CUSTOMER FEEDBACK (${feedbackDocs.length} docs) ===\n${truncate(lines.join("\n"), CUSTOMER_FEEDBACK_CHAR_LIMIT)}`
            );
        }

        if (sections.length === 0) {
            return "(No documents found for this project)";
        }

        return sections.join("\n\n");
    }

    private buildEntitiesSummary(
        entities: Array<{
            name: string;
            type: string;
            aliases: string[];
            metadata: Record<string, any>;
        }>
    ): string {
        if (entities.length === 0) return "(No entities found)";

        const lines = entities.map((e) => {
            const parts = [`${e.type.toUpperCase()}: ${e.name}`];
            if (e.aliases.length > 0) parts.push(`aka: ${e.aliases.join(", ")}`);
            const meta = e.metadata;
            if (meta.description) parts.push(meta.description.substring(0, 100));
            if (meta.role) parts.push(`role: ${meta.role}`);
            if (meta.team) parts.push(`team: ${meta.team}`);
            if (meta.status) parts.push(`status: ${meta.status}`);
            if (meta.technologies?.length) parts.push(`tech: ${meta.technologies.join(", ")}`);
            return `- ${parts.join(" | ")}`;
        });

        return truncate(lines.join("\n"), ENTITIES_CHAR_LIMIT);
    }

    private async storeResults(projectId: string, gaps: DetectedGap[]) {
        const collection = db.collection("test_results");
        await collection.insertOne({
            projectId,
            type: "gaps",
            results: gaps,
            createdAt: new Date().toISOString(),
        });
        this.logger.log(`Stored ${gaps.length} gap results in test_results`);
    }
}
