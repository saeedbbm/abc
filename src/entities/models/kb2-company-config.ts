import type { KB2NodeType, KB2HumanPageLayer } from "./kb2-types";
import type { SectionRequirement, KB2SectionSpec, KB2PageTemplate, HumanPageCategory } from "./kb2-templates";

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export interface Acronym {
  short: string;
  full: string;
}

export interface ProfileConfig {
  company_context: string;
  company_name: string;
  business_model: "b2b" | "b2c" | "both" | "internal";
  product_type: string;
  project_prefix: string;
  acronyms: Acronym[];
  focus_areas: string[];
  exclusions: string;
  known_team_members: string[];
  known_repos: string[];
  known_client_companies: string[];
  tech_stack_notes: string;
  deployment_environments: string[];
  se_notes: string;
}

export const DEFAULT_PROFILE: ProfileConfig = {
  company_context: "",
  company_name: "",
  business_model: "b2c",
  product_type: "web_app",
  project_prefix: "",
  acronyms: [],
  focus_areas: [],
  exclusions: "",
  known_team_members: [],
  known_repos: [],
  known_client_companies: [],
  tech_stack_notes: "",
  deployment_environments: [],
  se_notes: "",
};

// ---------------------------------------------------------------------------
// People & Teams hints
// ---------------------------------------------------------------------------
export interface PersonHint {
  name: string;
  role: string;
  slack_handle: string;
  email: string;
  focus_areas: string[];
}

export interface TeamHint {
  team_name: string;
  lead: string;
  members: string[];
  responsibilities: string;
}

// ---------------------------------------------------------------------------
// KB Structure
// ---------------------------------------------------------------------------
export interface HumanPageConfig {
  category: string;
  layer: KB2HumanPageLayer;
  title: string;
  description: string;
  relatedEntityTypes: KB2NodeType[];
  order: number;
  enabled: boolean;
}

export interface LayerConfig {
  enabled: boolean;
  pages: HumanPageConfig[];
}

export interface KBStructureConfig {
  layers: Record<KB2HumanPageLayer, LayerConfig>;
}

// ---------------------------------------------------------------------------
// Entity Templates
// ---------------------------------------------------------------------------
export interface EntityTemplateConfig {
  description: string;
  includeRules: string;
  excludeRules: string;
  enabled: boolean;
  sections: KB2SectionSpec[];
}

export type EntityTemplatesConfig = Partial<Record<KB2NodeType, EntityTemplateConfig>>;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
export interface PromptsConfig {
  // Pass 1
  entity_extraction: { system: string };
  entity_resolution: { system: string };
  extraction_validation: { system_gap: string; system_judge: string; system_attr_inference: string };
  discovery: { system: string };
  graph_enrichment: { system: string };
  pattern_synthesis?: { system: string };
  generate_entity_pages: { system: string };
  generate_human_pages: { system: string };
  generate_howto: { system: string };
  extract_claims: { system: string };
  create_verify_cards: { system: string };
  // Pass 2
  cluster_factgroups: { system: string };
  conflict_detection: { system: string };
  // Features
  verify_check: { system: string };
  verify_analyst: { system: string };
  verify_editor: { system: string };
  chat: { system: string };
  ticket_generation: { system: string };
  howto_on_demand: { system: string };
  impact_analysis: { system: string };
  propagation: { system: string };
  execute_coding: { system: string };
  execute_generic: { system: string };
  // Sync
  sync_entity_extraction: { system: string } | null;
  sync_entity_resolution: { system: string } | null;
}

// ---------------------------------------------------------------------------
// Pipeline Settings
// ---------------------------------------------------------------------------
export interface EntityResolutionSettings {
  similarity_threshold: number;
  llm_batch_size: number;
  auto_merge_first_names: boolean;
  auto_merge_dotted_names: boolean;
}

export interface EntityExtractionSettings {
  default_batch_size: number;
  dense_batch_size: number;
  evidence_excerpt_max_length: number;
}

export interface DiscoverySettings {
  batch_size: number;
  content_cap_per_doc: number;
  categories_enabled: {
    past_undocumented: boolean;
    ongoing_undocumented: boolean;
    proposed_project: boolean;
    proposed_ticket: boolean;
    proposed_from_feedback: boolean;
  };
}

export interface PageGenerationSettings {
  doc_snippets_per_entity_page: number;
  vector_snippets_per_entity_page: number;
  max_entity_pages_per_human_page: number;
  paragraph_range: { min: number; max: number };
}

export interface HowtoSettings {
  sections: string[];
}

export interface SeverityLabel {
  label: string;
  color: string;
}

export interface VerificationSettings {
  batch_size: number;
  ownerable_types: KB2NodeType[];
  severity_labels: Record<string, SeverityLabel>;
  card_sections?: string[];
}

export interface Pass2Settings {
  cluster_similarity_threshold: number;
  cluster_max_pairs: number;
  conflict_batch_size: number;
  evidence_score_threshold: number;
  evidence_min_hits: number;
  propagation_chunk_size: number;
}

export interface ModelSettings {
  fast: string;
  reasoning: string;
  judge: string;
}

export interface EmbedSettings {
  chunk_size: number;
  chunk_overlap: number;
  embed_batch_size: number;
}

export interface GraphRAGSettings {
  vector_top_k: number;
  neighbor_edges_limit: number;
  related_nodes_limit: number;
  doc_snippet_length: number;
  doc_snippets_limit: number;
}

export interface GraphEnrichmentSettings {
  batch_size: number;
  edge_weight: number;
  similarity_threshold?: number;
}

export interface ChatSettings {
  graph_node_limit: number;
  edge_limit: number;
  entity_page_limit: number;
  human_page_limit: number;
  page_context_length: number;
  vector_limit: number;
  vector_score_threshold: number;
  rag_context_length: number;
  max_output_tokens: number;
}

export interface VerifyCheckSettings {
  batch_size: number;
  max_tokens: number;
}

export interface TicketGenerationSettings {
  node_limit: number;
  existing_tickets_limit: number;
  feedback_max_length: number;
}

export interface HowtoOnDemandSettings {
  edges_limit: number;
  related_nodes_limit: number;
  max_output_tokens: number;
}

export interface ImpactSettings {
  edges_limit: number;
  related_pages_limit: number;
  min_value_length: number;
}

export interface PipelineSettingsConfig {
  entity_resolution: EntityResolutionSettings;
  entity_extraction: EntityExtractionSettings;
  discovery: DiscoverySettings;
  page_generation: PageGenerationSettings;
  howto: HowtoSettings;
  verification: VerificationSettings;
  pass2: Pass2Settings;
  models: ModelSettings;
  embed: EmbedSettings;
  graphrag: GraphRAGSettings;
  graph_enrichment: GraphEnrichmentSettings;
  chat: ChatSettings;
  verify_check: VerifyCheckSettings;
  ticket_generation: TicketGenerationSettings;
  howto_on_demand: HowtoOnDemandSettings;
  impact: ImpactSettings;
}

// ---------------------------------------------------------------------------
// Data Sources
// ---------------------------------------------------------------------------
export interface SourceFilter {
  include: string[];
  exclude: string[];
}

export interface DataSourceConfig {
  source: string;
  connected: boolean;
  filters: SourceFilter;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
export interface SyncSourceConfig {
  source: string;
  enabled: boolean;
  strategy: "cursor" | "hash";
}

export interface SyncConfig {
  frequency: "hourly" | "every_6_hours" | "twice_daily" | "daily" | "manual";
  sources: SyncSourceConfig[];
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  frequency: "daily",
  sources: [
    { source: "confluence", enabled: true, strategy: "cursor" },
    { source: "jira", enabled: true, strategy: "cursor" },
    { source: "slack", enabled: true, strategy: "cursor" },
    { source: "github", enabled: true, strategy: "cursor" },
    { source: "customerFeedback", enabled: true, strategy: "hash" },
  ],
};

// ---------------------------------------------------------------------------
// Refinements
// ---------------------------------------------------------------------------
export interface EntityMergeDirective {
  keep_name: string;
  merge_names: string[];
}

export interface RefinementsConfig {
  entity_merges: EntityMergeDirective[];
  entity_removals: { display_name: string; reason: string }[];
  category_removals: { category: string; layer: KB2HumanPageLayer }[];
  category_reorder: Record<KB2HumanPageLayer, string[]>;
  page_removals: { page_id: string; reason: string }[];
  discovery_decisions: { display_name: string; accepted: boolean }[];
  general_feedback: string;
}

export const DEFAULT_REFINEMENTS: RefinementsConfig = {
  entity_merges: [],
  entity_removals: [],
  category_removals: [],
  category_reorder: {} as Record<KB2HumanPageLayer, string[]>,
  page_removals: [],
  discovery_decisions: [],
  general_feedback: "",
};

// ---------------------------------------------------------------------------
// Top-level config
// ---------------------------------------------------------------------------
export interface CompanyConfigData {
  profile: ProfileConfig;
  people_hints: PersonHint[];
  team_hints: TeamHint[];
  kb_structure: KBStructureConfig;
  entity_templates: EntityTemplatesConfig;
  prompts: PromptsConfig;
  pipeline_settings: PipelineSettingsConfig;
  data_sources: DataSourceConfig[];
  refinements: RefinementsConfig;
  sync_config: SyncConfig;
}

export interface ConfigVersion {
  version: number;
  type: "default" | "custom";
  locked: boolean;
  created_at: string;
  changed_by?: string;
  change_summary?: string;
  data: CompanyConfigData;
}

export interface CompanyConfig {
  company_slug: string;
  active_version: number;
  versions: ConfigVersion[];
}
