import { embedMany } from "ai";
import { getTenantCollections } from "@/lib/mongodb";
import { getEmbeddingModel } from "@/lib/ai-model";
import { qdrantClient } from "@/lib/qdrant";
import type { KB2GraphNodeType, KB2GraphEdgeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import {
  PROJECT_CATEGORIES,
  classifyProjectCategory,
  type PagePlanArtifact,
  type EntityPagePlan,
  type HumanPagePlan,
} from "./page-plan";

const KB2_COLLECTION = "kb2_embeddings";

export interface RetrievalPack {
  page_id: string;
  page_type: "entity" | "human";
  title: string;
  graph_context: string[];
  doc_snippets: string[];
  vector_snippets: string[];
}

function getCriticalSamplePriority(
  plan: (EntityPagePlan & { page_type: "entity" }) | (HumanPagePlan & { page_type: "human" }),
  node?: KB2GraphNodeType,
): number {
  if (plan.page_type === "entity") {
    if (node?.attributes?.is_convention === true) return 100;
    if (plan.project_category === "proposed_projects") return 85;
    if (plan.project_category === "past_undocumented" || plan.project_category === "ongoing_undocumented") return 75;
    if (node?.type === "repository") return 65;
    return 40;
  }

  if (plan.category === "hidden_conventions") return 95;
  if (plan.category === "proposed_projects") return 90;
  if (plan.category === "past_undocumented" || plan.category === "ongoing_undocumented") return 80;
  if (PROJECT_CATEGORIES.has(plan.category)) return 70;
  if (plan.category === "company_overview") return 60;
  return 30;
}

export const graphragRetrievalStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const TOP_K = ctx.config?.pipeline_settings?.graphrag?.vector_top_k ?? 10;
  const DOC_SNIPPET_LENGTH = ctx.config?.pipeline_settings?.graphrag?.doc_snippet_length ?? 500;
  const DOC_SNIPPETS_LIMIT = ctx.config?.pipeline_settings?.graphrag?.doc_snippets_limit ?? 10;
  const NEIGHBOR_EDGES_LIMIT = ctx.config?.pipeline_settings?.graphrag?.neighbor_edges_limit ?? 20;
  const RELATED_NODES_LIMIT = ctx.config?.pipeline_settings?.graphrag?.related_nodes_limit ?? 15;

  const planArtifact = (await ctx.getStepArtifact("pass1", 12)) as PagePlanArtifact | undefined;
  if (!planArtifact) throw new Error("No page plan found — run step 12 first");

  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const nodesFilter = step9ExecId ? { execution_id: step9ExecId } : { run_id: ctx.runId };
  const nodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];
  const existingNodeIds = new Set(nodes.map((n) => n.node_id));
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  if (step10ExecId) {
    const extra = (await tc.graph_nodes.find({ execution_id: step10ExecId }).toArray()) as unknown as KB2GraphNodeType[];
    for (const n of extra) { if (!existingNodeIds.has(n.node_id)) { nodes.push(n); existingNodeIds.add(n.node_id); } }
  }
  const edgesExecId = await ctx.getStepExecutionId("pass1", 6);
  const edgesFilter = edgesExecId ? { execution_id: edgesExecId } : { run_id: ctx.runId };
  const edges = (await tc.graph_edges.find(edgesFilter).toArray()) as unknown as KB2GraphEdgeType[];
  for (const stepNum of [7, 11]) {
    const execId = await ctx.getStepExecutionId("pass1", stepNum);
    if (execId) {
      const extra = (await tc.graph_edges.find({ execution_id: execId }).toArray()) as unknown as KB2GraphEdgeType[];
      const edgeSet = new Set(edges.map((e) => e.edge_id));
      for (const e of extra) { if (!edgeSet.has(e.edge_id)) edges.push(e); }
    }
  }
  const snapshotExecId = await ctx.getStepExecutionId("pass1", 1);
  const snapshot = await tc.input_snapshots.findOne(
    snapshotExecId ? { execution_id: snapshotExecId } : { run_id: ctx.runId },
  );
  const docs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];

  const nodeById = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) nodeById.set(node.node_id, node);

  const embeddingModel = getEmbeddingModel();
  const packs: RetrievalPack[] = [];
  const criticalPackSamples: Array<{
    priority: number;
    title: string;
    page_type: "entity" | "human";
    graph_context: string[];
    doc_snippets: string[];
    vector_snippets: string[];
  }> = [];
  const allPlans = [
    ...planArtifact.entity_pages.map((p) => ({ ...p, page_type: "entity" as const })),
    ...planArtifact.human_pages.map((p) => ({ ...p, page_type: "human" as const })),
  ];

  await ctx.onProgress(`Retrieving context for ${allPlans.length} pages...`, 5);

  for (let idx = 0; idx < allPlans.length; idx++) {
    const plan = allPlans[idx];
    const graphContext: string[] = [];
    const docSnippets: string[] = [];
    const vectorSnippets: string[] = [];
    const seenDocSnippets = new Set<string>();
    const pushDocSnippet = (snippet: string) => {
      const normalized = snippet.trim();
      if (!normalized || seenDocSnippets.has(normalized)) return;
      seenDocSnippets.add(normalized);
      docSnippets.push(normalized);
    };
    let isCriticalPage = false;

    if (plan.page_type === "entity") {
      const ep = plan as EntityPagePlan & { page_type: "entity" };
      const node = nodeById.get(ep.node_id);
      if (node) {
        isCriticalPage =
          node.attributes?.is_convention === true ||
          ["proposed_projects", "past_undocumented", "ongoing_undocumented"].includes(ep.project_category ?? "");

        graphContext.push(`Entity: ${node.display_name} [${node.type}]`);
        if (node.aliases.length > 0) graphContext.push(`Aliases: ${node.aliases.join(", ")}`);

        for (const ref of node.source_refs.slice(0, DOC_SNIPPETS_LIMIT)) {
          if (ref.excerpt?.trim()) {
            pushDocSnippet(`[${ref.source_type}] ${ref.title}: ${ref.excerpt}`);
            continue;
          }

          const matchedDoc = docs.find(
            (doc) => doc.id === ref.doc_id || doc.sourceId === ref.doc_id || doc.title === ref.title,
          );
          if (matchedDoc) {
            pushDocSnippet(
              `[${matchedDoc.provider}] ${matchedDoc.title}: ${matchedDoc.content.slice(0, DOC_SNIPPET_LENGTH)}`,
            );
          }
        }

        const neighborEdges = edges.filter(
          (e) => e.source_node_id === node.node_id || e.target_node_id === node.node_id,
        );
        for (const edge of neighborEdges.slice(0, NEIGHBOR_EDGES_LIMIT)) {
          const otherId = edge.source_node_id === node.node_id ? edge.target_node_id : edge.source_node_id;
          const other = nodeById.get(otherId);
          if (other) {
            graphContext.push(`  --[${edge.type}]--> ${other.display_name} [${other.type}]`);
          }
        }

        const expandedConventionIds = new Set<string>();
        if (node.attributes?.is_convention === true) {
          expandedConventionIds.add(node.node_id);
          gatherConventionMultiHop(node, edges, nodeById, graphContext, docs, docSnippets, DOC_SNIPPET_LENGTH);
        }
        for (const edge of neighborEdges) {
          const otherId = edge.source_node_id === node.node_id ? edge.target_node_id : edge.source_node_id;
          const other = nodeById.get(otherId);
          if (!other || other.attributes?.is_convention !== true || expandedConventionIds.has(other.node_id)) continue;
          graphContext.push(`  Convention path via: ${other.display_name} [${other.type}]`);
          gatherConventionMultiHop(other, edges, nodeById, graphContext, docs, docSnippets, DOC_SNIPPET_LENGTH);
          expandedConventionIds.add(other.node_id);
        }

        const searchNames = [node.display_name, ...node.aliases.slice(0, 2)];
        for (const doc of docs) {
          const contentLower = doc.content.toLowerCase();
          if (searchNames.some((n) => contentLower.includes(n.toLowerCase()))) {
            pushDocSnippet(`[${doc.provider}] ${doc.title}: ${doc.content.slice(0, DOC_SNIPPET_LENGTH)}`);
          }
        }
      }
    } else {
      const hp = plan as HumanPagePlan & { page_type: "human" };
      isCriticalPage = hp.category === "hidden_conventions" || PROJECT_CATEGORIES.has(hp.category);
      graphContext.push(`Human Page: ${hp.title} (${hp.layer})`);
      graphContext.push(`Description: ${hp.description}`);

      let relatedNodes = nodes.filter((n) =>
        hp.related_entity_types.includes(n.type),
      );

      if (PROJECT_CATEGORIES.has(hp.category)) {
        relatedNodes = relatedNodes.filter(
          (node) => node.type !== "project" || classifyProjectCategory(node) === hp.category,
        );
      }

      if (hp.category === "hidden_conventions") {
        relatedNodes = relatedNodes.filter(
          (node) => node.type === "team_member" || node.attributes?.is_convention === true,
        );
      }

      for (const rn of relatedNodes.slice(0, RELATED_NODES_LIMIT)) {
        graphContext.push(`  Related: ${rn.display_name} [${rn.type}]`);
        const ref = rn.source_refs[0];
        if (ref?.excerpt?.trim()) {
          pushDocSnippet(`[${ref.source_type}] ${ref.title}: ${ref.excerpt}`);
        }
      }
    }

    const queryText = plan.page_type === "entity"
      ? `${(plan as EntityPagePlan).display_name} technical reference`
      : `${(plan as HumanPagePlan).title} ${(plan as HumanPagePlan).description}`;

    try {
      const { embeddings } = await embedMany({
        model: embeddingModel,
        values: [queryText],
      });

      const searchResult = await qdrantClient.search(KB2_COLLECTION, {
        vector: embeddings[0],
        limit: TOP_K,
        filter: { must: [{ key: "run_id", match: { value: ctx.runId } }] },
      });

      for (const hit of searchResult) {
        const payload = hit.payload as Record<string, any>;
        vectorSnippets.push(`[score=${hit.score.toFixed(3)}] ${payload.title}: ${payload.text}`);
      }
    } catch {
      // Qdrant might not be available; proceed without vector results
    }

    packs.push({
      page_id: plan.page_id,
      page_type: plan.page_type,
      title: plan.page_type === "entity"
        ? (plan as EntityPagePlan).display_name
        : (plan as HumanPagePlan).title,
      graph_context: graphContext,
      doc_snippets: docSnippets.slice(0, DOC_SNIPPETS_LIMIT),
      vector_snippets: vectorSnippets,
    });

    if (isCriticalPage) {
      criticalPackSamples.push({
        priority: getCriticalSamplePriority(plan, plan.page_type === "entity" ? nodeById.get((plan as EntityPagePlan).node_id) : undefined),
        title: plan.page_type === "entity"
          ? (plan as EntityPagePlan).display_name
          : (plan as HumanPagePlan).title,
        page_type: plan.page_type,
        graph_context: graphContext.slice(0, 12),
        doc_snippets: docSnippets.slice(0, 3),
        vector_snippets: vectorSnippets.slice(0, 3),
      });
    }

    if ((idx + 1) % 5 === 0 || idx === allPlans.length - 1) {
      const pct = Math.round(5 + ((idx + 1) / allPlans.length) * 90);
      await ctx.onProgress(`Retrieved context for ${idx + 1}/${allPlans.length} pages`, pct);
    }
  }

  await ctx.onProgress(`Retrieval complete for ${packs.length} pages`, 100);
  return {
    total_packs: packs.length,
    entity_packs: packs.filter((p) => p.page_type === "entity").length,
    human_packs: packs.filter((p) => p.page_type === "human").length,
    expected_total_packs: allPlans.length,
    critical_pack_samples: criticalPackSamples
      .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))
      .slice(0, 8)
      .map(({ priority: _priority, ...sample }) => sample),
    retrieval_packs: packs,
  };
};

function gatherConventionMultiHop(
  node: KB2GraphNodeType,
  edges: KB2GraphEdgeType[],
  nodeById: Map<string, KB2GraphNodeType>,
  graphContext: string[],
  docs: KB2ParsedDocument[],
  docSnippets: string[],
  snippetLength: number,
): void {
  const outEdges = edges.filter((e) => e.source_node_id === node.node_id);

  // Convention -> CONTAINS -> constituent decisions -> their source_refs
  const containsEdges = outEdges.filter((e) => e.type === "CONTAINS");
  for (const ce of containsEdges) {
    const decision = nodeById.get(ce.target_node_id);
    if (!decision) continue;
    graphContext.push(`  Convention constituent: ${decision.display_name} [${decision.type}]`);
    for (const ref of decision.source_refs.slice(0, 3)) {
      const doc = docs.find((d) => d.title === ref.title);
      if (doc) {
        docSnippets.push(`[convention-decision-source] ${doc.title}: ${doc.content.slice(0, snippetLength)}`);
      }
    }
  }

  // Convention -> PROPOSED_BY -> team member -> related work
  const proposedByEdges = outEdges.filter((e) => e.type === "PROPOSED_BY");
  for (const pe of proposedByEdges) {
    const member = nodeById.get(pe.target_node_id);
    if (!member) continue;
    graphContext.push(`  Established by: ${member.display_name} [${member.type}]`);
    const memberWork = edges.filter(
      (e) => e.source_node_id === member.node_id && e.source_node_id !== node.node_id,
    );
    for (const mw of memberWork.slice(0, 5)) {
      const related = nodeById.get(mw.target_node_id);
      if (related) {
        graphContext.push(`    Related work: ${related.display_name} [${related.type}]`);
      }
    }
  }

  // Convention -> APPLIES_TO -> features -> feature context
  const appliesToEdges = outEdges.filter((e) => e.type === "APPLIES_TO");
  for (const ae of appliesToEdges) {
    const feature = nodeById.get(ae.target_node_id);
    if (!feature) continue;
    graphContext.push(`  Applies to: ${feature.display_name} [${feature.type}]`);
    if (feature.attributes?.description) {
      graphContext.push(`    Context: ${feature.attributes.description}`);
    }
  }
}
