import { randomUUID } from "crypto";
import { getTenantCollections } from "@/lib/mongodb";
import {
  ENTITY_PAGE_TEMPLATES,
  STANDARD_HUMAN_PAGES,
} from "@/src/entities/models/kb2-templates";
import { getHumanPages } from "@/src/application/lib/kb2/company-config";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";

export const PROJECT_CATEGORIES = new Set([
  "past_documented",
  "past_undocumented",
  "ongoing_documented",
  "ongoing_undocumented",
  "proposed_projects",
]);

export function classifyProjectCategory(node: KB2GraphNodeType): string | null {
  if (node.type !== "project") return null;
  const disc = node.attributes?.discovery_category ?? "";
  const status = (node.attributes?.status ?? "").toLowerCase();
  const docLevel = (node.attributes?.documentation_level ?? "").toLowerCase();
  const isDone = ["done", "completed", "closed", "past"].some((s) => status.includes(s));
  const isProposed = status === "proposed" || status === "planned";
  const isUndocumented = docLevel === "undocumented";

  if (disc === "proposed_project" || isProposed) return "proposed_projects";
  if (disc === "past_undocumented") return "past_undocumented";
  if (disc === "ongoing_undocumented") return "ongoing_undocumented";

  if (isDone) {
    if (isUndocumented || node.truth_status === "inferred") return "past_undocumented";
    return "past_documented";
  }

  if (isUndocumented || node.truth_status === "inferred") return "ongoing_undocumented";
  if (node.truth_status === "direct") return "ongoing_documented";

  return docLevel === "documented" ? "ongoing_documented" : "ongoing_undocumented";
}

const TICKET_DISCOVERY_CATEGORIES = new Set([
  "proposed_ticket",
  "proposed_from_feedback",
]);

function isProposedTicketNode(node: KB2GraphNodeType): boolean {
  const cat = node.attributes?.discovery_category;
  return (
    (node.type === "ticket" || node.type === "customer_feedback") &&
    TICKET_DISCOVERY_CATEGORIES.has(cat)
  );
}

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
  ticket_sync: { synced: number; skipped: number };
}

/**
 * Sync ticket-type graph nodes into the kb2_tickets collection so they
 * appear on the Tickets/Kanban page. Covers both Jira-imported tickets
 * (truth_status=direct) and pipeline-discovered proposed tickets.
 */
export async function syncGraphNodesToTickets(
  nodes: KB2GraphNodeType[],
  runId: string,
  tc: ReturnType<typeof getTenantCollections>,
): Promise<{ synced: number; skipped: number }> {
  const ticketNodes = nodes.filter(
    (n) => n.type === "ticket" || isProposedTicketNode(n),
  );
  if (ticketNodes.length === 0) return { synced: 0, skipped: 0 };

  const existing = await tc.tickets
    .find({ linked_entity_ids: { $in: ticketNodes.map((n) => n.node_id) } })
    .toArray();
  const existingNodeIds = new Set(
    existing.flatMap((t: any) => t.linked_entity_ids ?? []),
  );

  const toInsert: any[] = [];
  let skipped = 0;

  for (const node of ticketNodes) {
    if (existingNodeIds.has(node.node_id)) {
      skipped++;
      continue;
    }

    const cat = node.attributes?.discovery_category ?? "";
    let source: string;
    if (node.truth_status === "direct") source = "jira";
    else if (cat === "proposed_from_feedback") source = "feedback";
    else source = "conversation";

    const jiraStatus = (node.attributes?.status ?? "").toLowerCase();
    const isDone =
      node.truth_status === "direct" &&
      ["done", "closed", "resolved"].some((s) => jiraStatus.includes(s));

    toInsert.push({
      ticket_id: randomUUID(),
      run_id: runId,
      source,
      title: node.display_name,
      description: node.attributes?.description ?? "",
      assignees: [],
      status: "open",
      priority: node.attributes?.priority ?? "P2",
      workflow_state: isDone ? "done" : "backlog",
      linked_entity_ids: [node.node_id],
      created_at: new Date().toISOString(),
    });
  }

  if (toInsert.length > 0) {
    await tc.tickets.insertMany(toInsert);
  }

  return { synced: toInsert.length, skipped };
}

export const pagePlanStep: StepFunction = async (ctx) => {
  const tc = getTenantCollections(ctx.companySlug);
  const step9ExecId = await ctx.getStepExecutionId("pass1", 9);
  const nodesFilter = step9ExecId ? { execution_id: step9ExecId } : { run_id: ctx.runId };
  const nodes = (await tc.graph_nodes.find(nodesFilter).toArray()) as unknown as KB2GraphNodeType[];

  const existingIds = new Set(nodes.map((n) => n.node_id));
  const step10ExecId = await ctx.getStepExecutionId("pass1", 10);
  if (step10ExecId) {
    const step10Nodes = (await tc.graph_nodes.find({ execution_id: step10ExecId }).toArray()) as unknown as KB2GraphNodeType[];
    for (const n of step10Nodes) { if (!existingIds.has(n.node_id)) { nodes.push(n); existingIds.add(n.node_id); } }
  }

  if (nodes.length === 0) throw new Error("No graph nodes found — run step 3 first");

  await ctx.onProgress(`Planning pages for ${nodes.length} entities...`, 10);

  const entityPlans: EntityPagePlan[] = nodes
    .filter((node) => !isProposedTicketNode(node))
    .map((node) => ({
      page_id: randomUUID(),
      node_id: node.node_id,
      node_type: node.type,
      display_name: node.display_name,
      has_template: node.type in ENTITY_PAGE_TEMPLATES,
    }));

  await ctx.onProgress("Planning human concept pages...", 50);

  const humanPageDefs = ctx.config
    ? await getHumanPages(ctx.companySlug)
    : STANDARD_HUMAN_PAGES;

  const humanPlans: HumanPagePlan[] = humanPageDefs
    .map((hp) => ({
      page_id: randomUUID(),
      category: hp.category,
      layer: hp.layer,
      title: hp.title,
      description: hp.description,
      related_entity_types: hp.relatedEntityTypes,
    }));

  await ctx.onProgress("Syncing ticket nodes to kb2_tickets...", 80);
  const ticketSync = await syncGraphNodesToTickets(nodes, ctx.runId, tc);

  const artifact: PagePlanArtifact = {
    entity_pages: entityPlans,
    human_pages: humanPlans,
    total_pages: entityPlans.length + humanPlans.length,
    ticket_sync: ticketSync,
  };

  await ctx.onProgress(
    `Planned ${artifact.total_pages} pages (${entityPlans.length} entity + ${humanPlans.length} human), synced ${ticketSync.synced} tickets`,
    100,
  );
  return artifact;
};
