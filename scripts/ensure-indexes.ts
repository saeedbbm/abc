import 'dotenv/config';
import { MongoClient } from 'mongodb';

const MONGODB_CONNECTION_STRING = process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017/pidrax';

interface IndexDefinition {
    key: Record<string, 1 | -1>;
    name: string;
    unique?: boolean;
}

const indexes: Record<string, IndexDefinition[]> = {
    knowledge_pages: [
        { key: { projectId: 1, category: 1 }, name: 'project_category' },
        { key: { projectId: 1, status: 1 }, name: 'project_status' },
        { key: { companySlug: 1 }, name: 'company_slug' },
    ],
    knowledge_documents: [
        { key: { projectId: 1, provider: 1 }, name: 'project_provider' },
        { key: { projectId: 1, sourceId: 1 }, name: 'project_source', unique: true },
    ],
    knowledge_entities: [
        { key: { projectId: 1, type: 1 }, name: 'project_type' },
        { key: { projectId: 1, name: 1 }, name: 'project_name' },
    ],
    oauth_tokens: [
        { key: { projectId: 1, provider: 1 }, name: 'project_provider', unique: true },
    ],
    sync_states: [
        { key: { projectId: 1, provider: 1 }, name: 'project_provider', unique: true },
    ],
    doc_audit_findings: [
        { key: { projectId: 1, status: 1 }, name: 'project_status' },
    ],
    doc_audit_runs: [
        { key: { projectId: 1, startedAt: -1 }, name: 'project_started' },
    ],
    projects: [
        { key: { companySlug: 1 }, name: 'company_slug', unique: true },
    ],
};

async function ensureIndexes() {
    const client = new MongoClient(MONGODB_CONNECTION_STRING);

    try {
        await client.connect();
        const db = client.db();

        for (const [collectionName, collectionIndexes] of Object.entries(indexes)) {
            const collection = db.collection(collectionName);

            for (const indexDef of collectionIndexes) {
                try {
                    await collection.createIndex(indexDef.key, {
                        name: indexDef.name,
                        unique: indexDef.unique ?? false,
                    });
                    console.log(`Created index '${indexDef.name}' on '${collectionName}'`);
                } catch (error: any) {
                    if (error?.code === 85 || error?.code === 86) {
                        console.log(`Index '${indexDef.name}' on '${collectionName}' already exists (compatible), skipping.`);
                    } else {
                        console.error(`Failed to create index '${indexDef.name}' on '${collectionName}':`, error);
                    }
                }
            }
        }

        console.log('\nAll indexes ensured successfully.');
    } finally {
        await client.close();
    }
}

ensureIndexes().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
