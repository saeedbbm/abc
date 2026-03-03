import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { generateText } from "ai";
import { getFastModel } from "@/lib/ai-model";
import {
  kb2TicketsCollection,
  kb2EntityPagesCollection,
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
  kb2HowtoCollection,
} from "@/lib/mongodb";

const HOWTO_TEMPLATE_SECTIONS = [
  "Overview",
  "Context",
  "Requirements",
  "Implementation Steps",
  "Testing Plan",
  "Risks and Considerations",
  "Prompt Section",
];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const body = await request.json();
  const { ticket_id, project_node_id } = body;

  const contextParts: string[] = [];
  let title = "How-to Guide";

  if (ticket_id) {
    const ticket = await kb2TicketsCollection.findOne({ ticket_id });
    if (ticket) {
      title = `How to: ${(ticket as any).title}`;
      contextParts.push(`Ticket: ${(ticket as any).title}\nDescription: ${(ticket as any).description ?? ""}\nPriority: ${(ticket as any).priority}`);
    }
  }

  if (project_node_id) {
    const page = await kb2EntityPagesCollection.findOne({ node_id: project_node_id });
    if (page) {
      const sections = ((page as any).sections ?? [])
        .map((s: any) => `### ${s.section_name}\n${(s.items ?? []).map((i: any) => `- ${i.text}`).join("\n")}`)
        .join("\n");
      contextParts.push(`Project: ${(page as any).title}\n${sections}`);
    }

    const edges = await kb2GraphEdgesCollection
      .find({ $or: [{ source_node_id: project_node_id }, { target_node_id: project_node_id }] })
      .limit(20)
      .toArray();

    const relatedIds = new Set<string>();
    for (const e of edges) {
      relatedIds.add(e.source_node_id as string);
      relatedIds.add(e.target_node_id as string);
    }
    relatedIds.delete(project_node_id);

    if (relatedIds.size > 0) {
      const relatedNodes = await kb2GraphNodesCollection
        .find({ node_id: { $in: [...relatedIds] } })
        .limit(10)
        .toArray();
      const relContext = relatedNodes
        .map((n: any) => `- ${n.type}: ${n.display_name}`)
        .join("\n");
      contextParts.push(`Related entities:\n${relContext}`);
    }
  }

  const context = contextParts.join("\n\n");

  const { text } = await generateText({
    model: getFastModel(),
    system: `You generate structured implementation guides. Output EXACTLY these sections separated by "## Section Name" headers:
${HOWTO_TEMPLATE_SECTIONS.map((s) => `- ${s}`).join("\n")}

For the "Prompt Section", write a structured prompt that could be given to an AI coding agent to implement this task. Include file paths, patterns to follow, and test commands.

Be concise but thorough. Use bullet points and code blocks where appropriate.`,
    prompt: `Generate an implementation guide based on this context:\n\n${context}`,
    maxOutputTokens: 4096,
  });

  const sections = HOWTO_TEMPLATE_SECTIONS.map((name) => {
    const regex = new RegExp(`##\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=##\\s|$)`);
    const match = text.match(regex);
    return { section_name: name, content: match?.[1]?.trim() ?? "" };
  });

  const howtoId = randomUUID();
  const doc = {
    howto_id: howtoId,
    company_slug: companySlug,
    ticket_id: ticket_id ?? null,
    project_node_id: project_node_id ?? null,
    title,
    sections,
    linked_entity_ids: project_node_id ? [project_node_id] : [],
    created_at: new Date().toISOString(),
    discussion: [],
  };

  await kb2HowtoCollection.insertOne(doc);

  return Response.json({ howto: doc });
}
