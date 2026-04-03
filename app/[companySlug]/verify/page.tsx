"use client";

import { useParams } from 'next/navigation';
import { KB2VerifyPage } from '@/components/pidrax/kb2/KB2VerifyPage';
import { useLatestCompletedRunAutoRefresh } from '@/components/pidrax/kb2/useLatestCompletedRunAutoRefresh';

export default function VerifyPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  useLatestCompletedRunAutoRefresh(companySlug);
  return <KB2VerifyPage companySlug={companySlug} />;
}
