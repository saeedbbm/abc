"use client";

import { useParams } from 'next/navigation';
import { KB2ChatPage } from '@/components/pidrax/kb2/KB2ChatPage';
import { useLatestCompletedRunAutoRefresh } from '@/components/pidrax/kb2/useLatestCompletedRunAutoRefresh';

export default function ChatPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  useLatestCompletedRunAutoRefresh(companySlug);
  return <KB2ChatPage companySlug={companySlug} />;
}
