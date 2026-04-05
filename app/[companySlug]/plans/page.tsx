"use client";

import { useParams } from "next/navigation";
import { KB2HowtoPage } from "@/components/pidrax/kb2/KB2HowtoPage";
import { useLatestCompletedRunAutoRefresh } from "@/components/pidrax/kb2/useLatestCompletedRunAutoRefresh";

export default function PlansPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  useLatestCompletedRunAutoRefresh(companySlug);
  return <KB2HowtoPage companySlug={companySlug} />;
}
