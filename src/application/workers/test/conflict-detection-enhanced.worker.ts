import { z } from "zod";
import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { buildConflictDetectionPrompt, DetectedConflict } from "./prompts/conflict-prompt";
import { structuredGenerate } from "./structured-generate";

const PROVIDER_DOC_CHAR_LIMIT = 15000;
const CUSTOMER_FEEDBACK_CHAR_LIMIT = 10000;

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 3) + "...";
}

const DetectedConflictSchema = z.object({
    conflictTitle: z.string(),
    severity: z.enum(["critical", "high", "medium", "low"]),
    topic: z.string(),
    conflictingClaims: z.array(
        z.object({
            claim: z.string(),
            source: z.string(),
            sourceType: z.enum(["confluence", "slack", "jira", "github", "customer_feedback"]),
            documentId: z.string(),
            section: z.string(),
            timestamp: z.string().optional(),
            excerpt: z.string(),
        })
    ),
    whyItsAConflict: z.string(),
    impactIfUnresolved: z.string(),
    resolutionQuestions: z.array(
        z.object({
            question: z.string(),
            whoToAsk: z.string(),
            whyThisPerson: z.string(),
        })
    ),
    suggestedResolution: z.string(),
    conflictCategory: z.enum([
        "factual_contradiction",
        "ownership_mismatch",
        "status_disagreement",
        "architecture_mismatch",
        "process_divergence",
        "config_mismatch",
        "version_conflict",
        "timeline_conflict",
    ]),
});

export class EnhancedConflictDetectorWorker {
    private docsRepo: MongoDBKnowledgeDocumentsRepository;
    private logger: PrefixLogger;

    constructor() {
        this.docsRepo = new MongoDBKnowledgeDocumentsRepository();
        this.logger = new PrefixLogger("EnhancedConflictDetector");
    }

    async run(projectId: string): Promise<DetectedConflict[]> {
        this.logger.log(`Starting enhanced conflict detection for project ${projectId}`);

        try {
            const allDocs = await this.loadAllDocuments(projectId);
            this.logger.log(`Loaded ${allDocs.length} documents`);

            const claimsSummary = this.buildClaimsSummary(allDocs);
            const allDocsSummary = this.buildAllDocsSummary(allDocs);

            const { system, prompt } = buildConflictDetectionPrompt(
                claimsSummary,
                allDocsSummary
            );

            this.logger.log("Calling LLM for conflict detection...");
            const result = await structuredGenerate({
                model: getFastModel(),
                system,
                prompt,
                schema: z.object({
                    conflicts: z.array(DetectedConflictSchema),
                }),
                maxOutputTokens: 16384,
                logger: this.logger,
            });

            const conflicts = Array.isArray(result) ? result : (result as any).conflicts ?? [];
            this.logger.log(`Detected ${conflicts.length} conflicts`);

            await this.storeResults(projectId, conflicts);

            return conflicts;
        } catch (error) {
            this.logger.log(`Enhanced conflict detection failed: ${error}`);
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
            sourceId: string;
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
                        sourceId: doc.sourceId,
                        metadata: doc.metadata as Record<string, any>,
                    });
                }
                cursor = result.nextCursor;
                hasMore = !!cursor;
            }
        }

        return allDocs;
    }

    private buildClaimsSummary(
        docs: Array<{
            provider: string;
            title: string;
            content: string;
            sourceType: string;
            sourceId: string;
            metadata: Record<string, any>;
        }>
    ): string {
        const sections: string[] = [];

        const confluenceDocs = docs.filter((d) => d.provider === "confluence");
        if (confluenceDocs.length > 0) {
            const lines = confluenceDocs.map((d) => {
                const headings = d.content.match(/^#+\s+.+$/gm) || [];
                const headingSummary = headings.slice(0, 5).join("; ");
                const statements = d.content
                    .split(/[.\n]/)
                    .filter((s) => s.trim().length > 20)
                    .slice(0, 10)
                    .map((s) => s.trim().substring(0, 300));
                return `[Confluence] "${d.title}"\n  Sections: ${headingSummary || "(none)"}\n  Key statements: ${statements.join(" | ") || "(none)"}`;
            });
            sections.push(
                `=== CONFLUENCE CLAIMS ===\n${truncate(lines.join("\n"), PROVIDER_DOC_CHAR_LIMIT)}`
            );
        }

        const jiraDocs = docs.filter((d) => d.provider === "jira");
        if (jiraDocs.length > 0) {
            const lines = jiraDocs.map((d) => {
                const meta = d.metadata;
                const fields = [
                    meta.issueKey,
                    `status:${meta.status || "?"}`,
                    meta.assigneeName ? `assignee:${meta.assigneeName}` : null,
                    meta.priority ? `priority:${meta.priority}` : null,
                ].filter(Boolean);
                const descExcerpt = d.content.substring(0, 500).replace(/\n/g, " ");
                return `[Jira] ${fields.join(" ")} "${d.title}": ${descExcerpt}`;
            });
            sections.push(
                `=== JIRA CLAIMS ===\n${truncate(lines.join("\n"), PROVIDER_DOC_CHAR_LIMIT)}`
            );
        }

        const slackDocs = docs.filter((d) => d.provider === "slack");
        if (slackDocs.length > 0) {
            const lines = slackDocs.map((d) => {
                const meta = d.metadata;
                const channel = meta.channelName || "";
                const user = meta.userName || "";
                const statements = d.content
                    .split(/[.\n]/)
                    .filter((s) => s.trim().length > 20)
                    .slice(0, 10)
                    .map((s) => s.trim().substring(0, 300));
                return `[Slack${channel ? ` #${channel}` : ""}${user ? ` @${user}` : ""}] "${d.title}": ${statements.join(" | ") || d.content.substring(0, 500)}`;
            });
            sections.push(
                `=== SLACK CLAIMS ===\n${truncate(lines.join("\n"), PROVIDER_DOC_CHAR_LIMIT)}`
            );
        }

        const githubDocs = docs.filter((d) => d.provider === "github");
        if (githubDocs.length > 0) {
            const lines = githubDocs.map((d) => {
                const excerpt = d.content.substring(0, 1000).replace(/\n/g, " ");
                return `[GitHub] "${d.title}": ${excerpt}`;
            });
            sections.push(
                `=== GITHUB CLAIMS ===\n${truncate(lines.join("\n"), PROVIDER_DOC_CHAR_LIMIT)}`
            );
        }

        const feedbackDocs = docs.filter((d) => d.provider === "customer_feedback");
        if (feedbackDocs.length > 0) {
            const lines = feedbackDocs.map((d) => {
                const excerpt = d.content.substring(0, 800).replace(/\n/g, " ");
                return `[Feedback] "${d.title}": ${excerpt}`;
            });
            sections.push(
                `=== CUSTOMER FEEDBACK CLAIMS ===\n${truncate(lines.join("\n"), CUSTOMER_FEEDBACK_CHAR_LIMIT)}`
            );
        }

        if (sections.length === 0) {
            return "(No claims extracted — no documents found)";
        }

        return sections.join("\n\n");
    }

    private buildAllDocsSummary(
        docs: Array<{
            provider: string;
            title: string;
            content: string;
            sourceType: string;
            sourceId: string;
            metadata: Record<string, any>;
        }>
    ): string {
        const sections: string[] = [];

        const byProvider = new Map<string, typeof docs>();
        for (const doc of docs) {
            const existing = byProvider.get(doc.provider) || [];
            existing.push(doc);
            byProvider.set(doc.provider, existing);
        }

        for (const [provider, providerDocs] of byProvider) {
            const limit =
                provider === "customer_feedback"
                    ? CUSTOMER_FEEDBACK_CHAR_LIMIT
                    : PROVIDER_DOC_CHAR_LIMIT;

            const lines = providerDocs.map((d) => {
                const excerpt = d.content.substring(0, 1500).replace(/\n/g, " ");
                return `- [${d.sourceType}] "${d.title}": ${excerpt}`;
            });

            sections.push(
                `=== ${provider.toUpperCase()} (${providerDocs.length} docs) ===\n${truncate(lines.join("\n"), limit)}`
            );
        }

        if (sections.length === 0) {
            return "(No documents found for this project)";
        }

        return sections.join("\n\n");
    }


    private async storeResults(projectId: string, conflicts: DetectedConflict[]) {
        const collection = db.collection("test_results");
        await collection.insertOne({
            projectId,
            type: "conflicts",
            results: conflicts,
            createdAt: new Date().toISOString(),
        });
        this.logger.log(`Stored ${conflicts.length} conflict results in test_results`);
    }
}
