"use client";

import { useParams } from "next/navigation";
import { KB2TicketsPage } from "@/components/pidrax/kb2/KB2TicketsPage";
import { useLatestCompletedRunAutoRefresh } from "@/components/pidrax/kb2/useLatestCompletedRunAutoRefresh";

export default function TicketsPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  useLatestCompletedRunAutoRefresh(companySlug);
  return <KB2TicketsPage companySlug={companySlug} />;
}
