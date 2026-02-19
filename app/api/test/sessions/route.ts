import { NextRequest } from "next/server";
import { db } from "@/lib/mongodb";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function toProjectId(slug: string): string {
  return `test-${slug}-project`;
}

export async function GET() {
  try {
    const sessions = await db
      .collection("test_sessions")
      .find({})
      .sort({ updatedAt: -1 })
      .toArray();

    return Response.json({
      sessions: sessions.map((s) => ({
        name: s.name,
        slug: s.slug,
        projectId: s.projectId,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list sessions";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { name } = await request.json();

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return Response.json({ error: "Session name is required" }, { status: 400 });
    }

    const slug = toSlug(name.trim());
    if (!slug) {
      return Response.json({ error: "Invalid session name" }, { status: 400 });
    }

    const projectId = toProjectId(slug);
    const now = new Date().toISOString();

    const existing = await db.collection("test_sessions").findOne({ slug });
    if (existing) {
      await db.collection("test_sessions").updateOne({ slug }, { $set: { updatedAt: now } });
      return Response.json({
        session: { name: existing.name, slug, projectId, createdAt: existing.createdAt, updatedAt: now },
        created: false,
      });
    }

    await db.collection("test_sessions").insertOne({
      name: name.trim(),
      slug,
      projectId,
      createdAt: now,
      updatedAt: now,
    });

    return Response.json({
      session: { name: name.trim(), slug, projectId, createdAt: now, updatedAt: now },
      created: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create session";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const slug = searchParams.get("slug");

    if (!slug) {
      return Response.json({ error: "slug is required" }, { status: 400 });
    }

    const projectId = toProjectId(slug);

    await Promise.all([
      db.collection("test_sessions").deleteOne({ slug }),
      db.collection("knowledge_documents").deleteMany({ projectId }),
      db.collection("knowledge_entities").deleteMany({ projectId }),
      db.collection("test_results").deleteMany({ projectId }),
      db.collection("test_analysis").deleteMany({ projectId }),
      db.collection("projects").deleteOne({ _id: projectId }),
    ]);

    return Response.json({ deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete session";
    return Response.json({ error: message }, { status: 500 });
  }
}
