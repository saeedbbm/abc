import { z } from "zod";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { calculateCostUsd } from "@/lib/ai-model";
import { PrefixLogger } from "@/lib/utils";
import type { LogLLMCallFn } from "@/src/application/workers/kb2/pipeline-runner";

// ---- Types ----

export interface SubScore {
  name: string;
  score: number;
  max: number;
  reason: string;
}

export interface JudgeIssue {
  severity: "low" | "medium" | "high";
  message: string;
  entity: string | null;
}

export interface JudgeResult {
  [key: string]: unknown;
  overall_score: number;
  pass: boolean;
  sub_scores: SubScore[];
  issues: JudgeIssue[];
  recommendations: string[];
  go_no_go?: "go" | "no-go";
  blockers?: string[];
  rerun_from_step?: number | null;
  judge_model?: string;
  cross_check_model?: string;
  agreement_rate?: number;
  tokens_used?: number;
  cost_usd?: number;
  evaluated_at?: string;
  cross_check_details?: CrossCheckDetails;
  llm_judge_error?: string;
}

export interface CrossCheckDetails {
  primary_scores: Record<string, number>;
  cross_check_scores: Record<string, number>;
  agreements: number;
  disagreements: number;
  unique_primary_issues: string[];
  unique_cross_check_issues: string[];
  effectiveness: "useful" | "redundant" | "conflicting";
}

// ---- Schemas ----

const LLMJudgeResponseSchema = z.object({
  sub_scores: z.array(z.object({
    name: z.string(),
    score: z.number(),
    reason: z.string(),
  })),
  issues: z.array(z.object({
    severity: z.enum(["low", "medium", "high"]),
    message: z.string(),
    entity: z.string().nullable(),
  })),
  recommendations: z.array(z.string()),
  go_no_go: z.enum(["go", "no-go"]).optional(),
  blockers: z.array(z.string()).optional(),
  rerun_from_step: z.number().nullable().optional(),
});

type LLMJudgeResponse = z.infer<typeof LLMJudgeResponseSchema>;

function normalizeLLMResponse(raw: unknown): LLMJudgeResponse {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    sub_scores: Array.isArray(r.sub_scores)
      ? r.sub_scores.map((s: any) => ({
          name: String(s?.name ?? "Unknown"),
          score: Number(s?.score ?? 0),
          reason: String(s?.reason ?? ""),
        }))
      : [],
    issues: Array.isArray(r.issues)
      ? r.issues.map((i: any) => ({
          severity: (["low", "medium", "high"].includes(i?.severity) ? i.severity : "low") as "low" | "medium" | "high",
          message: String(i?.message ?? ""),
          entity: i?.entity != null ? String(i.entity) : null,
        }))
      : [],
    recommendations: Array.isArray(r.recommendations)
      ? r.recommendations.map((x: any) => String(x))
      : [],
    go_no_go: r.go_no_go === "go" || r.go_no_go === "no-go"
      ? r.go_no_go
      : undefined,
    blockers: Array.isArray(r.blockers)
      ? r.blockers.map((x: any) => String(x))
      : [],
    rerun_from_step:
      typeof r.rerun_from_step === "number" || r.rerun_from_step === null
        ? r.rerun_from_step as number | null
        : undefined,
  };
}

// ---- Deterministic Judge ----

export interface DeterministicCheck {
  name: string;
  actual: number;
  target: number;
  mode: "eq" | "gte" | "lte" | "within";
  weight?: number;
  tolerance?: number;
}

export function buildDeterministicJudge(
  checks: DeterministicCheck[],
  passingScore: number,
): JudgeResult {
  const sub_scores: SubScore[] = [];
  const issues: JudgeIssue[] = [];

  let weightedSum = 0;
  let totalWeight = 0;

  for (const check of checks) {
    const weight = check.weight ?? 1;
    totalWeight += weight;
    let score = 0;
    let reason = "";

    switch (check.mode) {
      case "eq":
        score = check.actual === check.target ? 100 : 0;
        reason = score === 100 ? `${check.actual} equals target ${check.target}` : `${check.actual} ≠ ${check.target}`;
        break;
      case "gte":
        score = check.actual >= check.target ? 100 : Math.round((check.actual / check.target) * 100);
        reason = `${check.actual} / ${check.target} target`;
        break;
      case "lte":
        score = check.actual <= check.target ? 100 : Math.max(0, Math.round((1 - (check.actual - check.target) / check.target) * 100));
        reason = check.actual <= check.target ? `${check.actual} ≤ ${check.target}` : `${check.actual} exceeds ${check.target}`;
        break;
      case "within": {
        const tol = check.tolerance ?? Math.round(check.target * 0.5);
        const lo = check.target - tol;
        const hi = check.target + tol;
        score = check.actual >= lo && check.actual <= hi ? 100 : 0;
        reason = score === 100 ? `${check.actual} within [${lo}, ${hi}]` : `${check.actual} outside [${lo}, ${hi}]`;
        break;
      }
    }

    score = Math.max(0, Math.min(100, score));
    weightedSum += score * weight;
    sub_scores.push({ name: check.name, score, max: 100, reason });

    if (score < 50) {
      issues.push({ severity: "high", message: `${check.name}: ${reason}`, entity: null });
    } else if (score < 80) {
      issues.push({ severity: "medium", message: `${check.name}: ${reason}`, entity: null });
    }
  }

  const overall_score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  return {
    overall_score,
    pass: overall_score >= passingScore,
    sub_scores,
    issues,
    recommendations: [],
    go_no_go: overall_score >= passingScore ? "go" : "no-go",
    blockers: issues.filter((issue) => issue.severity === "high").map((issue) => issue.message),
    rerun_from_step: null,
    evaluated_at: new Date().toISOString(),
  };
}

// ---- LLM Judge ----

export interface RunLLMJudgeOptions {
  model: Parameters<typeof structuredGenerate>[0]["model"];
  modelName: string;
  systemPrompt: string;
  userPrompt: string;
  crossCheckModel?: Parameters<typeof structuredGenerate>[0]["model"];
  crossCheckModelName?: string;
  logLLMCall: LogLLMCallFn;
  stepId: string;
  signal?: AbortSignal;
}

export async function runLLMJudge(opts: RunLLMJudgeOptions): Promise<JudgeResult> {
  const logger = new PrefixLogger("LLMJudge");
  let totalTokens = 0;
  let totalCost = 0;

  const start = Date.now();
  let primaryUsage: { promptTokens: number; completionTokens: number } | null = null;

  const rawPrimary = await structuredGenerate<LLMJudgeResponse>({
    model: opts.model,
    system: opts.systemPrompt,
    prompt: opts.userPrompt,
    schema: LLMJudgeResponseSchema,
    logger,
    onUsage: (usage) => {
      const cost = calculateCostUsd(opts.modelName, usage.promptTokens, usage.completionTokens);
      totalTokens += usage.promptTokens + usage.completionTokens;
      totalCost += cost;
      primaryUsage = usage;
    },
    signal: opts.signal,
  });
  const primaryResult = normalizeLLMResponse(rawPrimary);

  if (primaryUsage) {
    const u = primaryUsage;
    const cost = calculateCostUsd(opts.modelName, u.promptTokens, u.completionTokens);
    opts.logLLMCall(opts.stepId, opts.modelName, opts.userPrompt.slice(0, 2000), JSON.stringify(primaryResult).slice(0, 2000), u.promptTokens, u.completionTokens, cost, Date.now() - start);
  }

  const primaryScoreMap: Record<string, number> = {};
  for (const s of primaryResult.sub_scores) {
    primaryScoreMap[s.name] = s.score;
  }

  let crossCheckDetails: CrossCheckDetails | undefined;

  if (opts.crossCheckModel && opts.crossCheckModelName) {
    try {
      const ccStart = Date.now();
      let ccUsage: { promptTokens: number; completionTokens: number } | null = null;
      const rawCC = await structuredGenerate<LLMJudgeResponse>({
        model: opts.crossCheckModel,
        system: opts.systemPrompt,
        prompt: opts.userPrompt,
        schema: LLMJudgeResponseSchema,
        logger,
        onUsage: (usage) => {
          const cost = calculateCostUsd(opts.crossCheckModelName!, usage.promptTokens, usage.completionTokens);
          totalTokens += usage.promptTokens + usage.completionTokens;
          totalCost += cost;
          ccUsage = usage;
        },
        signal: opts.signal,
      });
      const ccResult = normalizeLLMResponse(rawCC);

      if (ccUsage) {
        const u = ccUsage as { promptTokens: number; completionTokens: number };
        const cost = calculateCostUsd(opts.crossCheckModelName!, u.promptTokens, u.completionTokens);
        opts.logLLMCall(opts.stepId, opts.crossCheckModelName!, opts.userPrompt.slice(0, 2000), JSON.stringify(ccResult).slice(0, 2000), u.promptTokens, u.completionTokens, cost, Date.now() - ccStart);
      }

      const ccScoreMap: Record<string, number> = {};
      for (const s of ccResult.sub_scores) {
        ccScoreMap[s.name] = s.score;
      }

      let agreements = 0;
      let disagreements = 0;
      const allKeys = new Set([...Object.keys(primaryScoreMap), ...Object.keys(ccScoreMap)]);
      for (const key of allKeys) {
        const p = primaryScoreMap[key] ?? 0;
        const c = ccScoreMap[key] ?? 0;
        if (Math.abs(p - c) <= 15) agreements++;
        else disagreements++;
      }

      const primaryIssueSet = new Set(primaryResult.issues.map((i) => i.message));
      const ccIssueSet = new Set(ccResult.issues.map((i) => i.message));
      const uniquePrimary = primaryResult.issues.filter((i) => !ccIssueSet.has(i.message)).map((i) => i.message);
      const uniqueCC = ccResult.issues.filter((i) => !primaryIssueSet.has(i.message)).map((i) => i.message);

      const effectiveness: CrossCheckDetails["effectiveness"] =
        disagreements === 0 && uniqueCC.length === 0
          ? "redundant"
          : disagreements > agreements
            ? "conflicting"
            : "useful";

      crossCheckDetails = {
        primary_scores: primaryScoreMap,
        cross_check_scores: ccScoreMap,
        agreements,
        disagreements,
        unique_primary_issues: uniquePrimary,
        unique_cross_check_issues: uniqueCC,
        effectiveness,
      };
    } catch (err) {
      logger.log(`Cross-check model failed (non-fatal): ${err}`);
    }
  }

  const primaryAvg = primaryResult.sub_scores.length > 0
    ? Math.round(primaryResult.sub_scores.reduce((sum, s) => sum + s.score, 0) / primaryResult.sub_scores.length)
    : 0;

  return {
    overall_score: primaryAvg,
    pass: primaryAvg >= 70,
    sub_scores: primaryResult.sub_scores.map((s) => ({ ...s, max: 100 })),
    issues: primaryResult.issues.map((issue) => ({
      severity: issue.severity,
      message: issue.message,
      entity: issue.entity ?? null,
    })),
    recommendations: primaryResult.recommendations,
    go_no_go: primaryResult.go_no_go ?? (primaryAvg >= 70 ? "go" : "no-go"),
    blockers: primaryResult.blockers,
    rerun_from_step: primaryResult.rerun_from_step,
    judge_model: opts.modelName,
    cross_check_model: opts.crossCheckModelName,
    agreement_rate: crossCheckDetails
      ? crossCheckDetails.agreements / Math.max(1, crossCheckDetails.agreements + crossCheckDetails.disagreements)
      : undefined,
    tokens_used: totalTokens,
    cost_usd: totalCost,
    evaluated_at: new Date().toISOString(),
    cross_check_details: crossCheckDetails,
  };
}

// ---- Merge ----

export function mergeJudgeResults(
  deterministic: JudgeResult,
  llm: JudgeResult,
  deterministicWeight: number,
): JudgeResult {
  const llmWeight = 100 - deterministicWeight;
  const overall_score = Math.round(
    (deterministic.overall_score * deterministicWeight + llm.overall_score * llmWeight) / 100,
  );
  const hasActionableBlock = (result: JudgeResult): boolean => {
    const blockerCount = (result.blockers ?? []).filter((item) => item.trim().length > 0).length;
    return (
      blockerCount > 0
      || typeof result.rerun_from_step === "number"
    );
  };
  const deterministicBlocks =
    (deterministic.go_no_go === "no-go" || deterministic.pass === false)
    && hasActionableBlock(deterministic);
  const llmBlocks =
    (llm.go_no_go === "no-go" || llm.pass === false)
    && hasActionableBlock(llm);
  const mergedGoNoGo: "go" | "no-go" =
    deterministicBlocks || llmBlocks || overall_score < 70 ? "no-go" : "go";
  const mergedPass = mergedGoNoGo === "go";

  return {
    overall_score,
    pass: mergedPass,
    sub_scores: [...deterministic.sub_scores, ...llm.sub_scores],
    issues: [...deterministic.issues, ...llm.issues],
    recommendations: [...deterministic.recommendations, ...llm.recommendations],
    go_no_go: mergedGoNoGo,
    blockers: [...(deterministic.blockers ?? []), ...(llm.blockers ?? [])],
    rerun_from_step: llm.rerun_from_step ?? deterministic.rerun_from_step ?? null,
    judge_model: llm.judge_model,
    cross_check_model: llm.cross_check_model,
    agreement_rate: llm.agreement_rate,
    tokens_used: llm.tokens_used,
    cost_usd: llm.cost_usd,
    evaluated_at: llm.evaluated_at,
    cross_check_details: llm.cross_check_details,
  };
}
