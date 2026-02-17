import 'dotenv/config';
import { QdrantClient } from '@qdrant/js-client-rest';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

const COLLECTION_NAME = 'knowledge_embeddings';
const EMBEDDING_VECTOR_SIZE = Number(process.env.EMBEDDING_VECTOR_SIZE) || 1536;

const qdrantClient = new QdrantClient({
    url: QDRANT_URL,
    ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
});

(async () => {
    try {
        const result = await qdrantClient.createCollection(COLLECTION_NAME, {
            vectors: {
                size: EMBEDDING_VECTOR_SIZE,
                distance: 'Cosine',
            },
        });
        console.log(`Created Qdrant collection '${COLLECTION_NAME}': ${result}`);
    } catch (error: any) {
        if (error?.message?.includes('already exists')) {
            console.log(`Qdrant collection '${COLLECTION_NAME}' already exists, skipping.`);
        } else {
            console.error(`Unable to create Qdrant collection '${COLLECTION_NAME}':`, error);
            process.exit(1);
        }
    }
})();
