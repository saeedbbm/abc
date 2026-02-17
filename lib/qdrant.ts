import {QdrantClient} from '@qdrant/js-client-rest';

// To connect to Qdrant running locally
export const qdrantClient = new QdrantClient({
    url: process.env.QDRANT_URL,
    ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    // Suppress version mismatch warnings between client and server
    checkCompatibility: false,
});
