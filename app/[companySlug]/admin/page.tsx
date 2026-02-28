"use client";

import { useParams } from "next/navigation";
import { KB2AdminPage } from "@/components/pidrax/kb2/KB2AdminPage";

export default function AdminPage() {
  const { companySlug } = useParams<{ companySlug: string }>();

  if (companySlug === "brewandgo2") {
    return <KB2AdminPage companySlug={companySlug} />;
  }

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <h1 className="text-2xl font-bold mb-2">Admin Settings</h1>
        <p className="text-muted-foreground">
          Company administration panel coming soon.
        </p>
      </div>
    </div>
  );
}
