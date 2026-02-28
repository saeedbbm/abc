import { randomUUID } from "crypto";
import {
  kb2RunsCollection,
  kb2RunStepsCollection,
  kb2LLMCallsCollection,
} from "@/lib/mongodb";
import type { KB2RunType, KB2RunStepType } from "@/src/entities/models/kb2-types";

export type ProgressCallback = (detail: string, percent: number) => void;

export type LogLLMCallFn = (
  stepId: string,
  model: string,
  prompt: string,
  response: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  durationMs: number,
) => Promise<void>;

export interface StepContext {
  runId: string;
  companySlug: string;
  onProgress: ProgressCallback;
  logLLMCall: LogLLMCallFn;
  getStepArtifact: (pass: "pass1" | "pass2", stepNumber: number) => Promise<any>;
}

export type StepFunction = (ctx: StepContext) => Promise<any>;

interface StepDef {
  name: string;
  fn: StepFunction;
}

const pass1Steps: StepDef[] = [];
const pass2Steps: StepDef[] = [];

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

export interface RunOptions {
  companySlug: string;
  pass?: "pass1" | "pass2" | "all";
  step?: number;
  fromStep?: number;
  reuseRunId?: string;
  title?: string;
  onProgress?: ProgressCallback;
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
    parts.push(`Embedded ${a.total_chunks} chunks from ${a.total_docs ?? "?"} documents`);
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
  if (opts.fromStep !== undefined) {
    const stepDef = steps[opts.fromStep - 1];
    return `${passLabel} from Step ${opts.fromStep}: ${stepDef?.name ?? "Unknown"}`;
  }
  return passLabel;
}

export async function runPipeline(opts: RunOptions): Promise<KB2RunType> {
  const runId = opts.reuseRunId ?? randomUUID();
  const onProgress = opts.onProgress ?? (() => {});
  const title = generateRunTitle(opts, pass1Steps, pass2Steps);

  const logLLMCall: LogLLMCallFn = async (
    stepId, model, prompt, response, inputTokens, outputTokens, costUsd, durationMs,
  ) => {
    await kb2LLMCallsCollection.insertOne({
      call_id: randomUUID(),
      run_id: runId,
      step_id: stepId,
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

  const getStepArtifact = async (pass: "pass1" | "pass2", stepNumber: number): Promise<any> => {
    const stepDoc = await kb2RunStepsCollection.findOne({
      run_id: runId,
      pass,
      step_number: stepNumber,
    });
    return stepDoc?.artifact;
  };

  const ctx: StepContext = { runId, companySlug: opts.companySlug, onProgress, logLLMCall, getStepArtifact };

  await kb2RunsCollection.updateOne(
    { run_id: runId },
    {
      $set: {
        run_id: runId,
        company_slug: opts.companySlug,
        status: "running",
        title,
        started_at: new Date().toISOString(),
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
      }

      startIdx = Math.max(0, Math.min(startIdx, totalSteps));
      endIdx = Math.max(startIdx, Math.min(endIdx, totalSteps));

      await kb2RunsCollection.updateOne({ run_id: runId }, {
        $set: { current_pass: passKey, total_steps: totalSteps },
      });

      for (let i = startIdx; i < endIdx; i++) {
        const stepDef = steps[i];
        const stepId = `${passKey}-step-${i + 1}`;
        const stepNumber = i + 1;

        await kb2RunsCollection.updateOne({ run_id: runId }, { $set: { current_step: stepNumber } });

        const stepDoc: Partial<KB2RunStepType> = {
          step_id: stepId,
          run_id: runId,
          pass: passKey as "pass1" | "pass2",
          step_number: stepNumber,
          name: stepDef.name,
          status: "running",
          started_at: new Date().toISOString(),
        };

        await kb2RunStepsCollection.updateOne(
          { run_id: runId, step_id: stepId },
          { $set: stepDoc },
          { upsert: true },
        );

        onProgress(`[${passKey} Step ${stepNumber}/${totalSteps}] Starting: ${stepDef.name}`, 0);

        const stepStart = Date.now();
        try {
          const artifact = await stepDef.fn(ctx);
          const durationMs = Date.now() - stepStart;

          const llmCalls = await kb2LLMCallsCollection.countDocuments({ run_id: runId, step_id: stepId });
          const llmAgg = await kb2LLMCallsCollection.aggregate([
            { $match: { run_id: runId, step_id: stepId } },
            { $group: { _id: null, tokens_in: { $sum: "$input_tokens" }, tokens_out: { $sum: "$output_tokens" }, cost: { $sum: "$cost_usd" } } },
          ]).toArray();
          const agg = llmAgg[0] || { tokens_in: 0, tokens_out: 0, cost: 0 };

          await kb2RunStepsCollection.updateOne(
            { run_id: runId, step_id: stepId },
            {
              $set: {
                status: "completed",
                completed_at: new Date().toISOString(),
                duration_ms: durationMs,
                summary: generateStepSummary(stepDef.name, artifact),
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

          onProgress(
            `[${passKey} Step ${stepNumber}/${totalSteps}] Completed: ${stepDef.name} (${(durationMs / 1000).toFixed(1)}s)`,
            Math.round((stepNumber / totalSteps) * 100),
          );
        } catch (err: any) {
          await kb2RunStepsCollection.updateOne(
            { run_id: runId, step_id: stepId },
            { $set: { status: "failed", completed_at: new Date().toISOString(), duration_ms: Date.now() - stepStart, summary: err.message } },
          );
          throw err;
        }
      }
    }

    await kb2RunsCollection.updateOne({ run_id: runId }, {
      $set: { status: "completed", completed_at: new Date().toISOString() },
      $unset: { error: "" },
    });
  } catch (err: any) {
    await kb2RunsCollection.updateOne({ run_id: runId }, {
      $set: { status: "failed", completed_at: new Date().toISOString(), error: err.message },
    });
  }

  const finalRun = await kb2RunsCollection.findOne({ run_id: runId });
  return finalRun as unknown as KB2RunType;
}
