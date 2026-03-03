"use client";

import { useParams } from 'next/navigation';
import { KB2VerifyPage } from '@/components/pidrax/kb2/KB2VerifyPage';

export default function VerifyPage() {
  const { companySlug } = useParams<{ companySlug: string }>();
  return <KB2VerifyPage companySlug={companySlug} />;
}
