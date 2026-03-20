import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getReasoningModel, getReasoningModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import { PrefixLogger } from "@/lib/utils";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

const ConventionSchema = z.object({
  conventions: z.array(z.object({
    convention_name: z.string(),
    summary: z.string(),
    pattern_rule: z.string(),
    established_by: z.string(),
    constituent_decisions: z.array(z.string()),
    combined_evidence: z.string(),
    source_documents: z.array(z.string()),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});

const PATTERN_SYNTHESIS_PROMPT = `You are analyzing a set of company decisions to identify CROSS-CUTTING CONVENTIONS —
recurring patterns where the same person or team makes the same TYPE of choice
across multiple features over time.

A convention is NOT a single decision. It is a PATTERN that appears when you look at
3+ decisions together and realize they follow the same rule.

Examples of what we're looking for:
- A designer who always uses the same color scheme (green = money, blue = navigation)
  across 5+ different pages over 2 years
- An architect who always recommends the same data-loading pattern (load-all for small
  lists) across 4+ PRs
- A developer who always uses the same layout approach (vertical sidebar for selection)
  across 3+ features

For each convention, provide:
- convention_name: A descriptive name (e.g. "Gender-Color and Money-Color UI Convention")
- summary: One paragraph describing the pattern
- pattern_rule: The generalizable rule (e.g. "Green CTAs for financial actions,
  blue for non-financial, pink/blue for gender indicators")
- established_by: Who consistently applies this pattern
- constituent_decisions: List of decision entity names that are instances of this convention
- combined_evidence: Key quotes from sources proving the pattern
- source_documents: List of source document titles where evidence appears
- confidence: high/medium/low

RULES:
- Only identify conventions backed by 3+ individual decisions.
- The constituent_decisions MUST use the exact display_name values from the provided decision entities.
- Do NOT create conventions for single decisions or unrelated groups.
- Focus on patterns that a new team member would need to know about.`;

export const patternSynthesisStep: StepFunction = async (ctx) => {
  const logger = new PrefixLogger("kb2-pattern-synthesis");
  const stepId = "pass1-step-10";
  const tc = getTenantCollections(ctx.companySlug);

  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step9Filter = step9ExecId ? { execution_id: step9ExecId } : { run_id: ctx.runId };
  const allNodes = (await tc.graph_nodes.find(step9Filter).toArray()) as unknown as KB2GraphNodeType[];

  const decisions = allNodes.filter((n) => n.type === "decision");

  if (decisions.length < 3) {
    await ctx.onProgress("Not enough decisions to analyze for patterns", 100);
    return { conventions_found: 0, total_decisions_analyzed: decisions.length, llm_calls: 0, conventions: [] };
  }

  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  const docs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];

  await ctx.onProgress(`Analyzing ${decisions.length} decisions for cross-cutting conventions...`, 10);

  const decisionsText = decisions.map((d) => {
    const attrs = (d.attributes ?? {}) as Record<string, any>;
    const excerpts = d.source_refs
      .map((r) => `  [${r.source_type}] ${r.title}: ${r.excerpt}`)
      .join("\n");
    const attrLines: string[] = [];
    if (attrs.decided_by) attrLines.push(`decided_by: ${attrs.decided_by}`);
    if (attrs.scope) attrLines.push(`scope: ${attrs.scope}`);
    if (attrs.rationale) attrLines.push(`rationale: ${attrs.rationale}`);
    return `- "${d.display_name}"${attrLines.length > 0 ? ` {${attrLines.join(", ")}}` : ""}\n  Source excerpts:\n${excerpts}`;
  }).join("\n\n");

  const docContext = docs
    .slice(0, 20)
    .map((d) => `--- ${d.title} (${d.provider}) ---\n${d.content.slice(0, 1500)}`)
    .join("\n\n");

  const model = getReasoningModel(ctx.config?.pipeline_settings?.models);
  const prompt = `DECISIONS (${decisions.length} total):\n\n${decisionsText}\n\nSOURCE DOCUMENTS (for additional context):\n\n${docContext}`;

  const startMs = Date.now();
  let usageData: { promptTokens: number; completionTokens: number } | null = null;
  const result = await structuredGenerate({
    model,
    system: ctx.config?.prompts?.pattern_synthesis?.system ?? PATTERN_SYNTHESIS_PROMPT,
    prompt,
    schema: ConventionSchema,
    logger,
    onUsage: (u) => { usageData = u; },
    signal: ctx.signal,
  });
  let llmCalls = 1;

  if (usageData) {
    const cost = calculateCostUsd(getReasoningModelName(ctx.config?.pipeline_settings?.models), usageData.promptTokens, usageData.completionTokens);
    ctx.logLLMCall(stepId, getReasoningModelName(ctx.config?.pipeline_settings?.models), prompt.slice(0, 50000), JSON.stringify(result, null, 2).slice(0, 10000), usageData.promptTokens, usageData.completionTokens, cost, Date.now() - startMs);
  }

  const conventions = result.conventions ?? [];
  await ctx.onProgress(`Found ${conventions.length} conventions, creating entities...`, 70);

  const decisionsByName = new Map<string, KB2GraphNodeType>();
  for (const d of decisions) decisionsByName.set(d.display_name.toLowerCase().trim(), d);

  const conventionNodes: KB2GraphNodeType[] = [];
  for (const conv of conventions) {
    const combinedSourceRefs = conv.constituent_decisions
      .flatMap((name) => {
        const node = decisionsByName.get(name.toLowerCase().trim());
        return node?.source_refs ?? [];
      })
      .filter((r, i, arr) => arr.findIndex((x) => x.doc_id === r.doc_id) === i);

    const node: KB2GraphNodeType = {
      node_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      type: "decision",
      display_name: conv.convention_name,
      aliases: [],
      attributes: {
        is_convention: true,
        pattern_rule: conv.pattern_rule,
        summary: conv.summary,
        established_by: conv.established_by,
        constituent_decisions: conv.constituent_decisions,
        combined_evidence: conv.combined_evidence,
        status: "decided",
        documentation_level: "undocumented",
        description: conv.summary,
      },
      source_refs: combinedSourceRefs.slice(0, 20),
      truth_status: "inferred",
      confidence: conv.confidence as any,
    };
    conventionNodes.push(node);
  }

  if (conventionNodes.length > 0) {
    await tc.graph_nodes.insertMany(conventionNodes);
  }

  await ctx.onProgress(`Created ${conventionNodes.length} convention entities`, 100);
  return {
    conventions_found: conventionNodes.length,
    total_decisions_analyzed: decisions.length,
    llm_calls: llmCalls,
    conventions: conventions.map((c) => ({
      convention_name: c.convention_name,
      established_by: c.established_by,
      constituent_decisions: c.constituent_decisions,
      confidence: c.confidence,
    })),
  };
};
