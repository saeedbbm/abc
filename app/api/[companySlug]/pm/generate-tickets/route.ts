import { NextRequest } from "next/server";
import { z } from "zod";
import { getPrimaryModel } from "@/lib/ai-model";
import { db } from "@/lib/mongodb";
import { structuredGenerate } from "@/src/application/workers/test/structured-generate";
import { PrefixLogger } from "@/lib/utils";

export const maxDuration = 120;

const TicketSchema = z.object({
  tickets: z.array(z.object({
    ticket_id: z.string(),
    type: z.enum(["bug", "feature", "task", "improvement"]),
    title: z.string(),
    priority: z.enum(["P0", "P1", "P2", "P3"]),
    priority_rationale: z.string(),
    description: z.string(),
    acceptance_criteria: z.array(z.string()),
    assigned_to: z.string(),
    assignment_rationale: z.string(),
    affected_systems: z.array(z.string()),
    customer_evidence: z.array(z.object({
      feedback_id: z.string(),
      customer_name: z.string(),
      excerpt: z.string(),
      sentiment: z.enum(["positive", "negative", "neutral"]),
    })),
    technical_constraints: z.array(z.object({
      constraint: z.string(),
      source: z.string(),
      impact: z.string(),
    })),
    complexity: z.enum(["trivial", "small", "medium", "large", "xlarge"]),
    related_tickets: z.array(z.string()),
  })),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const logger = new PrefixLogger("pm-tickets");

  try {
    const { feedback } = await request.json();
    if (!feedback || typeof feedback !== "string" || feedback.trim().length === 0) {
      return Response.json({ error: "feedback text is required" }, { status: 400 });
    }

    const project = await db.collection("projects").findOne({ companySlug });
    if (!project) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }

    // Load entities for context
    const people = await db.collection("knowledge_entities")
      .find({ projectId: project.projectId, type: "person" })
      .limit(50).toArray();
    const systems = await db.collection("knowledge_entities")
      .find({ projectId: project.projectId, type: "system" })
      .limit(50).toArray();

    const peopleSummary = people.map(p => {
      const meta = p.metadata || {};
      return `${p.name}${meta.role ? ` — ${meta.role}` : ""}${meta.team ? ` [${meta.team}]` : ""}`;
    }).join("\n");

    const systemSummary = systems.map(s => {
      const meta = s.metadata || {};
      return `${s.name}${meta.description ? ` — ${meta.description.substring(0, 100)}` : ""}`;
    }).join("\n");

    const result = await structuredGenerate({
      model: getPrimaryModel(),
      schema: TicketSchema,
      system: `You are a product management AI. Given customer feedback, generate structured tickets (bugs, features, tasks). Each ticket should be actionable, have clear acceptance criteria, and be assigned to the right person based on their expertise and system ownership.`,
      prompt: `CUSTOMER FEEDBACK:\n${feedback.substring(0, 15000)}\n\nTEAM:\n${peopleSummary || "(unknown)"}\n\nSYSTEMS:\n${systemSummary || "(unknown)"}\n\nGenerate tickets from this feedback.`,
      maxOutputTokens: 8192,
      logger,
    });

    const tickets = (result as any).tickets || [];
    return Response.json({ tickets });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate tickets";
    return Response.json({ error: message }, { status: 500 });
  }
}
