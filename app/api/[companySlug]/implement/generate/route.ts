import { NextRequest } from "next/server";
import { z } from "zod";
import { getPrimaryModel } from "@/lib/ai-model";
import { db } from "@/lib/mongodb";
import { structuredGenerate } from "@/src/application/workers/test/structured-generate";
import { PrefixLogger } from "@/lib/utils";

export const maxDuration = 120;

const HowToDocSchema = z.object({
  doc: z.object({
    ticket_id: z.string(),
    title: z.string(),
    sections: z.array(z.object({
      section_name: z.string(),
      content: z.string(),
    })),
  }),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const logger = new PrefixLogger("implement-doc");

  try {
    const { ticket_id } = await request.json();
    if (!ticket_id) {
      return Response.json({ error: "ticket_id is required" }, { status: 400 });
    }

    const project = await db.collection("projects").findOne({ companySlug });
    if (!project) {
      return Response.json({ error: "Company not found" }, { status: 404 });
    }

    const pid = project.projectId;

    // Load context: entities, relevant docs
    const [people, systems, recentDocs] = await Promise.all([
      db.collection("knowledge_entities").find({ projectId: pid, type: "person" }).limit(30).toArray(),
      db.collection("knowledge_entities").find({ projectId: pid, type: "system" }).limit(30).toArray(),
      db.collection("knowledge_documents").find({ projectId: pid }).sort({ syncedAt: -1 }).limit(20).toArray(),
    ]);

    const contextSummary = [
      "PEOPLE:\n" + people.map(p => `${p.name} — ${(p.metadata as any)?.role || "unknown role"}`).join("\n"),
      "SYSTEMS:\n" + systems.map(s => `${s.name} — ${((s.metadata as any)?.description || "").substring(0, 100)}`).join("\n"),
      "RECENT DOCS:\n" + recentDocs.map(d => `[${d.provider}] ${d.title}`).join("\n"),
    ].join("\n\n");

    const result = await structuredGenerate({
      model: getPrimaryModel(),
      schema: HowToDocSchema,
      system: `You are generating an implementation document for an engineering ticket. The doc must include:

1. Summary — what needs to be done and why
2. Implementation Instructions — exact files/modules to change, step-by-step plan, testing plan, deploy/rollout plan, rollback plan
3. Context & Decision Guide — background from company KB, decisions to make with recommendations, tradeoffs with which side to take and why
4. AI Coding Prompt — a ready-to-paste prompt for Claude Code/Cursor grounded in this company's codebase

Be specific and actionable. Reference real systems and people from the company context.`,
      prompt: `Generate implementation doc for ticket: ${ticket_id}\n\nCOMPANY CONTEXT:\n${contextSummary}`,
      maxOutputTokens: 8192,
      logger,
    });

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate implementation doc";
    return Response.json({ error: message }, { status: 500 });
  }
}
