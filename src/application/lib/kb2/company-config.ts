import { kb2CompanyConfigCollection } from "@/lib/mongodb";
import {
  ENTITY_PAGE_TEMPLATES,
  STANDARD_HUMAN_PAGES,
  CLASSIFICATION_RULES,
  getSectionInstructionsKB2,
  type KB2PageTemplate,
  type HumanPageCategory,
} from "@/src/entities/models/kb2-templates";
import type { KB2NodeType } from "@/src/entities/models/kb2-types";
import type {
  CompanyConfig,
  CompanyConfigData,
  ConfigVersion,
  ProfileConfig,
  PersonHint,
  TeamHint,
  PipelineSettingsConfig,
  EntityTemplateConfig,
  PromptsConfig,
  KBStructureConfig,
  SyncConfig,
  RefinementsConfig,
  HumanPageConfig,
  DEFAULT_PROFILE,
  DEFAULT_SYNC_CONFIG,
  DEFAULT_REFINEMENTS,
} from "@/src/entities/models/kb2-company-config";
import { buildDefaultConfigData } from "./config-defaults";

// ---------------------------------------------------------------------------
// Cache (per-request, cleared on config writes)
// ---------------------------------------------------------------------------
const configCache = new Map<string, { data: CompanyConfigData; version: number; ts: number }>();
const CACHE_TTL_MS = 30_000;

function clearCache(slug: string) {
  configCache.delete(slug);
}

// ---------------------------------------------------------------------------
// Auto-seed helper
// ---------------------------------------------------------------------------
async function ensureConfigExists(companySlug: string): Promise<CompanyConfig> {
  const defaults = buildDefaultConfigData();
  const now = new Date().toISOString();

  const v1: ConfigVersion = { version: 1, type: "default", locked: true, created_at: now, data: defaults };
  const v2: ConfigVersion = { version: 2, type: "custom", locked: false, created_at: now, changed_by: "system", change_summary: "Auto-created from defaults", data: { ...defaults } };

  const newDoc: CompanyConfig = {
    company_slug: companySlug,
    active_version: 2,
    versions: [v1, v2],
  };

  await kb2CompanyConfigCollection.updateOne(
    { company_slug: companySlug },
    { $setOnInsert: newDoc } as any,
    { upsert: true },
  );

  const doc = await kb2CompanyConfigCollection.findOne({ company_slug: companySlug }) as unknown as CompanyConfig;
  return doc;
}

// ---------------------------------------------------------------------------
// Backfill missing prompt keys from defaults so the UI always shows every
// configurable prompt, even for configs created before a key was added.
// ---------------------------------------------------------------------------
function backfillPrompts(data: CompanyConfigData): CompanyConfigData {
  const defaults = buildDefaultConfigData();
  if (!defaults.prompts || !data.prompts) return data;

  let patched = false;
  const merged = { ...data.prompts } as Record<string, any>;

  for (const [stepKey, defaultEntry] of Object.entries(defaults.prompts)) {
    const existing = (merged as any)[stepKey];
    if (!existing) {
      (merged as any)[stepKey] = defaultEntry;
      patched = true;
      continue;
    }
    if (typeof defaultEntry === "object" && defaultEntry !== null) {
      for (const [subKey, subVal] of Object.entries(defaultEntry)) {
        if (!(subKey in existing)) {
          existing[subKey] = subVal;
          patched = true;
        }
      }
    }
  }

  if (!patched) return data;
  return { ...data, prompts: merged as PromptsConfig };
}

// ---------------------------------------------------------------------------
// Core reader
// ---------------------------------------------------------------------------
export async function getCompanyConfig(companySlug: string): Promise<CompanyConfigData | null> {
  const cached = configCache.get(companySlug);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  let doc = await kb2CompanyConfigCollection.findOne({ company_slug: companySlug }) as unknown as CompanyConfig | null;

  if (!doc || !doc.versions?.length) {
    doc = await ensureConfigExists(companySlug);
  }

  const activeVersion = doc.versions.find((v) => v.version === doc!.active_version);
  if (!activeVersion) return null;

  const data = backfillPrompts(activeVersion.data);
  configCache.set(companySlug, { data, version: activeVersion.version, ts: Date.now() });
  return data;
}

export async function getActiveConfigVersion(companySlug: string): Promise<number | null> {
  const doc = await kb2CompanyConfigCollection.findOne(
    { company_slug: companySlug },
    { projection: { active_version: 1 } },
  ) as unknown as { active_version: number } | null;
  return doc?.active_version ?? null;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export async function getCompanyContext(companySlug: string): Promise<string> {
  const cfg = await getCompanyConfig(companySlug);
  return cfg?.profile?.company_context ?? "";
}

export async function getProfile(companySlug: string): Promise<ProfileConfig> {
  const cfg = await getCompanyConfig(companySlug);
  if (cfg?.profile) return cfg.profile;
  return {
    company_context: "",
    company_name: "",
    business_model: "b2c",
    product_type: "web_app",
    project_prefix: "",
    acronyms: [],
    focus_areas: [],
    exclusions: "",
  };
}

// ---------------------------------------------------------------------------
// People & Teams
// ---------------------------------------------------------------------------
export async function getPeopleHints(companySlug: string): Promise<PersonHint[]> {
  const cfg = await getCompanyConfig(companySlug);
  return cfg?.people_hints ?? [];
}

export async function getTeamHints(companySlug: string): Promise<TeamHint[]> {
  const cfg = await getCompanyConfig(companySlug);
  return cfg?.team_hints ?? [];
}

// ---------------------------------------------------------------------------
// KB Structure
// ---------------------------------------------------------------------------
export async function getHumanPages(companySlug: string): Promise<HumanPageCategory[]> {
  const cfg = await getCompanyConfig(companySlug);
  if (cfg?.kb_structure) {
    const pages: HumanPageCategory[] = [];
    for (const [layer, layerCfg] of Object.entries(cfg.kb_structure.layers)) {
      if (!layerCfg.enabled) continue;
      for (const p of layerCfg.pages) {
        if (!p.enabled) continue;
        pages.push({
          category: p.category,
          layer: p.layer,
          title: p.title,
          description: p.description,
          relatedEntityTypes: p.relatedEntityTypes,
        });
      }
    }
    return pages;
  }
  return [...STANDARD_HUMAN_PAGES];
}

export async function getKBStructure(companySlug: string): Promise<KBStructureConfig | null> {
  const cfg = await getCompanyConfig(companySlug);
  return cfg?.kb_structure ?? null;
}

// ---------------------------------------------------------------------------
// Entity Templates
// ---------------------------------------------------------------------------
export async function getEntityTemplate(companySlug: string, nodeType: KB2NodeType): Promise<KB2PageTemplate | undefined> {
  const cfg = await getCompanyConfig(companySlug);
  if (cfg?.entity_templates?.[nodeType]) {
    const t = cfg.entity_templates[nodeType]!;
    if (!t.enabled) return undefined;
    return {
      description: t.description,
      includeRules: t.includeRules,
      excludeRules: t.excludeRules,
      sections: t.sections,
    };
  }
  return ENTITY_PAGE_TEMPLATES[nodeType];
}

export async function getAllEntityTemplates(companySlug: string): Promise<Partial<Record<KB2NodeType, KB2PageTemplate>>> {
  const cfg = await getCompanyConfig(companySlug);
  if (cfg?.entity_templates) {
    const result: Partial<Record<KB2NodeType, KB2PageTemplate>> = {};
    for (const [type, t] of Object.entries(cfg.entity_templates)) {
      if (!t.enabled) continue;
      result[type as KB2NodeType] = {
        description: t.description,
        includeRules: t.includeRules,
        excludeRules: t.excludeRules,
        sections: t.sections,
      };
    }
    return result;
  }
  return { ...ENTITY_PAGE_TEMPLATES };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
export async function getPrompt(companySlug: string, stepName: keyof PromptsConfig): Promise<string | null> {
  const cfg = await getCompanyConfig(companySlug);
  const promptEntry = cfg?.prompts?.[stepName];
  if (!promptEntry) return null;

  if ("system" in promptEntry) {
    let prompt = promptEntry.system;
    const context = cfg?.profile?.company_context ?? "";
    if (context) {
      prompt = prompt.replace(/\$\{company_context\}/g, context);
    } else {
      prompt = prompt.replace(/\$\{company_context\}\n?/g, "");
    }
    return prompt;
  }
  if ("system_gap" in promptEntry) return promptEntry.system_gap;
  return null;
}

export async function getPromptPair(companySlug: string, stepName: "extraction_validation"): Promise<{ system_gap: string; system_judge: string } | null> {
  const cfg = await getCompanyConfig(companySlug);
  const entry = cfg?.prompts?.extraction_validation;
  if (!entry) return null;
  return { system_gap: entry.system_gap, system_judge: entry.system_judge };
}

// ---------------------------------------------------------------------------
// Pipeline Settings
// ---------------------------------------------------------------------------
export async function getPipelineSettings(companySlug: string): Promise<PipelineSettingsConfig | null> {
  const cfg = await getCompanyConfig(companySlug);
  return cfg?.pipeline_settings ?? null;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
export async function getSyncConfig(companySlug: string): Promise<SyncConfig> {
  const cfg = await getCompanyConfig(companySlug);
  return cfg?.sync_config ?? {
    frequency: "daily",
    sources: [
      { source: "confluence", enabled: true, strategy: "cursor" },
      { source: "jira", enabled: true, strategy: "cursor" },
      { source: "slack", enabled: true, strategy: "cursor" },
      { source: "github", enabled: true, strategy: "cursor" },
      { source: "customerFeedback", enabled: true, strategy: "hash" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Refinements
// ---------------------------------------------------------------------------
export async function getRefinements(companySlug: string): Promise<RefinementsConfig> {
  const cfg = await getCompanyConfig(companySlug);
  return cfg?.refinements ?? {
    entity_merges: [],
    entity_removals: [],
    category_removals: [],
    category_reorder: {} as Record<string, string[]>,
    page_removals: [],
    discovery_decisions: [],
    general_feedback: "",
  };
}

// ---------------------------------------------------------------------------
// Config write helpers
// ---------------------------------------------------------------------------
export async function saveCompanyConfig(
  companySlug: string,
  partialData: Partial<CompanyConfigData>,
  changedBy?: string,
  changeSummary?: string,
): Promise<number> {
  clearCache(companySlug);

  let doc = await kb2CompanyConfigCollection.findOne({ company_slug: companySlug }) as unknown as CompanyConfig | null;
  if (!doc) {
    doc = await ensureConfigExists(companySlug);
  }

  const currentActive = doc.versions.find((v) => v.version === doc.active_version);
  if (!currentActive) throw new Error("Active version not found");

  const newVersion = doc.versions.length + 1;
  const newData: CompanyConfigData = {
    ...currentActive.data,
    ...partialData,
  };

  const newVersionEntry: ConfigVersion = {
    version: newVersion,
    type: "custom",
    locked: false,
    created_at: new Date().toISOString(),
    changed_by: changedBy,
    change_summary: changeSummary,
    data: newData,
  };

  await kb2CompanyConfigCollection.updateOne(
    { company_slug: companySlug },
    {
      $push: { versions: newVersionEntry },
      $set: { active_version: newVersion },
    } as any,
  );

  return newVersion;
}

export async function resetToDefault(companySlug: string): Promise<void> {
  clearCache(companySlug);
  await kb2CompanyConfigCollection.updateOne(
    { company_slug: companySlug },
    { $set: { active_version: 1 } },
  );
}

export async function getConfigVersion(companySlug: string, version: number): Promise<ConfigVersion | null> {
  const doc = await kb2CompanyConfigCollection.findOne({ company_slug: companySlug }) as unknown as CompanyConfig | null;
  if (!doc) return null;
  return doc.versions.find((v) => v.version === version) ?? null;
}
