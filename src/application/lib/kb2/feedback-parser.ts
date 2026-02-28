/**
 * Parses Zendesk-style customer feedback ticket exports into structured documents.
 */

import type { KB2ParsedDocument } from "./confluence-parser";

interface ZendeskTicket {
  id: number;
  status?: string;
  priority?: string;
  type?: string;
  subject: string;
  created_at?: string;
  updated_at?: string;
  requester?: { name?: string; external_id?: string };
  via?: { channel?: string; source?: Record<string, unknown> };
  description?: string;
  tags?: string[];
  custom_fields?: { id: string; value: unknown }[];
}

export function parseFeedbackApiResponse(json: unknown): KB2ParsedDocument[] {
  if (!json || typeof json !== "object") return [];

  const data = json as Record<string, unknown>;
  let tickets: ZendeskTicket[] = [];

  if (Array.isArray(data)) {
    tickets = data;
  } else if ("tickets" in data && Array.isArray(data.tickets)) {
    tickets = data.tickets;
  }

  return tickets
    .filter((t) => t.subject)
    .map((ticket) => {
      const parts: string[] = [];
      parts.push(`# ${ticket.subject}`);
      parts.push("");

      const meta: string[] = [];
      if (ticket.status) meta.push(`Status: ${ticket.status}`);
      if (ticket.priority) meta.push(`Priority: ${ticket.priority}`);
      if (ticket.type) meta.push(`Type: ${ticket.type}`);
      if (ticket.via?.channel) meta.push(`Channel: ${ticket.via.channel}`);
      if (ticket.requester?.name) meta.push(`From: ${ticket.requester.name}`);
      if (meta.length) { parts.push(meta.join(" | ")); parts.push(""); }

      if (ticket.description) { parts.push(ticket.description); parts.push(""); }

      if (ticket.tags?.length) {
        parts.push(`Tags: ${ticket.tags.join(", ")}`);
      }

      const customMap: Record<string, unknown> = {};
      for (const cf of ticket.custom_fields ?? []) {
        customMap[cf.id] = cf.value;
      }

      return {
        id: `feedback-${ticket.id}`,
        provider: "customerFeedback",
        sourceType: ticket.type ?? "ticket",
        sourceId: String(ticket.id),
        title: ticket.subject,
        content: parts.join("\n").trim(),
        metadata: {
          ticketId: ticket.id,
          status: ticket.status,
          priority: ticket.priority,
          type: ticket.type,
          channel: ticket.via?.channel,
          requester: ticket.requester?.name,
          rating: (ticket.via?.source as any)?.rating,
          created: ticket.created_at,
          tags: ticket.tags,
          productArea: customMap["product_area"],
          feedbackType: customMap["feedback_type"],
        },
      };
    });
}
