import { redirect } from 'next/navigation';

export default async function KBRedirectPage({ params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  redirect(`/${companySlug}/docs`);
}
