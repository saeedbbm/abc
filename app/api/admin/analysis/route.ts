/**
 * Analysis API — System Health Metrics
 * 
 * GET /api/admin/analysis
 * Returns per-company metrics: ingestion, KB health, verification, conflicts, gaps, entity quality, freshness
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/mongodb";

interface CompanyMetrics {
    companySlug: string;
    companyName: string;
    projectId: string;
    ingestion: {
        totalDocuments: number;
        byProvider: Record<string, number>;
        byType: Record<string, number>;
        lastSyncAt: string | null;
    };
    kbHealth: {
        totalPages: number;
        byCategory: Record<string, number>;
        citationCoverage: number;  // 0-1
        avgCitationsPerPage: number;
    };
    verification: {
        totalClaims: number;
        byStatus: Record<string, number>;
        verificationRate: number;  // 0-1
    };
    conflicts: {
        totalFindings: number;
        byType: Record<string, number>;
        bySeverity: Record<string, number>;
        pendingCount: number;
        resolvedCount: number;
    };
    entities: {
        totalEntities: number;
        byType: Record<string, number>;
        withAnchors: number;
        fuzzyOnly: number;
    };
    freshness: {
        avgClaimAgeDays: number;
        verifiedLast7Days: number;
        staleClaims: number;
    };
    healthScore: number;  // 0-100
}

export async function GET(): Promise<Response> {
    try {
        // Get all companies
        const projects = await db.collection('projects').find({}).toArray();
        
        const metrics: CompanyMetrics[] = [];
        
        // Aggregate global stats
        let totalDocs = 0;
        let totalPages = 0;
        let totalClaims = 0;
        
        for (const project of projects) {
            const projectId = project.projectId || project._id.toString();
            const companySlug = project.companySlug || project.slug || '';
            const companyName = project.name || project.companyName || companySlug;
            
            // Ingestion metrics
            const docsByProvider = await db.collection('knowledge_documents').aggregate([
                { $match: { projectId, deletedAt: { $exists: false } } },
                { $group: { _id: '$provider', count: { $sum: 1 } } },
            ]).toArray();
            
            const docsByType = await db.collection('knowledge_documents').aggregate([
                { $match: { projectId, deletedAt: { $exists: false } } },
                { $group: { _id: '$sourceType', count: { $sum: 1 } } },
            ]).toArray();
            
            const totalDocsForProject = docsByProvider.reduce((sum, d) => sum + d.count, 0);
            totalDocs += totalDocsForProject;
            
            const syncStates = await db.collection('sync_states').find({ projectId }).toArray();
            const lastSyncAt = syncStates.reduce((latest: string | null, s: any) => {
                const syncTime = s.lastSyncedAt || s.lastSyncAt;
                if (!syncTime) return latest;
                if (!latest) return syncTime;
                return syncTime > latest ? syncTime : latest;
            }, null);
            
            // KB Health metrics
            const kbPages = await db.collection('knowledge_pages').find({ projectId }).toArray();
            totalPages += kbPages.length;
            
            const pagesByCategory: Record<string, number> = {};
            let totalCitations = 0;
            let pagesWithCitations = 0;
            
            for (const page of kbPages) {
                const cat = page.category || 'uncategorized';
                pagesByCategory[cat] = (pagesByCategory[cat] || 0) + 1;
                
                const citedBlocks = page.reviewableBlocks?.filter((b: any) => b.sourceRefs?.length > 0).length || 0;
                totalCitations += citedBlocks;
                if (citedBlocks > 0) pagesWithCitations++;
            }
            
            const citationCoverage = kbPages.length > 0 ? pagesWithCitations / kbPages.length : 0;
            const avgCitations = kbPages.length > 0 ? totalCitations / kbPages.length : 0;
            
            // Claims metrics
            const claimsByStatus = await db.collection('doc_audit_claims').aggregate([
                { $match: { projectId } },
                { $group: { _id: '$status', count: { $sum: 1 } } },
            ]).toArray();
            
            const claimStatusMap: Record<string, number> = {};
            let totalClaimsForProject = 0;
            for (const c of claimsByStatus) {
                claimStatusMap[c._id || 'unknown'] = c.count;
                totalClaimsForProject += c.count;
            }
            totalClaims += totalClaimsForProject;
            
            const verifiedCount = claimStatusMap['verified'] || 0;
            const verificationRate = totalClaimsForProject > 0 ? verifiedCount / totalClaimsForProject : 0;
            
            // Conflicts/Findings metrics
            const findingsByType = await db.collection('doc_audit_findings').aggregate([
                { $match: { projectId } },
                { $group: { _id: '$type', count: { $sum: 1 } } },
            ]).toArray();
            
            const findingsBySeverity = await db.collection('doc_audit_findings').aggregate([
                { $match: { projectId } },
                { $group: { _id: '$severity', count: { $sum: 1 } } },
            ]).toArray();
            
            const pendingFindings = await db.collection('doc_audit_findings').countDocuments({ projectId, status: 'pending' });
            const resolvedFindings = await db.collection('doc_audit_findings').countDocuments({ projectId, status: { $in: ['accepted', 'resolved'] } });
            const totalFindings = findingsByType.reduce((sum, f) => sum + f.count, 0);
            
            // Entity metrics
            const entitiesByType = await db.collection('knowledge_entities').aggregate([
                { $match: { projectId, deletedAt: { $exists: false } } },
                { $group: { _id: '$type', count: { $sum: 1 } } },
            ]).toArray();
            
            const totalEntities = entitiesByType.reduce((sum, e) => sum + e.count, 0);
            const withAnchors = await db.collection('knowledge_entities').countDocuments({
                projectId,
                deletedAt: { $exists: false },
                $or: [
                    { 'metadata.slackUserId': { $exists: true } },
                    { 'metadata.jiraAccountId': { $exists: true } },
                    { 'metadata.email': { $exists: true } },
                ],
            });
            
            // Freshness metrics
            const now = new Date();
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
            
            const verifiedLast7Days = await db.collection('doc_audit_claims').countDocuments({
                projectId,
                lastVerifiedAt: { $gte: sevenDaysAgo },
            });
            
            const staleClaims = await db.collection('doc_audit_claims').countDocuments({
                projectId,
                status: { $in: ['active', 'unknown'] },
                $or: [
                    { lastVerifiedAt: { $exists: false } },
                    { lastVerifiedAt: { $lt: thirtyDaysAgo } },
                ],
            });
            
            // Calculate avg claim age
            const claimsWithDates = await db.collection('doc_audit_claims').find(
                { projectId, extractedAt: { $exists: true } },
                { projection: { extractedAt: 1 } }
            ).limit(500).toArray();
            
            let avgClaimAgeDays = 0;
            if (claimsWithDates.length > 0) {
                const totalAge = claimsWithDates.reduce((sum, c) => {
                    const age = (now.getTime() - new Date(c.extractedAt).getTime()) / (1000 * 60 * 60 * 24);
                    return sum + age;
                }, 0);
                avgClaimAgeDays = Math.round(totalAge / claimsWithDates.length);
            }
            
            // Health Score: citation coverage × 0.3 + verification rate × 0.3 + freshness × 0.2 + gap coverage × 0.2
            const freshnessScore = totalClaimsForProject > 0 
                ? Math.min(1, verifiedLast7Days / Math.max(totalClaimsForProject * 0.1, 1))
                : 0;
            const gapCoverage = totalEntities > 0 
                ? Math.min(1, kbPages.length / Math.max(totalEntities * 0.5, 1))
                : 0;
            
            const healthScore = Math.round(
                (citationCoverage * 30) +
                (verificationRate * 30) +
                (freshnessScore * 20) +
                (gapCoverage * 20)
            );
            
            metrics.push({
                companySlug,
                companyName,
                projectId,
                ingestion: {
                    totalDocuments: totalDocsForProject,
                    byProvider: Object.fromEntries(docsByProvider.map(d => [d._id || 'unknown', d.count])),
                    byType: Object.fromEntries(docsByType.map(d => [d._id || 'unknown', d.count])),
                    lastSyncAt,
                },
                kbHealth: {
                    totalPages: kbPages.length,
                    byCategory: pagesByCategory,
                    citationCoverage,
                    avgCitationsPerPage: avgCitations,
                },
                verification: {
                    totalClaims: totalClaimsForProject,
                    byStatus: claimStatusMap,
                    verificationRate,
                },
                conflicts: {
                    totalFindings,
                    byType: Object.fromEntries(findingsByType.map(f => [f._id || 'unknown', f.count])),
                    bySeverity: Object.fromEntries(findingsBySeverity.map(f => [f._id || 'unknown', f.count])),
                    pendingCount: pendingFindings,
                    resolvedCount: resolvedFindings,
                },
                entities: {
                    totalEntities,
                    byType: Object.fromEntries(entitiesByType.map(e => [e._id || 'unknown', e.count])),
                    withAnchors,
                    fuzzyOnly: totalEntities - withAnchors,
                },
                freshness: {
                    avgClaimAgeDays,
                    verifiedLast7Days,
                    staleClaims,
                },
                healthScore,
            });
        }
        
        return NextResponse.json({
            overview: {
                totalCompanies: projects.length,
                totalDocuments: totalDocs,
                totalPages,
                totalClaims,
            },
            companies: metrics,
        });
    } catch (error) {
        console.error('[Analysis API] Error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
