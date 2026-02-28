import { randomUUID } from "crypto";
import { kb2GraphNodesCollection } from "@/lib/mongodb";
import {
  ENTITY_PAGE_TEMPLATES,
  STANDARD_HUMAN_PAGES,
} from "@/src/entities/models/kb2-templates";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

export interface EntityPagePlan {
  page_id: string;
  node_id: string;
  node_type: string;
  display_name: string;
  has_template: boolean;
}

export interface HumanPagePlan {
  page_id: string;
  category: string;
  layer: string;
  title: string;
  description: string;
  related_entity_types: string[];
}

export interface PagePlanArtifact {
  entity_pages: EntityPagePlan[];
  human_pages: HumanPagePlan[];
  total_pages: number;
}

export const pagePlanStep: StepFunction = async (ctx) => {
  const nodes = (await kb2GraphNodesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  if (nodes.length === 0) throw new Error("No graph nodes found — run step 3 first");

  ctx.onProgress(`Planning pages for ${nodes.length} entities...`, 10);

  const entityPlans: EntityPagePlan[] = nodes.map((node) => ({
    page_id: randomUUID(),
    node_id: node.node_id,
    node_type: node.type,
    display_name: node.display_name,
    has_template: node.type in ENTITY_PAGE_TEMPLATES,
  }));

  ctx.onProgress("Planning human concept pages...", 60);

  const humanPlans: HumanPagePlan[] = STANDARD_HUMAN_PAGES.map((hp) => ({
    page_id: randomUUID(),
    category: hp.category,
    layer: hp.layer,
    title: hp.title,
    description: hp.description,
    related_entity_types: hp.relatedEntityTypes,
  }));

  const artifact: PagePlanArtifact = {
    entity_pages: entityPlans,
    human_pages: humanPlans,
    total_pages: entityPlans.length + humanPlans.length,
  };

  ctx.onProgress(`Planned ${artifact.total_pages} pages (${entityPlans.length} entity + ${humanPlans.length} human)`, 100);
  return artifact;
};
