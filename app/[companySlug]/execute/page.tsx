"use client";

import { useParams } from "next/navigation";
import { KB2ExecutePage } from "@/components/pidrax/kb2/KB2ExecutePage";

export default function ExecutePage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  return <KB2ExecutePage companySlug={companySlug} />;
}
