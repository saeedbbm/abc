"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
    RefreshCw,
    Loader2,
    FileText,
    Database,
    Shield,
    AlertTriangle,
    Users,
    Clock,
    ArrowLeft,
    ChevronDown,
    ChevronRight,
    Heart,
} from "lucide-react";
import { Button } from "@/components/ui/button";

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
        citationCoverage: number;
        avgCitationsPerPage: number;
    };
    verification: {
        totalClaims: number;
        byStatus: Record<string, number>;
        verificationRate: number;
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
    healthScore: number;
}

interface AnalysisData {
    overview: {
        totalCompanies: number;
        totalDocuments: number;
        totalPages: number;
        totalClaims: number;
    };
    companies: CompanyMetrics[];
}

function HealthBadge({ score }: { score: number }) {
    const color = score >= 70 ? "text-green-600 bg-green-50 border-green-200"
        : score >= 40 ? "text-yellow-600 bg-yellow-50 border-yellow-200"
        : "text-red-600 bg-red-50 border-red-200";
    return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${color}`}>
            <Heart className="h-3 w-3" />
            {score}
        </span>
    );
}

function StatCard({ label, value, icon: Icon, subtitle }: {
    label: string;
    value: string | number;
    icon: any;
    subtitle?: string;
}) {
    return (
        <div className="rounded-xl border bg-card p-4 flex items-start gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Icon className="h-4.5 w-4.5 text-primary" />
            </div>
            <div>
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
                {subtitle && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{subtitle}</p>}
            </div>
        </div>
    );
}

function MetricRow({ label, value, total, barColor = "bg-primary" }: {
    label: string;
    value: number;
    total?: number;
    barColor?: string;
}) {
    const percent = total && total > 0 ? Math.round((value / total) * 100) : 0;
    return (
        <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground w-28 shrink-0">{label}</span>
            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(percent, 100)}%` }} />
            </div>
            <span className="font-medium w-16 text-right">{value}{total ? ` / ${total}` : ''}</span>
        </div>
    );
}

function CompanyAccordion({ company }: { company: CompanyMetrics }) {
    const [open, setOpen] = useState(false);
    
    return (
        <div className="rounded-xl border bg-card overflow-hidden">
            <button
                onClick={() => setOpen(!open)}
                className="w-full flex items-center gap-4 p-4 hover:bg-accent/50 transition-colors text-left"
            >
                {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="font-semibold">{company.companyName}</span>
                        <span className="text-xs text-muted-foreground">/{company.companySlug}</span>
                    </div>
                </div>
                <HealthBadge score={company.healthScore} />
                <div className="flex gap-4 text-xs text-muted-foreground">
                    <span>{company.ingestion.totalDocuments} docs</span>
                    <span>{company.kbHealth.totalPages} pages</span>
                    <span>{company.verification.totalClaims} claims</span>
                </div>
            </button>
            
            {open && (
                <div className="px-4 pb-4 space-y-6 border-t pt-4">
                    {/* Ingestion */}
                    <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <Database className="h-3 w-3" /> Ingestion
                        </h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <p className="text-xs text-muted-foreground mb-1">By Provider</p>
                                {Object.entries(company.ingestion.byProvider).map(([provider, count]) => (
                                    <MetricRow key={provider} label={provider} value={count} total={company.ingestion.totalDocuments} />
                                ))}
                            </div>
                            <div className="space-y-2">
                                <p className="text-xs text-muted-foreground mb-1">By Type</p>
                                {Object.entries(company.ingestion.byType).slice(0, 6).map(([type, count]) => (
                                    <MetricRow key={type} label={type} value={count} total={company.ingestion.totalDocuments} />
                                ))}
                            </div>
                        </div>
                        {company.ingestion.lastSyncAt && (
                            <p className="text-[10px] text-muted-foreground mt-2">
                                Last sync: {new Date(company.ingestion.lastSyncAt).toLocaleString()}
                            </p>
                        )}
                    </div>
                    
                    {/* KB Health */}
                    <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <FileText className="h-3 w-3" /> KB Health
                        </h4>
                        <div className="grid grid-cols-3 gap-4 text-xs">
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold">{company.kbHealth.totalPages}</p>
                                <p className="text-muted-foreground">Pages</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold">{Math.round(company.kbHealth.citationCoverage * 100)}%</p>
                                <p className="text-muted-foreground">Citation Coverage</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold">{company.kbHealth.avgCitationsPerPage.toFixed(1)}</p>
                                <p className="text-muted-foreground">Avg Citations/Page</p>
                            </div>
                        </div>
                        {Object.keys(company.kbHealth.byCategory).length > 0 && (
                            <div className="mt-3 space-y-1.5">
                                {Object.entries(company.kbHealth.byCategory).map(([cat, count]) => (
                                    <MetricRow key={cat} label={cat} value={count} total={company.kbHealth.totalPages} />
                                ))}
                            </div>
                        )}
                    </div>
                    
                    {/* Verification */}
                    <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <Shield className="h-3 w-3" /> Verification
                        </h4>
                        <div className="grid grid-cols-3 gap-4 text-xs">
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold">{company.verification.totalClaims}</p>
                                <p className="text-muted-foreground">Total Claims</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold">{Math.round(company.verification.verificationRate * 100)}%</p>
                                <p className="text-muted-foreground">Verified</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold text-yellow-600">{company.freshness.staleClaims}</p>
                                <p className="text-muted-foreground">Stale Claims</p>
                            </div>
                        </div>
                        {Object.keys(company.verification.byStatus).length > 0 && (
                            <div className="mt-3 space-y-1.5">
                                {Object.entries(company.verification.byStatus).map(([status, count]) => (
                                    <MetricRow
                                        key={status}
                                        label={status}
                                        value={count}
                                        total={company.verification.totalClaims}
                                        barColor={status === 'verified' ? 'bg-green-500' : status === 'contradicted' ? 'bg-red-500' : 'bg-primary'}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                    
                    {/* Conflicts */}
                    <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <AlertTriangle className="h-3 w-3" /> Conflicts & Findings
                        </h4>
                        <div className="grid grid-cols-3 gap-4 text-xs">
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold">{company.conflicts.totalFindings}</p>
                                <p className="text-muted-foreground">Total Findings</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold text-orange-600">{company.conflicts.pendingCount}</p>
                                <p className="text-muted-foreground">Pending</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold text-green-600">{company.conflicts.resolvedCount}</p>
                                <p className="text-muted-foreground">Resolved</p>
                            </div>
                        </div>
                    </div>
                    
                    {/* Entities */}
                    <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <Users className="h-3 w-3" /> Entities
                        </h4>
                        <div className="grid grid-cols-3 gap-4 text-xs">
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold">{company.entities.totalEntities}</p>
                                <p className="text-muted-foreground">Total Entities</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold text-green-600">{company.entities.withAnchors}</p>
                                <p className="text-muted-foreground">With Anchors</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold text-yellow-600">{company.entities.fuzzyOnly}</p>
                                <p className="text-muted-foreground">Fuzzy Only</p>
                            </div>
                        </div>
                        {Object.keys(company.entities.byType).length > 0 && (
                            <div className="mt-3 space-y-1.5">
                                {Object.entries(company.entities.byType).map(([type, count]) => (
                                    <MetricRow key={type} label={type} value={count} total={company.entities.totalEntities} />
                                ))}
                            </div>
                        )}
                    </div>
                    
                    {/* Freshness */}
                    <div>
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <Clock className="h-3 w-3" /> Freshness
                        </h4>
                        <div className="grid grid-cols-3 gap-4 text-xs">
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold">{company.freshness.avgClaimAgeDays}d</p>
                                <p className="text-muted-foreground">Avg Claim Age</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold text-green-600">{company.freshness.verifiedLast7Days}</p>
                                <p className="text-muted-foreground">Verified (7d)</p>
                            </div>
                            <div className="rounded-lg border p-3 text-center">
                                <p className="text-lg font-bold text-red-600">{company.freshness.staleClaims}</p>
                                <p className="text-muted-foreground">Stale ({'>'}30d)</p>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function AnalysisPage() {
    const [data, setData] = useState<AnalysisData | null>(null);
    const [loading, setLoading] = useState(true);
    
    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch("/api/admin/analysis");
            if (res.ok) {
                const json = await res.json();
                setData(json);
            }
        } catch {
            // silent
        } finally {
            setLoading(false);
        }
    }, []);
    
    useEffect(() => {
        fetchData();
    }, [fetchData]);
    
    // Sort companies by health score (lowest first = needs attention)
    const sortedCompanies = data?.companies?.slice().sort((a, b) => a.healthScore - b.healthScore) || [];
    
    // Alerts
    const alerts: Array<{ company: string; message: string; severity: 'warning' | 'error' }> = [];
    for (const c of sortedCompanies) {
        if (c.healthScore < 30) {
            alerts.push({ company: c.companyName, message: `Very low health score (${c.healthScore})`, severity: 'error' });
        }
        if (c.freshness.staleClaims > 10) {
            alerts.push({ company: c.companyName, message: `${c.freshness.staleClaims} stale claims (>30 days)`, severity: 'warning' });
        }
        if (c.conflicts.pendingCount > 5) {
            alerts.push({ company: c.companyName, message: `${c.conflicts.pendingCount} unresolved conflicts`, severity: 'warning' });
        }
    }
    
    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                    <Link href="/admin" className="text-muted-foreground hover:text-foreground transition-colors">
                        <ArrowLeft className="h-4 w-4" />
                    </Link>
                    <div>
                        <h1 className="text-2xl font-bold">System Analysis</h1>
                        <p className="text-sm text-muted-foreground mt-0.5">
                            Per-company health metrics and system performance
                        </p>
                    </div>
                </div>
                <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
                    {loading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                    Refresh
                </Button>
            </div>
            
            {loading && !data && (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
            )}
            
            {data && (
                <>
                    {/* Overview cards */}
                    <div className="grid grid-cols-4 gap-4 mb-8">
                        <StatCard label="Companies" value={data.overview.totalCompanies} icon={Users} />
                        <StatCard label="Documents" value={data.overview.totalDocuments} icon={Database} />
                        <StatCard label="KB Pages" value={data.overview.totalPages} icon={FileText} />
                        <StatCard label="Claims" value={data.overview.totalClaims} icon={Shield} />
                    </div>
                    
                    {/* Alerts */}
                    {alerts.length > 0 && (
                        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4 mb-6 space-y-2">
                            <h3 className="text-sm font-semibold flex items-center gap-1.5 text-yellow-800">
                                <AlertTriangle className="h-4 w-4" />
                                Alerts ({alerts.length})
                            </h3>
                            {alerts.map((alert, i) => (
                                <p key={i} className={`text-xs ${alert.severity === 'error' ? 'text-red-700' : 'text-yellow-700'}`}>
                                    <span className="font-medium">{alert.company}:</span> {alert.message}
                                </p>
                            ))}
                        </div>
                    )}
                    
                    {/* Per-company accordions */}
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                            Per-Company Metrics
                        </h2>
                        {sortedCompanies.map(company => (
                            <CompanyAccordion key={company.projectId} company={company} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
