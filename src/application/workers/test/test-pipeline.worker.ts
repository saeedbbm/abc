import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { EnhancedGapDetectorWorker } from "./gap-detection-enhanced.worker";
import { FeedbackToTicketsWorker } from "./feedback-to-tickets.worker";
import { HowToGeneratorWorker } from "./howto-generator.worker";
import { EnhancedConflictDetectorWorker } from "./conflict-detection-enhanced.worker";
import { OutdatedDetectorWorker } from "./outdated-detector.worker";
import { EntityExtractor } from "@/src/application/workers/sync/entity-extractor";
import { embedKnowledgeDocument } from "@/src/application/lib/knowledge/embedding-service";
import { parseBundles, ParsedDocument } from "@/src/application/lib/test/bundle-parser";
import { QdrantClient } from "@qdrant/js-client-rest";
import { nanoid } from "nanoid";

const DEFAULT_PROJECT_ID = "test-company-project";
const DEFAULT_COMPANY_SLUG = "test-company";
const QDRANT_COLLECTION = "knowledge_embeddings";

export interface TestPipelineProgress {
    phase: string;
    detail: string;
    percent: number;
}

export type ProgressCallback = (progress: TestPipelineProgress) => void;

export class TestPipelineWorker {
    private docsRepo: MongoDBKnowledgeDocumentsRepository;
    private entitiesRepo: MongoDBKnowledgeEntitiesRepository;
    private logger: PrefixLogger;

    constructor() {
        this.docsRepo = new MongoDBKnowledgeDocumentsRepository();
        this.entitiesRepo = new MongoDBKnowledgeEntitiesRepository();
        this.logger = new PrefixLogger("test-pipeline");
    }

    async run(
        confluence: string,
        jira: string,
        slack: string,
        github: string,
        customerFeedback: string,
        onProgress?: ProgressCallback,
        options?: { projectId?: string; companySlug?: string; sessionName?: string }
    ): Promise<{ success: boolean; error?: string }> {
        const projectId = options?.projectId || DEFAULT_PROJECT_ID;
        const companySlug = options?.companySlug || DEFAULT_COMPANY_SLUG;
        const sessionLabel = options?.sessionName || companySlug;

        const report = (phase: string, detail: string, percent: number) => {
            this.logger.log(`[${percent}%] ${phase}: ${detail}`);
            onProgress?.({ phase, detail, percent });
        };

        try {
            // Phase 1: Setup project
            report("setup", `Creating project "${sessionLabel}"...`, 0);
            await this.ensureProject(projectId, companySlug, sessionLabel);

            // Phase 2: Clear previous data
            report("setup", "Clearing previous test data...", 2);
            await this.clearPreviousData(projectId);

            // Phase 3: Parse bundles
            report("parse", "Parsing input bundles...", 5);
            const bundles = parseBundles(confluence, jira, slack, github, customerFeedback);
            report("parse", `Parsed ${bundles.totalDocuments} documents`, 8);

            // Phase 4: Store documents in MongoDB
            report("store", "Storing documents in MongoDB...", 10);
            const storedDocs = await this.storeDocuments(bundles, projectId);
            report("store", `Stored ${storedDocs.length} documents`, 15);

            // Phase 5: Embed documents
            report("embed", "Generating embeddings...", 18);
            let embedded = 0;
            for (const doc of storedDocs) {
                try {
                    await embedKnowledgeDocument(doc, this.logger);
                    embedded++;
                } catch (err) {
                    this.logger.log(`Embedding failed for ${doc.title}: ${err}`);
                }
            }
            report("embed", `Embedded ${embedded}/${storedDocs.length} documents`, 30);

            // Phase 6: Entity extraction
            report("entities", "Extracting entities...", 32);
            const extractor = new EntityExtractor(this.docsRepo, this.entitiesRepo, {}, this.logger);
            const entityResult = await extractor.processProject(projectId);
            report("entities", `Extracted ${entityResult.processed} entities`, 40);

            // Phase 7: Run all 5 analysis pipelines (each wrapped so one failure doesn't block others)
            report("gaps", "Detecting documentation gaps...", 42);
            let gaps: Awaited<ReturnType<EnhancedGapDetectorWorker["run"]>> = [];
            try {
                const gapWorker = new EnhancedGapDetectorWorker();
                gaps = await gapWorker.run(projectId);
                report("gaps", `Found ${gaps.length} gaps`, 55);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.log(`Gap detection failed (non-fatal): ${msg}`);
                report("gaps", `Gap detection failed: ${msg.substring(0, 120)}`, 55);
            }

            report("tickets", "Generating feature requests and bug reports...", 57);
            let tickets: Awaited<ReturnType<FeedbackToTicketsWorker["run"]>> = [];
            try {
                const ticketWorker = new FeedbackToTicketsWorker();
                tickets = await ticketWorker.run(projectId);
                report("tickets", `Generated ${tickets.length} tickets`, 65);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.log(`Ticket generation failed (non-fatal): ${msg}`);
                report("tickets", `Ticket generation failed: ${msg.substring(0, 120)}`, 65);
            }

            report("howto", "Generating how-to-implement docs...", 67);
            let howtos: Awaited<ReturnType<HowToGeneratorWorker["run"]>> = [];
            try {
                const howtoWorker = new HowToGeneratorWorker();
                howtos = await howtoWorker.run(projectId, tickets);
                report("howto", `Generated ${howtos.length} how-to docs`, 78);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.log(`How-to generation failed (non-fatal): ${msg}`);
                report("howto", `How-to generation failed: ${msg.substring(0, 120)}`, 78);
            }

            report("conflicts", "Detecting cross-source conflicts...", 80);
            let conflicts: Awaited<ReturnType<EnhancedConflictDetectorWorker["run"]>> = [];
            try {
                const conflictWorker = new EnhancedConflictDetectorWorker();
                conflicts = await conflictWorker.run(projectId);
                report("conflicts", `Found ${conflicts.length} conflicts`, 90);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.log(`Conflict detection failed (non-fatal): ${msg}`);
                report("conflicts", `Conflict detection failed: ${msg.substring(0, 120)}`, 90);
            }

            report("outdated", "Detecting outdated documentation...", 92);
            let outdated: Awaited<ReturnType<OutdatedDetectorWorker["run"]>> = [];
            try {
                const outdatedWorker = new OutdatedDetectorWorker();
                outdated = await outdatedWorker.run(projectId);
                report("outdated", `Found ${outdated.length} outdated docs`, 98);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.log(`Outdated detection failed (non-fatal): ${msg}`);
                report("outdated", `Outdated detection failed: ${msg.substring(0, 120)}`, 98);
            }

            report("done", `Pipeline complete: ${gaps.length} gaps, ${tickets.length} tickets, ${howtos.length} how-tos, ${conflicts.length} conflicts, ${outdated.length} outdated`, 100);

            return { success: true };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.log(`Pipeline failed: ${msg}`);
            report("error", msg, -1);
            return { success: false, error: msg };
        }
    }

    private async ensureProject(pid: string, slug: string, label: string): Promise<void> {
        const projects = db.collection("projects");
        const existing = await projects.findOne({ _id: pid });
        if (!existing) {
            await projects.insertOne({
                _id: pid,
                projectId: pid,
                name: label,
                companySlug: slug,
                secret: nanoid(),
                createdAt: new Date().toISOString(),
            });
        }
    }

    private async clearPreviousData(pid: string): Promise<void> {
        await Promise.all([
            db.collection("knowledge_documents").deleteMany({ projectId: pid }),
            db.collection("knowledge_entities").deleteMany({ projectId: pid }),
            db.collection("knowledge_pages").deleteMany({ projectId: pid }),
            db.collection("claims").deleteMany({ projectId: pid }),
            db.collection("test_results").deleteMany({ projectId: pid }),
            db.collection("test_analysis").deleteMany({ projectId: pid }),
            db.collection("doc_audit_findings").deleteMany({ projectId: pid }),
            db.collection("doc_audit_runs").deleteMany({ projectId: pid }),
        ]);

        try {
            const qdrant = new QdrantClient({
                url: process.env.QDRANT_URL || "http://localhost:6333",
                checkCompatibility: false,
            });
            await qdrant.delete(QDRANT_COLLECTION, {
                filter: {
                    must: [{ key: "projectId", match: { value: pid } }],
                },
            });
        } catch (err) {
            this.logger.log(`Qdrant cleanup warning: ${err}`);
        }
    }

    private async storeDocuments(bundles: ReturnType<typeof parseBundles>, pid: string) {
        const allParsed: ParsedDocument[] = [
            ...bundles.confluence,
            ...bundles.jira,
            ...bundles.slack,
            ...bundles.github,
            ...bundles.customerFeedback,
        ];

        const stored = [];
        for (const parsed of allParsed) {
            const doc = await this.docsRepo.create({
                projectId: pid,
                provider: parsed.provider,
                sourceType: parsed.sourceType,
                sourceId: parsed.sourceId,
                title: parsed.title,
                content: parsed.content,
                metadata: parsed.metadata,
                entityRefs: parsed.entityRefs,
                syncedAt: new Date().toISOString(),
            });
            stored.push(doc);
        }
        return stored;
    }
}
