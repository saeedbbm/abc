import { randomUUID } from "crypto";
import {
  kb2RunsCollection,
  kb2RunStepsCollection,
  kb2LLMCallsCollection,
  getTenantCollections,
} from "@/lib/mongodb";
import type { KB2RunType, KB2RunStepType } from "@/src/entities/models/kb2-types";
import type { CompanyConfigData } from "@/src/entities/models/kb2-company-config";
import { getCompanyConfig, getActiveConfigVersion } from "@/src/application/lib/kb2/company-config";
import { evaluateStep } from "@/src/application/lib/kb2/step-judge-configs";
import { publishRunAsBaseline } from "@/src/application/lib/kb2/demo-state";

export type ProgressCallback = (detail: string, percent: number, stepPercent?: number, stepId?: string) => void | Promise<void>;

export type LogLLMCallFn = (
  stepId: string,
  model: string,
  prompt: string,
  response: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  durationMs: number,
  callId?: string,
) => Promise<void>;

export interface StepContext {
  runId: string;
  executionId: string;
  companySlug: string;
  configVersion: number | null;
  config: CompanyConfigData | null;
  onProgress: ProgressCallback;
  logLLMCall: LogLLMCallFn;
  getStepArtifact: (pass: "pass1" | "pass2", stepNumber: number) => Promise<any>;
  getStepExecutionId: (pass: "pass1" | "pass2", stepNumber: number) => Promise<string | null>;
  persistJudgeResult: (judgeResult: Record<string, unknown>) => Promise<void>;
  signal: AbortSignal;
}

export type StepFunction = (ctx: StepContext) => Promise<any>;

interface StepDef {
  name: string;
  fn: StepFunction;
}

const pass1Steps: StepDef[] = [];
const pass2Steps: StepDef[] = [];

const runningPipelines = new Set<string>();
const pipelineAbortControllers = new Map<string, AbortController>();

export function cancelPipeline(companySlug: string): boolean {
  const ctrl = pipelineAbortControllers.get(companySlug);
  if (ctrl) {
    ctrl.abort();
    return true;
  }
  return false;
}

export function registerPass1Step(name: string, fn: StepFunction) {
  pass1Steps.push({ name, fn });
}

export function registerPass2Step(name: string, fn: StepFunction) {
  pass2Steps.push({ name, fn });
}

export function getPass1Steps(): { name: string; index: number }[] {
  return pass1Steps.map((s, i) => ({ name: s.name, index: i + 1 }));
}

export function getPass2Steps(): { name: string; index: number }[] {
  return pass2Steps.map((s, i) => ({ name: s.name, index: i + 1 }));
}

export type StepLifecycleCallback = (type: string, data: Record<string, unknown>) => void | Promise<void>;

export interface RunOptions {
  companySlug: string;
  pass?: "pass1" | "pass2" | "all";
  step?: number;
  fromStep?: number;
  toStep?: number;
  reuseRunId?: string;
  title?: string;
  onProgress?: ProgressCallback;
  onStepLifecycle?: StepLifecycleCallback;
}

function generateStepSummary(stepName: string, artifact: unknown): string {
  if (!artifact || typeof artifact !== "object") return String(artifact ?? "No output");
  const a = artifact as Record<string, unknown>;

  const parts: string[] = [];

  if (a.total_documents !== undefined) {
    parts.push(`Parsed ${a.total_documents} documents`);
    const byProvider = a.by_provider as Record<string, number> | undefined;
    if (byProvider) {
      const provs = Object.entries(byProvider).map(([k, v]) => `${k}: ${v}`).join(", ");
      parts.push(`(${provs})`);
    }
    return parts.join(" ");
  }

  if (a.total_entities !== undefined) {
    if (a.total_observations !== undefined) {
      return `Extracted ${a.total_observations} observations and ${a.total_entities} candidate entities`;
    }
    parts.push(`Extracted ${a.total_entities} unique entities`);
    if (a.llm_calls) parts.push(`using ${a.llm_calls} LLM calls`);
    const byType = a.entities_by_type as Record<string, unknown[]> | undefined;
    if (byType) {
      const top = Object.entries(byType)
        .sort((x, y) => y[1].length - x[1].length)
        .slice(0, 6)
        .map(([k, v]) => `${v.length} ${k.replace(/_/g, " ")}`)
        .join(", ");
      parts.push(`— ${top}`);
    }
    return parts.join(" ");
  }

  if (a.total_chunks !== undefined) {
    parts.push(`Embedded ${a.total_chunks} chunks from ${a.total_documents ?? a.total_docs ?? "?"} documents`);
    const byProvider = a.by_provider as Record<string, { docs?: number; chunks?: number; spans?: number }> | undefined;
    if (byProvider) {
      const provs = Object.entries(byProvider)
        .map(([k, v]) => `${k}: ${v.chunks ?? v.spans ?? "?"}`)
        .join(", ");
      parts.push(`(${provs})`);
    }
    return parts.join(" ");
  }

  if (a.nodes_created !== undefined || a.edges_created !== undefined) {
    if (a.nodes_created) parts.push(`${a.nodes_created} nodes created`);
    if (a.edges_created) parts.push(`${a.edges_created} edges created`);
    return parts.join(", ");
  }

  if (a.new_edges !== undefined && a.added_edges !== undefined) {
    parts.push(`Discovered +${a.new_edges} relationships across ${a.total_nodes} entities`);
    return parts.join(", ");
  }

  if (a.pattern_candidates !== undefined) {
    const candidates = Array.isArray(a.pattern_candidates) ? a.pattern_candidates.length : 0;
    parts.push(`Mined ${candidates} pattern candidates from ${a.total_nodes ?? "?"} observations`);
    return parts.join(", ");
  }

  if (a.original_count !== undefined && a.final_count !== undefined && a.recovery_details !== undefined) {
    const gap = (a.final_count as number) - (a.original_count as number);
    parts.push(`Validated ${a.original_count} entities, recovered +${gap}`);
    parts.push(`(${a.opus_confirmed} confirmed, ${a.opus_rejected} rejected)`);
    return parts.join(" ");
  }

  if (a.total_entities_before !== undefined && a.merges_performed !== undefined) {
    parts.push(`Resolved ${a.total_entities_before} → ${a.total_entities_after} entities`);
    parts.push(`(${a.merges_performed} merges from ${a.candidates_found} candidates)`);
    return parts.join(" ");
  }

  if (a.total_edges !== undefined) {
    parts.push(`Built graph with ${a.total_edges} edges`);
    if (a.mentioned_in_edges) parts.push(`(${a.mentioned_in_edges} mentions, ${a.relationship_edges} relationships)`);
    return parts.join(" ");
  }

  if (a.entity_pages !== undefined && a.human_pages !== undefined) {
    const ep = a.entity_pages as unknown[];
    const hp = a.human_pages as unknown[];
    parts.push(`Planned ${a.total_pages} pages (${ep.length} entity + ${hp.length} human)`);
    return parts.join(" ");
  }

  if (a.total_pages !== undefined) {
    parts.push(`Generated ${a.total_pages} pages`);
    if (a.llm_calls) parts.push(`using ${a.llm_calls} LLM calls`);
    return parts.join(" ");
  }

  if (a.total_claims !== undefined) {
    parts.push(`Extracted ${a.total_claims} claims`);
    if (a.llm_calls) parts.push(`using ${a.llm_calls} LLM calls`);
    return parts.join(" ");
  }

  if (a.total_discoveries !== undefined) {
    parts.push(`Discovered ${a.total_discoveries} new items`);
    if (a.llm_calls) parts.push(`using ${a.llm_calls} LLM calls`);
    const byCat = a.by_category as Record<string, number> | undefined;
    if (byCat) {
      const cats = Object.entries(byCat).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ");
      parts.push(`— ${cats}`);
    }
    return parts.join(" ");
  }

  if (a.total_cards !== undefined) {
    parts.push(`Created ${a.total_cards} verification cards`);
    return parts.join(" ");
  }

  if (a.total_entities_processed !== undefined && a.descriptions_promoted !== undefined) {
    parts.push(`Completed attributes for ${a.total_entities_processed} entities`);
    parts.push(`(${a.descriptions_promoted} descriptions, ${a.statuses_filled} statuses, ${a.decided_by_fixed} decided_by)`);
    return parts.join(" ");
  }

  if (a.conventions_found !== undefined && a.total_decisions_analyzed !== undefined) {
    parts.push(`Found ${a.conventions_found} cross-cutting conventions from ${a.total_decisions_analyzed} decisions`);
    return parts.join(" ");
  }

  if (a.total_new_edges !== undefined && a.discovery_edges_added !== undefined) {
    parts.push(`Added ${a.total_new_edges} edges (${a.discovery_edges_added} discovery, ${a.convention_edges_added} convention, ${a.applies_to_edges_added} applies-to)`);
    const qa = (a.traversal_qa as { summary?: { full_pass?: number; checked?: number } } | undefined)?.summary;
    if (qa && qa.checked !== undefined) {
      parts.push(`Traversal QA ${qa.full_pass ?? 0}/${qa.checked}`);
    }
    return parts.join(" ");
  }

  const keys = Object.keys(a);
  const summary = keys.slice(0, 5).map((k) => {
    const v = a[k];
    if (typeof v === "number" || typeof v === "string") return `${k}: ${v}`;
    if (Array.isArray(v)) return `${k}: ${v.length} items`;
    return `${k}: [object]`;
  }).join(", ");
  return summary || stepName;
}

function generateRunTitle(opts: RunOptions, pass1Steps: StepDef[], pass2Steps: StepDef[]): string {
  if (opts.title) return opts.title;
  const passLabel = opts.pass === "all" || !opts.pass ? "Full Pipeline" : opts.pass === "pass1" ? "Pass 1" : "Pass 2";
  const steps = opts.pass === "pass2" ? pass2Steps : pass1Steps;
  if (opts.step !== undefined) {
    const stepDef = steps[opts.step - 1];
    return `${passLabel} → Step ${opts.step}: ${stepDef?.name ?? "Unknown"}`;
  }
  if (opts.fromStep !== undefined && opts.toStep !== undefined) {
    const fromDef = steps[opts.fromStep - 1];
    const toDef = steps[opts.toStep - 1];
    return `${passLabel} Steps ${opts.fromStep}–${opts.toStep}: ${fromDef?.name ?? "?"} → ${toDef?.name ?? "?"}`;
  }
  if (opts.fromStep !== undefined) {
    const stepDef = steps[opts.fromStep - 1];
    return `${passLabel} from Step ${opts.fromStep}: ${stepDef?.name ?? "Unknown"}`;
  }
  if (opts.toStep !== undefined) {
    const toDef = steps[opts.toStep - 1];
    return `${passLabel} Steps 1–${opts.toStep}: through ${toDef?.name ?? "Unknown"}`;
  }
  return passLabel;
}

export async function runPipeline(opts: RunOptions): Promise<KB2RunType> {
  if (runningPipelines.has(opts.companySlug)) {
    throw new Error(`Pipeline already running for ${opts.companySlug}. Wait for it to finish or cancel it.`);
  }
  runningPipelines.add(opts.companySlug);
  const abortCtrl = new AbortController();
  pipelineAbortControllers.set(opts.companySlug, abortCtrl);

  try {
    const tc = getTenantCollections(opts.companySlug);
    const runId = opts.reuseRunId ?? randomUUID();
    const onProgress = opts.onProgress ?? (() => {});
    const onStepLifecycle = opts.onStepLifecycle ?? (() => {});
    const title = generateRunTitle(opts, pass1Steps, pass2Steps);

    const getStepArtifact = async (pass: "pass1" | "pass2", stepNumber: number): Promise<any> => {
      const stepDoc = await tc.run_steps.findOne(
        { run_id: runId, pass, step_number: stepNumber, status: "completed" },
        { sort: { execution_number: -1 } },
      );
      return stepDoc?.artifact;
    };

    const getStepExecutionId = async (pass: "pass1" | "pass2", stepNumber: number): Promise<string | null> => {
      const stepDoc = await tc.run_steps.findOne(
        { run_id: runId, pass, step_number: stepNumber, status: "completed" },
        { sort: { execution_number: -1 } },
      );
      return stepDoc?.execution_id ?? null;
    };

    const config = await getCompanyConfig(opts.companySlug);
    const configVersion = await getActiveConfigVersion(opts.companySlug);

    let currentExecutionId = "";
    const logLLMCall: LogLLMCallFn = async (
      stepId, model, prompt, response, inputTokens, outputTokens, costUsd, durationMs, callId?,
    ) => {
      await tc.llm_calls.insertOne({
        call_id: callId ?? randomUUID(),
        run_id: runId,
        step_id: stepId,
        execution_id: currentExecutionId,
        model,
        prompt: prompt.slice(0, 50000),
        response: response.slice(0, 50000),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        duration_ms: durationMs,
        timestamp: new Date().toISOString(),
      });
    };

    const persistingOnProgress: ProgressCallback = async (detail, percent, stepPercent?, stepId?) => {
      await onProgress(detail, percent, stepPercent, stepId);
      if (currentExecutionId) {
        await tc.run_steps.updateOne(
          { execution_id: currentExecutionId },
          { $push: { progress_log: { detail, percent, step_percent: stepPercent ?? percent, ts: new Date().toISOString() } } as any },
        );
      }
    };

    const persistJudgeResult = async (judgeResult: Record<string, unknown>) => {
      if (!currentExecutionId) return;
      await tc.run_steps.updateOne(
        { execution_id: currentExecutionId },
        { $set: { judge_result: judgeResult } },
      );
    };

    const ctx: StepContext = {
      runId,
      executionId: currentExecutionId,
      companySlug: opts.companySlug,
      configVersion,
      config,
      onProgress: persistingOnProgress,
      logLLMCall,
      getStepArtifact,
      getStepExecutionId,
      persistJudgeResult,
      signal: abortCtrl.signal,
    };

    await tc.runs.updateOne(
      { run_id: runId },
      {
        $set: {
          run_id: runId,
          company_slug: opts.companySlug,
          status: "running",
          title,
          started_at: new Date().toISOString(),
          config_version: configVersion,
          config_snapshot: config ? {
            models: config.pipeline_settings?.models,
            profile_name: config.profile?.company_name,
            se_context_preview: config.profile?.company_context?.slice(0, 200),
          } : null,
        },
        $setOnInsert: { stats: {} },
      },
      { upsert: true },
    );

    try {
      const passesToRun = opts.pass === "all" || !opts.pass ? ["pass1", "pass2"] : [opts.pass];

      for (const passKey of passesToRun) {
        const steps = passKey === "pass1" ? pass1Steps : pass2Steps;
        const totalSteps = steps.length;

        let startIdx = 0;
        let endIdx = totalSteps;

        if (opts.step !== undefined) {
          startIdx = opts.step - 1;
          endIdx = opts.step;
        } else if (opts.fromStep !== undefined) {
          startIdx = opts.fromStep - 1;
          if (opts.toStep !== undefined) {
            endIdx = opts.toStep;
          }
        } else if (opts.toStep !== undefined) {
          endIdx = opts.toStep;
        }

        startIdx = Math.max(0, Math.min(startIdx, totalSteps));
        endIdx = Math.max(startIdx, Math.min(endIdx, totalSteps));

        await tc.runs.updateOne({ run_id: runId }, {
          $set: { current_pass: passKey, total_steps: totalSteps },
        });

        for (let i = startIdx; i < endIdx; i++) {
          if (abortCtrl.signal.aborted) {
            throw new Error("Pipeline cancelled by user");
          }

          const stepDef = steps[i];
          const stepId = `${passKey}-step-${i + 1}`;
          const stepNumber = i + 1;

          await tc.runs.updateOne({ run_id: runId }, { $set: { current_step: stepNumber } });

          const executionId = randomUUID();
          currentExecutionId = executionId;
          (ctx as any).executionId = executionId;
          const executionNumber = (await tc.run_steps.countDocuments({ run_id: runId, step_id: stepId })) + 1;

          let parentExecutionId: string | null = null;
          if (i > 0) {
            const prevStepId = `${passKey}-step-${i}`;
            const prevExec = await tc.run_steps.findOne(
              { run_id: runId, step_id: prevStepId },
              { sort: { execution_number: -1 } },
            );
            parentExecutionId = prevExec?.execution_id ?? null;
          }

          await tc.run_steps.insertOne({
            step_id: stepId,
            run_id: runId,
            pass: passKey as "pass1" | "pass2",
            step_number: stepNumber,
            name: stepDef.name,
            status: "running",
            execution_id: executionId,
            execution_number: executionNumber,
            parent_execution_id: parentExecutionId,
            started_at: new Date().toISOString(),
          });

          const stepsToRun = endIdx - startIdx;
          const stepIdx = i - startIdx;
          const stepStartPct = Math.round((stepIdx / stepsToRun) * 100);
          const stepEndPct = Math.round(((stepIdx + 1) / stepsToRun) * 100);

          const stepOnProgress: ProgressCallback = async (detail, stepPercent) => {
            const globalPercent = stepStartPct + Math.round((stepPercent / 100) * (stepEndPct - stepStartPct));
            await persistingOnProgress(detail, globalPercent, stepPercent, stepId);
          };

          const prevOnProgress = ctx.onProgress;
          ctx.onProgress = stepOnProgress;

          await onProgress(`[${passKey} Step ${stepNumber}/${totalSteps}] Starting: ${stepDef.name}`, stepStartPct, undefined, stepId);
          await onStepLifecycle("step_started", {
            step_id: stepId, step_number: stepNumber, total_steps: totalSteps,
            step_name: stepDef.name, pass: passKey, started_at: new Date().toISOString(),
            steps_remaining: endIdx - (i + 1),
          });

          const stepStart = Date.now();
          try {
            const artifact = await stepDef.fn(ctx);
            const durationMs = Date.now() - stepStart;

            if (abortCtrl.signal.aborted) {
              throw new Error("Pipeline cancelled by user");
            }

            const llmCalls = await tc.llm_calls.countDocuments({ run_id: runId, step_id: stepId, execution_id: executionId });
            const llmAgg = await tc.llm_calls.aggregate([
              { $match: { run_id: runId, step_id: stepId, execution_id: executionId } },
              { $group: { _id: null, tokens_in: { $sum: "$input_tokens" }, tokens_out: { $sum: "$output_tokens" }, cost: { $sum: "$cost_usd" } } },
            ]).toArray();
            const agg = llmAgg[0] || { tokens_in: 0, tokens_out: 0, cost: 0 };

            const summary = generateStepSummary(stepDef.name, artifact);
            await tc.run_steps.updateOne(
              { execution_id: executionId },
              {
                $set: {
                  status: "completed",
                  completed_at: new Date().toISOString(),
                  duration_ms: durationMs,
                  summary,
                  artifact,
                  metrics: {
                    llm_calls: llmCalls,
                    input_tokens: agg.tokens_in,
                    output_tokens: agg.tokens_out,
                    cost_usd: agg.cost,
                  },
                },
              },
            );

            await onProgress(
              `[${passKey} Step ${stepNumber}/${totalSteps}] Completed: ${stepDef.name} (${(durationMs / 1000).toFixed(1)}s)`,
              stepEndPct,
              undefined,
              stepId,
            );
            await onStepLifecycle("step_completed", {
              step_id: stepId, step_number: stepNumber, total_steps: totalSteps,
              step_name: stepDef.name, pass: passKey, duration_ms: durationMs,
              summary, steps_remaining: endIdx - (i + 1),
              metrics: { llm_calls: llmCalls, input_tokens: agg.tokens_in, output_tokens: agg.tokens_out, cost_usd: agg.cost },
            });

            if (!abortCtrl.signal.aborted) {
              void (async () => {
                try {
                  console.log(`[pipeline] Running auto-judge for ${stepDef.name} (exec=${executionId})...`);
                  const judgeResult = await evaluateStep(opts.companySlug, executionId);
                  console.log(`[pipeline] Auto-judge completed for ${stepDef.name}: ${judgeResult.overall_score}% ${judgeResult.pass ? "PASS" : "FAIL"}`);
                } catch (judgeErr) {
                  console.error(`[pipeline] Judge failed for ${stepDef.name}: ${judgeErr}`);
                }
              })();
            }
          } catch (err: any) {
            const isCancelled = abortCtrl.signal.aborted || err.message?.includes("cancelled");
            const durationMs = Date.now() - stepStart;
            await tc.run_steps.updateOne(
              { execution_id: executionId },
              { $set: { status: isCancelled ? "cancelled" : "failed", completed_at: new Date().toISOString(), duration_ms: durationMs, summary: isCancelled ? "Cancelled by user" : err.message } },
            );
            await onStepLifecycle("step_failed", {
              step_id: stepId, step_number: stepNumber, total_steps: totalSteps,
              step_name: stepDef.name, pass: passKey, duration_ms: durationMs,
              error: isCancelled ? "Cancelled by user" : err.message,
              steps_remaining: endIdx - (i + 1),
            });
            throw err;
          } finally {
            ctx.onProgress = prevOnProgress;
          }
        }
      }

      await tc.runs.updateOne({ run_id: runId }, {
        $set: { status: "completed", completed_at: new Date().toISOString() },
        $unset: { error: "" },
      });
      await publishRunAsBaseline(tc, opts.companySlug, runId);
    } catch (err: any) {
      const isCancelled = abortCtrl.signal.aborted || err.message?.includes("cancelled");
      const status = isCancelled ? "cancelled" : "failed";
      await tc.runs.updateOne({ run_id: runId }, {
        $set: { status, completed_at: new Date().toISOString(), error: err.message },
      });
      if (isCancelled) {
        await onProgress("Pipeline cancelled by user", 100);
      }
    }

    const finalRun = await tc.runs.findOne({ run_id: runId });
    return finalRun as unknown as KB2RunType;
  } finally {
    runningPipelines.delete(opts.companySlug);
    pipelineAbortControllers.delete(opts.companySlug);
  }
}
