"use client";

import { useParams } from 'next/navigation';
import { KB2ChatPage } from '@/components/pidrax/kb2/KB2ChatPage';

export default function ChatPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  return <KB2ChatPage companySlug={companySlug} />;
}
