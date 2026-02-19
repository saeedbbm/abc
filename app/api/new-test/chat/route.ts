import { NextRequest } from "next/server";
import { getPrimaryModel } from "@/lib/ai-model";
import { streamText } from "ai";

export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a test scenario designer for Pidrax, an AI knowledge base system. Your job is to help the user define a realistic mock company scenario for testing.

You need to agree on these parameters before the user clicks "Start":
1. **Domain**: What kind of company (fintech, e-commerce, SaaS, dev tools, etc.)
2. **Tech stack**: Frontend, backend, infrastructure, databases
3. **Team size**: How many engineers, PMs, etc.
4. **Data sources**: What Confluence pages, Jira tickets, Slack conversations, GitHub repos, and customer feedback should exist
5. **Complexity**: How many gaps, conflicts, outdated items, and customer-driven features to plant
6. **Text length**: Short (8-20 lines per doc), medium (20-50), or long (50-100+)
7. **Difficulty**: Easy (obvious conflicts), medium (subtle), hard (requires multi-source synthesis)

Guide the conversation to cover all parameters. Ask clarifying questions. Suggest reasonable defaults when the user is vague. Once all parameters are agreed upon, summarize them and tell the user they can click "Start" to begin generation.

Keep responses concise and focused.`;

export async function POST(request: NextRequest) {
  try {
    const { messages } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      return Response.json({ error: "messages array is required" }, { status: 400 });
    }

    const result = streamText({
      model: getPrimaryModel(),
      system: SYSTEM_PROMPT,
      messages: messages.map((m: any) => ({
        role: m.role,
        content: m.content,
      })),
    });

    return result.toTextStreamResponse();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Chat failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
