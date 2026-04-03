"use client";

import { useParams } from 'next/navigation';
import { KB2KBPage } from '@/components/pidrax/kb2/KB2KBPage';
import { useLatestCompletedRunAutoRefresh } from '@/components/pidrax/kb2/useLatestCompletedRunAutoRefresh';

export default function KBPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  useLatestCompletedRunAutoRefresh(companySlug);
  return <KB2KBPage companySlug={companySlug} />;
}
