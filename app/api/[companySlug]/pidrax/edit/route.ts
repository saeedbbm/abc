import { NextRequest } from "next/server";
import { resolveCompanySlug } from "@/lib/company-resolver";
import { db } from "@/lib/mongodb";
import { getFastModel } from "@/lib/ai-model";
import { generateText } from "ai";
import type { ScoreFormatOutputType } from "@/src/entities/models/score-format";

const COLLECTION = "pidrax_pass2_results";

async function buildFilter(companySlug: string): Promise<Record<string, string>> {
  const projectId = await resolveCompanySlug(companySlug);
  if (projectId) return { projectId };
  return { companySlug };
}

function loadInstances(
  data: ScoreFormatOutputType,
  groupId: string,
): { item_id: string; page_id: string; page_title: string; section: string; current_text: string }[] {
  const instances: { item_id: string; page_id: string; page_title: string; section: string; current_text: string }[] = [];
  for (const source of ["kb_pages", "howto_pages"] as const) {
    for (const page of data[source] || []) {
      for (const section of page.sections) {
        for (const bullet of section.bullets) {
          if (bullet.group_id === groupId) {
            instances.push({
              item_id: bullet.item_id,
              page_id: page.page_id,
              page_title: page.title,
              section: section.section_name,
              current_text: bullet.item_text,
            });
          }
        }
      }
    }
  }
  return instances;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
): Promise<Response> {
  const { companySlug } = await params;
  const filter = await buildFilter(companySlug);

  try {
    const body = await request.json();
    const { group_id, user_instruction } = body;

    if (!group_id || !user_instruction) {
      return Response.json(
        { error: "group_id and user_instruction are required" },
        { status: 400 },
      );
    }

    const doc = await db.collection(COLLECTION).findOne(filter, { sort: { updatedAt: -1 } });
    if (!doc?.data) return Response.json({ error: "No pass2 results found" }, { status: 404 });

    const instances = loadInstances(doc.data as ScoreFormatOutputType, group_id);
    if (instances.length === 0) {
      return Response.json({ rewrites: [] });
    }

    const instancesBlock = instances
      .map((inst, i) => `[${i}] Page: "${inst.page_title}" | Section: "${inst.section}" | Item ID: ${inst.item_id}\nCurrent text: "${inst.current_text}"`)
      .join("\n\n");

    const { text } = await generateText({
      model: getFastModel(),
      prompt: `You are editing a knowledge base. The user wants to correct a fact that appears on multiple pages.

User instruction: "${user_instruction}"

Here are all instances of this fact across different KB pages:

${instancesBlock}

For EACH instance, produce a rewritten version that:
1. Incorporates the user's correction
2. Fits naturally in the page/section context (adapt wording to match)
3. Preserves any page-specific details that are correct

Respond with a JSON array. Each element must have:
- "index": the instance number [0], [1], etc.
- "new_text": the corrected text for that instance

Return ONLY the JSON array, no markdown fences or extra text.`,
    });

    let parsed: { index: number; new_text: string }[];
    try {
      const cleaned = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return Response.json({ error: "Failed to parse LLM response", raw: text }, { status: 500 });
    }

    const rewrites = parsed.map(p => {
      const inst = instances[p.index];
      if (!inst) return null;
      return {
        item_id: inst.item_id,
        page_id: inst.page_id,
        page_title: inst.page_title,
        section: inst.section,
        old_text: inst.current_text,
        new_text: p.new_text,
      };
    }).filter(Boolean);

    return Response.json({ rewrites });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Edit preview failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
