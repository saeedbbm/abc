import { MongoClient } from 'mongodb';
import 'dotenv/config';

const SOURCE_URI = process.env.SOURCE_MONGODB_URI || 'mongodb://localhost:27017';
const TARGET_URI = process.env.MONGODB_CONNECTION_STRING || 'mongodb://localhost:27017';

const BIX_PROJECT_ID = '41bf81ea-4ea9-4442-a7fd-9a72ac72d1f7';

async function migrate() {
  const sourceClient = new MongoClient(SOURCE_URI);
  const targetClient = new MongoClient(TARGET_URI);
  
  try {
    await sourceClient.connect();
    await targetClient.connect();
    
    const sourceDb = sourceClient.db('rowboat');
    const targetDb = targetClient.db('pidrax');
    
    const collections = [
      'knowledge_pages',
      'knowledge_documents', 
      'knowledge_entities',
      'oauth_tokens',
      'sync_states',
      'doc_audit_findings',
      'doc_audit_runs',
      'doc_audit_configs',
      'claims',
      'company_profiles',
      'knowledge_gap_queries',
    ];
    
    // Copy project record
    const project = await sourceDb.collection('projects').findOne({ _id: BIX_PROJECT_ID as any });
    if (project) {
      await targetDb.collection('projects').replaceOne(
        { _id: project._id },
        { ...project, companySlug: 'bix' },
        { upsert: true }
      );
      console.log('Copied project record');
    }
    
    for (const collName of collections) {
      const docs = await sourceDb.collection(collName)
        .find({ projectId: BIX_PROJECT_ID })
        .toArray();
      
      if (docs.length > 0) {
        const bulkOps = docs.map(doc => ({
          replaceOne: {
            filter: { _id: doc._id },
            replacement: doc,
            upsert: true,
          }
        }));
        await targetDb.collection(collName).bulkWrite(bulkOps);
      }
      
      console.log(`${collName}: copied ${docs.length} documents`);
    }
    
    console.log('Migration complete!');
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

migrate().catch(console.error);
