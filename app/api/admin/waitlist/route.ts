import { NextRequest } from "next/server";
import { pidraxGlobalDb } from "@/lib/mongodb";

const waitlist = pidraxGlobalDb.collection("waitlist");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "pidrax-admin-2026";

export async function GET(request: NextRequest) {
  const pwd = request.nextUrl.searchParams.get("pwd") ?? "";
  if (pwd !== ADMIN_PASSWORD) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const entries = await waitlist.find({}).sort({ created_at: -1 }).toArray();
  const results = entries.map((e) => ({
    email: e.email,
    created_at: e.created_at,
    source: e.source ?? "unknown",
  }));

  return Response.json({ total: results.length, entries: results });
}
