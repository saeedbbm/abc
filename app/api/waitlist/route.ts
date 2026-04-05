import { NextRequest } from "next/server";
import { pidraxGlobalDb } from "@/lib/mongodb";

const waitlist = pidraxGlobalDb.collection("waitlist");

export async function POST(request: NextRequest) {
  const body = await request.json();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!email || !email.includes("@")) {
    return Response.json({ error: "Invalid email" }, { status: 400 });
  }

  const existing = await waitlist.findOne({ email });
  if (existing) {
    return Response.json({ ok: true, duplicate: true });
  }

  await waitlist.insertOne({
    email,
    created_at: new Date().toISOString(),
    source: "marketing_page",
  });

  return Response.json({ ok: true });
}
