import { NextRequest } from "next/server";
import { db } from "@/lib/mongodb";

function toProjectId(slug: string): string {
  return `newtest-${slug}-project`;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const type = searchParams.get("type"); // "inputs" | "generated" | "ground_truth"
    const session = searchParams.get("session") || "";
    const projectId = toProjectId(session);

    if (!type || !["inputs", "generated", "ground_truth", "page_plan"].includes(type)) {
      return Response.json({ error: "type must be one of: inputs, generated, ground_truth, page_plan" }, { status: 400 });
    }

    if (type === "inputs") {
      const doc = await db.collection("new_test_inputs").findOne(
        { projectId },
        { sort: { createdAt: -1 } },
      );
      return Response.json({ inputs: doc?.inputs || null, createdAt: doc?.createdAt });
    }

    if (type === "page_plan") {
      const doc = await db.collection("new_test_page_plan").findOne(
        { projectId },
        { sort: { updatedAt: -1 } },
      );
      return Response.json({ plan: doc?.plan || null, updatedAt: doc?.updatedAt });
    }

    const collectionName = type === "generated" ? "new_test_results" : "new_test_ground_truth";
    const doc = await db.collection(collectionName).findOne(
      { projectId },
      { sort: { createdAt: -1 } },
    );

    return Response.json({ data: doc?.data || null, createdAt: doc?.createdAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch results";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { session, inputs, groundTruth, pagePlan } = await request.json();
    if (!session) {
      return Response.json({ error: "session is required" }, { status: 400 });
    }
    const projectId = toProjectId(session);
    const now = new Date().toISOString();

    if (inputs) {
      await db.collection("new_test_inputs").updateOne(
        { projectId },
        { $set: { projectId, inputs, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    }

    if (groundTruth) {
      await db.collection("new_test_ground_truth").updateOne(
        { projectId },
        { $set: { projectId, data: groundTruth, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    }

    if (pagePlan) {
      await db.collection("new_test_page_plan").updateOne(
        { projectId },
        { $set: { projectId, plan: pagePlan, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    }

    return Response.json({ ok: true, savedAt: now });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save";
    return Response.json({ error: message }, { status: 500 });
  }
}
