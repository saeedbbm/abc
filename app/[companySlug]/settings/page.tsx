"use client";
import { useParams } from "next/navigation";
import { KB2SettingsPage } from "@/components/pidrax/kb2/KB2SettingsPage";

export default function SettingsRoute() {
  const { companySlug } = useParams<{ companySlug: string }>();
  return <KB2SettingsPage companySlug={companySlug} />;
}
