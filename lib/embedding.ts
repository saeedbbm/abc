import { createOpenAI } from "@ai-sdk/openai";
import { getOptionalServerEnv, getServerEnv } from "@/lib/server-env";

/**
 * Get the embedding model lazily to ensure environment variables are loaded
 */
function getEmbeddingModel() {
    const apiKey = getServerEnv("EMBEDDING_PROVIDER_API_KEY", ["OPENAI_API_KEY"]);
    const baseUrl = getOptionalServerEnv("EMBEDDING_PROVIDER_BASE_URL");
    const modelName = getOptionalServerEnv("EMBEDDING_MODEL") || 'text-embedding-3-small';

    const openai = createOpenAI({
        apiKey,
        baseURL: baseUrl,
    });

    return openai.embedding(modelName);
}

// Export a proxy object that calls getEmbeddingModel() lazily
export const embeddingModel = new Proxy({} as ReturnType<typeof getEmbeddingModel>, {
    get(target, prop) {
        const model = getEmbeddingModel();
        return (model as any)[prop];
    },
});
