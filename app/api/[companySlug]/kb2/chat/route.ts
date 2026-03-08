import { NextRequest } from "next/server";
import { generateText } from "ai";
import { getFastModel } from "@/lib/ai-model";
import { embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/ai-model";
import { qdrantClient } from "@/lib/qdrant";
import {
  kb2EntityPagesCollection,
  kb2HumanPagesCollection,
  kb2GraphNodesCollection,
  kb2GraphEdgesCollection,
  kb2TicketsCollection,
  kb2VerificationCardsCollection,
} from "@/lib/mongodb";
import { getCompanyConfig } from "@/src/application/lib/kb2/company-config";

const KB2_COLLECTION = "kb2_embeddings";

interface ContextItem {
  type: string;
  id: string;
  title: string;
}

function extractSearchTerms(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

async function loadContextItems(items: ContextItem[]): Promise<string> {
  const parts: string[] = [];

  for (const item of items) {
    try {
      if (item.type === "entity_page") {
        const page = await kb2EntityPagesCollection.findOne({ page_id: item.id });
        if (page) {
          const sections = ((page as any).sections ?? [])
            .map((s: any) => `### ${s.section_name}\n${(s.items ?? []).map((i: any) => `- ${i.text}`).join("\n")}`)
            .join("\n");
          parts.push(`[Entity Page: ${page.title}]\n${sections}`);
        }
      } else if (item.type === "ticket") {
        const ticket = await kb2TicketsCollection.findOne({ ticket_id: item.id });
        if (ticket) {
          parts.push(`[Ticket: ${ticket.title}]\nDescription: ${(ticket as any).description ?? ""}\nPriority: ${(ticket as any).priority}\nStatus: ${(ticket as any).workflow_state}`);
        }
      } else if (item.type === "verify_card") {
        const card = await kb2VerificationCardsCollection.findOne({ card_id: item.id });
        if (card) {
          parts.push(`[Verify Card: ${(card as any).title ?? item.title}]\nType: ${(card as any).card_type}\nSeverity: ${(card as any).severity}\nDescription: ${(card as any).description ?? ""}`);
        }
      } else if (item.type === "human_page") {
        const page = await kb2HumanPagesCollection.findOne({ page_id: item.id });
        if (page) {
          const body = ((page as any).paragraphs ?? []).map((p: any) => `### ${p.heading}\n${p.body}`).join("\n");
          parts.push(`[KB Page: ${page.title}]\n${body}`);
        }
      }
    } catch {
      // skip failed loads
    }
  }

  return parts.join("\n\n");
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const config = await getCompanyConfig(companySlug);
  const body = await request.json();

  const message: string = body.message ?? body.question ?? "";
  const contextItems: ContextItem[] = body.context_items ?? [];
  const conversationHistory: { role: string; content: string }[] = body.conversation_history ?? [];

  const inputSources: { source_type: string; doc_id: string; title: string; excerpt?: string }[] = [];
  const kbSources: { page_id: string; title: string; node_type: string; sections: { section_name: string; items: { text: string; confidence: string }[] }[] }[] = [];
  const seenDocIds = new Set<string>();
  const seenPageIds = new Set<string>();
  const contextParts: string[] = [];

  // Load explicitly referenced context items
  if (contextItems.length > 0) {
    const itemContext = await loadContextItems(contextItems);
    if (itemContext) {
      contextParts.push(`=== Referenced Items ===\n${itemContext}`);
    }
  }

  // Graph-aware retrieval
  try {
    const terms = extractSearchTerms(message);
    if (terms.length > 0) {
      const orConditions = terms.flatMap((term) => [
        { display_name: { $regex: term, $options: "i" } },
        { aliases: { $elemMatch: { $regex: term, $options: "i" } } },
      ]);

      const matchingNodes = await kb2GraphNodesCollection
        .find({ $or: orConditions })
        .limit(config?.pipeline_settings?.chat?.graph_node_limit ?? 20)
        .toArray();

      if (matchingNodes.length > 0) {
        const nodeIds = new Set(matchingNodes.map((n: any) => n.node_id));
        const edges = await kb2GraphEdgesCollection
          .find({
            $or: [
              { source_node_id: { $in: [...nodeIds] } },
              { target_node_id: { $in: [...nodeIds] } },
            ],
          })
          .limit(config?.pipeline_settings?.chat?.edge_limit ?? 50)
          .toArray();

        const allRelatedIds = new Set<string>();
        for (const e of edges) {
          allRelatedIds.add(e.source_node_id as string);
          allRelatedIds.add(e.target_node_id as string);
        }

        const relatedNodes = allRelatedIds.size > nodeIds.size
          ? await kb2GraphNodesCollection.find({ node_id: { $in: [...allRelatedIds] } }).toArray()
          : matchingNodes;

        const nodeById = new Map(relatedNodes.map((n: any) => [n.node_id, n]));

        const graphContext = matchingNodes.map((n: any) => {
          const nodeEdges = edges.filter(
            (e: any) => e.source_node_id === n.node_id || e.target_node_id === n.node_id,
          );
          const relationships = nodeEdges.map((e: any) => {
            const otherId = e.source_node_id === n.node_id ? e.target_node_id : e.source_node_id;
            const other = nodeById.get(otherId as string);
            return `${e.type} → ${other?.display_name ?? otherId}`;
          });

          const attrs = n.attributes
            ? Object.entries(n.attributes as Record<string, any>)
                .filter(([k]) => !k.startsWith("_"))
                .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
                .join(", ")
            : "";

          return `[${n.type}: ${n.display_name}]${attrs ? ` (${attrs})` : ""}${relationships.length > 0 ? ` | Relations: ${relationships.join("; ")}` : ""}`;
        }).join("\n");

        if (graphContext) {
          contextParts.push(`=== Knowledge Graph ===\n${graphContext}`);
          for (const n of matchingNodes) {
            for (const ref of ((n as any).source_refs ?? [])) {
              const docId = ref.doc_id ?? ref.title;
              if (!seenDocIds.has(docId)) {
                seenDocIds.add(docId);
                inputSources.push({ source_type: ref.source_type ?? "unknown", doc_id: docId, title: ref.title, excerpt: ref.excerpt });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[kb2/chat] Graph retrieval failed:", err);
  }

  // Generated pages
  try {
    const entityPages = await kb2EntityPagesCollection.find({}).limit(config?.pipeline_settings?.chat?.entity_page_limit ?? 20).toArray();
    const humanPages = await kb2HumanPagesCollection.find({}).limit(config?.pipeline_settings?.chat?.human_page_limit ?? 10).toArray();

    const pageContext = [
      ...entityPages.map((p: any) =>
        `[Entity: ${p.title}] ${p.sections?.map((s: any) => `${s.section_name}: ${s.items?.map((i: any) => i.text).join("; ")}`).join(" | ")}`,
      ),
      ...humanPages.map((p: any) =>
        `[Page: ${p.title}] ${p.paragraphs?.map((pg: any) => pg.body).join(" ")}`,
      ),
    ].join("\n\n").slice(0, config?.pipeline_settings?.chat?.page_context_length ?? 15000);

    if (pageContext) {
      contextParts.push(`=== KB Pages ===\n${pageContext}`);
    }

    for (const ep of entityPages) {
      const pid = (ep as any).page_id;
      if (!seenPageIds.has(pid)) {
        seenPageIds.add(pid);
        kbSources.push({
          page_id: pid,
          title: (ep as any).title,
          node_type: (ep as any).node_type,
          sections: ((ep as any).sections ?? []).map((s: any) => ({
            section_name: s.section_name,
            items: (s.items ?? []).map((i: any) => ({ text: i.text, confidence: i.confidence ?? "medium" })),
          })),
        });
      }
    }
  } catch (err) {
    console.error("[kb2/chat] KB pages retrieval failed:", err);
  }

  // Vector search (embeddings)
  try {
    const { embeddings } = await embedMany({
      model: getEmbeddingModel(),
      values: [message],
    });

    const results = await qdrantClient.search(KB2_COLLECTION, {
      vector: embeddings[0],
      limit: config?.pipeline_settings?.chat?.vector_limit ?? 10,
      with_payload: true,
      score_threshold: config?.pipeline_settings?.chat?.vector_score_threshold ?? 0.5,
    });

    const vectorContext = results
      .map((r: any) => {
        const payload = r.payload || {};
        const docId = payload.doc_id ?? payload.title ?? "unknown";
        if (!seenDocIds.has(docId)) {
          seenDocIds.add(docId);
          inputSources.push({
            source_type: payload.provider || "unknown",
            doc_id: docId,
            title: payload.title || "Unknown",
            excerpt: (payload.text || payload.content || "").slice(0, 300),
          });
        }
        return `[${payload.provider}] ${payload.title}: ${(payload.text || payload.content || "").slice(0, 1000)}`;
      })
      .join("\n\n");

    if (vectorContext) {
      contextParts.push(`=== Document Chunks ===\n${vectorContext}`);
    }
  } catch (err) {
    console.error("[kb2/chat] Vector search failed:", err);
  }

  const ragContext = contextParts.join("\n\n").slice(0, config?.pipeline_settings?.chat?.rag_context_length ?? 30000);

  const historyMessages = conversationHistory.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const { text } = await generateText({
    model: getFastModel(config?.pipeline_settings?.models),
    system: config?.prompts?.chat?.system ?? `You are a helpful assistant that answers questions about the company using ONLY the provided knowledge base context.

Rules:
- Answer ONLY based on the provided context. Do NOT fabricate answers, processes, or steps that are not in the context.
- If the context does not contain relevant information, say clearly: "I don't have enough information about this in the knowledge base."
- Do NOT list or append sources/references at the end of your answer — sources are displayed separately in the UI.
- Do NOT use excessive markdown bold. Use bold sparingly for key terms only.
- Use short paragraphs and bullet points for readability.
- If you reference a ticket (e.g. PAW-19), mention it naturally in the text.
- When referencing people or entities from the context, use the information as it appears — do not speculate about what they would do unless the context says so.`,
    messages: [
      ...historyMessages,
      { role: "user" as const, content: `Context:\n${ragContext}\n\nQuestion: ${message}` },
    ],
    maxOutputTokens: config?.pipeline_settings?.chat?.max_output_tokens ?? 2048,
  });

  return Response.json({ answer: text, input_sources: inputSources, kb_sources: kbSources });
}
