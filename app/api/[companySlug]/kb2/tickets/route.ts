import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { kb2TicketsCollection } from "@/lib/mongodb";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
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
    status: "open",
    priority: body.priority || "P2",
    workflow_state: "backlog",
    linked_entity_ids: [],
    created_at: new Date().toISOString(),
  };

  await kb2TicketsCollection.insertOne(ticket);
  return Response.json({ success: true, ticket });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const body = await request.json();
  const { ticketId, ...updates } = body;

  await kb2TicketsCollection.updateOne(
    { ticket_id: ticketId },
    { $set: updates },
  );

  return Response.json({ success: true });
}
