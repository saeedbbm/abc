import { embedMany } from "ai";
import { getTenantCollections } from "@/lib/mongodb";
import { getEmbeddingModel } from "@/lib/ai-model";
import { qdrantClient } from "@/lib/qdrant";
import type { KB2GraphNodeType, KB2GraphEdgeType } from "@/src/entities/models/kb2-types";
import type { KB2ParsedDocument } from "@/src/application/lib/kb2/confluence-parser";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import type { PagePlanArtifact, EntityPagePlan, HumanPagePlan } from "./page-plan";

const KB2_COLLECTION = "kb2_embeddings";

export interface RetrievalPack {
  page_id: string;
  page_type: "entity" | "human";
  title: string;
  graph_context: string[];
  doc_snippets: string[];
  vector_snippets: string[];
}

export const graphragRetrievalStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const TOP_K = ctx.config?.pipeline_settings?.graphrag?.vector_top_k ?? 10;

  const planArtifact = (await ctx.getStepArtifact("pass1", 9)) as PagePlanArtifact | undefined;
  if (!planArtifact) throw new Error("No page plan found — run step 9 first");

  const nodes = (await tc.graph_nodes.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  const edges = (await tc.graph_edges.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphEdgeType[];
  const snapshot = await tc.input_snapshots.findOne({ run_id: ctx.runId });
  const docs = (snapshot?.parsed_documents ?? []) as KB2ParsedDocument[];

  const nodeById = new Map<string, KB2GraphNodeType>();
  for (const node of nodes) nodeById.set(node.node_id, node);

  const embeddingModel = getEmbeddingModel();
  const packs: RetrievalPack[] = [];
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

    if (plan.page_type === "entity") {
      const ep = plan as EntityPagePlan & { page_type: "entity" };
      const node = nodeById.get(ep.node_id);
      if (node) {
        graphContext.push(`Entity: ${node.display_name} [${node.type}]`);
        if (node.aliases.length > 0) graphContext.push(`Aliases: ${node.aliases.join(", ")}`);

        const neighborEdges = edges.filter(
          (e) => e.source_node_id === node.node_id || e.target_node_id === node.node_id,
        );
        for (const edge of neighborEdges.slice(0, ctx.config?.pipeline_settings?.graphrag?.neighbor_edges_limit ?? 20)) {
          const otherId = edge.source_node_id === node.node_id ? edge.target_node_id : edge.source_node_id;
          const other = nodeById.get(otherId);
          if (other) {
            graphContext.push(`  --[${edge.type}]--> ${other.display_name} [${other.type}]`);
          }
        }

        const searchNames = [node.display_name, ...node.aliases.slice(0, 2)];
        for (const doc of docs) {
          const contentLower = doc.content.toLowerCase();
          if (searchNames.some((n) => contentLower.includes(n.toLowerCase()))) {
            docSnippets.push(`[${doc.provider}] ${doc.title}: ${doc.content.slice(0, ctx.config?.pipeline_settings?.graphrag?.doc_snippet_length ?? 500)}`);
          }
        }
      }
    } else {
      const hp = plan as HumanPagePlan & { page_type: "human" };
      graphContext.push(`Human Page: ${hp.title} (${hp.layer})`);
      graphContext.push(`Description: ${hp.description}`);

      const relatedNodes = nodes.filter((n) =>
        hp.related_entity_types.includes(n.type),
      );
      for (const rn of relatedNodes.slice(0, ctx.config?.pipeline_settings?.graphrag?.related_nodes_limit ?? 15)) {
        graphContext.push(`  Related: ${rn.display_name} [${rn.type}]`);
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
      doc_snippets: docSnippets.slice(0, ctx.config?.pipeline_settings?.graphrag?.doc_snippets_limit ?? 10),
      vector_snippets: vectorSnippets,
    });

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
    retrieval_packs: packs,
  };
};
