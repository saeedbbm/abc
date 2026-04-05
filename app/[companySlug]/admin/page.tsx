"use client";

import { useParams } from "next/navigation";
import { KB2AdminPage } from "@/components/pidrax/kb2/KB2AdminPage";

export default function AdminPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  return <KB2AdminPage companySlug={companySlug} />;
}
