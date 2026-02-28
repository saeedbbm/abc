"use client";

import { useParams } from "next/navigation";
import { KB2HowtoPage } from "@/components/pidrax/kb2/KB2HowtoPage";

export default function HowtoPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  return <KB2HowtoPage companySlug={companySlug} />;
}
