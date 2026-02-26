import { redirect } from 'next/navigation';
import { isDemo } from '@/lib/is-demo';

export default async function CompanyPage({ params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  redirect(isDemo(companySlug) ? `/${companySlug}/chat` : `/${companySlug}/kb`);
}
