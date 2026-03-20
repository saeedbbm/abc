import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getCrossCheckModel, getCrossCheckModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const VALID_PROJECT_STATUS = new Set(["active", "completed", "proposed"]);
const VALID_PROCESS_STATUS = new Set(["active", "deprecated", "proposed", "informal"]);
const VALID_DOC_LEVEL = new Set(["documented", "undocumented"]);

function computeSourceCoverage(sourceTypes: Set<string>) {
  const hasConfluence = sourceTypes.has("confluence");
  let level: "documented" | "undocumented" = hasConfluence ? "documented" : "undocumented";
  const parts: string[] = [];
  if (hasConfluence) parts.push("confluence");
  if (sourceTypes.has("jira")) parts.push("jira");
  if (sourceTypes.has("github")) parts.push("github");
  if (sourceTypes.has("slack")) parts.push("slack");
  if (sourceTypes.has("customer_feedback") || sourceTypes.has("webform")) parts.push("feedback");
  return { level, reason: `Sources: ${parts.join(", ") || "none"}` };
}

const BATCH_SIZE = 12;

const DecidedBySchema = z.object({
  entities: z.array(z.object({
    display_name: z.string(),
    decided_by: z.string().optional(),
    rationale: z.string().optional(),
    scope: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: z.string(),
  })),
});

const StatusInferenceSchema = z.object({
  entities: z.array(z.object({
    display_name: z.string(),
    status: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: z.string(),
  })),
});

export const attributeCompletionStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-attribute-completion");
  const stepId = "pass1-step-9";
  const tc = getTenantCollections(ctx.companySlug);

  const step5ExecId = await ctx.getStepExecutionId("pass1", 5);
  const step5Filter = step5ExecId ? { execution_id: step5ExecId } : { run_id: ctx.runId };
  const step5Nodes = (await tc.graph_nodes.find(step5Filter).toArray()) as unknown as KB2GraphNodeType[];

  const step8ExecId = await ctx.getStepExecutionId("pass1", 8);
  const step8Filter = step8ExecId ? { execution_id: step8ExecId } : { run_id: ctx.runId, "attributes.discovery_category": { $exists: true } };
  const step8Nodes = (await tc.graph_nodes.find(step8Filter).toArray()) as unknown as KB2GraphNodeType[];

  const allNodes = [
    ...step5Nodes,
    ...step8Nodes.filter((n) => !step5Nodes.some((s5) => s5.node_id === n.node_id)),
  ];

  const clonedNodes = allNodes.map(({ _id, ...rest }: any) => ({
    ...rest,
    execution_id: ctx.executionId,
  }));
  if (clonedNodes.length > 0) {
    await tc.graph_nodes.insertMany(clonedNodes as any[]);
  }

  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  const docs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];

  await ctx.onProgress(`Processing ${allNodes.length} entities for attribute completion...`, 5);

  let descriptionsPromoted = 0;
  let statusesFilled = 0;
  let docLevelsFilled = 0;
  let decidedByFixed = 0;
  let rationalesFilled = 0;
  let llmCalls = 0;

  const bulkOps: any[] = [];

  // 1. Promote _description to description
  for (const node of allNodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    if (attrs._description && !attrs.description) {
      bulkOps.push({
        updateOne: {
          filter: { node_id: node.node_id, execution_id: ctx.executionId },
          update: { $set: { "attributes.description": attrs._description } },
        },
      });
      descriptionsPromoted++;
    }
  }

  if (bulkOps.length > 0) {
    await tc.graph_nodes.bulkWrite(bulkOps);
    bulkOps.length = 0;
  }
  await ctx.onProgress(`Promoted ${descriptionsPromoted} descriptions`, 15);

  // 2. Fill missing documentation_level
  for (const node of allNodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    if (!attrs.documentation_level || !VALID_DOC_LEVEL.has(attrs.documentation_level)) {
      const sourceTypes = new Set(node.source_refs.map((r) => r.source_type));
      const { level } = computeSourceCoverage(sourceTypes);
      bulkOps.push({
        updateOne: {
          filter: { node_id: node.node_id, execution_id: ctx.executionId },
          update: { $set: { "attributes.documentation_level": level } },
        },
      });
      docLevelsFilled++;
    }
  }

  if (bulkOps.length > 0) {
    await tc.graph_nodes.bulkWrite(bulkOps);
    bulkOps.length = 0;
  }
  await ctx.onProgress(`Filled ${docLevelsFilled} documentation levels`, 25);

  // 3. Fill missing status on project/process nodes via LLM
  const needsStatus = allNodes.filter((n) => {
    const attrs = (n.attributes ?? {}) as Record<string, any>;
    if (n.type === "project") return !attrs.status || !VALID_PROJECT_STATUS.has(attrs.status);
    if (n.type === "process") return !attrs.status || !VALID_PROCESS_STATUS.has(attrs.status);
    return false;
  });

  if (needsStatus.length > 0) {
    await ctx.onProgress(`Inferring status for ${needsStatus.length} entities via LLM...`, 30);
    const model = getCrossCheckModel(ctx.config?.pipeline_settings?.models);

    for (let i = 0; i < needsStatus.length; i += BATCH_SIZE) {
      if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
      const batch = needsStatus.slice(i, i + BATCH_SIZE);
      const entitiesText = batch.map((n, idx) => {
        const excerpts = n.source_refs
          .map((r) => `[${r.source_type}] ${r.title}: ${r.excerpt}`)
          .join("\n")
          .slice(0, 2000);
        return `${idx + 1}. "${n.display_name}" [${n.type}]\n${excerpts}`;
      }).join("\n\n---\n\n");

      const prompt = `Infer the status for these entities.\nFor projects: active, completed, or proposed.\nFor processes: active, deprecated, proposed, or informal.\n\n${entitiesText}`;

      try {
        const startMs = Date.now();
        let usageData: { promptTokens: number; completionTokens: number } | null = null;
        const result = await structuredGenerate({
          model,
          system: "You infer entity statuses from source excerpts. Be precise and evidence-based.",
          prompt,
          schema: StatusInferenceSchema,
          logger,
          onUsage: (u) => { usageData = u; },
          signal: ctx.signal,
        });
        llmCalls++;

        if (usageData) {
          const cost = calculateCostUsd(getCrossCheckModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
          ctx.logLLMCall(stepId, getCrossCheckModelName(ctx.config?.pipeline_settings?.models), prompt, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
        }

        const resultMap = new Map<string, (typeof result.entities)[number]>();
        for (const e of result.entities ?? []) resultMap.set(e.display_name.toLowerCase().trim(), e);

        for (const node of batch) {
          const inferred = resultMap.get(node.display_name.toLowerCase().trim());
          if (!inferred?.status) continue;
          const validSet = node.type === "process" ? VALID_PROCESS_STATUS : VALID_PROJECT_STATUS;
          if (!validSet.has(inferred.status)) continue;

          bulkOps.push({
            updateOne: {
              filter: { node_id: node.node_id, execution_id: ctx.executionId },
              update: { $set: { "attributes.status": inferred.status, "attributes._status_reasoning": inferred.reasoning } },
            },
          });
          statusesFilled++;
        }
      } catch (err) {
        logger.log(`Status inference batch failed (non-fatal): ${err}`);
      }
    }

    if (bulkOps.length > 0) {
      await tc.graph_nodes.bulkWrite(bulkOps);
      bulkOps.length = 0;
    }
    await ctx.onProgress(`Filled ${statusesFilled} statuses`, 50);
  }

  // 4. Fix decided_by, rationale, scope on decisions
  const decisions = allNodes.filter((n) => n.type === "decision");
  const needsDecisionFix = decisions.filter((n) => {
    const attrs = (n.attributes ?? {}) as Record<string, any>;
    return !attrs.decided_by || !attrs.rationale || !attrs.scope;
  });

  if (needsDecisionFix.length > 0) {
    await ctx.onProgress(`Fixing ${needsDecisionFix.length} decision attributes via LLM...`, 55);
    const model = getCrossCheckModel(ctx.config?.pipeline_settings?.models);

    for (let i = 0; i < needsDecisionFix.length; i += BATCH_SIZE) {
      if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
      const batch = needsDecisionFix.slice(i, i + BATCH_SIZE);
      const entitiesText = batch.map((n, idx) => {
        const attrs = (n.attributes ?? {}) as Record<string, any>;
        const missing: string[] = [];
        if (!attrs.decided_by) missing.push("decided_by");
        if (!attrs.rationale) missing.push("rationale");
        if (!attrs.scope) missing.push("scope");
        const excerpts = n.source_refs
          .map((r) => `[${r.source_type}] ${r.title}: ${r.excerpt}`)
          .join("\n")
          .slice(0, 2000);
        return `${idx + 1}. "${n.display_name}" — missing: ${missing.join(", ")}\n${excerpts}`;
      }).join("\n\n---\n\n");

      const prompt = `For each decision, infer missing attributes from source excerpts.\n- decided_by: Who MADE this decision? Not who mentioned or reviewed it.\n- rationale: Why was this decision made?\n- scope: Which project, feature, or area does it affect?\n\n${entitiesText}`;

      try {
        const startMs = Date.now();
        let usageData: { promptTokens: number; completionTokens: number } | null = null;
        const result = await structuredGenerate({
          model,
          system: "You infer decision attributes from source excerpts. Only fill fields with clear evidence.",
          prompt,
          schema: DecidedBySchema,
          logger,
          onUsage: (u) => { usageData = u; },
          signal: ctx.signal,
        });
        llmCalls++;

        if (usageData) {
          const cost = calculateCostUsd(getCrossCheckModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
          ctx.logLLMCall(stepId, getCrossCheckModelName(ctx.config?.pipeline_settings?.models), prompt, JSON.stringify(result, null, 2), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
        }

        const resultMap = new Map<string, (typeof result.entities)[number]>();
        for (const e of result.entities ?? []) resultMap.set(e.display_name.toLowerCase().trim(), e);

        for (const node of batch) {
          const inferred = resultMap.get(node.display_name.toLowerCase().trim());
          if (!inferred) continue;
          const attrs = (node.attributes ?? {}) as Record<string, any>;
          const patch: Record<string, any> = {};

          if (!attrs.decided_by && inferred.decided_by) {
            patch["attributes.decided_by"] = inferred.decided_by;
            decidedByFixed++;
          }
          if (!attrs.rationale && inferred.rationale) {
            patch["attributes.rationale"] = inferred.rationale;
            rationalesFilled++;
          }
          if (!attrs.scope && inferred.scope) {
            patch["attributes.scope"] = inferred.scope;
          }

          if (Object.keys(patch).length > 0) {
            bulkOps.push({
              updateOne: {
                filter: { node_id: node.node_id, execution_id: ctx.executionId },
                update: { $set: patch },
              },
            });
          }
        }
      } catch (err) {
        logger.log(`Decision attribute inference batch failed (non-fatal): ${err}`);
      }
    }

    if (bulkOps.length > 0) {
      await tc.graph_nodes.bulkWrite(bulkOps);
      bulkOps.length = 0;
    }
    await ctx.onProgress(`Fixed ${decidedByFixed} decided_by, ${rationalesFilled} rationales`, 80);
  }

  // 5. Ensure uniform public attributes per type
  const typeAttrs = new Map<string, Set<string>>();
  for (const node of allNodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    const pubKeys = Object.keys(attrs).filter((k) => !k.startsWith("_"));
    if (!typeAttrs.has(node.type)) typeAttrs.set(node.type, new Set());
    const set = typeAttrs.get(node.type)!;
    for (const k of pubKeys) set.add(k);
  }

  let uniformFills = 0;
  for (const node of allNodes) {
    const attrs = (node.attributes ?? {}) as Record<string, any>;
    const expectedKeys = typeAttrs.get(node.type);
    if (!expectedKeys) continue;
    const patch: Record<string, any> = {};
    for (const key of expectedKeys) {
      if (attrs[key] === undefined) {
        patch[`attributes.${key}`] = null;
        uniformFills++;
      }
    }
    if (Object.keys(patch).length > 0) {
      bulkOps.push({
        updateOne: {
          filter: { node_id: node.node_id, execution_id: ctx.executionId },
          update: { $set: patch },
        },
      });
    }
  }

  if (bulkOps.length > 0) {
    await tc.graph_nodes.bulkWrite(bulkOps);
  }
  await ctx.onProgress(`Attribute completion done`, 100);

  return {
    total_entities_processed: allNodes.length,
    descriptions_promoted: descriptionsPromoted,
    statuses_filled: statusesFilled,
    doc_levels_filled: docLevelsFilled,
    decided_by_fixed: decidedByFixed,
    rationales_filled: rationalesFilled,
    uniform_fills: uniformFills,
    llm_calls: llmCalls,
  };
};
