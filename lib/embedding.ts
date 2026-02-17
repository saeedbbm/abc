import { createOpenAI } from "@ai-sdk/openai";

/**
 * Get the embedding model lazily to ensure environment variables are loaded
 */
function getEmbeddingModel() {
    const apiKey = process.env.EMBEDDING_PROVIDER_API_KEY || process.env.OPENAI_API_KEY || '';
    const baseUrl = process.env.EMBEDDING_PROVIDER_BASE_URL || undefined;
    const modelName = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

    if (!apiKey) {
        throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY or EMBEDDING_PROVIDER_API_KEY environment variable.');
    }

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
