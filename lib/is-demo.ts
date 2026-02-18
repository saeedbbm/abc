export const DEMO_SLUG = 'pidrax';

export function isDemo(companySlug: string | undefined): boolean {
  return companySlug === DEMO_SLUG;
}
