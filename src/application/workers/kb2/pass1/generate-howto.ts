import { randomUUID } from "crypto";
import { z } from "zod";
import { getTenantCollections } from "@/lib/mongodb";
import { getFastModel, getFastModelName, calculateCostUsd } from "@/lib/ai-model";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import type { KB2GraphNodeType, KB2GraphEdgeType, KB2EntityPageType } from "@/src/entities/models/kb2-types";
import { PrefixLogger } from "@/lib/utils";

const PROPOSED_TICKET_CATEGORIES = new Set([
  "proposed_ticket",
  "proposed_from_feedback",
]);

const DEFAULT_HOWTO_SECTIONS = [
  "Overview",
  "Context",
  "Requirements",
  "Implementation Steps",
  "Testing Plan",
  "Risks and Considerations",
  "Prompt Section",
];

const DEFAULT_GENERATE_HOWTO_SYSTEM = `You generate implementation guide documents for engineering tickets.
Each guide has sections that must be filled with specific, actionable content.

\${company_context}

Sections: \${howto_sections}

Rules:
- Overview: 2-3 sentences explaining what this ticket is about and why it matters.
- Context: What existing patterns, systems, and decisions are relevant. Reference specific entities.
- Requirements: What must be true when this is done. Acceptance criteria.
- Implementation Steps: Step-by-step how to build this. Reference specific files, patterns, libraries from the KB. Use code examples where helpful.
- Testing Plan: What tests to write. What edge cases to cover.
- Risks and Considerations: What could go wrong. What tradeoffs exist.
- Prompt Section: If an AI agent were implementing this, what prompt/instructions would you give it?

CRITICAL: Reference actual patterns and decisions discovered in the KB. Do NOT give generic advice.`;

const HowtoResultSchema = z.object({
  sections: z.array(z.object({
    section_name: z.string(),
    content: z.string(),
  })),
  linked_entity_ids: z.array(z.string()),
});

export const generateHowtoStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const logger = new PrefixLogger("kb2-generate-howto");
  const stepId = "pass1-step-16";

  const epExecId = await ctx.getStepExecutionId("pass1", 14);
  const epFilter = epExecId ? { execution_id: epExecId } : { run_id: ctx.runId };
  const entityPages = (await tc.entity_pages.find(epFilter).toArray()) as unknown as KB2EntityPageType[];
  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  const nodeExecIds = [step9ExecId, step10ExecId].filter(Boolean);
  const nodesFilter = nodeExecIds.length > 0
    ? { execution_id: { $in: nodeExecIds } }
    : { run_id: ctx.runId };
  const graphNodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  const edgesExecId = await ctx.getStepExecutionId("pass1", 6);
  const edgesFilter = edgesExecId ? { execution_id: edgesExecId } : { run_id: ctx.runId };
  const graphEdges = (await tc.graph_edges.find(edgesFilter).toArray()) as unknown as KB2GraphEdgeType[];
  for (const stepNum of [7, 11]) {
    const execId = await ctx.getStepExecutionId("pass1", stepNum);
    if (execId) {
      const extra = (await tc.graph_edges.find({ execution_id: execId }).toArray()) as unknown as KB2GraphEdgeType[];
      const edgeSet = new Set(graphEdges.map((e) => e.edge_id));
      for (const e of extra) { if (!edgeSet.has(e.edge_id)) graphEdges.push(e); }
    }
  }

  const proposedTicketNodes = graphNodes.filter((n) =>
    PROPOSED_TICKET_CATEGORIES.has(n.attributes?.discovery_category ?? ""),
  );

  if (proposedTicketNodes.length === 0) {
    await ctx.onProgress("No proposed tickets to generate how-tos for", 100);
    return { total_howtos: 0, llm_calls: 0 };
  }

  const entityPageByNodeId = new Map<string, KB2EntityPageType>();
  for (const ep of entityPages) {
    entityPageByNodeId.set(ep.node_id, ep);
  }

  const howtoSections =
    ctx.config?.pipeline_settings?.howto?.sections ?? DEFAULT_HOWTO_SECTIONS;
  const howtoSectionsStr = howtoSections.join(", ");

  let systemPrompt =
    ctx.config?.prompts?.generate_howto?.system ?? DEFAULT_GENERATE_HOWTO_SYSTEM;
  const companyContext = ctx.config?.profile?.company_context ?? "";
  systemPrompt = systemPrompt.replace(/\$\{company_context\}/g, companyContext);
  systemPrompt = systemPrompt.replace(/\$\{howto_sections\}/g, howtoSectionsStr);

  const model = getFastModel(ctx.config?.pipeline_settings?.models);
  const modelName = getFastModelName(ctx.config?.pipeline_settings?.models);
  let totalLLMCalls = 0;
  const howtoDocs: any[] = [];

  await ctx.onProgress(`Generating how-tos for ${proposedTicketNodes.length} proposed tickets...`, 5);

  for (let i = 0; i < proposedTicketNodes.length; i++) {
    if (ctx.signal.aborted) throw new Error("Pipeline cancelled by user");
    const node = proposedTicketNodes[i];

    const ticketEntityPage = entityPageByNodeId.get(node.node_id);
    const ticketInfo = ticketEntityPage
      ? ticketEntityPage.sections
          .map((s) =>
            `### ${s.section_name}\n${s.items.map((it) => `- ${it.text}`).join("\n")}`,
          )
          .join("\n\n")
      : [
          `Title: ${node.display_name}`,
          node.attributes?.description ? `Description: ${node.attributes.description}` : "",
          node.attributes?.priority ? `Priority: ${node.attributes.priority}` : "",
          node.attributes?.status ? `Status: ${node.attributes.status}` : "",
        ]
          .filter(Boolean)
          .join("\n");

    const relatedNodeIds = new Set<string>();
    for (const edge of graphEdges) {
      if (edge.source_node_id === node.node_id) relatedNodeIds.add(edge.target_node_id);
      if (edge.target_node_id === node.node_id) relatedNodeIds.add(edge.source_node_id);
    }
    relatedNodeIds.delete(node.node_id);

    const relatedPages = entityPages.filter((ep) => relatedNodeIds.has(ep.node_id));
    const relatedContext = relatedPages
      .map((ep) => {
        const sections = ep.sections
          .map((s) =>
            `### ${s.section_name}\n${s.items.map((it) => `- ${it.text}`).join("\n")}`,
          )
          .join("\n\n");
        return `## ${ep.title} [${ep.node_type}]\n${sections}`;
      })
      .join("\n\n");

    const userPrompt = `Generate an implementation guide for this proposed ticket:

## Ticket
${ticketInfo}

${relatedContext ? `## Related Entity Context (from knowledge base)\n${relatedContext}` : ""}`;

    const startMs = Date.now();
    let usageData: { promptTokens: number; completionTokens: number } | null = null;

    const result = await structuredGenerate({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      schema: HowtoResultSchema,
      logger,
      onUsage: (u) => { usageData = u; },
      signal: ctx.signal,
    });

    totalLLMCalls++;
    if (usageData) {
      const cost = calculateCostUsd(modelName, usageData.promptTokens, usageData.completionTokens);
      ctx.logLLMCall(
        stepId,
        modelName,
        `How-To: ${node.display_name}`,
        JSON.stringify(result.sections?.slice(0, 2)).slice(0, 5000),
        usageData.promptTokens,
        usageData.completionTokens,
        cost,
        Date.now() - startMs,
      );
    }

    const linkedEntityIds = [
      node.node_id,
      ...(result.linked_entity_ids ?? []).filter((id) => relatedNodeIds.has(id)),
    ];
    const uniqueLinked = [...new Set(linkedEntityIds)];

    const doc = {
      howto_id: randomUUID(),
      run_id: ctx.runId,
      execution_id: ctx.executionId,
      ticket_id: node.node_id,
      title: `How-To: ${node.display_name}`,
      sections: result.sections ?? [],
      linked_entity_ids: uniqueLinked,
      created_at: new Date().toISOString(),
    };
    howtoDocs.push(doc);

    if ((i + 1) % 3 === 0 || i === proposedTicketNodes.length - 1) {
      const pct = Math.round(5 + ((i + 1) / proposedTicketNodes.length) * 90);
      await ctx.onProgress(`Generated ${i + 1}/${proposedTicketNodes.length} how-tos`, pct);
    }
  }

  if (howtoDocs.length > 0) {
    await tc.howto.insertMany(howtoDocs);
  }

  await ctx.onProgress(`Generated ${howtoDocs.length} how-to guides`, 100);
  return { total_howtos: howtoDocs.length, llm_calls: totalLLMCalls };
};
