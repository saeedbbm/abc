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
} from "@/lib/mongodb";

const KB2_COLLECTION = "kb2_embeddings";

function extractSearchTerms(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  await params;
  const { question } = await request.json();

  const sources: { title: string; type: string }[] = [];
  const contextParts: string[] = [];

  // ---- Layer 1: Graph-aware retrieval ----
  try {
    const terms = extractSearchTerms(question);
    if (terms.length > 0) {
      const orConditions = terms.flatMap((term) => [
        { display_name: { $regex: term, $options: "i" } },
        { aliases: { $elemMatch: { $regex: term, $options: "i" } } },
      ]);

      const matchingNodes = await kb2GraphNodesCollection
        .find({ $or: orConditions })
        .limit(20)
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
          .limit(50)
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
            sources.push({ title: (n as any).display_name, type: `graph:${(n as any).type}` });
          }
        }
      }
    }
  } catch {
    // Graph query may fail if collections don't exist yet
  }

  // ---- Layer 2: Generated pages ----
  try {
    const entityPages = await kb2EntityPagesCollection.find({}).limit(20).toArray();
    const humanPages = await kb2HumanPagesCollection.find({}).limit(10).toArray();

    const pageContext = [
      ...entityPages.map((p: any) =>
        `[Entity: ${p.title}] ${p.sections?.map((s: any) => `${s.section_name}: ${s.items?.map((i: any) => i.text).join("; ")}`).join(" | ")}`,
      ),
      ...humanPages.map((p: any) =>
        `[Page: ${p.title}] ${p.paragraphs?.map((pg: any) => pg.body).join(" ")}`,
      ),
    ].join("\n\n").slice(0, 15000);

    if (pageContext) {
      contextParts.push(`=== KB Pages ===\n${pageContext}`);
    }
  } catch {
    // Pages may not exist yet
  }

  // ---- Layer 3: Vector search (embeddings) ----
  try {
    const { embeddings } = await embedMany({
      model: getEmbeddingModel(),
      values: [question],
    });

    const results = await qdrantClient.search(KB2_COLLECTION, {
      vector: embeddings[0],
      limit: 10,
      with_payload: true,
      score_threshold: 0.5,
    });

    const vectorContext = results
      .map((r: any) => {
        const payload = r.payload || {};
        sources.push({ title: payload.title || "Unknown", type: payload.provider || "kb2" });
        return `[${payload.provider}] ${payload.title}: ${(payload.text || payload.content || "").slice(0, 1000)}`;
      })
      .join("\n\n");

    if (vectorContext) {
      contextParts.push(`=== Document Chunks ===\n${vectorContext}`);
    }
  } catch {
    // Vector search may fail if collection doesn't exist yet
  }

  const ragContext = contextParts.join("\n\n").slice(0, 30000);

  const { text } = await generateText({
    model: getFastModel(),
    system: `You are a helpful assistant that answers questions about the company using the provided knowledge base context. The context comes from three layers:
1. Knowledge Graph — structured entities and their relationships (most authoritative)
2. KB Pages — generated summaries of entities and topics
3. Document Chunks — raw text from source documents (most detailed)

Prefer graph and page information for factual answers. Use document chunks for specific details, quotes, and context.
Be concise and cite sources when possible. If you don't have enough information, say so.`,
    prompt: `Context:\n${ragContext}\n\nQuestion: ${question}`,
    maxOutputTokens: 2048,
  });

  return Response.json({ answer: text, sources });
}
