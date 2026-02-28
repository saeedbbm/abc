"use client";

import { useParams } from "next/navigation";
import { KB2TicketsPage } from "@/components/pidrax/kb2/KB2TicketsPage";

export default function TicketsPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  return <KB2TicketsPage companySlug={companySlug} />;
}
