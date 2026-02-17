/**
 * Company Slug -> Project ID Resolver
 * 
 * Maps a company slug (e.g., "bix") to a projectId by looking up
 * the knowledge_pages collection for any page with that companySlug,
 * or by checking a mapping in the projects collection.
 */

import { db } from "@/lib/mongodb";

// Cache for slug -> projectId mapping (TTL: 5 minutes)
const cache = new Map<string, { projectId: string; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function resolveCompanySlug(companySlug: string): Promise<string | null> {
  // Check cache first
  const cached = cache.get(companySlug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.projectId;
  }

  try {
    // Try to find from knowledge_pages collection
    const page = await db.collection('knowledge_pages').findOne(
      { companySlug },
      { projection: { projectId: 1 } }
    );

    if (page?.projectId) {
      cache.set(companySlug, { projectId: page.projectId, expiresAt: Date.now() + CACHE_TTL });
      return page.projectId;
    }

    // Try to find from projects collection (if companySlug is stored there)
    const project = await db.collection('projects').findOne(
      { companySlug },
      { projection: { _id: 1 } }
    );

    if (project?._id) {
      const projectId = String(project._id);
      cache.set(companySlug, { projectId, expiresAt: Date.now() + CACHE_TTL });
      return projectId;
    }

    return null;
  } catch (error) {
    console.error(`Failed to resolve company slug "${companySlug}":`, error);
    return null;
  }
}

export function clearCompanyCache(companySlug?: string) {
  if (companySlug) {
    cache.delete(companySlug);
  } else {
    cache.clear();
  }
}
