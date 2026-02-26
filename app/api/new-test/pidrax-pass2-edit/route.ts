import { NextRequest } from "next/server";
import { loadGroupInstances } from "@/src/application/workers/new-test/pidrax-pass2.worker";
import { getFastModel } from "@/lib/ai-model";
import { generateText } from "ai";

function toProjectId(slug: string): string {
  return `newtest-${slug}-project`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session, group_id, user_instruction } = body;

    if (!session || !group_id || !user_instruction) {
      return Response.json(
        { error: "session, group_id, and user_instruction are required" },
        { status: 400 },
      );
    }

    const projectId = toProjectId(session);
    const { instances } = await loadGroupInstances(projectId, group_id);

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
