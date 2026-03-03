"use client";

import { useParams } from 'next/navigation';
import { KB2KBPage } from '@/components/pidrax/kb2/KB2KBPage';

export default function KBPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  return <KB2KBPage companySlug={companySlug} />;
}
