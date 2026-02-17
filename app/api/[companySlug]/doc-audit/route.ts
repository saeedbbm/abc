/**
 * Documentation Audit API
 * 
 * POST /api/[companySlug]/doc-audit          - Trigger a doc audit run
 * GET  /api/[companySlug]/doc-audit          - Get audit status, config, and recent findings
 * PUT  /api/[companySlug]/doc-audit          - Update audit config
 * DELETE /api/[companySlug]/doc-audit        - Clean up all audit data
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/mongodb";
import { resolveCompanySlug } from "@/lib/company-resolver";
import { PrefixLogger } from "@/lib/utils";
import { MongoDBOAuthTokensRepository } from "@/src/infrastructure/repositories/mongodb.oauth-tokens.repository";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import {
    MongoDBDocAuditFindingsRepository,
    MongoDBDocAuditRunsRepository,
    MongoDBDocAuditConfigRepository,
} from "@/src/infrastructure/repositories/mongodb.doc-audit.repository";
import { DocAuditWorker } from "@/src/application/workers/doc-audit";
import { CompanyDiscoveryService } from "@/src/application/workers/discovery/company-discovery";
import { getFrequentGaps } from "@/src/application/lib/knowledge/gap-feedback";

const oauthTokensRepo = new MongoDBOAuthTokensRepository();
const knowledgeDocsRepo = new MongoDBKnowledgeDocumentsRepository();
const knowledgeEntitiesRepo = new MongoDBKnowledgeEntitiesRepository();
const findingsRepo = new MongoDBDocAuditFindingsRepository();
const runsRepo = new MongoDBDocAuditRunsRepository();
const configRepo = new MongoDBDocAuditConfigRepository();

const logger = new PrefixLogger('doc-audit-api');

// Allow long-running audits
export const maxDuration = 300; // 5 minutes

/**
 * POST - Trigger a documentation audit run or discovery
 * 
 * Body: { action?: 'audit' | 'discover' | 'gaps' }
 * - audit (default): Full audit run (discovery + conflict + gap detection)
 * - discover: Run company discovery only (build/update knowledge graph)
 * - gaps: Get Q&A-driven gap suggestions (queries that users asked but couldn't answer)
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    let action = 'audit';
    try {
        const body = await req.json();
        action = body.action || 'audit';
    } catch {
        // Default to audit if no body
    }

    // --- Action: discover ---
    if (action === 'discover') {
        logger.log(`Triggering company discovery for project ${projectId}`);
        try {
            const discoveryService = new CompanyDiscoveryService(
                knowledgeDocsRepo,
                knowledgeEntitiesRepo,
                logger.child('discovery')
            );
            const result = await discoveryService.discover(projectId);
            return NextResponse.json(result);
        } catch (error) {
            logger.log(`Discovery error: ${error}`);
            return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
        }
    }

    // --- Action: gaps ---
    if (action === 'gaps') {
        logger.log(`Getting Q&A gap suggestions for project ${projectId}`);
        try {
            const gaps = await getFrequentGaps(projectId, 2, logger);
            return NextResponse.json({ success: true, gaps });
        } catch (error) {
            logger.log(`Gaps error: ${error}`);
            return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
        }
    }

    // --- Action: audit (default) ---
    logger.log(`Triggering doc audit (background) for project ${projectId}`);

    const worker = new DocAuditWorker(
        oauthTokensRepo,
        knowledgeDocsRepo,
        knowledgeEntitiesRepo,
        findingsRepo,
        runsRepo,
        configRepo,
        logger.child('worker')
    );

    // Fire and forget — the audit runs in the background
    worker.run(projectId).then(result => {
        logger.log(`Background audit complete: ${JSON.stringify(result)}`);
    }).catch(error => {
        logger.log(`Background audit failed: ${error}`);
    });

    return NextResponse.json({
        success: true,
        message: 'Audit started in background. Poll GET /doc-audit for status.',
        status: 'running',
    });
}

/**
 * GET - Get audit status, config, and recent findings
 */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        const config = await configRepo.getOrCreate(projectId);
        const latestRun = await runsRepo.getLatestRun(projectId);
        const recentRuns = await runsRepo.findByProjectId(projectId, 5);
        const recentFindings = await findingsRepo.findByProjectId(projectId, { limit: 20 });

        // Stats
        const pendingCount = await findingsRepo.countByProject(projectId, { status: 'pending' });
        const notifiedCount = await findingsRepo.countByProject(projectId, { status: 'notified' });
        const proposalCount = await findingsRepo.countByProject(projectId, { status: 'proposal_created' });
        const acceptedCount = await findingsRepo.countByProject(projectId, { status: 'accepted' });
        const conflictCount = await findingsRepo.countByProject(projectId, { type: 'contradiction' });
        const outdatedCount = await findingsRepo.countByProject(projectId, { type: 'outdated' });
        const gapCount = await findingsRepo.countByProject(projectId, { type: 'undocumented' });

        return NextResponse.json({
            config,
            latestRun,
            recentRuns,
            recentFindings,
            stats: {
                pending: pendingCount,
                notified: notifiedCount,
                proposals: proposalCount,
                accepted: acceptedCount,
                conflicts: conflictCount,
                outdated: outdatedCount,
                gaps: gapCount,
                total: pendingCount + notifiedCount + proposalCount + acceptedCount,
            },
        });
    } catch (error) {
        logger.log(`Error fetching audit status: ${error}`);
        return NextResponse.json({
            error: String(error),
        }, { status: 500 });
    }
}

/**
 * DELETE - Clean up all audit data (findings, runs, configs, claims)
 */
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    logger.log(`Cleaning up all audit data for project ${projectId}`);

    try {
        const findingsResult = await db.collection('doc_audit_findings').deleteMany({ projectId });
        const runsResult = await db.collection('doc_audit_runs').deleteMany({ projectId });
        const configsResult = await db.collection('doc_audit_configs').deleteMany({ projectId });
        const claimsResult = await db.collection('doc_audit_claims').deleteMany({ projectId });

        const summary = {
            findings: findingsResult.deletedCount,
            runs: runsResult.deletedCount,
            configs: configsResult.deletedCount,
            claims: claimsResult.deletedCount,
        };

        logger.log(`Audit cleanup complete: ${JSON.stringify(summary)}`);

        return NextResponse.json({
            success: true,
            message: 'All audit data has been cleaned up',
            deleted: summary,
        });
    } catch (error) {
        logger.log(`Error cleaning up audit data: ${error}`);
        return NextResponse.json({
            success: false,
            error: String(error),
        }, { status: 500 });
    }
}

/**
 * PUT - Update audit config
 */
export async function PUT(
    req: NextRequest,
    { params }: { params: Promise<{ companySlug: string }> }
): Promise<Response> {
    const { companySlug } = await params;
    const projectId = await resolveCompanySlug(companySlug);
    if (!projectId) return Response.json({ error: "Company not found" }, { status: 404 });

    try {
        const body = await req.json();

        const updatedConfig = await configRepo.update(projectId, {
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.cronExpression ? { cronExpression: body.cronExpression } : {}),
            ...(body.slackChannelName ? { slackChannelName: body.slackChannelName } : {}),
            ...(body.auditConflicts !== undefined ? { auditConflicts: body.auditConflicts } : {}),
            ...(body.auditGaps !== undefined ? { auditGaps: body.auditGaps } : {}),
            ...(body.targetSpaceIds ? { targetSpaceIds: body.targetSpaceIds } : {}),
            ...(body.proposalSpaceId ? { proposalSpaceId: body.proposalSpaceId } : {}),
            ...(body.pidraxSpaceKey ? { pidraxSpaceKey: body.pidraxSpaceKey } : {}),
            ...(body.conflictSimilarityThreshold !== undefined ? { conflictSimilarityThreshold: body.conflictSimilarityThreshold } : {}),
            ...(body.gapSimilarityThreshold !== undefined ? { gapSimilarityThreshold: body.gapSimilarityThreshold } : {}),
            ...(body.minTopicMentions !== undefined ? { minTopicMentions: body.minTopicMentions } : {}),
        });

        return NextResponse.json({
            success: true,
            config: updatedConfig,
        });
    } catch (error) {
        logger.log(`Error updating config: ${error}`);
        return NextResponse.json({
            success: false,
            error: String(error),
        }, { status: 500 });
    }
}
