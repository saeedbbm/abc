import { redirect } from 'next/navigation';

export default async function CompanyPage({ params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  redirect(`/${companySlug}/docs`);
}
