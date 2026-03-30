import { randomUUID } from "crypto";
import { getTenantCollections } from "@/lib/mongodb";
import {
  ENTITY_PAGE_TEMPLATES,
  STANDARD_HUMAN_PAGES,
} from "@/src/entities/models/kb2-templates";
import { getHumanPages } from "@/src/application/lib/kb2/company-config";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import type { StepFunction } from "@/src/application/workers/kb2/pipeline-runner";
import { PrefixLogger } from "@/lib/utils";

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
  const hasConfluenceSource = (node.source_refs ?? []).some((ref) => ref.source_type === "confluence");
  const isDone = ["done", "completed", "closed", "past"].some((s) => status.includes(s));
  const isProposed = status === "proposed" || status === "planned";
  const effectiveDocLevel = docLevel || (hasConfluenceSource ? "documented" : "");
  const isDocumented = effectiveDocLevel === "documented";
  const isUndocumented = effectiveDocLevel === "undocumented";

  if (disc === "proposed_project" || isProposed) return "proposed_projects";
  if (disc === "past_undocumented") return "past_undocumented";
  if (disc === "ongoing_undocumented") return "ongoing_undocumented";

  if (isDone) {
    if (isDocumented) return "past_documented";
    return "past_undocumented";
  }

  if (isUndocumented) return "ongoing_undocumented";
  if (isDocumented || node.truth_status === "direct") return "ongoing_documented";

  return "ongoing_undocumented";
}

const TICKET_DISCOVERY_CATEGORIES = new Set([
  "proposed_ticket",
  "proposed_from_feedback",
]);

const EXCLUDED_ENTITY_PAGE_TYPES = new Set([
  "ticket",
  "pull_request",
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
  priority: "high" | "medium" | "low";
  project_category?: string | null;
  plan_reason?: string;
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
  entity_pages_by_type: Record<string, number>;
  excluded_entity_pages_by_type: Record<string, number>;
  human_page_categories: string[];
  human_page_titles: string[];
  convention_node_count: number;
  repository_node_count: number;
  planned_repository_pages: string[];
  planned_convention_pages: string[];
  planned_convention_page_details: Array<{
    title: string;
    established_by?: string;
    pattern_rule?: string;
  }>;
  planned_project_pages_by_category: Record<string, string[]>;
  project_node_count_by_category: Record<string, number>;
  priority_counts: Record<"high" | "medium" | "low", number>;
}

function incrementCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizePlanningKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function scoreNodeForPlanning(node: KB2GraphNodeType): number {
  let score = 0;
  score += Math.min(node.source_refs.length, 5);
  if (node.attributes?._hypothesis === true) score -= 3;
  if (node.attributes?.discovery_category) score += node.attributes?._hypothesis === true ? 2 : 6;
  if (node.attributes?.status) score += 4;
  if (node.attributes?.documentation_level) score += 3;
  if (node.attributes?.is_convention === true) score += 3;
  if (node.attributes?._hypothesis !== true) score += 2;
  if (node.truth_status === "direct") score += 2;
  if (node.confidence === "high") score += 2;
  if (node.confidence === "medium") score += 1;
  return score;
}

function dedupeNodesForPlanning(nodes: KB2GraphNodeType[]): KB2GraphNodeType[] {
  const byKey = new Map<string, KB2GraphNodeType>();

  for (const node of nodes) {
    const key = `${node.type}:${normalizePlanningKey(node.display_name)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, node);
      continue;
    }

    const existingScore = scoreNodeForPlanning(existing);
    const incomingScore = scoreNodeForPlanning(node);
    if (
      incomingScore > existingScore ||
      (incomingScore === existingScore && node.source_refs.length > existing.source_refs.length)
    ) {
      byKey.set(key, node);
    }
  }

  return [...byKey.values()];
}

function shouldPlanEntityPage(node: KB2GraphNodeType): boolean {
  if (isProposedTicketNode(node)) return false;
  if (EXCLUDED_ENTITY_PAGE_TYPES.has(node.type)) return false;
  return node.type in ENTITY_PAGE_TEMPLATES;
}

function getEntityPagePriority(node: KB2GraphNodeType): "high" | "medium" | "low" {
  if (node.attributes?.is_convention === true) return "high";
  if (node.type === "project" || node.type === "team_member") return "high";
  if (node.type === "decision" || node.type === "process" || node.type === "repository") return "medium";
  return "low";
}

function getEntityPageReason(node: KB2GraphNodeType, projectCategory: string | null): string {
  if (node.attributes?.is_convention === true) {
    return "Cross-cutting convention or benchmark-critical decision";
  }
  if (node.type === "project") {
    return projectCategory ? `Project synthesis page (${projectCategory})` : "Project synthesis page";
  }
  if (node.type === "team_member") return "Owner and expertise reference";
  if (node.type === "process") return "Repeatable workflow reference";
  if (node.type === "decision") return "Decision and rationale reference";
  return "Structured reference page";
}

/**
 * Sync ticket-type graph nodes into the kb2_tickets collection so they
 * appear on the Tickets/Kanban page. Covers both Jira-imported tickets
 * (truth_status=direct) and pipeline-discovered proposed tickets.
 */
const JIRA_TICKET_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

function normalizeTicketIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractJiraTicketKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.toUpperCase().match(JIRA_TICKET_KEY_RE);
  return match?.[0] ?? null;
}

function getJiraTicketKeyFromNode(node: KB2GraphNodeType): string | null {
  for (const ref of node.source_refs ?? []) {
    if (ref.source_type !== "jira") continue;
    const docMatch = extractJiraTicketKey(ref.doc_id);
    if (docMatch) return docMatch;
    const titleMatch = extractJiraTicketKey(ref.title);
    if (titleMatch) return titleMatch;
  }
  return extractJiraTicketKey(node.display_name);
}

function getTicketSyncKeyFromNode(node: KB2GraphNodeType): string {
  const jiraKey = getJiraTicketKeyFromNode(node);
  if (jiraKey) return `jira:${jiraKey}`;
  const cat = typeof node.attributes?.discovery_category === "string" ? node.attributes.discovery_category : "";
  if (cat === "proposed_from_feedback") return `feedback:${normalizeTicketIdentity(node.display_name)}`;
  return `ticket:${normalizeTicketIdentity(node.display_name)}`;
}

function isSyncedTicketDoc(ticket: Record<string, unknown>): boolean {
  return Array.isArray(ticket.linked_entity_ids) && ticket.linked_entity_ids.some((id) => typeof id === "string" && id.trim().length > 0);
}

function getTicketSyncKeyFromDoc(
  ticket: Record<string, unknown>,
  currentNodeById?: Map<string, KB2GraphNodeType>,
): string {
  if (currentNodeById && Array.isArray(ticket.linked_entity_ids)) {
    const candidateKeys = ticket.linked_entity_ids
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => currentNodeById.get(id))
      .filter((node): node is KB2GraphNodeType => Boolean(node))
      .map((node) => getTicketSyncKeyFromNode(node));
    const jiraKey = candidateKeys.find((key) => key.startsWith("jira:"));
    if (jiraKey) return jiraKey;
    if (candidateKeys[0]) return candidateKeys[0];
  }
  if (typeof ticket.sync_key === "string" && ticket.sync_key.trim().length > 0) {
    return ticket.sync_key.trim();
  }
  const title = typeof ticket.title === "string" ? ticket.title : "";
  const source = typeof ticket.source === "string" ? ticket.source : "";
  const jiraKey = extractJiraTicketKey(title);
  if (jiraKey) return `jira:${jiraKey}`;
  if (source === "feedback") return `feedback:${normalizeTicketIdentity(title)}`;
  if (isSyncedTicketDoc(ticket)) return `ticket:${normalizeTicketIdentity(title)}`;
  return `manual:${typeof ticket.ticket_id === "string" ? ticket.ticket_id : normalizeTicketIdentity(title)}`;
}

function inferTicketSourceFromNode(node: KB2GraphNodeType): string {
  if ((node.source_refs ?? []).some((ref) => ref.source_type === "jira") || getJiraTicketKeyFromNode(node)) {
    return "jira";
  }
  const cat = typeof node.attributes?.discovery_category === "string" ? node.attributes.discovery_category : "";
  if (cat === "proposed_from_feedback") return "feedback";
  return "conversation";
}

function inferTicketWorkflowStateFromNode(node: KB2GraphNodeType): string {
  const status = String(node.attributes?.status ?? "").toLowerCase();
  if (/\b(done|closed|resolved|complete|completed)\b/.test(status)) return "done";
  if (/\b(review|qa|verify|testing)\b/.test(status)) return "review";
  if (/\b(in progress|in_progress|active|doing|wip)\b/.test(status)) return "in_progress";
  if (/\b(todo|to do|selected for development|open|backlog|planned)\b/.test(status)) return "backlog";
  return "backlog";
}

function scoreTicketNodeForSync(node: KB2GraphNodeType): number {
  let score = 0;
  if (inferTicketSourceFromNode(node) === "jira") score += 30;
  if ((node.source_refs ?? []).some((ref) => ref.source_type === "jira")) score += 20;
  if (extractJiraTicketKey(node.display_name)) score += 5;
  if (typeof node.attributes?.status === "string" && node.attributes.status.trim().length > 0) score += 10;
  if (node.truth_status === "direct") score += 10;
  if (node.confidence === "high") score += 4;
  else if (node.confidence === "medium") score += 2;
  score += Math.min(node.source_refs.length, 5);
  return score;
}

function chooseTicketKeeper(tickets: Array<Record<string, unknown>>): Record<string, unknown> {
  return [...tickets].sort((a, b) => {
    const aComments = Array.isArray(a.comments) ? a.comments.length : 0;
    const bComments = Array.isArray(b.comments) ? b.comments.length : 0;
    if (bComments !== aComments) return bComments - aComments;
    const aSubtasks = Array.isArray(a.subtask_ids) ? a.subtask_ids.length : 0;
    const bSubtasks = Array.isArray(b.subtask_ids) ? b.subtask_ids.length : 0;
    if (bSubtasks !== aSubtasks) return bSubtasks - aSubtasks;
    const aCreated = typeof a.created_at === "string" ? Date.parse(a.created_at) : 0;
    const bCreated = typeof b.created_at === "string" ? Date.parse(b.created_at) : 0;
    return bCreated - aCreated;
  })[0];
}

function mergeStringArrays(...groups: unknown[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const value of group ?? []) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

function mergeComments(...groups: unknown[][]): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const merged: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    for (const value of group ?? []) {
      if (!value || typeof value !== "object") continue;
      const comment = value as Record<string, unknown>;
      const key = typeof comment.id === "string" && comment.id.trim().length > 0
        ? comment.id
        : JSON.stringify(comment);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(comment);
    }
  }
  return merged;
}

async function collapseDuplicateTicketsForRun(
  runId: string,
  tc: ReturnType<typeof getTenantCollections>,
  currentNodes: KB2GraphNodeType[],
  demoStateId?: string,
): Promise<Map<string, Record<string, unknown>>> {
  const ticketFilter: Record<string, unknown> = demoStateId
    ? { demo_state_id: demoStateId }
    : { run_id: runId, demo_state_id: { $exists: false } };
  const tickets = await tc.tickets.find(ticketFilter).sort({ created_at: -1 }).toArray() as Array<Record<string, unknown>>;
  const currentNodeById = new Map(currentNodes.map((node) => [node.node_id, node]));
  const byKey = new Map<string, Array<Record<string, unknown>>>();
  for (const ticket of tickets) {
    const key = getTicketSyncKeyFromDoc(ticket, currentNodeById);
    const list = byKey.get(key) ?? [];
    list.push(ticket);
    byKey.set(key, list);
  }

  const canonical = new Map<string, Record<string, unknown>>();
  for (const [key, group] of byKey.entries()) {
    const keeper = chooseTicketKeeper(group);
    const duplicates = group.filter((ticket) => ticket.ticket_id !== keeper.ticket_id);
    const mergedPatch = {
      sync_key: key,
      linked_entity_ids: mergeStringArrays(...group.map((ticket) => ticket.linked_entity_ids as unknown[] ?? [])),
      linked_entity_names: mergeStringArrays(...group.map((ticket) => ticket.linked_entity_names as unknown[] ?? [])),
      assignees: mergeStringArrays(...group.map((ticket) => ticket.assignees as unknown[] ?? [])),
      labels: mergeStringArrays(...group.map((ticket) => ticket.labels as unknown[] ?? [])),
      subtask_ids: mergeStringArrays(...group.map((ticket) => ticket.subtask_ids as unknown[] ?? [])),
      comments: mergeComments(...group.map((ticket) => ticket.comments as unknown[] ?? [])),
    };
    await tc.tickets.updateOne(
      demoStateId
        ? { ticket_id: keeper.ticket_id, demo_state_id: demoStateId }
        : { ticket_id: keeper.ticket_id, demo_state_id: { $exists: false } },
      { $set: mergedPatch },
    );
    if (duplicates.length > 0) {
      await tc.tickets.deleteMany({
        ...(demoStateId
          ? { demo_state_id: demoStateId }
          : { demo_state_id: { $exists: false } }),
        ticket_id: {
          $in: duplicates
            .map((ticket) => ticket.ticket_id)
            .filter((ticketId): ticketId is string => typeof ticketId === "string" && ticketId.trim().length > 0),
        },
      });
    }
    canonical.set(key, { ...keeper, ...mergedPatch });
  }
  return canonical;
}

function buildSyncedTicketPatch(
  node: KB2GraphNodeType,
  runId: string,
  existing?: Record<string, unknown>,
  demoStateId?: string,
): Record<string, unknown> {
  const workflowState = inferTicketWorkflowStateFromNode(node);
  const description = typeof node.attributes?.description === "string" && node.attributes.description.trim().length > 0
    ? node.attributes.description
    : typeof existing?.description === "string"
      ? existing.description
      : "";
  const priority = typeof node.attributes?.priority === "string" && node.attributes.priority.trim().length > 0
    ? node.attributes.priority
    : typeof existing?.priority === "string"
      ? existing.priority
      : "P2";
  return {
    run_id: runId,
    ...(demoStateId ? { demo_state_id: demoStateId } : {}),
    sync_key: getTicketSyncKeyFromNode(node),
    source: inferTicketSourceFromNode(node),
    title: node.display_name,
    description,
    priority,
    workflow_state: workflowState,
    linked_entity_ids: [node.node_id],
    linked_entity_names: [node.display_name],
    status: workflowState === "done" ? "closed" : "open",
    updated_at: new Date().toISOString(),
  };
}

export async function syncGraphNodesToTickets(
  nodes: KB2GraphNodeType[],
  runId: string,
  tc: ReturnType<typeof getTenantCollections>,
  demoStateId?: string,
): Promise<{ synced: number; skipped: number }> {
  const ticketNodes = nodes.filter(
    (n) => n.type === "ticket" || isProposedTicketNode(n),
  );
  if (ticketNodes.length === 0) return { synced: 0, skipped: 0 };

  const incomingByKey = new Map<string, KB2GraphNodeType>();
  let skipped = 0;
  for (const node of ticketNodes) {
    const key = getTicketSyncKeyFromNode(node);
    const existingNode = incomingByKey.get(key);
    if (!existingNode) {
      incomingByKey.set(key, node);
      continue;
    }
    if (scoreTicketNodeForSync(node) > scoreTicketNodeForSync(existingNode)) {
      incomingByKey.set(key, node);
    }
    skipped++;
  }

  const existingByKey = await collapseDuplicateTicketsForRun(runId, tc, [...incomingByKey.values()], demoStateId);

  let synced = 0;
  for (const [key, node] of incomingByKey.entries()) {
    const existing = existingByKey.get(key);
    const patch = buildSyncedTicketPatch(node, runId, existing, demoStateId);
    if (existing && typeof existing.ticket_id === "string" && existing.ticket_id.trim().length > 0) {
      await tc.tickets.updateOne(
        demoStateId
          ? { ticket_id: existing.ticket_id, demo_state_id: demoStateId }
          : { ticket_id: existing.ticket_id, demo_state_id: { $exists: false } },
        { $set: patch },
      );
    } else {
      await tc.tickets.insertOne({
        ticket_id: randomUUID(),
        run_id: runId,
        source: patch.source,
        title: patch.title,
        description: patch.description,
        assignees: [],
        labels: [],
        status: patch.status,
        priority: patch.priority,
        workflow_state: patch.workflow_state,
        linked_entity_ids: patch.linked_entity_ids,
        linked_entity_names: patch.linked_entity_names,
        parent_ticket_id: null,
        subtask_ids: [],
        comments: [],
        sync_key: patch.sync_key,
        ...(demoStateId ? { demo_state_id: demoStateId } : {}),
        created_at: new Date().toISOString(),
        updated_at: patch.updated_at,
      });
    }
    synced++;
  }

  return { synced, skipped };
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

  const nodesForPlanning = dedupeNodesForPlanning(nodes);

  await ctx.onProgress(`Planning pages for ${nodesForPlanning.length} deduplicated entities...`, 10);

  const entityPagesByType: Record<string, number> = {};
  const excludedEntityPagesByType: Record<string, number> = {};
  const priorityCounts: Record<"high" | "medium" | "low", number> = {
    high: 0,
    medium: 0,
    low: 0,
  };

  const entityPlans: EntityPagePlan[] = [];
  for (const node of nodesForPlanning) {
    const projectCategory = classifyProjectCategory(node);
    if (!shouldPlanEntityPage(node)) {
      incrementCount(excludedEntityPagesByType, node.type);
      continue;
    }

    const priority = getEntityPagePriority(node);
    incrementCount(entityPagesByType, node.type);
    priorityCounts[priority] += 1;

    entityPlans.push({
      page_id: randomUUID(),
      node_id: node.node_id,
      node_type: node.type,
      display_name: node.display_name,
      has_template: node.type in ENTITY_PAGE_TEMPLATES,
      priority,
      project_category: projectCategory,
      plan_reason: getEntityPageReason(node, projectCategory),
    });
  }

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
  const ticketSync = await syncGraphNodesToTickets(nodesForPlanning, ctx.runId, tc);

  softCoverageAssertions(nodesForPlanning, entityPlans, humanPlans);

  const plannedNodeIds = new Set(entityPlans.map((plan) => plan.node_id));
  const conventionNodes = nodesForPlanning.filter((node) => node.attributes?.is_convention === true);
  const repositoryNodes = nodesForPlanning.filter((node) => node.type === "repository");
  const humanPageCategories = uniqueSorted(humanPlans.map((plan) => plan.category));
  const humanPageTitles = uniqueSorted(humanPlans.map((plan) => plan.title));
  const plannedProjectPagesByCategory = Array.from(PROJECT_CATEGORIES).reduce<Record<string, string[]>>(
    (acc, category) => {
      acc[category] = uniqueSorted(
        nodesForPlanning
          .filter(
            (node) =>
              node.type === "project" &&
              classifyProjectCategory(node) === category &&
              plannedNodeIds.has(node.node_id),
          )
          .map((node) => node.display_name),
      );
      return acc;
    },
    {},
  );
  const projectNodeCountByCategory = Array.from(PROJECT_CATEGORIES).reduce<Record<string, number>>(
    (acc, category) => {
      acc[category] = nodesForPlanning.filter(
        (node) => node.type === "project" && classifyProjectCategory(node) === category,
      ).length;
      return acc;
    },
    {},
  );

  const artifact: PagePlanArtifact = {
    entity_pages: entityPlans,
    human_pages: humanPlans,
    total_pages: entityPlans.length + humanPlans.length,
    ticket_sync: ticketSync,
    entity_pages_by_type: entityPagesByType,
    excluded_entity_pages_by_type: excludedEntityPagesByType,
    human_page_categories: humanPageCategories,
    human_page_titles: humanPageTitles,
    convention_node_count: conventionNodes.length,
    repository_node_count: repositoryNodes.length,
    planned_repository_pages: uniqueSorted(
      repositoryNodes
        .filter((node) => plannedNodeIds.has(node.node_id))
        .map((node) => node.display_name),
    ),
    planned_convention_pages: uniqueSorted(
      conventionNodes
        .filter((node) => plannedNodeIds.has(node.node_id))
        .map((node) => node.display_name),
    ),
    planned_convention_page_details: conventionNodes
      .filter((node) => plannedNodeIds.has(node.node_id))
      .map((node) => ({
        title: node.display_name,
        established_by:
          typeof node.attributes?.established_by === "string"
            ? node.attributes.established_by
            : undefined,
        pattern_rule:
          typeof node.attributes?.pattern_rule === "string"
            ? node.attributes.pattern_rule
            : undefined,
      })),
    planned_project_pages_by_category: plannedProjectPagesByCategory,
    project_node_count_by_category: projectNodeCountByCategory,
    priority_counts: priorityCounts,
  };

  await ctx.onProgress(
    `Planned ${artifact.total_pages} pages (${entityPlans.length} entity + ${humanPlans.length} human), synced ${ticketSync.synced} tickets`,
    100,
  );
  return artifact;
};

function softCoverageAssertions(
  nodes: KB2GraphNodeType[],
  entityPlans: EntityPagePlan[],
  humanPlans: HumanPagePlan[],
): void {
  const logger = new PrefixLogger("kb2-page-plan-coverage");
  const entityPlanNodeIds = new Set(entityPlans.map((p) => p.node_id));

  const conventionNodes = nodes.filter((n) => n.attributes?.is_convention === true);
  if (conventionNodes.length > 0) {
    const hasConventionHumanPage = humanPlans.some(
      (hp) => hp.category === "hidden_conventions",
    );
    if (!hasConventionHumanPage) {
      logger.log(
        `${conventionNodes.length} convention nodes exist but no hidden_conventions human page is planned`,
      );
    }

    for (const cn of conventionNodes) {
      if (!entityPlanNodeIds.has(cn.node_id)) {
        logger.log(
          `Convention node "${cn.display_name}" (${cn.node_id}) has no entity page plan`,
        );
      }
    }
  }

  const feedbackFeatureNodes = nodes.filter(
    (n) => n.attributes?.discovery_category === "proposed_from_feedback",
  );
  for (const fn of feedbackFeatureNodes) {
    if (!entityPlanNodeIds.has(fn.node_id) && !isProposedTicketNode(fn)) {
      logger.log(
        `Proposed feature from feedback "${fn.display_name}" (${fn.node_id}) has no entity page plan`,
      );
    }
  }
}
