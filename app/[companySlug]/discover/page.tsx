"use client";

import { useParams } from "next/navigation";
import { KB2DiscoverPage } from "@/components/pidrax/kb2/KB2DiscoverPage";
import { useLatestCompletedRunAutoRefresh } from "@/components/pidrax/kb2/useLatestCompletedRunAutoRefresh";

export default function DiscoverPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  useLatestCompletedRunAutoRefresh(companySlug);
  return <KB2DiscoverPage companySlug={companySlug} />;
}
