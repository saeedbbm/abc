import { randomUUID } from "crypto";
import { kb2GraphNodesCollection, kb2TicketsCollection } from "@/lib/mongodb";
import {
  ENTITY_PAGE_TEMPLATES,
  STANDARD_HUMAN_PAGES,
} from "@/src/entities/models/kb2-templates";
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
  const isDone = ["done", "completed", "closed", "past"].some((s) => status.includes(s));

  if (disc === "proposed_project") return "proposed_projects";
  if (disc === "past_undocumented") return "past_undocumented";
  if (disc === "ongoing_undocumented") return "ongoing_undocumented";

  if (node.truth_status === "direct") {
    return isDone ? "past_documented" : "ongoing_documented";
  }
  if (node.truth_status === "inferred") {
    return isDone ? "past_undocumented" : "ongoing_undocumented";
  }
  return "ongoing_documented";
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
): Promise<{ synced: number; skipped: number }> {
  const ticketNodes = nodes.filter(
    (n) => n.type === "ticket" || isProposedTicketNode(n),
  );
  if (ticketNodes.length === 0) return { synced: 0, skipped: 0 };

  const existing = await kb2TicketsCollection
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
    await kb2TicketsCollection.insertMany(toInsert);
  }

  return { synced: toInsert.length, skipped };
}

async function linkTicketsProjectsHowtos(
  nodes: KB2GraphNodeType[],
  runId: string,
): Promise<{ linked: number }> {
  const { kb2TicketsCollection, kb2HowtoCollection } = await import("@/lib/mongodb");
  const { randomUUID } = await import("crypto");
  
  const tickets = await kb2TicketsCollection.find({ run_id: runId }).toArray();
  const projectNodes = nodes.filter((n) => n.type === "project");
  let linked = 0;

  for (const ticket of tickets) {
    const ticketNode = nodes.find((n) => (ticket as any).linked_entity_ids?.includes(n.node_id));
    if (!ticketNode) continue;
    
    const relatedEntities: string[] = ticketNode.attributes?.related_entities ?? [];
    let linkedProject = projectNodes.find((p) => 
      relatedEntities.some((re) => 
        p.display_name.toLowerCase().includes(re.toLowerCase()) || 
        re.toLowerCase().includes(p.display_name.toLowerCase())
      )
    );

    const cat = ticketNode.attributes?.discovery_category ?? "";
    const isProposed = ["proposed_ticket", "proposed_from_feedback"].includes(cat);
    
    if (!linkedProject && isProposed) {
      const newProjectNode: KB2GraphNodeType = {
        node_id: randomUUID(),
        run_id: runId,
        type: "project" as any,
        display_name: `Project: ${ticketNode.display_name}`,
        aliases: [],
        attributes: {
          discovery_category: "proposed_project",
          description: `Auto-linked project for ticket: ${ticketNode.display_name}`,
          related_entities: [ticketNode.display_name],
        },
        source_refs: ticketNode.source_refs ?? [],
        truth_status: "inferred" as any,
        confidence: "low" as any,
      };
      await kb2GraphNodesCollection.insertOne(newProjectNode);
      linkedProject = newProjectNode;
    }

    if (linkedProject) {
      await kb2TicketsCollection.updateOne(
        { ticket_id: (ticket as any).ticket_id },
        { $addToSet: { linked_entity_ids: linkedProject.node_id } },
      );

      if (isProposed) {
        const existingHowto = await kb2HowtoCollection.findOne({
          ticket_id: (ticket as any).ticket_id,
          run_id: runId,
        });
        if (!existingHowto) {
          await kb2HowtoCollection.insertOne({
            howto_id: randomUUID(),
            run_id: runId,
            ticket_id: (ticket as any).ticket_id,
            project_node_id: linkedProject.node_id,
            title: `How to: ${(ticket as any).title}`,
            sections: [
              { section_name: "Overview", content: "" },
              { section_name: "Context", content: "" },
              { section_name: "Requirements", content: "" },
              { section_name: "Implementation Steps", content: "" },
              { section_name: "Testing Plan", content: "" },
              { section_name: "Risks and Considerations", content: "" },
              { section_name: "Prompt Section", content: "" },
            ],
            linked_entity_ids: [linkedProject.node_id],
            created_at: new Date().toISOString(),
          });
          linked++;
        }
      }
    }
  }

  return { linked };
}

export const pagePlanStep: StepFunction = async (ctx) => {
  const nodes = (await kb2GraphNodesCollection.find({ run_id: ctx.runId }).toArray()) as unknown as KB2GraphNodeType[];
  if (nodes.length === 0) throw new Error("No graph nodes found — run step 3 first");

  ctx.onProgress(`Planning pages for ${nodes.length} entities...`, 10);

  const entityPlans: EntityPagePlan[] = nodes
    .filter((node) => !isProposedTicketNode(node))
    .map((node) => ({
      page_id: randomUUID(),
      node_id: node.node_id,
      node_type: node.type,
      display_name: node.display_name,
      has_template: node.type in ENTITY_PAGE_TEMPLATES,
    }));

  ctx.onProgress("Planning human concept pages...", 50);

  const projectNodes = nodes.filter((n) => n.type === "project");
  const populatedProjectCategories = new Set<string>();
  for (const pn of projectNodes) {
    const cat = classifyProjectCategory(pn);
    if (cat) populatedProjectCategories.add(cat);
  }

  const humanPlans: HumanPagePlan[] = STANDARD_HUMAN_PAGES
    .filter((hp) => {
      if (PROJECT_CATEGORIES.has(hp.category)) {
        return populatedProjectCategories.has(hp.category);
      }
      return true;
    })
    .map((hp) => ({
      page_id: randomUUID(),
      category: hp.category,
      layer: hp.layer,
      title: hp.title,
      description: hp.description,
      related_entity_types: hp.relatedEntityTypes,
    }));

  ctx.onProgress("Syncing ticket nodes to kb2_tickets...", 70);
  const ticketSync = await syncGraphNodesToTickets(nodes, ctx.runId);

  ctx.onProgress("Linking tickets, projects, and howto docs...", 85);
  const linkResult = await linkTicketsProjectsHowtos(nodes, ctx.runId);

  const artifact: PagePlanArtifact = {
    entity_pages: entityPlans,
    human_pages: humanPlans,
    total_pages: entityPlans.length + humanPlans.length,
    ticket_sync: ticketSync,
  };

  ctx.onProgress(
    `Planned ${artifact.total_pages} pages (${entityPlans.length} entity + ${humanPlans.length} human), synced ${ticketSync.synced} tickets, linked ${linkResult.linked} howtos`,
    100,
  );
  return artifact;
};
