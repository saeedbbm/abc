import {QdrantClient} from '@qdrant/js-client-rest';

export const qdrantClient = new QdrantClient({
    url: process.env.QDRANT_URL,
    ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    checkCompatibility: false,
});

const DEFAULT_COLLECTION = "kb2_documents";

export function getQdrantCollectionName(companySlug?: string): string {
    const useMultiTenant = process.env.PIDRAX_MULTI_TENANT === "true";
    if (!useMultiTenant || !companySlug) return DEFAULT_COLLECTION;
    return `kb2_${companySlug}_documents`;
}

export async function ensureQdrantCollection(collectionName: string, vectorSize: number = 1536): Promise<void> {
    try {
        await qdrantClient.getCollection(collectionName);
    } catch {
        await qdrantClient.createCollection(collectionName, {
            vectors: { size: vectorSize, distance: "Cosine" },
        });
    }
}
