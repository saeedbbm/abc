import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { getTenantCollections } from "@/lib/mongodb";
import { syncGraphNodesToTickets } from "@/src/application/workers/kb2/pass1/page-plan";
import {
  getLatestCompletedRunId,
  getLatestCompletedStepExecutionId,
  getLatestRunIdFromCollection,
} from "@/src/application/lib/kb2/run-scope";
import {
  buildBaselineRunFilter,
  buildStateFilter,
  ensureWritableDemoState,
  isWorkspaceLikeState,
  resolveActiveDemoState,
} from "@/src/application/lib/kb2/demo-state";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";

const UPDATABLE_FIELDS = [
  "title", "description", "priority", "assignees", "labels",
  "linked_entity_ids", "linked_entity_names", "workflow_state", "parent_ticket_id",
] as const;

type TicketDoc = Record<string, any>;

function dedupeStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function dedupeSourceRefs(sourceRefs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const ref of sourceRefs) {
    const sourceType = typeof ref.source_type === "string" ? ref.source_type : "unknown";
    const docId = typeof ref.doc_id === "string" ? ref.doc_id : "";
    const title = typeof ref.title === "string" ? ref.title : "";
    const excerpt = typeof ref.excerpt === "string" ? ref.excerpt : "";
    const key = `${sourceType}::${docId}::${title}::${excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source_type: sourceType,
      doc_id: docId,
      title,
      excerpt,
      section_heading: typeof ref.section_heading === "string" ? ref.section_heading : undefined,
    });
  }
  return out;
}

async function enrichTicketsForResponse(
  tickets: TicketDoc[],
  tc: ReturnType<typeof getTenantCollections>,
): Promise<TicketDoc[]> {
  if (tickets.length === 0) return tickets;

  const ticketGroups = new Map<string, { runId: string; demoStateId: string | null; tickets: TicketDoc[] }>();
  for (const ticket of tickets) {
    const runId = typeof ticket.run_id === "string" && ticket.run_id.trim().length > 0
      ? ticket.run_id
      : "__no_run__";
    const demoStateId = typeof ticket.demo_state_id === "string" && ticket.demo_state_id.trim().length > 0
      ? ticket.demo_state_id
      : null;
    const key = demoStateId ? `state:${demoStateId}` : `run:${runId}`;
    const existing = ticketGroups.get(key) ?? { runId, demoStateId, tickets: [] };
    existing.tickets.push(ticket);
    ticketGroups.set(key, existing);
  }

  const enriched: TicketDoc[] = [];
  for (const { runId, demoStateId, tickets: group } of ticketGroups.values()) {
    const linkedIds = [...new Set(group.flatMap((ticket) =>
      Array.isArray(ticket.linked_entity_ids)
        ? ticket.linked_entity_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [],
    ))];

    const nodeFilter: Record<string, unknown> = { node_id: { $in: linkedIds } };
    if (demoStateId) {
      nodeFilter.demo_state_id = demoStateId;
    } else if (runId !== "__no_run__") {
      Object.assign(nodeFilter, buildBaselineRunFilter(runId));
    }
    const nodes = linkedIds.length > 0 ? await tc.graph_nodes.find(nodeFilter).toArray() : [];
    const nodeById = new Map(nodes.map((node) => [String(node.node_id), node]));

    for (const ticket of group) {
      const ids = Array.isArray(ticket.linked_entity_ids)
        ? ticket.linked_entity_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [];
      const linkedNodes = ids
        .map((id) => nodeById.get(id))
        .filter((node): node is (typeof nodes)[number] => Boolean(node));
      const linkedNames = dedupeStrings([
        ...(Array.isArray(ticket.linked_entity_names) ? ticket.linked_entity_names : []),
        ...linkedNodes.map((node) => node.display_name),
      ]);
      const sourceRefs = dedupeSourceRefs(
        linkedNodes.flatMap((node) => Array.isArray(node.source_refs) ? node.source_refs : []),
      );
      enriched.push({
        ...ticket,
        linked_entity_names: linkedNames,
        source_refs: sourceRefs,
      });
    }
  }

  return enriched;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const action = request.nextUrl.searchParams.get("action");
  const ticketId = request.nextUrl.searchParams.get("ticket_id");
  const requestedRunId = request.nextUrl.searchParams.get("run_id");
  const stateId = request.nextUrl.searchParams.get("state_id");
  const activeDemoState =
    !requestedRunId
      ? await resolveActiveDemoState(tc, companySlug, stateId)
      : stateId
        ? await resolveActiveDemoState(tc, companySlug, stateId)
        : null;

  const effectiveRunId =
    requestedRunId
    ?? activeDemoState?.base_run_id
    ?? await getLatestRunIdFromCollection(tc, companySlug, {
      distinct: (field: string) => tc.tickets.distinct(field, { demo_state_id: { $exists: false } }),
    })
    ?? await getLatestCompletedRunId(tc, companySlug);
  const baseTicketFilter = isWorkspaceLikeState(activeDemoState)
    ? buildStateFilter(activeDemoState.state_id)
    : effectiveRunId
      ? buildBaselineRunFilter(effectiveRunId)
      : { demo_state_id: { $exists: false } };

  if (ticketId) {
    const ticket = await tc.tickets.findOne({ ticket_id: ticketId, ...baseTicketFilter });
    if (!ticket) return Response.json({ error: "Ticket not found" }, { status: 404 });
    const subtaskFilter: Record<string, unknown> = { parent_ticket_id: ticketId, ...baseTicketFilter };
    const subtasks = await tc.tickets
      .find(subtaskFilter)
      .sort({ created_at: -1 })
      .toArray();
    const [enrichedTicket] = await enrichTicketsForResponse([ticket], tc);
    const enrichedSubtasks = await enrichTicketsForResponse(subtasks as TicketDoc[], tc);
    return Response.json({ ticket: enrichedTicket, subtasks: enrichedSubtasks });
  }

  if (action === "sync") {
    const writableState = await ensureWritableDemoState(tc, companySlug);
    const runId = requestedRunId ?? writableState.base_run_id ?? await getLatestCompletedRunId(tc, companySlug);
    let syncResult = { synced: 0, skipped: 0 };
    if (runId) {
      const step9ExecId = await getLatestCompletedStepExecutionId(tc, runId, "pass1-step-9");
      const nodeFilter = step9ExecId
        ? { execution_id: step9ExecId, demo_state_id: { $exists: false } }
        : buildBaselineRunFilter(runId);
      const nodes = (await tc.graph_nodes
        .find(nodeFilter)
        .toArray()) as unknown as KB2GraphNodeType[];
      syncResult = await syncGraphNodesToTickets(nodes, runId, tc, writableState.state_id);
    }
    const tickets = await tc.tickets
      .find(buildStateFilter(writableState.state_id))
      .sort({ created_at: -1 })
      .toArray();
    return Response.json({ tickets: await enrichTicketsForResponse(tickets as TicketDoc[], tc), sync: syncResult });
  }

  const tickets = await tc.tickets
    .find(baseTicketFilter)
    .sort({ created_at: -1 })
    .toArray();
  return Response.json({ tickets: await enrichTicketsForResponse(tickets as TicketDoc[], tc) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const body = await request.json();
  const writableState = await ensureWritableDemoState(tc, companySlug);
  const runId = body.run_id ?? writableState.base_run_id ?? await getLatestCompletedRunId(tc, companySlug);
  const ticket = {
    ticket_id: randomUUID(),
    run_id: runId,
    demo_state_id: writableState.state_id,
    source: body.source || "manual",
    title: body.title,
    description: body.description || "",
    assignees: body.assignees || [],
    labels: body.labels || [],
    status: "open",
    priority: body.priority || "P2",
    workflow_state: "backlog",
    linked_entity_ids: body.linked_entity_ids || [],
    linked_entity_names: body.linked_entity_names || [],
    parent_ticket_id: body.parent_ticket_id || null,
    subtask_ids: [],
    comments: [],
    created_at: new Date().toISOString(),
  };

  await tc.tickets.insertOne(ticket);

  if (body.parent_ticket_id) {
    await tc.tickets.updateOne(
      { ticket_id: body.parent_ticket_id, demo_state_id: writableState.state_id },
      { $addToSet: { subtask_ids: ticket.ticket_id } },
    );
  }

  return Response.json({ success: true, ticket });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const body = await request.json();
  const { ticketId, add_comment, add_subtask_id, ...rest } = body;
  const writableState = await ensureWritableDemoState(tc, companySlug);

  const $set: Record<string, unknown> = {};
  for (const field of UPDATABLE_FIELDS) {
    if (rest[field] !== undefined) $set[field] = rest[field];
  }

  const $push: Record<string, unknown> = {};

  if (add_comment) {
    $push["comments"] = {
      id: randomUUID(),
      author: add_comment.author,
      text: add_comment.text,
      source: add_comment.source || "manual",
      created_at: new Date().toISOString(),
    };
  }

  if (add_subtask_id) {
    $push["subtask_ids"] = add_subtask_id;
  }

  const update: Record<string, unknown> = {};
  if (Object.keys($set).length > 0) update.$set = $set;
  if (Object.keys($push).length > 0) update.$push = $push;

  if (Object.keys(update).length === 0) {
    return Response.json({ error: "No valid updates provided" }, { status: 400 });
  }

  await tc.tickets.updateOne({ ticket_id: ticketId, demo_state_id: writableState.state_id }, update);

  return Response.json({ success: true });
}
