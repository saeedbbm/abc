import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { generateText } from "ai";
import { getFastModel } from "@/lib/ai-model";
import { getTenantCollections } from "@/lib/mongodb";
import { getCompanyConfig } from "@/src/application/lib/kb2/company-config";
import { getLatestCompletedRunId, getLatestRunIdFromCollection } from "@/src/application/lib/kb2/run-scope";
import {
  buildBaselineRunFilter,
  buildStateFilter,
  ensureWritableDemoState,
} from "@/src/application/lib/kb2/demo-state";

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
  const tc = getTenantCollections(companySlug);
  const config = await getCompanyConfig(companySlug);
  const body = await request.json();
  const { ticket_id, project_node_id } = body;
  const writableState = await ensureWritableDemoState(tc, companySlug);
  let scopedRunId =
    body.run_id
    ?? writableState.base_run_id
    ?? await getLatestRunIdFromCollection(tc, companySlug, {
      distinct: (field: string) => tc.entity_pages.distinct(field, { demo_state_id: { $exists: false } }),
    })
    ?? await getLatestRunIdFromCollection(tc, companySlug, {
      distinct: (field: string) => tc.tickets.distinct(field, { demo_state_id: { $exists: false } }),
    })
    ?? await getLatestCompletedRunId(tc, companySlug);

  const templateSections = config?.pipeline_settings?.howto?.sections ?? HOWTO_TEMPLATE_SECTIONS;

  const contextParts: string[] = [];
  let title = "How-to Guide";

  if (ticket_id) {
    const ticket = await tc.tickets.findOne({ ticket_id, ...buildStateFilter(writableState.state_id) });
    if (ticket) {
      if (typeof ticket.run_id === "string" && ticket.run_id.trim().length > 0) {
        scopedRunId = ticket.run_id;
      }
      title = `How to: ${(ticket as any).title}`;
      contextParts.push(`Ticket: ${(ticket as any).title}\nDescription: ${(ticket as any).description ?? ""}\nPriority: ${(ticket as any).priority}`);
    }
  }

  if (project_node_id) {
    const pageFilter: Record<string, unknown> = {
      node_id: project_node_id,
      ...buildStateFilter(writableState.state_id),
    };
    const page = await tc.entity_pages.findOne(pageFilter);
    if (page) {
      if (!scopedRunId && typeof (page as any).run_id === "string" && (page as any).run_id.trim().length > 0) {
        scopedRunId = (page as any).run_id;
      }
      const sections = ((page as any).sections ?? [])
        .map((s: any) => `### ${s.section_name}\n${(s.items ?? []).map((i: any) => `- ${i.text}`).join("\n")}`)
        .join("\n");
      contextParts.push(`Project: ${(page as any).title}\n${sections}`);
    }

    const edgeFilter: Record<string, unknown> = {
      $or: [{ source_node_id: project_node_id }, { target_node_id: project_node_id }],
    };
    if (scopedRunId) Object.assign(edgeFilter, buildBaselineRunFilter(scopedRunId));
    const edges = await tc.graph_edges
      .find(edgeFilter)
      .limit(config?.pipeline_settings?.howto_on_demand?.edges_limit ?? 20)
      .toArray();

    const relatedIds = new Set<string>();
    for (const e of edges) {
      relatedIds.add(e.source_node_id as string);
      relatedIds.add(e.target_node_id as string);
    }
    relatedIds.delete(project_node_id);

    if (relatedIds.size > 0) {
      const relatedNodeFilter: Record<string, unknown> = {
        node_id: { $in: [...relatedIds] },
        ...buildStateFilter(writableState.state_id),
      };
      const relatedNodes = await tc.graph_nodes
        .find(relatedNodeFilter)
        .limit(config?.pipeline_settings?.howto_on_demand?.related_nodes_limit ?? 10)
        .toArray();
      const relContext = relatedNodes
        .map((n: any) => `- ${n.type}: ${n.display_name}`)
        .join("\n");
      contextParts.push(`Related entities:\n${relContext}`);
    }
  }

  const context = contextParts.join("\n\n");

  const { text } = await generateText({
    model: getFastModel(config?.pipeline_settings?.models),
    system: config?.prompts?.howto_on_demand?.system ?? `You generate structured implementation guides. Output EXACTLY these sections separated by "## Section Name" headers:
${templateSections.map((s) => `- ${s}`).join("\n")}

For the "Prompt Section", write a structured prompt that could be given to an AI coding agent to implement this task. Include file paths, patterns to follow, and test commands.

Be concise but thorough. Use bullet points and code blocks where appropriate.`,
    prompt: `Generate an implementation guide based on this context:\n\n${context}`,
    maxOutputTokens: config?.pipeline_settings?.howto_on_demand?.max_output_tokens ?? 4096,
  });

  const sections = templateSections.map((name) => {
    const regex = new RegExp(`##\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=##\\s|$)`);
    const match = text.match(regex);
    return { section_name: name, content: match?.[1]?.trim() ?? "" };
  });

  const howtoId = randomUUID();
  const doc = {
    howto_id: howtoId,
    run_id: scopedRunId,
    demo_state_id: writableState.state_id,
    company_slug: companySlug,
    ticket_id: ticket_id ?? null,
    project_node_id: project_node_id ?? null,
    title,
    sections,
    linked_entity_ids: project_node_id ? [project_node_id] : [],
    created_at: new Date().toISOString(),
    discussion: [],
  };

  await tc.howto.insertOne(doc);

  return Response.json({ howto: doc });
}
