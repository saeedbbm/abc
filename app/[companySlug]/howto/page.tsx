import { redirect } from "next/navigation";

export default async function HowtoRedirectPage({ params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  redirect(`/${companySlug}/plans`);
}
