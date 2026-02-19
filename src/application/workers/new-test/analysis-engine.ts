import { z } from "zod";
import { getFastModel } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import { db } from "@/lib/mongodb";
import { structuredGenerate } from "@/src/application/workers/test/structured-generate";
import {
  KB_PAGE_TEMPLATES,
  type ScoreFormatOutputType,
  type ScoreFormatPageType,
  type AtomicItemType,
  type PMTicketType,
  type KBCategory,
} from "@/src/entities/models/score-format";

const logger = new PrefixLogger("analysis-engine");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  projectId: string;
  analyzedAt: string;
  metrics: {
    groundedness: GroundednessMetrics;
    completeness: CompletenessMetrics;
    coherence: CoherenceMetrics;
    decision_quality: DecisionQualityMetrics;
    reviewer_burden: ReviewerBurdenMetrics;
  };
}

interface GroundednessMetrics {
  overall: number;
  citation_coverage: number;
  evidence_sufficiency: number;
  suspicious_citations: string[];
}

interface CompletenessMetrics {
  overall: number;
  schema_compliance: number;
  atom_coverage: number;
  atom_diff: {
    missing: { text: string; severity: string }[];
    extra: { text: string }[];
    conflicting: { gt_text: string; gen_text: string }[];
  };
}

interface CoherenceMetrics {
  overall: number;
  duplicate_pages: string[];
  consistency_violations: string[];
  category_errors: string[];
}

interface DecisionQualityMetrics {
  overall: number;
  correct: number;
  mismatches: number;
  severity_penalty: number;
  top_mismatches: { item_text: string; expected: string; actual: string; severity: string }[];
}

interface ReviewerBurdenMetrics {
  overall: number;
  total_verify_items: number;
  verify_rate: number;
  people_count: number;
  per_person: { person: string; count: number; percent: number; hotspot: boolean }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAllItems(output: ScoreFormatOutputType): AtomicItemType[] {
  const items: AtomicItemType[] = [];
  for (const page of [...(output.kb_pages || []), ...(output.howto_pages || [])]) {
    for (const section of (page.sections || [])) {
      for (const bullet of (section.bullets || [])) {
        items.push(bullet);
      }
    }
  }
  return items;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

// ---------------------------------------------------------------------------
// 1. Groundedness
// ---------------------------------------------------------------------------

function computeGroundedness(generated: ScoreFormatOutputType): GroundednessMetrics {
  const items = getAllItems(generated);
  const nonTrivialTypes = ["fact", "decision", "conflict", "gap", "outdated", "ticket", "risk", "dependency"];
  const nonTrivial = items.filter(i => nonTrivialTypes.includes(i.item_type));

  if (nonTrivial.length === 0) {
    return { overall: 0, citation_coverage: 0, evidence_sufficiency: 0, suspicious_citations: [] };
  }

  const withCitation = nonTrivial.filter(i => (i.source_refs?.length || 0) > 0).length;
  const citation_coverage = withCitation / nonTrivial.length;

  const strongEvidence = nonTrivial.filter(i =>
    i.verification?.status === "verified_authoritative" ||
    i.verification?.status === "supported_multi_source" ||
    i.verification?.status === "verified_human"
  ).length;
  const evidence_sufficiency = strongEvidence / nonTrivial.length;

  const overall = (citation_coverage * 0.6 + evidence_sufficiency * 0.4);

  const suspicious: string[] = [];
  for (const item of nonTrivial) {
    if ((item.source_refs?.length || 0) > 0 && item.confidence_bucket === "low") {
      suspicious.push(`"${truncate(item.item_text, 80)}" — has citations but low confidence`);
    }
  }

  return { overall, citation_coverage, evidence_sufficiency, suspicious_citations: suspicious.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// 2. Completeness & Structure
// ---------------------------------------------------------------------------

function computeSchemaCompliance(generated: ScoreFormatOutputType): number {
  const pages = generated.kb_pages || [];
  if (pages.length === 0) return 0;

  let totalRequired = 0;
  let totalPresent = 0;

  for (const page of pages) {
    const template = KB_PAGE_TEMPLATES[page.category as KBCategory];
    if (!template) continue;

    totalRequired += template.length;
    const sectionNames = new Set(page.sections.map(s => s.section_name.toLowerCase()));
    for (const required of template) {
      if (sectionNames.has(required.toLowerCase()) ||
          [...sectionNames].some(s => s.includes(required.toLowerCase().split(" ")[0]))) {
        totalPresent++;
      }
    }
  }

  return totalRequired > 0 ? totalPresent / totalRequired : 0;
}

async function computeAtomCoverage(
  generated: ScoreFormatOutputType,
  groundTruth: ScoreFormatOutputType,
): Promise<{ score: number; diff: CompletenessMetrics["atom_diff"] }> {
  const gtItems = getAllItems(groundTruth);
  const genItems = getAllItems(generated);

  if (gtItems.length === 0 && genItems.length === 0) {
    return { score: 1, diff: { missing: [], extra: [], conflicting: [] } };
  }

  if (gtItems.length === 0) {
    return { score: 0, diff: { missing: [], extra: genItems.map(i => ({ text: i.item_text })), conflicting: [] } };
  }

  const gtSummary = gtItems.slice(0, 100).map((item, i) =>
    `[GT-${i}] (${item.item_type}) ${truncate(item.item_text, 200)}`
  ).join("\n");

  const genSummary = genItems.slice(0, 100).map((item, i) =>
    `[GEN-${i}] (${item.item_type}) ${truncate(item.item_text, 200)}`
  ).join("\n");

  try {
    const result = await structuredGenerate({
      model: getFastModel(),
      schema: z.object({
        matched_count: z.number().describe("Number of GT items that have a matching generated item"),
        missing: z.array(z.object({
          gt_index: z.number(),
          text: z.string(),
          severity: z.string(),
        })).describe("GT items NOT found in generated output"),
        extra: z.array(z.object({
          gen_index: z.number(),
          text: z.string(),
        })).describe("Generated items that don't match any GT item (potential hallucinations or genuine insights)"),
        conflicting: z.array(z.object({
          gt_index: z.number(),
          gen_index: z.number(),
          gt_text: z.string(),
          gen_text: z.string(),
        })).describe("Items about the same topic but with contradicting content"),
      }),
      system: `You are comparing ground truth atomic items against generated items. Match by semantic meaning (same topic/entity/claim), not exact wording. An item is "matched" if the generated output covers the same fact/decision/issue.`,
      prompt: `Compare these item lists:

GROUND TRUTH (${gtItems.length} items):
${gtSummary}

GENERATED (${genItems.length} items):
${genSummary}

Identify matches, missing items, extra items, and conflicts.`,
      maxOutputTokens: 8192,
      logger,
    });

    const r = result as any;
    const matched = r.matched_count || 0;
    const score = gtItems.length > 0 ? matched / gtItems.length : 0;

    return {
      score,
      diff: {
        missing: (r.missing || []).map((m: any) => ({ text: m.text, severity: m.severity || "medium" })),
        extra: (r.extra || []).map((e: any) => ({ text: e.text })),
        conflicting: (r.conflicting || []).map((c: any) => ({ gt_text: c.gt_text, gen_text: c.gen_text })),
      },
    };
  } catch (err) {
    logger.log(`Atom coverage comparison failed: ${err}`);
    return { score: 0, diff: { missing: [], extra: [], conflicting: [] } };
  }
}

// ---------------------------------------------------------------------------
// 3. Coherence & Dedup
// ---------------------------------------------------------------------------

async function computeCoherence(generated: ScoreFormatOutputType): Promise<CoherenceMetrics> {
  const pages = generated.kb_pages || [];
  const duplicates: string[] = [];
  const violations: string[] = [];
  const categoryErrors: string[] = [];

  // Duplicate detection: pages with very similar titles
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i].title.toLowerCase();
      const b = pages[j].title.toLowerCase();
      if (a === b || a.includes(b) || b.includes(a)) {
        duplicates.push(`"${pages[i].title}" (${pages[i].category}) and "${pages[j].title}" (${pages[j].category})`);
      }
    }
  }

  // Category correctness: check obvious misplacements
  for (const page of pages) {
    const cat = page.category;
    const title = page.title.toLowerCase();
    if (cat === "processes" && (title.includes("project") || title.includes("migration"))) {
      categoryErrors.push(`"${page.title}" is in processes but looks like a project`);
    }
    if (cat === "past_documented" && page.sections.some(s =>
      s.bullets.some(b => b.item_type === "gap")
    )) {
      categoryErrors.push(`"${page.title}" is in past_documented but contains gap items — should be past_undocumented`);
    }
  }

  // Cross-page consistency: check owner references
  const ownerItems: { page: string; person: string; system: string }[] = [];
  for (const page of pages) {
    for (const section of page.sections) {
      for (const bullet of section.bullets) {
        if (bullet.item_type === "owner") {
          ownerItems.push({
            page: page.title,
            person: bullet.item_text,
            system: page.title,
          });
        }
      }
    }
  }

  const issueCount = duplicates.length + violations.length + categoryErrors.length;
  const maxIssues = Math.max(pages.length, 1);
  const overall = Math.max(0, 1 - (issueCount / maxIssues));

  return { overall, duplicate_pages: duplicates, consistency_violations: violations, category_errors: categoryErrors };
}

// ---------------------------------------------------------------------------
// 4. Decision Quality
// ---------------------------------------------------------------------------

async function computeDecisionQuality(
  generated: ScoreFormatOutputType,
  groundTruth: ScoreFormatOutputType,
): Promise<DecisionQualityMetrics> {
  const gtItems = getAllItems(groundTruth);
  const genItems = getAllItems(generated);

  if (gtItems.length === 0) {
    return { overall: 0, correct: 0, mismatches: 0, severity_penalty: 0, top_mismatches: [] };
  }

  const gtSummary = gtItems.slice(0, 80).map((item, i) =>
    `[GT-${i}] "${truncate(item.item_text, 150)}" → action: ${item.action_routing?.action ?? "unknown"} (${item.action_routing?.severity ?? "unknown"})`
  ).join("\n");

  const genSummary = genItems.slice(0, 80).map((item, i) =>
    `[GEN-${i}] "${truncate(item.item_text, 150)}" → action: ${item.action_routing?.action ?? "unknown"} (${item.action_routing?.severity ?? "unknown"})`
  ).join("\n");

  try {
    const result = await structuredGenerate({
      model: getFastModel(),
      schema: z.object({
        correct: z.number().describe("Number of items where generated routing matches GT routing"),
        mismatches: z.array(z.object({
          item_text: z.string(),
          expected: z.string(),
          actual: z.string(),
          severity: z.string(),
        })).describe("Items where routing differs between GT and generated"),
      }),
      system: `Compare action_routing decisions between ground truth and generated output. Two items match if they're about the same topic AND have the same action_routing.action. Focus on the routing decision, not the exact wording.`,
      prompt: `GROUND TRUTH ROUTING:
${gtSummary}

GENERATED ROUTING:
${genSummary}

Count correct matches and list mismatches.`,
      maxOutputTokens: 4096,
      logger,
    });

    const r = result as any;
    const correct = r.correct || 0;
    const mismatches = r.mismatches || [];

    const severityWeights: Record<string, number> = { S1: 4, S2: 2, S3: 1, S4: 0.5 };
    let severity_penalty = 0;
    for (const mm of mismatches) {
      severity_penalty += severityWeights[mm.severity] || 1;
    }

    const total = correct + mismatches.length;
    const overall = total > 0 ? correct / total : 0;

    return {
      overall,
      correct,
      mismatches: mismatches.length,
      severity_penalty,
      top_mismatches: mismatches.slice(0, 10),
    };
  } catch (err) {
    logger.log(`Decision quality analysis failed: ${err}`);
    return { overall: 0, correct: 0, mismatches: 0, severity_penalty: 0, top_mismatches: [] };
  }
}

// ---------------------------------------------------------------------------
// 5. Reviewer Burden
// ---------------------------------------------------------------------------

function computeReviewerBurden(generated: ScoreFormatOutputType): ReviewerBurdenMetrics {
  const items = getAllItems(generated);
  const total = items.length;
  const verifyItems = items.filter(i => i.verification?.status === "needs_verification");
  const totalVerify = verifyItems.length;

  const personCounts = new Map<string, number>();
  for (const item of verifyItems) {
    const person = item.verification?.verifier || "unassigned";
    personCounts.set(person, (personCounts.get(person) || 0) + 1);
  }

  const perPerson = [...personCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([person, count]) => ({
      person,
      count,
      percent: totalVerify > 0 ? Math.round((count / totalVerify) * 100) : 0,
      hotspot: totalVerify > 0 && (count / totalVerify) > 0.4,
    }));

  const verifyRate = total > 0 ? Math.round((totalVerify / total) * 100) : 0;
  const hasHotspot = perPerson.some(p => p.hotspot);
  const overall = verifyRate > 0 ? (hasHotspot ? 0.4 : verifyRate > 50 ? 0.5 : verifyRate > 30 ? 0.7 : 0.9) : 1;

  return {
    overall,
    total_verify_items: totalVerify,
    verify_rate: verifyRate,
    people_count: personCounts.size,
    per_person: perPerson,
  };
}

// ---------------------------------------------------------------------------
// Main Analysis
// ---------------------------------------------------------------------------

export async function runAnalysis(
  projectId: string,
  onProgress?: (detail: string, percent: number) => void,
): Promise<AnalysisResult> {
  const analysisStart = Date.now();
  logger.log(`Starting analysis for ${projectId}`);
  onProgress?.("[Analysis] Loading generated results and ground truth from database...", 80);

  const generatedDoc = await db.collection("new_test_results").findOne(
    { projectId }, { sort: { createdAt: -1 } },
  );
  const gtDoc = await db.collection("new_test_ground_truth").findOne(
    { projectId }, { sort: { createdAt: -1 } },
  );

  const generated: ScoreFormatOutputType = generatedDoc?.data || { kb_pages: [], conversation_tickets: [], feedback_tickets: [], howto_pages: [] };
  const groundTruth: ScoreFormatOutputType = gtDoc?.data || { kb_pages: [], conversation_tickets: [], feedback_tickets: [], howto_pages: [] };

  const genItems = getAllItems(generated);
  const gtItems = getAllItems(groundTruth);
  onProgress?.(`[Analysis] Loaded — Generated: ${generated.kb_pages?.length || 0} pages (${genItems.length} items), GT: ${groundTruth.kb_pages?.length || 0} pages (${gtItems.length} items)`, 82);

  // 1. Groundedness
  onProgress?.("[Analysis 1/5] Computing groundedness (citation coverage + evidence sufficiency)...", 84);
  const groundedness = computeGroundedness(generated);
  logger.log(`Groundedness: ${groundedness.overall.toFixed(2)} (citations: ${groundedness.citation_coverage.toFixed(2)}, evidence: ${groundedness.evidence_sufficiency.toFixed(2)})`);
  onProgress?.(`[Analysis 1/5] Groundedness: ${(groundedness.overall * 100).toFixed(1)}% — citations: ${(groundedness.citation_coverage * 100).toFixed(1)}%, evidence: ${(groundedness.evidence_sufficiency * 100).toFixed(1)}%`, 86);

  // 2. Completeness
  onProgress?.("[Analysis 2/5] Computing completeness — schema compliance check...", 87);
  const schema_compliance = computeSchemaCompliance(generated);
  onProgress?.(`[Analysis 2/5] Schema compliance: ${(schema_compliance * 100).toFixed(1)}% — now running atom coverage (LLM semantic comparison, may take 15-30s)...`, 88);
  const atomCoverage = await computeAtomCoverage(generated, groundTruth);
  const completeness: CompletenessMetrics = {
    overall: (schema_compliance * 0.4 + atomCoverage.score * 0.6),
    schema_compliance,
    atom_coverage: atomCoverage.score,
    atom_diff: atomCoverage.diff,
  };
  logger.log(`Completeness: ${completeness.overall.toFixed(2)} (schema: ${schema_compliance.toFixed(2)}, atom: ${atomCoverage.score.toFixed(2)})`);
  onProgress?.(`[Analysis 2/5] Completeness: ${(completeness.overall * 100).toFixed(1)}% — schema: ${(schema_compliance * 100).toFixed(1)}%, atom coverage: ${(atomCoverage.score * 100).toFixed(1)}% (missing: ${atomCoverage.diff.missing.length}, extra: ${atomCoverage.diff.extra.length}, conflicts: ${atomCoverage.diff.conflicting.length})`, 91);

  // 3. Coherence
  onProgress?.("[Analysis 3/5] Computing coherence (duplicate detection + cross-page consistency)...", 92);
  const coherence = await computeCoherence(generated);
  logger.log(`Coherence: ${coherence.overall.toFixed(2)} (dupes: ${coherence.duplicate_pages.length}, violations: ${coherence.consistency_violations.length}, cat errors: ${coherence.category_errors.length})`);
  onProgress?.(`[Analysis 3/5] Coherence: ${(coherence.overall * 100).toFixed(1)}% — ${coherence.duplicate_pages.length} duplicates, ${coherence.consistency_violations.length} violations, ${coherence.category_errors.length} category errors`, 94);

  // 4. Decision Quality
  onProgress?.("[Analysis 4/5] Computing decision quality — comparing routing decisions (LLM comparison, may take 15-30s)...", 95);
  const decision_quality = await computeDecisionQuality(generated, groundTruth);
  logger.log(`Decision Quality: ${decision_quality.overall.toFixed(2)} (correct: ${decision_quality.correct}, mismatches: ${decision_quality.mismatches}, penalty: ${decision_quality.severity_penalty.toFixed(1)})`);
  onProgress?.(`[Analysis 4/5] Decision Quality: ${(decision_quality.overall * 100).toFixed(1)}% — ${decision_quality.correct} correct, ${decision_quality.mismatches} mismatches, penalty: ${decision_quality.severity_penalty.toFixed(1)}`, 97);

  // 5. Reviewer Burden
  onProgress?.("[Analysis 5/5] Computing reviewer burden...", 98);
  const reviewer_burden = computeReviewerBurden(generated);
  logger.log(`Reviewer Burden: ${reviewer_burden.overall.toFixed(2)} (verify: ${reviewer_burden.total_verify_items}/${genItems.length}, rate: ${reviewer_burden.verify_rate}%)`);
  onProgress?.(`[Analysis 5/5] Reviewer Burden: ${reviewer_burden.total_verify_items} verify items (${reviewer_burden.verify_rate}% rate), ${reviewer_burden.people_count} people`, 99);

  const analysisElapsed = ((Date.now() - analysisStart) / 1000).toFixed(1);

  const result: AnalysisResult = {
    projectId,
    analyzedAt: new Date().toISOString(),
    metrics: {
      groundedness,
      completeness,
      coherence,
      decision_quality,
      reviewer_burden,
    },
  };

  await db.collection("new_test_analysis").insertOne(result);
  logger.log(`Analysis stored in ${analysisElapsed}s`);

  return result;
}
