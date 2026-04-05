import { MongoClient, type Db, type Collection } from "mongodb";

const MONGODB_URI =
  process.env.MONGODB_CONNECTION_STRING || "mongodb://localhost:27017";

// ---------------------------------------------------------------------------
// Resilient singleton — survives Next.js HMR & auto-reconnects after restart
// ---------------------------------------------------------------------------
const g = globalThis as unknown as { _mongoClient?: MongoClient };

if (!g._mongoClient) {
  g._mongoClient = new MongoClient(MONGODB_URI);
}

const client: MongoClient = g._mongoClient;

// ---------------------------------------------------------------------------
// Default database (backwards-compatible)
// ---------------------------------------------------------------------------
export const db = client.db("pidrax");

// ---------------------------------------------------------------------------
// Multi-tenant database helper
// ---------------------------------------------------------------------------
const tenantDbCache = new Map<string, Db>();

export function getTenantDb(companySlug: string): Db {
  const useMultiTenant = process.env.PIDRAX_MULTI_TENANT === "true";
  if (!useMultiTenant) return db;

  const cached = tenantDbCache.get(companySlug);
  if (cached) return cached;

  const tenantDb = client.db(`pidrax_${companySlug}`);
  tenantDbCache.set(companySlug, tenantDb);
  return tenantDb;
}

// ---------------------------------------------------------------------------
// Global database (config, shared data)
// ---------------------------------------------------------------------------
export const pidraxGlobalDb = client.db("pidrax_global");

// ---------------------------------------------------------------------------
// Architecture 2 (kb2) collections — default DB for backwards compatibility
// These are used when companySlug is not in scope (e.g., direct imports).
// For tenant-scoped access, use getTenantCollections(slug).
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
export const kb2PeopleCollection = db.collection("kb2_people");
export const kb2DemoStatesCollection = db.collection("kb2_demo_states");

// Global collections (not tenant-scoped — shared across all companies)
export const kb2CompanyConfigCollection = db.collection("kb2_company_config");

export const kb2SyncCursorsCollection = db.collection("kb2_sync_cursors");
export const kb2SyncRunsCollection = db.collection("kb2_sync_runs");

// ---------------------------------------------------------------------------
// Tenant-scoped collection accessor
// ---------------------------------------------------------------------------
export interface TenantCollections {
  raw_inputs: Collection;
  input_snapshots: Collection;
  graph_nodes: Collection;
  graph_nodes_pre_resolution: Collection;
  graph_edges: Collection;
  claims: Collection;
  fact_groups: Collection;
  verification_cards: Collection;
  entity_pages: Collection;
  human_pages: Collection;
  runs: Collection;
  run_steps: Collection;
  llm_calls: Collection;
  tickets: Collection;
  howto: Collection;
  people: Collection;
  demo_states: Collection;
}

export function getTenantCollections(companySlug: string): TenantCollections {
  const tdb = getTenantDb(companySlug);
  return {
    raw_inputs: tdb.collection("kb2_raw_inputs"),
    input_snapshots: tdb.collection("kb2_input_snapshots"),
    graph_nodes: tdb.collection("kb2_graph_nodes"),
    graph_nodes_pre_resolution: tdb.collection("kb2_graph_nodes_pre_resolution"),
    graph_edges: tdb.collection("kb2_graph_edges"),
    claims: tdb.collection("kb2_claims"),
    fact_groups: tdb.collection("kb2_fact_groups"),
    verification_cards: tdb.collection("kb2_verification_cards"),
    entity_pages: tdb.collection("kb2_entity_pages"),
    human_pages: tdb.collection("kb2_human_pages"),
    runs: tdb.collection("kb2_runs"),
    run_steps: tdb.collection("kb2_run_steps"),
    llm_calls: tdb.collection("kb2_llm_calls"),
    tickets: tdb.collection("kb2_tickets"),
    howto: tdb.collection("kb2_howto"),
    people: tdb.collection("kb2_people"),
    demo_states: tdb.collection("kb2_demo_states"),
  };
}
