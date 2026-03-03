import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { kb2TicketsCollection, kb2GraphNodesCollection, kb2RunsCollection } from "@/lib/mongodb";
import { syncGraphNodesToTickets } from "@/src/application/workers/kb2/pass1/page-plan";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";

const UPDATABLE_FIELDS = [
  "title", "description", "priority", "assignees", "labels",
  "linked_entity_ids", "linked_entity_names", "workflow_state", "parent_ticket_id",
] as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const action = request.nextUrl.searchParams.get("action");
  const ticketId = request.nextUrl.searchParams.get("ticket_id");

  if (ticketId) {
    const ticket = await kb2TicketsCollection.findOne({ ticket_id: ticketId });
    if (!ticket) return Response.json({ error: "Ticket not found" }, { status: 404 });
    const subtasks = await kb2TicketsCollection
      .find({ parent_ticket_id: ticketId })
      .sort({ created_at: -1 })
      .toArray();
    return Response.json({ ticket, subtasks });
  }

  if (action === "sync") {
    const latestRun = await kb2RunsCollection
      .find({ status: "completed" })
      .sort({ completed_at: -1 })
      .limit(1)
      .toArray();
    const runId = latestRun[0]?.run_id;
    let syncResult = { synced: 0, skipped: 0 };
    if (runId) {
      const nodes = (await kb2GraphNodesCollection
        .find({ run_id: runId })
        .toArray()) as unknown as KB2GraphNodeType[];
      syncResult = await syncGraphNodesToTickets(nodes, runId);
    }
    const tickets = await kb2TicketsCollection.find({}).sort({ created_at: -1 }).toArray();
    return Response.json({ tickets, sync: syncResult });
  }

  const tickets = await kb2TicketsCollection.find({}).sort({ created_at: -1 }).toArray();
  return Response.json({ tickets });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const body = await request.json();
  const ticket = {
    ticket_id: randomUUID(),
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

  await kb2TicketsCollection.insertOne(ticket);

  if (body.parent_ticket_id) {
    await kb2TicketsCollection.updateOne(
      { ticket_id: body.parent_ticket_id },
      { $addToSet: { subtask_ids: ticket.ticket_id } },
    );
  }

  return Response.json({ success: true, ticket });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const body = await request.json();
  const { ticketId, add_comment, add_subtask_id, ...rest } = body;

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

  await kb2TicketsCollection.updateOne({ ticket_id: ticketId }, update);

  return Response.json({ success: true });
}
