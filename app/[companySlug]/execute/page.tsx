"use client";

import { useParams } from "next/navigation";
import { KB2ExecutePage } from "@/components/pidrax/kb2/KB2ExecutePage";
import { useLatestCompletedRunAutoRefresh } from "@/components/pidrax/kb2/useLatestCompletedRunAutoRefresh";

export default function ExecutePage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  useLatestCompletedRunAutoRefresh(companySlug);
  return <KB2ExecutePage companySlug={companySlug} />;
}
