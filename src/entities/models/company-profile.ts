import { z } from "zod";

/**
 * Company Profile Model
 * 
 * A singleton document per project that represents the system's structured
 * understanding of the company as a whole. Built by the CompanyDiscoveryService
 * from all ingested Slack, Jira, and Confluence data.
 * 
 * Stored as a knowledge_document with provider='internal', sourceType='company_profile'.
 */

// Individual section with confidence tracking
export const ProfileSection = z.object({
    content: z.string(),
    confidence: z.number().default(0.5),
    sourceCount: z.number().default(0),        // How many sources contributed
    lastUpdatedAt: z.string().datetime(),
});

export type ProfileSectionType = z.infer<typeof ProfileSection>;

// A person summary within the org chart
export const OrgChartEntry = z.object({
    entityId: z.string(),                      // KnowledgeEntity ID
    name: z.string(),
    role: z.string().optional(),
    team: z.string().optional(),
    responsibilities: z.array(z.string()).default([]),
    ownsSystems: z.array(z.string()).default([]),   // system names
    slackUserId: z.string().optional(),
});

export type OrgChartEntryType = z.infer<typeof OrgChartEntry>;

// A system/service entry in the catalog
export const ServiceCatalogEntry = z.object({
    entityId: z.string(),                      // KnowledgeEntity ID
    name: z.string(),
    description: z.string().optional(),
    owner: z.string().optional(),              // person or team name
    ownerEntityId: z.string().optional(),
    technologies: z.array(z.string()).default([]),
    dependencies: z.array(z.string()).default([]),    // other system names
    status: z.enum(['active', 'deprecated', 'planned', 'unknown']).default('unknown'),
    hasDocumentation: z.boolean().default(false),
});

export type ServiceCatalogEntryType = z.infer<typeof ServiceCatalogEntry>;

// A customer entry in the portfolio
export const CustomerSummary = z.object({
    entityId: z.string(),                      // KnowledgeEntity ID
    name: z.string(),
    industry: z.string().optional(),
    healthStatus: z.string().optional(),
    projectCount: z.number().default(0),
    openIssueCount: z.number().default(0),
    accountOwner: z.string().optional(),       // person name
});

export type CustomerSummaryType = z.infer<typeof CustomerSummary>;

// A project summary
export const ProjectSummary = z.object({
    entityId: z.string(),                      // KnowledgeEntity ID
    name: z.string(),
    status: z.string().optional(),
    lead: z.string().optional(),               // person name
    teamSize: z.number().optional(),
    technologies: z.array(z.string()).default([]),
    hasDocumentation: z.boolean().default(false),
    jiraKey: z.string().optional(),
});

export type ProjectSummaryType = z.infer<typeof ProjectSummary>;

// A process summary
export const ProcessSummary = z.object({
    entityId: z.string(),                      // KnowledgeEntity ID
    name: z.string(),
    category: z.string().optional(),
    owner: z.string().optional(),              // person or team name
    frequency: z.string().optional(),
    hasDocumentation: z.boolean().default(false),
});

export type ProcessSummaryType = z.infer<typeof ProcessSummary>;

// The full company profile
export const CompanyProfile = z.object({
    projectId: z.string(),
    
    // High-level company info
    companyName: z.string().optional(),
    industry: z.string().optional(),
    productDescription: z.string().optional(),
    
    // Key metrics
    teamSize: z.number().optional(),
    customerCount: z.number().optional(),
    techStackSummary: z.array(z.string()).default([]),
    
    // Structured sections with confidence
    overview: ProfileSection.optional(),
    orgStructure: ProfileSection.optional(),
    serviceCatalog: ProfileSection.optional(),
    customerPortfolio: ProfileSection.optional(),
    activeProjects: ProfileSection.optional(),
    keyProcesses: ProfileSection.optional(),
    
    // Detailed entries for each category
    people: z.array(OrgChartEntry).default([]),
    systems: z.array(ServiceCatalogEntry).default([]),
    customers: z.array(CustomerSummary).default([]),
    projects: z.array(ProjectSummary).default([]),
    processes: z.array(ProcessSummary).default([]),
    
    // Metadata
    discoveryRunCount: z.number().default(0),
    lastFullDiscoveryAt: z.string().datetime().optional(),
    lastIncrementalUpdateAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
});

export type CompanyProfileType = z.infer<typeof CompanyProfile>;

// Source document constants
export const COMPANY_PROFILE_PROVIDER = 'internal';
export const COMPANY_PROFILE_SOURCE_TYPE = 'company_profile';
export const COMPANY_PROFILE_SOURCE_ID = 'company_profile:singleton';
