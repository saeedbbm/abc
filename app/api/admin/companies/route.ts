/**
 * Admin Companies API
 *
 * GET  /api/admin/companies  — List all onboarded companies with integration status
 * POST /api/admin/companies  — Create a new company / project
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/mongodb";
import { nanoid } from "nanoid";

export async function GET(): Promise<Response> {
  try {
    const projects = await db.collection("projects").find({}).toArray();

    const enriched = await Promise.all(
      projects.map(async (project) => {
        const projectId = String(project._id);

        // Get connected OAuth tokens
        const tokens = await db
          .collection("oauth_tokens")
          .find({ projectId })
          .toArray();

        const connectedProviders: Record<string, boolean> = {
          slack: false,
          atlassian: false,
        };
        for (const t of tokens) {
          connectedProviders[t.provider] = true;
        }

        // Get sync states
        const syncStates = await db
          .collection("sync_states")
          .find({ projectId })
          .toArray();

        const syncStatus: Record<string, any> = {};
        for (const s of syncStates) {
          syncStatus[s.provider] = {
            lastSyncAt: s.lastSyncedAt,
            status: s.status,
            totalDocuments: s.totalDocuments,
            totalEmbeddings: s.totalEmbeddings,
          };
        }

        // Count knowledge documents
        const docCount = await db
          .collection("knowledge_documents")
          .countDocuments({ projectId });

        // Count KB pages
        const pageCount = await db
          .collection("knowledge_pages")
          .countDocuments({ projectId });

        return {
          id: projectId,
          name: project.name,
          companySlug: project.companySlug,
          createdAt: project.createdAt,
          connectedProviders,
          syncStatus,
          docCount,
          pageCount,
        };
      })
    );

    return Response.json({ companies: enriched });
  } catch (error) {
    console.error("[Admin] Failed to list companies:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = await req.json();
    const { name, companySlug } = body;

    if (!name || !companySlug) {
      return Response.json(
        { error: "name and companySlug are required" },
        { status: 400 }
      );
    }

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(companySlug)) {
      return Response.json(
        { error: "companySlug must be lowercase alphanumeric with hyphens" },
        { status: 400 }
      );
    }

    // Check for duplicate slug
    const existing = await db
      .collection("projects")
      .findOne({ companySlug });
    if (existing) {
      return Response.json(
        { error: "A company with this slug already exists" },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const doc = {
      _id: id,
      name,
      companySlug,
      createdByUserId: "admin",
      secret: nanoid(),
      createdAt: now,
    };

    await db.collection("projects").insertOne(doc as any);

    return Response.json(
      {
        id,
        name,
        companySlug,
        createdAt: now,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[Admin] Failed to create company:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
