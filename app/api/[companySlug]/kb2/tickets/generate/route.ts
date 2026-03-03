import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getFastModel, calculateCostUsd } from "@/lib/ai-model";
import { kb2GraphNodesCollection, kb2TicketsCollection } from "@/lib/mongodb";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { PrefixLogger } from "@/lib/utils";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";

export const maxDuration = 120;

const GeneratedTicketsSchema = z.object({
  tickets: z.array(z.object({
    title: z.string(),
    description: z.string(),
    priority: z.enum(["P0", "P1", "P2", "P3"]),
    priority_rationale: z.string(),
    affected_systems: z.array(z.string()),
    customer_evidence: z.array(z.object({
      excerpt: z.string(),
      sentiment: z.enum(["positive", "negative", "neutral"]),
    })),
  })),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const logger = new PrefixLogger("kb2-ticket-gen");

  try {
    const { feedback } = await request.json();
    if (!feedback || typeof feedback !== "string" || feedback.trim().length === 0) {
      return Response.json({ error: "feedback text is required" }, { status: 400 });
    }

    const nodes = (await kb2GraphNodesCollection
      .find({})
      .sort({ _id: -1 })
      .limit(200)
      .toArray()) as unknown as KB2GraphNodeType[];

    const people = nodes
      .filter((n) => n.type === "person")
      .map((n) => `${n.display_name}${n.attributes?.role ? ` — ${n.attributes.role}` : ""}`)
      .join("\n");

    const systems = nodes
      .filter((n) => ["repository", "infrastructure", "integration", "database"].includes(n.type))
      .map((n) => `${n.display_name} [${n.type}]`)
      .join("\n");

    const existingTickets = await kb2TicketsCollection
      .find({})
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    const existingTitles = existingTickets.map((t: any) => t.title).join("\n");

    const model = getFastModel();
    const startMs = Date.now();

    const result = await structuredGenerate({
      model,
      system: `You are a product management AI for a software company knowledge base.
Given customer feedback text, generate actionable engineering tickets.

Rules:
- Each ticket should be specific and actionable
- Set priority based on impact and urgency: P0=critical/blocking, P1=high impact, P2=medium, P3=low/nice-to-have
- Reference affected systems by name from the provided list
- Extract exact customer quotes as evidence
- Do NOT create tickets that duplicate existing ones
- Generate 1-8 tickets depending on feedback complexity`,
      prompt: `CUSTOMER FEEDBACK:
${feedback.substring(0, 15000)}

TEAM MEMBERS:
${people || "(unknown)"}

SYSTEMS:
${systems || "(unknown)"}

EXISTING TICKETS (do not duplicate):
${existingTitles || "(none)"}

Generate tickets from this feedback.`,
      schema: GeneratedTicketsSchema,
      logger,
    });

    const durationMs = Date.now() - startMs;
    const tickets = (result as any).tickets || [];

    return Response.json({
      tickets,
      meta: { count: tickets.length, duration_ms: durationMs },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate tickets";
    return Response.json({ error: message }, { status: 500 });
  }
}
