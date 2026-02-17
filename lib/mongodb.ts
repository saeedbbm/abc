import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_CONNECTION_STRING || "mongodb://localhost:27017");

export const db = client.db("pidrax");

// Knowledge base collections
export const knowledgePagesCollection = db.collection("knowledge_pages");
export const knowledgeDocumentsCollection = db.collection("knowledge_documents");
export const knowledgeEntitiesCollection = db.collection("knowledge_entities");
export const oauthTokensCollection = db.collection("oauth_tokens");
export const syncStatesCollection = db.collection("sync_states");
export const docAuditFindingsCollection = db.collection("doc_audit_findings");
export const docAuditRunsCollection = db.collection("doc_audit_runs");
export const docAuditConfigsCollection = db.collection("doc_audit_configs");
export const knowledgeGapQueriesCollection = db.collection("knowledge_gap_queries");
export const claimsCollection = db.collection("claims");
export const projectsCollection = db.collection("projects");
export const companyProfilesCollection = db.collection("company_profiles");
