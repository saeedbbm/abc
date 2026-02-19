/**
 * Company Discovery Service
 * 
 * Reads ALL knowledge documents and entities, then builds a structured Company
 * Knowledge Graph in multiple passes. This is the foundation for gap detection,
 * conflict detection, and documentation generation.
 * 
 * Passes:
 *   1. People & Org Structure
 *   2. Systems & Services
 *   3. Customers
 *   4. Projects (Past & Current)
 *   5. Processes
 *   6. Company Profile synthesis
 */

import { generateText, generateObject } from "ai";
import { getPrimaryModel } from "@/lib/ai-model";
import { z } from "zod";
import { PrefixLogger } from "@/lib/utils";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { KnowledgeDocumentType } from "@/src/entities/models/knowledge-document";
import { KnowledgeEntityType } from "@/src/entities/models/knowledge-entity";
import {
    CompanyProfileType,
    COMPANY_PROFILE_PROVIDER,
    COMPANY_PROFILE_SOURCE_TYPE,
    COMPANY_PROFILE_SOURCE_ID,
    OrgChartEntryType,
    ServiceCatalogEntryType,
    CustomerSummaryType,
    ProjectSummaryType,
    ProcessSummaryType,
} from "@/src/entities/models/company-profile";
import { embedKnowledgeDocument } from "@/src/application/lib/knowledge/embedding-service";

export interface DiscoveryResult {
    success: boolean;
    peopleEnriched: number;
    systemsDiscovered: number;
    customersDiscovered: number;
    projectsDiscovered: number;
    processesDiscovered: number;
    profileGenerated: boolean;
    understandingAnalysis?: string; // HTML content for "What PidraxBot Understands" page
    error?: string;
}

export class CompanyDiscoveryService {
    private docsRepo: MongoDBKnowledgeDocumentsRepository;
    private entitiesRepo: MongoDBKnowledgeEntitiesRepository;
    private logger: PrefixLogger;

    constructor(
        docsRepo: MongoDBKnowledgeDocumentsRepository,
        entitiesRepo: MongoDBKnowledgeEntitiesRepository,
        logger?: PrefixLogger
    ) {
        this.docsRepo = docsRepo;
        this.entitiesRepo = entitiesRepo;
        this.logger = logger || new PrefixLogger('company-discovery');
    }

    /**
     * Run full discovery for a project
     */
    async discover(projectId: string): Promise<DiscoveryResult> {
        this.logger.log(`Starting company discovery for project ${projectId}`);
        const result: DiscoveryResult = {
            success: false,
            peopleEnriched: 0,
            systemsDiscovered: 0,
            customersDiscovered: 0,
            projectsDiscovered: 0,
            processesDiscovered: 0,
            profileGenerated: false,
        };

        try {
            // Load all documents and entities
            const allDocs = await this.loadAllDocuments(projectId);
            const allEntities = await this.loadAllEntities(projectId);
            this.logger.log(`Loaded ${allDocs.length} documents, ${allEntities.length} entities`);

            // Pass 1: People & Org Structure
            this.logger.log('Pass 1: Enriching people & org structure...');
            result.peopleEnriched = await this.enrichPeople(projectId, allDocs, allEntities);

            // Reload entities after enrichment
            const entitiesAfterP1 = await this.loadAllEntities(projectId);

            // Pass 2: Systems & Services
            this.logger.log('Pass 2: Discovering systems & services...');
            result.systemsDiscovered = await this.discoverSystems(projectId, allDocs, entitiesAfterP1);

            // Pass 3: Customers
            this.logger.log('Pass 3: Discovering customers...');
            result.customersDiscovered = await this.discoverCustomers(projectId, allDocs, entitiesAfterP1);

            // Pass 4: Projects
            this.logger.log('Pass 4: Discovering projects...');
            result.projectsDiscovered = await this.discoverProjects(projectId, allDocs, entitiesAfterP1);

            // Pass 5: Processes
            this.logger.log('Pass 5: Discovering processes...');
            result.processesDiscovered = await this.discoverProcesses(projectId, allDocs, entitiesAfterP1);

            // Reload all entities for profile synthesis
            const finalEntities = await this.loadAllEntities(projectId);

            // Pass 6: Company Profile synthesis
            this.logger.log('Pass 6: Synthesizing company profile...');
            result.profileGenerated = await this.synthesizeProfile(projectId, allDocs, finalEntities);

            // Pass 7: Relationship Inference & Understanding Analysis
            this.logger.log('Pass 7: Building relationship inference & understanding analysis...');
            try {
                result.understandingAnalysis = await this.buildUnderstandingAnalysis(projectId, finalEntities, allDocs);
            } catch (error) {
                this.logger.log(`Understanding analysis failed (non-fatal): ${error}`);
            }

            result.success = true;
            this.logger.log(`Discovery complete: ${JSON.stringify({...result, understandingAnalysis: result.understandingAnalysis ? '(generated)' : '(none)'})}`);
            return result;

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.log(`Discovery failed: ${errorMsg}`);
            result.error = errorMsg;
            return result;
        }
    }

    // -----------------------------------------------------------------------
    // Data Loading
    // -----------------------------------------------------------------------

    private async loadAllDocuments(projectId: string): Promise<KnowledgeDocumentType[]> {
        const allDocs: KnowledgeDocumentType[] = [];
        for (const provider of ['slack', 'jira', 'confluence']) {
            const { items } = await this.docsRepo.findByProjectAndProvider(projectId, provider);
            allDocs.push(...items);
        }
        return allDocs;
    }

    private async loadAllEntities(projectId: string): Promise<KnowledgeEntityType[]> {
        const allEntities: KnowledgeEntityType[] = [];
        let cursor: string | undefined;
        do {
            const result = await this.entitiesRepo.findByProjectId(projectId, { limit: 500, cursor });
            allEntities.push(...result.items);
            cursor = result.nextCursor;
        } while (cursor);
        return allEntities;
    }

    // -----------------------------------------------------------------------
    // Pass 1: People & Org Structure
    // -----------------------------------------------------------------------

    private async enrichPeople(
        projectId: string,
        allDocs: KnowledgeDocumentType[],
        allEntities: KnowledgeEntityType[]
    ): Promise<number> {
        const people = allEntities.filter(e => e.type === 'person');
        if (people.length === 0) return 0;

        // Gather Slack user docs for title/team info
        const slackUserDocs = allDocs.filter(d => d.sourceType === 'slack_user');
        const jiraIssueDocs = allDocs.filter(d => d.sourceType === 'jira_issue');

        let enriched = 0;

        // Process people in batches of 10
        for (let i = 0; i < people.length; i += 10) {
            const batch = people.slice(i, i + 10);
            
            for (const person of batch) {
                try {
                    const metadata = person.metadata as Record<string, any>;
                    
                    // Find Slack user doc for this person
                    const slackDoc = slackUserDocs.find(d => {
                        const m = d.metadata as Record<string, any>;
                        return m.userId === metadata.slackUserId ||
                            d.title.toLowerCase().includes(person.name.toLowerCase());
                    });

                    // Find Jira issues assigned to this person
                    const assignedIssues = jiraIssueDocs.filter(d => {
                        const m = d.metadata as Record<string, any>;
                        return m.assigneeName?.toLowerCase() === person.name.toLowerCase() ||
                            m.assigneeId === metadata.jiraAccountId;
                    });

                    // Enrich with Slack profile data
                    let role = metadata.role;
                    let team = metadata.team;
                    if (slackDoc) {
                        const slackMeta = slackDoc.metadata as Record<string, any>;
                        if (!role && slackMeta.title) role = slackMeta.title;
                        if (!team && slackMeta.teamId) team = slackMeta.teamId;
                    }

                    // Enrich working-on from Jira assignments
                    const workingOn = new Set(metadata.workingOn || []);
                    for (const issue of assignedIssues.slice(0, 10)) {
                        const issueMeta = issue.metadata as Record<string, any>;
                        if (issueMeta.issueKey) {
                            workingOn.add(issueMeta.issueKey);
                        }
                    }

                    // Only update if we have new info
                    if (role !== metadata.role || team !== metadata.team || workingOn.size > (metadata.workingOn?.length || 0)) {
                        await this.entitiesRepo.update(person.id, {
                            metadata: {
                                ...metadata,
                                role: role || metadata.role,
                                team: team || metadata.team,
                                workingOn: Array.from(workingOn),
                            },
                        }, 'Enriched by company discovery');
                        enriched++;
                    }
                } catch (error) {
                    this.logger.log(`Error enriching person ${person.name}: ${error}`);
                }
            }
        }

        this.logger.log(`Enriched ${enriched}/${people.length} people`);
        return enriched;
    }

    // -----------------------------------------------------------------------
    // Pass 2: Systems & Services
    // -----------------------------------------------------------------------

    private async discoverSystems(
        projectId: string,
        allDocs: KnowledgeDocumentType[],
        allEntities: KnowledgeEntityType[]
    ): Promise<number> {
        const existingSystems = allEntities.filter(e => e.type === 'system');
        const existingNames = new Set(existingSystems.map(s => s.name.toLowerCase()));
        existingSystems.forEach(s => s.aliases.forEach(a => existingNames.add(a.toLowerCase())));

        // Gather text samples from all sources to discover systems
        const textSamples: string[] = [];
        
        // Slack conversations
        const conversations = allDocs.filter(d => d.sourceType === 'slack_conversation');
        for (const conv of conversations.slice(0, 50)) {
            textSamples.push(conv.content.substring(0, 500));
        }
        
        // Jira issues
        const jiraIssues = allDocs.filter(d => d.sourceType === 'jira_issue');
        for (const issue of jiraIssues.slice(0, 50)) {
            textSamples.push(`${issue.title}\n${issue.content.substring(0, 300)}`);
        }

        // Confluence pages
        const confluencePages = allDocs.filter(d => d.sourceType === 'confluence_page');
        for (const page of confluencePages.slice(0, 30)) {
            textSamples.push(`${page.title}\n${page.content.substring(0, 500)}`);
        }

        if (textSamples.length === 0) return 0;

        // Use LLM to extract systems from text samples in batches
        let discoveredCount = 0;
        const batchSize = 20;
        const allDiscoveredSystems: Array<{ name: string; description: string; technologies: string[]; owner: string; dependencies: string[] }> = [];

        for (let i = 0; i < textSamples.length; i += batchSize) {
            const batch = textSamples.slice(i, i + batchSize).join('\n\n---\n\n');

            try {
                const { object } = await generateObject({
                    model: getPrimaryModel(),
                    schema: z.object({
                        systems: z.array(z.object({
                            name: z.string().describe("System/service name as it appears in the text"),
                            description: z.string().describe("Brief description of what this system does"),
                            technologies: z.array(z.string()).describe("Technologies/frameworks used"),
                            owner: z.string().describe("Person or team who owns/maintains it, or empty if unknown"),
                            dependencies: z.array(z.string()).describe("Other systems this depends on"),
                        })),
                    }),
                    system: `You are extracting systems, services, tools, and infrastructure components mentioned in company communications. 
Only extract things that are clearly internal systems, services, or infrastructure (e.g., "auth-cerberus", "billing service", "ML pipeline", "kserve deployment"). 
Do NOT extract generic tools everyone uses (like "Slack", "Jira", "Chrome") unless they are hosted/managed internally.
Do NOT extract programming languages or general concepts.`,
                    prompt: `Extract all internal systems, services, and infrastructure from these texts:\n\n${batch}`,
                });

                allDiscoveredSystems.push(...object.systems);
            } catch (error) {
                this.logger.log(`Error extracting systems from batch: ${error}`);
            }
        }

        // Deduplicate and create/update entities
        const seenNames = new Set<string>();
        for (const sys of allDiscoveredSystems) {
            const normalizedName = sys.name.toLowerCase().trim();
            if (seenNames.has(normalizedName) || existingNames.has(normalizedName)) continue;
            seenNames.add(normalizedName);

            try {
                // Check if already exists by alias too
                const existingByName = await this.entitiesRepo.findByName(projectId, sys.name, 'system');
                const existingByAlias = await this.entitiesRepo.findByAlias(projectId, sys.name, 'system');
                
                if (existingByName || existingByAlias) {
                    // Update existing with new info
                    const existing = existingByName || existingByAlias!;
                    const meta = existing.metadata as Record<string, any>;
                    await this.entitiesRepo.update(existing.id, {
                        metadata: {
                            ...meta,
                            description: meta.description || sys.description,
                            technologies: [...new Set([...(meta.technologies || []), ...sys.technologies])],
                            owner: meta.owner || sys.owner || undefined,
                            dependencies: [...new Set([...(meta.dependencies || []), ...sys.dependencies])],
                        },
                    }, 'Enriched by system discovery');
                } else {
                    // Create new system entity
                    await this.entitiesRepo.bulkUpsert([{
                        projectId,
                        type: 'system',
                        name: sys.name,
                        aliases: [],
                        metadata: {
                            description: sys.description,
                            technologies: sys.technologies,
                            owner: sys.owner || undefined,
                            dependencies: sys.dependencies,
                        },
                        sources: [{
                            provider: 'manual' as const,
                            sourceType: 'discovery',
                            sourceId: `discovery:system:${normalizedName}`,
                            lastSeen: new Date().toISOString(),
                            confidence: 0.7,
                            extractedFields: [],
                        }],
                    }]);
                    discoveredCount++;
                }
            } catch (error) {
                this.logger.log(`Error creating system ${sys.name}: ${error}`);
            }
        }

        this.logger.log(`Discovered ${discoveredCount} new systems (${allDiscoveredSystems.length} total found)`);
        return discoveredCount;
    }

    // -----------------------------------------------------------------------
    // Pass 3: Customers
    // -----------------------------------------------------------------------

    private async discoverCustomers(
        projectId: string,
        allDocs: KnowledgeDocumentType[],
        allEntities: KnowledgeEntityType[]
    ): Promise<number> {
        const existingCustomers = allEntities.filter(e => e.type === 'customer');
        const existingNames = new Set(existingCustomers.map(c => c.name.toLowerCase()));

        // Gather text mentioning external companies
        const textSamples: string[] = [];

        // Look in Jira for customer-related issues
        const jiraIssues = allDocs.filter(d => d.sourceType === 'jira_issue');
        for (const issue of jiraIssues.slice(0, 80)) {
            textSamples.push(`${issue.title}\n${issue.content.substring(0, 400)}`);
        }

        // Look in Slack for customer mentions
        const conversations = allDocs.filter(d => d.sourceType === 'slack_conversation');
        for (const conv of conversations.slice(0, 50)) {
            textSamples.push(conv.content.substring(0, 500));
        }

        // Look in Confluence for customer pages
        const confluencePages = allDocs.filter(d => d.sourceType === 'confluence_page');
        for (const page of confluencePages.slice(0, 30)) {
            textSamples.push(`${page.title}\n${page.content.substring(0, 500)}`);
        }

        if (textSamples.length === 0) return 0;

        // Use LLM to extract customer mentions
        let discoveredCount = 0;
        const batch = textSamples.slice(0, 40).join('\n\n---\n\n');

        try {
            const { object } = await generateObject({
                model: getPrimaryModel(),
                schema: z.object({
                    customers: z.array(z.object({
                        name: z.string().describe("Company/organization name"),
                        industry: z.string().describe("Industry or sector, or 'unknown'"),
                        contacts: z.array(z.object({
                            name: z.string(),
                            role: z.string().optional(),
                        })).describe("Known contacts at this customer"),
                        projects: z.array(z.string()).describe("Projects or products they use"),
                        issues: z.array(z.string()).describe("Known issues or problems"),
                    })),
                }),
                system: `You are extracting external customers/clients mentioned in company communications.
Only extract EXTERNAL companies that are customers or clients of this company.
Do NOT extract the company itself, vendors, or tools.
Do NOT extract people as customers -- only companies/organizations.`,
                prompt: `Extract all external customers/clients mentioned in these texts:\n\n${batch}`,
            });

            for (const customer of object.customers) {
                const normalizedName = customer.name.toLowerCase().trim();
                if (existingNames.has(normalizedName)) continue;
                existingNames.add(normalizedName);

                try {
                    const existing = await this.entitiesRepo.findByName(projectId, customer.name, 'customer');
                    if (existing) continue;

                    await this.entitiesRepo.bulkUpsert([{
                        projectId,
                        type: 'customer',
                        name: customer.name,
                        aliases: [],
                        metadata: {
                            companyName: customer.name,
                            industry: customer.industry !== 'unknown' ? customer.industry : undefined,
                            keyContacts: customer.contacts.map(c => ({
                                name: c.name,
                                role: c.role,
                            })),
                            projects: [],
                            issueHistory: customer.issues.map(i => ({ summary: i })),
                            healthStatus: 'unknown' as const,
                            slackChannels: [],
                            confluencePages: [],
                        },
                        sources: [{
                            provider: 'manual' as const,
                            sourceType: 'discovery',
                            sourceId: `discovery:customer:${normalizedName}`,
                            lastSeen: new Date().toISOString(),
                            confidence: 0.6,
                            extractedFields: [],
                        }],
                    }]);
                    discoveredCount++;
                } catch (error) {
                    this.logger.log(`Error creating customer ${customer.name}: ${error}`);
                }
            }
        } catch (error) {
            this.logger.log(`Error extracting customers: ${error}`);
        }

        this.logger.log(`Discovered ${discoveredCount} new customers`);
        return discoveredCount;
    }

    // -----------------------------------------------------------------------
    // Pass 4: Projects
    // -----------------------------------------------------------------------

    private async discoverProjects(
        projectId: string,
        allDocs: KnowledgeDocumentType[],
        allEntities: KnowledgeEntityType[]
    ): Promise<number> {
        const existingProjects = allEntities.filter(e => e.type === 'project');
        const existingNames = new Set(existingProjects.map(p => p.name.toLowerCase()));
        existingProjects.forEach(p => p.aliases.forEach(a => existingNames.add(a.toLowerCase())));

        let discoveredCount = 0;

        // Source 1: Jira projects (these are already entities, but may need enrichment)
        const jiraProjectDocs = allDocs.filter(d => d.sourceType === 'jira_project');
        const jiraIssueDocs = allDocs.filter(d => d.sourceType === 'jira_issue');

        for (const project of existingProjects) {
            const metadata = project.metadata as Record<string, any>;
            const jiraKey = metadata.jiraKey;
            
            if (!jiraKey) continue;

            // Find issues for this project
            const projectIssues = jiraIssueDocs.filter(d => {
                const m = d.metadata as Record<string, any>;
                return m.projectKey === jiraKey;
            });

            // Extract team members, technologies, decisions from issues
            if (projectIssues.length > 0) {
                const issueTexts = projectIssues.slice(0, 20).map(d => 
                    `${d.title}\n${d.content.substring(0, 200)}`
                ).join('\n---\n');

                try {
                    const { object } = await generateObject({
                        model: getPrimaryModel(),
                        schema: z.object({
                            technologies: z.array(z.string()),
                            members: z.array(z.string()),
                            status: z.enum(['active', 'completed', 'on-hold', 'planning', 'unknown']),
                            description: z.string(),
                        }),
                        prompt: `From these Jira issues for project "${project.name}" (${jiraKey}), extract:\n\n${issueTexts}`,
                    });

                    const currentTechs = metadata.technologies || [];
                    const currentMembers = metadata.members || [];
                    const newTechs = [...new Set([...currentTechs, ...object.technologies])];
                    const newMembers = [...new Set([...currentMembers, ...object.members])];

                    if (newTechs.length > currentTechs.length || newMembers.length > currentMembers.length || !metadata.description) {
                        await this.entitiesRepo.update(project.id, {
                            metadata: {
                                ...metadata,
                                technologies: newTechs,
                                members: newMembers,
                                status: metadata.status === 'unknown' ? object.status : metadata.status,
                                description: metadata.description || object.description,
                            },
                        }, 'Enriched by project discovery');
                    }
                } catch (error) {
                    this.logger.log(`Error enriching project ${project.name}: ${error}`);
                }
            }
        }

        // Source 2: Slack channels that look like projects but aren't in Jira
        const slackChannelDocs = allDocs.filter(d => d.sourceType === 'slack_channel');
        const conversations = allDocs.filter(d => d.sourceType === 'slack_conversation');

        for (const channel of slackChannelDocs) {
            const channelMeta = channel.metadata as Record<string, any>;
            const channelName = channelMeta.channelId ? channel.title : channel.title;
            
            // Look for project-like channels (proj-, project-, feature-, etc.)
            const isProjectChannel = /^(proj|project|feature|epic|team)-/i.test(channel.title) ||
                (channelMeta.purpose && /project|feature|epic|initiative/i.test(channelMeta.purpose));
            
            if (!isProjectChannel) continue;
            
            // Check if already known
            const cleanName = channel.title.replace(/^(proj|project|feature|epic|team)-/i, '').replace(/-/g, ' ').trim();
            if (existingNames.has(cleanName.toLowerCase()) || existingNames.has(channel.title.toLowerCase())) continue;

            // Check for sustained activity (at least some conversations)
            const channelConvs = conversations.filter(c => {
                const m = c.metadata as Record<string, any>;
                return m.channelId === channelMeta.channelId || c.content.includes(channel.title);
            });

            if (channelConvs.length < 2) continue;

            try {
                await this.entitiesRepo.bulkUpsert([{
                    projectId,
                    type: 'project',
                    name: cleanName.charAt(0).toUpperCase() + cleanName.slice(1),
                    aliases: [channel.title],
                    metadata: {
                        slackChannels: [channelMeta.channelId || channel.title],
                        status: 'unknown' as const,
                        description: channelMeta.purpose || channelMeta.topic || undefined,
                        technologies: [],
                        members: [],
                    },
                    sources: [{
                        provider: 'slack' as const,
                        sourceType: 'channel_discovery',
                        sourceId: `discovery:project:${channel.title}`,
                        lastSeen: new Date().toISOString(),
                        confidence: 0.6,
                        extractedFields: [],
                    }],
                }]);
                discoveredCount++;
                existingNames.add(cleanName.toLowerCase());
            } catch (error) {
                this.logger.log(`Error creating project from channel ${channel.title}: ${error}`);
            }
        }

        this.logger.log(`Discovered ${discoveredCount} new projects, enriched existing ones`);
        return discoveredCount;
    }

    // -----------------------------------------------------------------------
    // Pass 5: Processes
    // -----------------------------------------------------------------------

    private async discoverProcesses(
        projectId: string,
        allDocs: KnowledgeDocumentType[],
        allEntities: KnowledgeEntityType[]
    ): Promise<number> {
        const existingProcesses = allEntities.filter(e => e.type === 'process');
        const existingNames = new Set(existingProcesses.map(p => p.name.toLowerCase()));

        // Gather text about processes from all sources
        const textSamples: string[] = [];

        // Confluence pages about processes
        const confluencePages = allDocs.filter(d => d.sourceType === 'confluence_page');
        for (const page of confluencePages) {
            const titleLower = page.title.toLowerCase();
            const contentLower = page.content.toLowerCase();
            const isProcess = /how to|runbook|procedure|sop|process|guide|onboarding|deployment|release|incident/i.test(titleLower) ||
                /step 1|step 2|prerequisites|instructions/i.test(contentLower.substring(0, 500));
            if (isProcess) {
                textSamples.push(`[Confluence: ${page.title}]\n${page.content.substring(0, 600)}`);
            }
        }

        // Slack messages about processes
        const conversations = allDocs.filter(d => d.sourceType === 'slack_conversation');
        for (const conv of conversations) {
            const contentLower = conv.content.toLowerCase();
            const isProcessRelated = /deploy|release|code freeze|on-call|onboarding|incident|rollback|migration/i.test(contentLower);
            if (isProcessRelated) {
                textSamples.push(`[Slack conversation]\n${conv.content.substring(0, 400)}`);
            }
        }

        if (textSamples.length === 0) return 0;

        let discoveredCount = 0;
        const batch = textSamples.slice(0, 30).join('\n\n---\n\n');

        try {
            const { object } = await generateObject({
                model: getPrimaryModel(),
                schema: z.object({
                    processes: z.array(z.object({
                        name: z.string().describe("Process name (e.g., 'Code Freeze', 'On-Call Rotation', 'Release Process')"),
                        description: z.string().describe("Brief description of the process"),
                        category: z.string().describe("Category like deployment, release, onboarding, incident-response, on-call, code-review, testing, monitoring, security, compliance, other"),
                        owner: z.string().describe("Person or team responsible, or empty string if unknown"),
                        frequency: z.string().describe("How often: daily, weekly, biweekly, monthly, quarterly, yearly, ad-hoc, or unknown"),
                        tools: z.array(z.string()).describe("Tools/systems used in this process"),
                        steps: z.array(z.string()).describe("Key steps if identifiable"),
                    })),
                }),
                system: `You are extracting business and engineering processes from company communications.
Extract recurring processes, procedures, and workflows that the company follows.
Focus on things like deployments, releases, on-call, onboarding, incident response, code reviews, etc.
Do NOT extract one-time tasks or individual actions.`,
                prompt: `Extract all processes and procedures mentioned:\n\n${batch}`,
            });

            for (const process of object.processes) {
                const normalizedName = process.name.toLowerCase().trim();
                if (existingNames.has(normalizedName)) continue;
                existingNames.add(normalizedName);

                try {
                    const existing = await this.entitiesRepo.findByName(projectId, process.name, 'process');
                    if (existing) continue;

                    // Map free-form LLM values to valid enum values for storage
                    const validCategories = ['deployment', 'release', 'onboarding', 'incident-response', 'on-call', 'code-review', 'testing', 'monitoring', 'security', 'compliance', 'other'] as const;
                    const validFrequencies = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'ad-hoc', 'unknown'] as const;
                    const mappedCategory = validCategories.find(c => process.category.toLowerCase().includes(c)) || 'other';
                    const mappedFrequency = validFrequencies.find(f => process.frequency.toLowerCase().includes(f)) || 'unknown';

                    await this.entitiesRepo.bulkUpsert([{
                        projectId,
                        type: 'process',
                        name: process.name,
                        aliases: [],
                        metadata: {
                            description: process.description,
                            category: mappedCategory,
                            owner: process.owner || undefined,
                            frequency: mappedFrequency,
                            tools: process.tools,
                            steps: process.steps,
                            relatedSystems: [],
                            documentationLinks: [],
                            participants: [],
                            prerequisites: [],
                        },
                        sources: [{
                            provider: 'manual' as const,
                            sourceType: 'discovery',
                            sourceId: `discovery:process:${normalizedName}`,
                            lastSeen: new Date().toISOString(),
                            confidence: 0.6,
                            extractedFields: [],
                        }],
                    }]);
                    discoveredCount++;
                } catch (error) {
                    this.logger.log(`Error creating process ${process.name}: ${error}`);
                }
            }
        } catch (error) {
            this.logger.log(`Error extracting processes: ${error}`);
        }

        this.logger.log(`Discovered ${discoveredCount} new processes`);
        return discoveredCount;
    }

    // -----------------------------------------------------------------------
    // Pass 6: Company Profile Synthesis
    // -----------------------------------------------------------------------

    private async synthesizeProfile(
        projectId: string,
        allDocs: KnowledgeDocumentType[],
        allEntities: KnowledgeEntityType[]
    ): Promise<boolean> {
        const now = new Date().toISOString();
        const people = allEntities.filter(e => e.type === 'person');
        const systems = allEntities.filter(e => e.type === 'system');
        const customers = allEntities.filter(e => e.type === 'customer');
        const projects = allEntities.filter(e => e.type === 'project');
        const processes = allEntities.filter(e => e.type === 'process');

        // Build summaries for each category
        const orgChartEntries: OrgChartEntryType[] = people.map(p => {
            const m = p.metadata as Record<string, any>;
            return {
                entityId: p.id,
                name: p.name,
                role: m.role,
                team: m.team,
                responsibilities: m.responsibilities || [],
                ownsSystems: [],
                slackUserId: m.slackUserId,
            };
        });

        const serviceCatalogEntries: ServiceCatalogEntryType[] = systems.map(s => {
            const m = s.metadata as Record<string, any>;
            return {
                entityId: s.id,
                name: s.name,
                description: m.description,
                owner: m.owner,
                technologies: m.technologies || [],
                dependencies: m.dependencies || [],
                status: 'active' as const,
                hasDocumentation: false,
            };
        });

        const customerSummaries: CustomerSummaryType[] = customers.map(c => {
            const m = c.metadata as Record<string, any>;
            return {
                entityId: c.id,
                name: c.name,
                industry: m.industry,
                healthStatus: m.healthStatus,
                projectCount: (m.projects || []).length,
                openIssueCount: (m.issueHistory || []).length,
                accountOwner: m.accountOwner,
            };
        });

        const projectSummaries: ProjectSummaryType[] = projects.map(p => {
            const m = p.metadata as Record<string, any>;
            return {
                entityId: p.id,
                name: p.name,
                status: m.status,
                lead: m.lead,
                teamSize: (m.members || []).length,
                technologies: m.technologies || [],
                hasDocumentation: false,
                jiraKey: m.jiraKey,
            };
        });

        const processSummaries: ProcessSummaryType[] = processes.map(pr => {
            const m = pr.metadata as Record<string, any>;
            return {
                entityId: pr.id,
                name: pr.name,
                category: m.category,
                owner: m.owner,
                frequency: m.frequency,
                hasDocumentation: false,
            };
        });

        // Generate company overview using LLM
        const entitySummary = [
            `People (${people.length}): ${people.map(p => p.name).join(', ')}`,
            `Systems (${systems.length}): ${systems.map(s => s.name).join(', ')}`,
            `Customers (${customers.length}): ${customers.map(c => c.name).join(', ')}`,
            `Projects (${projects.length}): ${projects.map(p => p.name).join(', ')}`,
            `Processes (${processes.length}): ${processes.map(p => p.name).join(', ')}`,
        ].join('\n');

        // Get some confluence page titles for context
        const confluencePages = allDocs.filter(d => d.sourceType === 'confluence_page');
        const pageTitles = confluencePages.slice(0, 20).map(p => p.title).join(', ');

        let overview = '';
        let companyName = '';
        let industry = '';
        let productDescription = '';

        try {
            const { text } = await generateText({
                model: getPrimaryModel(),
                system: `You are analyzing a company based on its internal data. Generate a structured company overview.
Output in this exact format:
COMPANY_NAME: [name]
INDUSTRY: [industry]
PRODUCT: [what the company builds/sells in 1-2 sentences]
OVERVIEW: [2-3 paragraph overview of the company, its teams, what they do, key systems, and current projects]`,
                prompt: `Based on the following data from the company's internal tools, describe this company:

Entities found:
${entitySummary}

Confluence page titles: ${pageTitles}

Tech stack mentioned: ${[...new Set(systems.flatMap(s => (s.metadata as any).technologies || []))].join(', ')}`,
                maxOutputTokens: 800,
            });

            // Parse response
            const nameMatch = text.match(/COMPANY_NAME:\s*(.+)/);
            const industryMatch = text.match(/INDUSTRY:\s*(.+)/);
            const productMatch = text.match(/PRODUCT:\s*(.+)/);
            const overviewMatch = text.match(/OVERVIEW:\s*([\s\S]+)/);

            companyName = nameMatch?.[1]?.trim() || '';
            industry = industryMatch?.[1]?.trim() || '';
            productDescription = productMatch?.[1]?.trim() || '';
            overview = overviewMatch?.[1]?.trim() || '';
        } catch (error) {
            this.logger.log(`Error generating company overview: ${error}`);
            overview = `Company with ${people.length} people, ${systems.length} systems, ${customers.length} customers, ${projects.length} projects.`;
        }

        // Build the profile
        const profile: CompanyProfileType = {
            projectId,
            companyName,
            industry,
            productDescription,
            teamSize: people.length,
            customerCount: customers.length,
            techStackSummary: [...new Set(systems.flatMap(s => (s.metadata as any).technologies || []))],
            overview: {
                content: overview,
                confidence: 0.6,
                sourceCount: allDocs.length,
                lastUpdatedAt: now,
            },
            people: orgChartEntries,
            systems: serviceCatalogEntries,
            customers: customerSummaries,
            projects: projectSummaries,
            processes: processSummaries,
            discoveryRunCount: 1,
            lastFullDiscoveryAt: now,
            createdAt: now,
            updatedAt: now,
        };

        // Store as a knowledge document
        const profileContent = this.buildProfileContent(profile);
        const existing = await this.docsRepo.findBySourceId(
            projectId,
            COMPANY_PROFILE_PROVIDER,
            COMPANY_PROFILE_SOURCE_ID
        );

        if (existing) {
            await this.docsRepo.update(existing.id, {
                content: profileContent,
                metadata: profile as any,
                sourceUpdatedAt: now,
            });
            this.logger.log('Updated existing company profile');
        } else {
            const doc = await this.docsRepo.create({
                projectId,
                provider: COMPANY_PROFILE_PROVIDER,
                sourceType: COMPANY_PROFILE_SOURCE_TYPE,
                sourceId: COMPANY_PROFILE_SOURCE_ID,
                title: `Company Profile: ${companyName || 'Unknown'}`,
                content: profileContent,
                metadata: profile as any,
                entityRefs: [],
                syncedAt: now,
            });
            // Embed the profile
            await embedKnowledgeDocument(doc, this.logger);
            this.logger.log('Created new company profile');
        }

        return true;
    }

    /**
     * Build human-readable content from the company profile
     */
    private buildProfileContent(profile: CompanyProfileType): string {
        const lines: string[] = [];

        lines.push(`# Company Profile: ${profile.companyName || 'Unknown'}`);
        lines.push('');
        if (profile.industry) lines.push(`Industry: ${profile.industry}`);
        if (profile.productDescription) lines.push(`Product: ${profile.productDescription}`);
        lines.push(`Team size: ${profile.teamSize || 'unknown'}`);
        lines.push(`Customers: ${profile.customerCount || 0}`);
        if (profile.techStackSummary.length > 0) {
            lines.push(`Tech stack: ${profile.techStackSummary.join(', ')}`);
        }
        lines.push('');

        if (profile.overview?.content) {
            lines.push('## Overview');
            lines.push(profile.overview.content);
            lines.push('');
        }

        if (profile.people.length > 0) {
            lines.push('## People');
            for (const p of profile.people) {
                const role = p.role ? ` - ${p.role}` : '';
                const team = p.team ? ` (${p.team})` : '';
                lines.push(`- ${p.name}${role}${team}`);
            }
            lines.push('');
        }

        if (profile.systems.length > 0) {
            lines.push('## Systems & Services');
            for (const s of profile.systems) {
                const desc = s.description ? `: ${s.description}` : '';
                const owner = s.owner ? ` [owner: ${s.owner}]` : '';
                lines.push(`- ${s.name}${desc}${owner}`);
            }
            lines.push('');
        }

        if (profile.customers.length > 0) {
            lines.push('## Customers');
            for (const c of profile.customers) {
                const industry = c.industry ? ` (${c.industry})` : '';
                lines.push(`- ${c.name}${industry}`);
            }
            lines.push('');
        }

        if (profile.projects.length > 0) {
            lines.push('## Projects');
            for (const p of profile.projects) {
                const status = p.status ? ` [${p.status}]` : '';
                const jira = p.jiraKey ? ` (${p.jiraKey})` : '';
                lines.push(`- ${p.name}${jira}${status}`);
            }
            lines.push('');
        }

        if (profile.processes.length > 0) {
            lines.push('## Processes');
            for (const p of profile.processes) {
                const freq = p.frequency ? ` (${p.frequency})` : '';
                lines.push(`- ${p.name}${freq}`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    // -----------------------------------------------------------------------
    // Pass 7: Relationship Inference & Understanding Analysis
    // -----------------------------------------------------------------------

    // Bot/junk name patterns to filter from the understanding page
    private static readonly JUNK_PATTERNS = [
        /\bwidget$/i, /\banalytics\b.*system/i, /^confluence\b/i, /\bnotification/i,
        /\bmigrator$/i, /\bautomation\b/i, /\bbot$/i, /^opsgenie\b/i, /^statuspage\b/i,
        /^bitbucket\b/i, /^microsoft\s+teams\b/i, /^fake-system/i, /^app[_-]/i,
        /\bspreadsheet/i, /^slackbot$/i, /^pidraxbot$/i, /^atlas\b/i, /^atlassian\b/i,
        /^jira\b/i, /^slack$/i, /^trello$/i, /^system$/i, /^proforma/i, /^chat\b/i,
    ];

    private isJunkEntity(entity: KnowledgeEntityType): boolean {
        const name = entity.name;
        if (CompanyDiscoveryService.JUNK_PATTERNS.some(p => p.test(name))) return true;
        // Filter out Slack channel IDs, team IDs, etc.
        if (/^[A-Z][0-9A-Z]{8,}$/.test(name)) return true; // e.g. T0AD12345
        if (/^[a-z0-9._-]+$/i.test(name) && name.length > 20) return true; // long machine IDs
        return false;
    }

    private isRealPerson(entity: KnowledgeEntityType): boolean {
        if (this.isJunkEntity(entity)) return false;
        const name = entity.name;
        // Real people have first + last name pattern
        if (name.includes(' ') && name.split(' ').length >= 2) return true;
        // Or email-like with a dot
        if (name.includes('.') && name.length < 40) return true;
        return false;
    }

    /**
     * Builds a comprehensive "What PidraxBot Understands" analysis.
     * 
     * Uses domain expertise to: list facts with sources, infer architecture,
     * identify missing pieces with specific guesses, and ask sharp questions.
     * 
     * Returns Confluence-compatible HTML for a single page.
     */
    private async buildUnderstandingAnalysis(
        projectId: string,
        allEntities: KnowledgeEntityType[],
        allDocs: KnowledgeDocumentType[]
    ): Promise<string> {
        // --- Clean entity lists: filter out junk ---
        const people = allEntities.filter(e => e.type === 'person' && this.isRealPerson(e));
        const systems = allEntities.filter(e => e.type === 'system' && !this.isJunkEntity(e));
        const projects = allEntities.filter(e => e.type === 'project' && !this.isJunkEntity(e));
        const customers = allEntities.filter(e => e.type === 'customer' && !this.isJunkEntity(e));
        const processes = allEntities.filter(e => e.type === 'process' && !this.isJunkEntity(e));

        // --- Build clean, detailed entity summaries with source links ---
        const buildEntityBlock = (entity: KnowledgeEntityType) => {
            const meta = entity.metadata as Record<string, any>;
            const lines: string[] = [`  Name: ${entity.name}`];
            if (entity.aliases?.length > 0) lines.push(`  Aliases: ${entity.aliases.join(', ')}`);
            if (meta.description) lines.push(`  Description: ${meta.description}`);
            if (meta.role) lines.push(`  Role: ${meta.role}`);
            if (meta.responsibilities?.length) lines.push(`  Responsibilities: ${meta.responsibilities.join(', ')}`);
            if (meta.workingOn?.length) lines.push(`  Working on: ${meta.workingOn.join(', ')}`);
            if (meta.skills?.length) lines.push(`  Skills: ${meta.skills.join(', ')}`);
            if (meta.technologies?.length) lines.push(`  Technologies: ${meta.technologies.join(', ')}`);
            if (meta.dependencies?.length) lines.push(`  Dependencies: ${meta.dependencies.join(', ')}`);
            if (meta.owner) lines.push(`  Owner: ${meta.owner}`);
            if (meta.companyName) lines.push(`  Company: ${meta.companyName}`);
            if (meta.industry) lines.push(`  Industry: ${meta.industry}`);
            if (meta.keyContacts?.length) lines.push(`  Key contacts: ${meta.keyContacts.map((c: any) => c.name || c).join(', ')}`);
            if (meta.status) lines.push(`  Status: ${meta.status}`);
            if (meta.relatedSystems?.length) lines.push(`  Related systems: ${meta.relatedSystems.join(', ')}`);
            if (meta.frequency) lines.push(`  Frequency: ${meta.frequency}`);
            if (meta.steps?.length) lines.push(`  Steps: ${meta.steps.join(' → ')}`);
            // Source summary (provider only, no internal IDs)
            const providers = [...new Set(entity.sources.map(s => s.provider))];
            if (providers.length > 0) lines.push(`  Found in: ${providers.join(', ')}`);
            return lines.join('\n');
        };

        // --- Gather the BEST conversation snippets with actual URLs ---
        const slackMessages = allDocs
            .filter(d => d.sourceType === 'slack_message' && d.content.length > 50)
            .sort((a, b) => b.content.length - a.content.length)
            .slice(0, 30);
        const slackSnippets = slackMessages.map(d => {
            const meta = d.metadata as Record<string, any>;
            const url = meta?.url || '';
            const channel = meta?.channelName || 'unknown';
            return `[Slack #${channel}]${url ? ` (${url})` : ''}: ${d.content.substring(0, 300)}`;
        }).join('\n\n');

        const jiraDocs = allDocs.filter(d => d.sourceType === 'jira_issue').slice(0, 15);
        const jiraSnippets = jiraDocs.map(d => {
            const meta = d.metadata as Record<string, any>;
            const url = meta?.url || '';
            return `[Jira: ${d.title}]${url ? ` (${url})` : ''}: ${d.content.substring(0, 300)}`;
        }).join('\n\n');

        const confluenceDocs = allDocs.filter(d => d.sourceType === 'confluence_page');
        const confluenceSnippets = confluenceDocs.map(d => {
            const meta = d.metadata as Record<string, any>;
            const url = meta?.url || '';
            return `[Confluence: ${d.title}]${url ? ` (${url})` : ''}: ${d.content.substring(0, 400)}`;
        }).join('\n\n');

        // --- Build the prompt ---
        const prompt = `You are PidraxBot. You have ingested ALL of a company's Slack messages, Jira tickets, and Confluence pages. Below is everything you know.

Your job is to write a single document that:
1. States every confirmed fact and cites where you found it (with clickable source links where available)
2. Uses your deep domain expertise to INFER the architecture, connecting the dots
3. For each section, FIRST lists what you know, THEN explains what is missing and asks sharp, hypothesis-driven questions

You are an expert software architect. You know that:
- If kserve exists, there MUST be Kubernetes, a model registry, and ML model artifacts somewhere
- If MongoDB exists, there MUST be a backend framework (Node.js/Python/Java) connecting to it
- If there's a billing service, there MUST be a payment processor (Stripe/Braintree) and billing model
- If there's auth-cerberus, there MUST be an auth protocol (OAuth2/JWT/SAML) and user store
- ML Pipeline + kserve together imply model training, feature engineering, model serving, and monitoring
- Every production system needs CI/CD, monitoring, logging, and alerting

Use this knowledge to fill in the gaps with your best guesses, then ask specific questions to confirm.

=== PEOPLE ===
${people.map(buildEntityBlock).join('\n---\n')}

=== SYSTEMS & SERVICES ===
${systems.map(buildEntityBlock).join('\n---\n')}

=== PROJECTS ===
${projects.map(buildEntityBlock).join('\n---\n')}

=== CUSTOMERS ===
${customers.map(buildEntityBlock).join('\n---\n')}

=== PROCESSES ===
${processes.map(buildEntityBlock).join('\n---\n')}

=== SLACK CONVERSATIONS (with URLs) ===
${slackSnippets}

=== JIRA TICKETS (with URLs) ===
${jiraSnippets}

=== CONFLUENCE PAGES (with URLs) ===
${confluenceSnippets}

---

Generate a Confluence-compatible HTML document with these sections. For EACH section:

STRUCTURE EACH SECTION LIKE THIS:
1. <h3>What I Know (Confirmed Facts)</h3> — List every fact with a source link. Use <a href="URL">Source: Slack #channel-name</a> or <a href="URL">Source: Confluence page title</a>. If no URL is available, write [Source: provider].
2. <h3>What I Think Is Going On (Inferences)</h3> — Based on the facts above, explain what the architecture MUST look like. Use your domain knowledge. Be specific: "Because you have kserve and an ML Pipeline, you are almost certainly running Kubernetes. The ML Pipeline likely trains models that get deployed to kserve as InferenceServices. This means you need a model registry (probably S3, MinIO, or MLflow) to store model artifacts."
3. <h3>What's Missing & My Questions</h3> — For each gap, write it as: "Because I found [fact X from source Y], I believe [inference]. But I don't know [specific gap]. My questions are: 1. [specific hypothesis question] 2. [specific hypothesis question]". Questions should NEVER be open-ended like "tell me about X". They should be: "I think your ML pipeline uses PyTorch for training and the model is likely a fraud detection or recommendation model — which one is it? Or is it something else entirely?"

THE SECTIONS:

<h2>1. The Company</h2>
What does this company do? Who are their customers? What's the business model?

<h2>2. The People</h2>
Who works here? What does each person do? Who leads what? Who is the expert on which system?

<h2>3. The Tech Stack</h2>
Every system/service, how they connect, what technologies they use, and how data flows between them. Draw the full picture. This is the MOST IMPORTANT section — be extremely detailed in your inferences.

<h2>4. The Projects</h2>
What projects are active? What's been shipped? What's in progress? Who's working on what?

<h2>5. The Processes</h2>
How does the team work? Releases, code freeze, incident response, onboarding, etc.

<h2>6. Best-Guess System Architecture</h2>
Based on everything above, describe the FULL system architecture as if you were drawing a diagram. Include every component, every connection, every data flow. Fill in gaps with your best guesses marked as [GUESS]. Write this as a narrative: "When a customer like ACME CORP accesses the platform, they hit [auth-cerberus] which [GUESS] validates their JWT token. The request flows to [platform-core] which [GUESS] is a Node.js service connected to [MongoDB] for data storage and [Postgres] for..."

FORMAT RULES:
- Use Confluence HTML: <h2>, <h3>, <ul>, <li>, <p>, <strong>, <em>, <table>, <tr>, <td>, <th>
- Source links: <a href="ACTUAL_URL">Source: Slack #channel-name</a>. Use the real URLs from the data above. If a source has a URL in parentheses like (https://...), use that URL.
- For confirmed facts: prefix with ✅
- For inferences/guesses: prefix with 🔮
- For missing/unknown: prefix with ❓
- Questions should be in <ol> (numbered lists) and each start with "Because I found..."
- Make it EASY TO READ. Use tables where they help. Use bold for entity names.
- Do NOT include raw IDs, team IDs (like T0AD...), or internal system identifiers.
- Do NOT list entities that are clearly Jira bots, Slack integrations, or system accounts.
- Be DETAILED. This page should be 3000+ words.`;

        this.logger.log('Generating understanding analysis with LLM (gpt-4o)...');

        const { text } = await generateText({
            model: getPrimaryModel(),
            system: `You are PidraxBot, a senior software architect AI with deep expertise in cloud infrastructure, microservices, ML/AI systems, billing platforms, authentication systems, Kubernetes, and DevOps. You have been trained on millions of system design documents and can deduce entire architectures from a few puzzle pieces — just like a musician can guess the song from a few chords. Your specialty is hypothesis-driven analysis: you don't ask lazy open-ended questions, you make specific educated guesses and ask for confirmation. You write clean, well-structured documentation that is easy to read.`,
            prompt,
            maxOutputTokens: 12000,
        });

        // Wrap in PidraxBot banner
        const html = `<ac:structured-macro ac:name="info"><ac:rich-text-body>
<p><strong>[PidraxBot] What I Understand About This Company</strong></p>
<p>Generated on ${new Date().toISOString().split('T')[0]}. This page shows what PidraxBot has learned from Slack, Jira, and Confluence — and more importantly, what it has <em>inferred</em> using domain expertise.</p>
<p>Each section has three parts: <strong>confirmed facts</strong> (with source links), <strong>inferences</strong> (what must be true based on the facts), and <strong>questions</strong> (specific hypotheses that need confirmation).</p>
<p><em>Data analyzed: ${people.length} people, ${systems.length} systems, ${projects.length} projects, ${customers.length} customers, ${processes.length} processes, ${slackMessages.length} Slack messages, ${jiraDocs.length} Jira tickets, ${confluenceDocs.length} Confluence pages</em></p>
</ac:rich-text-body></ac:structured-macro>

${text}

<hr/>
<ac:structured-macro ac:name="note"><ac:rich-text-body>
<p>✅ = Confirmed fact backed by evidence from Slack, Jira, or Confluence.</p>
<p>🔮 = Inference based on domain knowledge — please verify or correct.</p>
<p>❓ = Unknown — these questions need answers from the team to complete the knowledge base.</p>
</ac:rich-text-body></ac:structured-macro>`;

        this.logger.log(`Understanding analysis generated (${html.length} chars)`);
        return html;
    }
}
