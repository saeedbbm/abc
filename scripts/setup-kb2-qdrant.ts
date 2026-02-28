import { qdrantClient } from "../lib/qdrant";

const KB2_COLLECTION = "kb2_embeddings";
const VECTOR_SIZE = 1536;

async function setup() {
  const collections = await qdrantClient.getCollections();
  const exists = collections.collections.some((c) => c.name === KB2_COLLECTION);

  if (exists) {
    console.log(`Collection "${KB2_COLLECTION}" already exists — skipping.`);
    return;
  }

  await qdrantClient.createCollection(KB2_COLLECTION, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
  });

  await qdrantClient.createPayloadIndex(KB2_COLLECTION, {
    field_name: "run_id",
    field_schema: "keyword",
  });
  await qdrantClient.createPayloadIndex(KB2_COLLECTION, {
    field_name: "doc_id",
    field_schema: "keyword",
  });
  await qdrantClient.createPayloadIndex(KB2_COLLECTION, {
    field_name: "provider",
    field_schema: "keyword",
  });

  console.log(`Created Qdrant collection "${KB2_COLLECTION}" (${VECTOR_SIZE}-dim, cosine).`);
}

setup().catch(console.error);
