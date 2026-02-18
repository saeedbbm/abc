/**
 * Documentation Audit Worker v3
 * 
 * Two-channel architecture:
 * - Conflicts → #documentation channel (comments on existing Confluence pages)
 * - New docs → #knowledge-base channel (pages created in our KB, not Confluence)
 * - "What I Understand" page → both Confluence AND our KB
 */

import { PrefixLogger } from "@/lib/utils";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import {
    MongoDBDocAuditFindingsRepository,
    MongoDBDocAuditRunsRepository,
    MongoDBDocAuditConfigRepository,
} from "@/src/infrastructure/repositories/mongodb.doc-audit.repository";
import { MongoDBKnowledgePagesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-pages.repository";
import { SlackClient } from "@/src/application/lib/integrations/slack";
import { ConfluenceClient } from "@/src/application/lib/integrations/atlassian/confluence-client";
import { getValidAtlassianToken } from "@/src/application/lib/integrations/atlassian";
import { ConflictDetector } from "./conflict-detector";
import { GapDetector } from "./gap-detector";
import { DocAuditNotificationService } from "./notification-service";
import { CompanyDiscoveryService } from "../discovery/company-discovery";

export interface DocAuditWorkerResult {
    runId: string;
    success: boolean;
    conflictsFound: number;
    gapsFound: number;
    proposalsCreated: number;
    notificationsSent: number;
    error?: string;
}

export class DocAuditWorker {
    private oauthTokensRepo: MongoDBOAuthTokensRepository;
    private knowledgeDocsRepo: MongoDBKnowledgeDocumentsRepository;
    private knowledgeEntitiesRepo: MongoDBKnowledgeEntitiesRepository;
    private findingsRepo: MongoDBDocAuditFindingsRepository;
    private runsRepo: MongoDBDocAuditRunsRepository;
    private configRepo: MongoDBDocAuditConfigRepository;
    private kbPagesRepo: MongoDBKnowledgePagesRepository;
    private logger: PrefixLogger;

    constructor(
        oauthTokensRepo: MongoDBOAuthTokensRepository,
        knowledgeDocsRepo: MongoDBKnowledgeDocumentsRepository,
        knowledgeEntitiesRepo: MongoDBKnowledgeEntitiesRepository,
        findingsRepo: MongoDBDocAuditFindingsRepository,
        runsRepo: MongoDBDocAuditRunsRepository,
        configRepo: MongoDBDocAuditConfigRepository,
        logger: PrefixLogger
    ) {
        this.oauthTokensRepo = oauthTokensRepo;
        this.knowledgeDocsRepo = knowledgeDocsRepo;
        this.knowledgeEntitiesRepo = knowledgeEntitiesRepo;
        this.findingsRepo = findingsRepo;
        this.runsRepo = runsRepo;
        this.configRepo = configRepo;
        this.kbPagesRepo = new MongoDBKnowledgePagesRepository();
        this.logger = logger;
    }

    async run(projectId: string): Promise<DocAuditWorkerResult> {
        const now = new Date().toISOString();

        const auditRun = await this.runsRepo.create({
            projectId,
            status: 'running',
            confluencePagesScanned: 0,
            slackConversationsScanned: 0,
            jiraIssuesScanned: 0,
            conflictsFound: 0,
            gapsFound: 0,
            proposalsCreated: 0,
            notificationsSent: 0,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
        });

        const auditRunId = auditRun.id;
        this.logger.log(`Starting doc audit run ${auditRunId} for project ${projectId}`);

        try {
            const config = await this.configRepo.getOrCreate(projectId);
            const { slackClient, confluenceClient, siteUrl } = await this.initializeClients(projectId);

            // Initialize detectors
            const conflictDetector = new ConflictDetector(
                this.knowledgeDocsRepo,
                this.knowledgeEntitiesRepo,
                this.logger.child('conflict-detector'),
                { similarityThreshold: config.conflictSimilarityThreshold }
            );

            const gapDetector = new GapDetector(
                this.knowledgeDocsRepo,
                this.knowledgeEntitiesRepo,
                this.logger.child('gap-detector'),
                {
                    similarityThreshold: config.gapSimilarityThreshold,
                    minTopicMentions: config.minTopicMentions,
                }
            );

            // Resolve company slug from the projects collection
            const project = await (await import("@/lib/mongodb")).db.collection('projects').findOne({ projectId });
            const companySlug = project?.companySlug || config.pidraxSpaceKey?.toLowerCase() || 'unknown';

            // Initialize notification service (v3 — saves to our DB)
            // Slack is optional — KB pages are still generated even without Slack
            const notificationService = new DocAuditNotificationService(
                slackClient!,
                confluenceClient,
                this.findingsRepo,
                this.kbPagesRepo,
                siteUrl,
                projectId,
                companySlug,
                this.logger.child('notifications')
            );

            // Try to get Slack channels — non-fatal if they don't exist
            let docChannelId: string | null = null;
            let kbChannelId: string | null = null;
            if (slackClient) {
                try {
                    const docChannel = await notificationService.getChannel(
                        config.slackChannelName || 'documentation'
                    );
                    const kbChannel = await notificationService.getChannel('knowledge-base');
                    docChannelId = docChannel?.id || null;
                    kbChannelId = kbChannel?.id || null;
                    if (docChannelId) {
                        this.logger.log(`Using Slack channels: #documentation (${docChannelId})${kbChannelId ? `, #knowledge-base (${kbChannelId})` : ''}`);
                    }
                } catch (err) {
                    this.logger.log(`Slack channel setup failed (non-fatal, KB pages will still be generated): ${err}`);
                }
            } else {
                this.logger.log('Slack not connected — KB pages will be generated without Slack notifications');
            }

            // --- Clear stale findings ---
            const clearedCount = await this.findingsRepo.clearStaleFindings(projectId);
            if (clearedCount > 0) {
                this.logger.log(`Cleared ${clearedCount} stale findings`);
            }

            // --- Phase 0: Company Discovery (with TTL cache) ---
            const discoveryTtl = config.discoveryTtlMinutes || 60;
            const lastDiscovery = config.lastDiscoveryAt ? new Date(config.lastDiscoveryAt).getTime() : 0;
            const discoveryAge = (Date.now() - lastDiscovery) / 60000; // minutes
            let understandingHtml: string | undefined;

            if (discoveryAge < discoveryTtl) {
                this.logger.log(`Phase 0: Skipping discovery — last run ${Math.round(discoveryAge)} min ago (TTL: ${discoveryTtl} min)`);
            } else {
                this.logger.log('Phase 0: Running company discovery...');
                try {
                    const discoveryService = new CompanyDiscoveryService(
                        this.knowledgeDocsRepo,
                        this.knowledgeEntitiesRepo,
                        this.logger.child('discovery')
                    );
                    const result = await discoveryService.discover(projectId);
                    this.logger.log(`Discovery: ${result.peopleEnriched} people, ${result.systemsDiscovered} systems, ${result.customersDiscovered} customers, ${result.projectsDiscovered} projects`);
                    understandingHtml = result.understandingAnalysis;

                    // Update discovery timestamp in config
                    await this.configRepo.update(projectId, {
                        lastDiscoveryAt: new Date().toISOString(),
                    });
                } catch (error) {
                    this.logger.log(`Discovery failed (non-fatal): ${error}`);
                }
            }

            // --- Phase 0.5: "What I Understand" page ---
            if (understandingHtml) {
                this.logger.log('Creating "What PidraxBot Understands" page...');
                try {
                    const result = await notificationService.createUnderstandingPage(understandingHtml);
                    if (result && kbChannelId && slackClient) {
                        const msg = `:brain: Updated the company understanding analysis — <${result.url}|View the full analysis>`;
                        await slackClient.postMessage(kbChannelId, msg);
                    }
                } catch (error) {
                    this.logger.log(`Understanding page failed (non-fatal): ${error}`);
                }
            }

            let totalConflicts = 0;
            let totalGaps = 0;
            let totalProposals = 0;
            let totalNotifications = 0;

            // --- Phase 1: Conflict Detection → #documentation ---
            if (config.auditConflicts) {
                this.logger.log('Phase 1: Running conflict detection...');
                const conflictResult = await conflictDetector.detect(projectId, auditRunId);
                totalConflicts = conflictResult.findings.length;
                this.logger.log(`Found ${totalConflicts} conflicts`);

                for (const findingData of conflictResult.findings) {
                    const existing = await this.findingsRepo.findExistingFinding(
                        projectId, findingData.confluencePageId, findingData.type, findingData.title
                    );
                    if (existing) continue;

                    const saved = await this.findingsRepo.create(findingData);
                    if (docChannelId) {
                        try {
                            await notificationService.notifyConflictFinding(saved, docChannelId);
                            totalNotifications++;
                        } catch (error) {
                            this.logger.log(`Notification failed: ${error}`);
                        }
                    }
                }

                await this.runsRepo.update(auditRunId, {
                    confluencePagesScanned: conflictResult.pagesScanned,
                    conflictsFound: totalConflicts,
                });
            }

            // --- Phase 2: Gap Detection → #knowledge-base ---
            if (config.auditGaps) {
                this.logger.log('Phase 2: Running gap detection...');
                const gapResult = await gapDetector.detect(projectId, auditRunId);
                totalGaps = gapResult.findings.length;
                this.logger.log(`Found ${totalGaps} undocumented entities`);

                const gapChannelId = kbChannelId || docChannelId;

                // Step 1: Save findings and filter out duplicates
                const newFindings = [];
                for (const findingData of gapResult.findings) {
                    const existing = await this.findingsRepo.findExistingFinding(
                        projectId, undefined, 'undocumented', findingData.title
                    );
                    if (existing) continue;
                    const saved = await this.findingsRepo.create(findingData);
                    newFindings.push(saved);
                }

                // Step 2: Create KB pages in PARALLEL batches of 5
                const PAGE_BATCH_SIZE = 5;
                const createdPages: Array<{ name: string; url: string; mentions: string[] }> = [];

                for (let i = 0; i < newFindings.length; i += PAGE_BATCH_SIZE) {
                    const batch = newFindings.slice(i, i + PAGE_BATCH_SIZE);
                    this.logger.log(`Generating pages batch ${Math.floor(i / PAGE_BATCH_SIZE) + 1}/${Math.ceil(newFindings.length / PAGE_BATCH_SIZE)} (${batch.length} pages)...`);

                    const results = await Promise.allSettled(
                        batch.map(finding => notificationService.createGapPage(finding))
                    );

                    for (const result of results) {
                        if (result.status === 'fulfilled' && result.value) {
                            createdPages.push(result.value);
                            totalProposals++;
                        } else if (result.status === 'rejected') {
                            this.logger.log(`Page creation failed: ${result.reason}`);
                        }
                    }
                }

                // Step 2: Send ONE summary Slack message with all created pages
                if (createdPages.length > 0 && gapChannelId) {
                    try {
                        await notificationService.sendGapSummary(createdPages, gapChannelId);
                        totalNotifications++;
                    } catch (error) {
                        this.logger.log(`Gap summary notification failed: ${error}`);
                    }
                }

                await this.runsRepo.update(auditRunId, {
                    slackConversationsScanned: gapResult.topicsScanned,
                    gapsFound: totalGaps,
                });
            }

            // --- Complete ---
            await this.runsRepo.update(auditRunId, {
                status: 'completed',
                proposalsCreated: totalProposals,
                notificationsSent: totalNotifications,
                completedAt: new Date().toISOString(),
            });

            const result: DocAuditWorkerResult = {
                runId: auditRunId,
                success: true,
                conflictsFound: totalConflicts,
                gapsFound: totalGaps,
                proposalsCreated: totalProposals,
                notificationsSent: totalNotifications,
            };

            this.logger.log(`Doc audit complete: ${JSON.stringify(result)}`);
            return result;

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.log(`Doc audit failed: ${errorMsg}`);

            await this.runsRepo.update(auditRunId, {
                status: 'failed',
                error: errorMsg,
                completedAt: new Date().toISOString(),
            });

            return {
                runId: auditRunId,
                success: false,
                conflictsFound: 0,
                gapsFound: 0,
                proposalsCreated: 0,
                notificationsSent: 0,
                error: errorMsg,
            };
        }
    }

    private async initializeClients(projectId: string): Promise<{
        slackClient: SlackClient | null;
        confluenceClient: ConfluenceClient | null;
        siteUrl: string;
    }> {
        let slackClient: SlackClient | null = null;
        let confluenceClient: ConfluenceClient | null = null;
        let siteUrl = '';

        const slackToken = await this.oauthTokensRepo.fetchByProjectAndProvider(projectId, 'slack');
        if (slackToken) {
            slackClient = new SlackClient(slackToken.accessToken);
        }

        const atlassianToken = await getValidAtlassianToken(projectId);
        if (atlassianToken && atlassianToken.metadata?.cloudId) {
            confluenceClient = new ConfluenceClient(
                atlassianToken.accessToken,
                atlassianToken.metadata.cloudId as string
            );
            siteUrl = (atlassianToken.metadata?.siteUrl as string) || '';
        }

        return { slackClient, confluenceClient, siteUrl };
    }
}
