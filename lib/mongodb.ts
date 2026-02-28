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

// ---------------------------------------------------------------------------
// Architecture 2 (kb2) -- fully separate collections
// ---------------------------------------------------------------------------
export const kb2RawInputsCollection = db.collection("kb2_raw_inputs");
export const kb2InputSnapshotsCollection = db.collection("kb2_input_snapshots");
export const kb2GraphNodesCollection = db.collection("kb2_graph_nodes");
export const kb2GraphEdgesCollection = db.collection("kb2_graph_edges");
export const kb2ClaimsCollection = db.collection("kb2_claims");
export const kb2FactGroupsCollection = db.collection("kb2_fact_groups");
export const kb2VerificationCardsCollection = db.collection("kb2_verification_cards");
export const kb2EntityPagesCollection = db.collection("kb2_entity_pages");
export const kb2HumanPagesCollection = db.collection("kb2_human_pages");
export const kb2RunsCollection = db.collection("kb2_runs");
export const kb2RunStepsCollection = db.collection("kb2_run_steps");
export const kb2LLMCallsCollection = db.collection("kb2_llm_calls");
export const kb2TicketsCollection = db.collection("kb2_tickets");
export const kb2HowtoCollection = db.collection("kb2_howto");
