import { NextRequest } from "next/server";
import { kb2CompanyConfigCollection } from "@/lib/mongodb";
import {
  getCompanyConfig,
  saveCompanyConfig,
  resetToDefault,
  getConfigVersion,
  getActiveConfigVersion,
} from "@/src/application/lib/kb2/company-config";
import type { CompanyConfig } from "@/src/entities/models/kb2-company-config";

export async function GET(request: NextRequest, { params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const versionParam = request.nextUrl.searchParams.get("version");

  if (versionParam) {
    const version = await getConfigVersion(companySlug, parseInt(versionParam, 10));
    if (!version) return Response.json({ error: "Version not found" }, { status: 404 });
    return Response.json({ version });
  }

  const config = await getCompanyConfig(companySlug);
  if (!config) return Response.json({ error: "No config found" }, { status: 404 });

  const activeVersion = await getActiveConfigVersion(companySlug);
  return Response.json({ config, active_version: activeVersion });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const body = await request.json();
  const { data, changed_by, change_summary } = body;

  if (!data) return Response.json({ error: "Missing data" }, { status: 400 });

  try {
    const newVersion = await saveCompanyConfig(companySlug, data, changed_by, change_summary);
    return Response.json({ success: true, version: newVersion });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 400 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const body = await request.json();

  if (body.action === "reset") {
    await resetToDefault(companySlug);
    return Response.json({ success: true, message: "Reset to default version" });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
