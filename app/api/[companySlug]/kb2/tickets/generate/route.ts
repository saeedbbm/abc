import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getFastModel, calculateCostUsd } from "@/lib/ai-model";
import { getTenantCollections } from "@/lib/mongodb";
import { structuredGenerate } from "@/src/application/lib/llm/structured-generate";
import { PrefixLogger } from "@/lib/utils";
import type { KB2GraphNodeType } from "@/src/entities/models/kb2-types";
import { getCompanyConfig } from "@/src/application/lib/kb2/company-config";
import { getLatestCompletedRunId, getLatestRunIdFromCollection } from "@/src/application/lib/kb2/run-scope";
import {
  buildBaselineRunFilter,
  buildStateFilter,
  isWorkspaceLikeState,
  resolveActiveDemoState,
} from "@/src/application/lib/kb2/demo-state";

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
  const { companySlug } = await params;
  const tc = getTenantCollections(companySlug);
  const config = await getCompanyConfig(companySlug);
  const logger = new PrefixLogger("kb2-ticket-gen");
  const activeDemoState = await resolveActiveDemoState(tc, companySlug);

  try {
    const { feedback } = await request.json();
    if (!feedback || typeof feedback !== "string" || feedback.trim().length === 0) {
      return Response.json({ error: "feedback text is required" }, { status: 400 });
    }

    const runId =
      activeDemoState?.base_run_id
      ?? await getLatestRunIdFromCollection(tc, companySlug, {
        distinct: (field: string) => tc.graph_nodes.distinct(field, { demo_state_id: { $exists: false } }),
      })
      ?? await getLatestCompletedRunId(tc, companySlug);
    const nodeFilter = isWorkspaceLikeState(activeDemoState)
      ? buildStateFilter(activeDemoState.state_id)
      : runId
        ? buildBaselineRunFilter(runId)
        : { demo_state_id: { $exists: false } };
    const nodes = (await tc.graph_nodes
      .find(nodeFilter)
      .sort({ _id: -1 })
      .limit(config?.pipeline_settings?.ticket_generation?.node_limit ?? 200)
      .toArray()) as unknown as KB2GraphNodeType[];

    const people = [...new Set(nodes
      .filter((n) => n.type === "team_member")
      .map((n) => `${n.display_name}${n.attributes?.role ? ` — ${n.attributes.role}` : ""}`)
    )].join("\n");

    const systems = [...new Set(nodes
      .filter((n) => ["repository", "infrastructure", "integration", "database"].includes(n.type))
      .map((n) => `${n.display_name} [${n.type}]`)
    )].join("\n");

    const ticketFilter = isWorkspaceLikeState(activeDemoState)
      ? buildStateFilter(activeDemoState.state_id)
      : runId
        ? buildBaselineRunFilter(runId)
        : { demo_state_id: { $exists: false } };
    const existingTickets = await tc.tickets
      .find(ticketFilter)
      .sort({ created_at: -1 })
      .limit(config?.pipeline_settings?.ticket_generation?.existing_tickets_limit ?? 50)
      .toArray();
    const existingTitles = existingTickets.map((t: any) => t.title).join("\n");

    const model = getFastModel(config?.pipeline_settings?.models);
    const startMs = Date.now();

    const result = await structuredGenerate({
      model,
      system: config?.prompts?.ticket_generation?.system ?? `You are a product management AI for a software company knowledge base.
Given customer feedback text, generate actionable engineering tickets.

Rules:
- Each ticket should be specific and actionable
- Set priority based on impact and urgency: P0=critical/blocking, P1=high impact, P2=medium, P3=low/nice-to-have
- Reference affected systems by name from the provided list
- Extract exact customer quotes as evidence
- Do NOT create tickets that duplicate existing ones
- Generate 1-8 tickets depending on feedback complexity`,
      prompt: `CUSTOMER FEEDBACK:
${feedback.substring(0, config?.pipeline_settings?.ticket_generation?.feedback_max_length ?? 15000)}

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
