/**
 * Gap Detector v2
 * 
 * Uses the Knowledge Graph as the source of truth for what SHOULD be documented.
 * For each entity (system, customer, project, process), checks if adequate
 * documentation exists and generates categorized, template-based docs for gaps.
 */

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { PrefixLogger } from "@/lib/utils";
import { KnowledgeEntityType } from "@/src/entities/models/knowledge-entity";
import { searchKnowledgeEmbeddings } from "@/src/application/lib/knowledge/embedding-service";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { RelationshipResolver, RelevantPerson } from "@/src/application/lib/knowledge/relationship-resolver";
import {
    AuditEvidenceType,
    CreateDocAuditFindingType,
    SmartQuestionType,
} from "@/src/entities/models/doc-audit";
import {
    DocumentCategory,
    getTemplateForEntityType,
    buildGenerationPrompt,
    DocumentTemplate,
} from "./document-templates";

/**
 * Append a Confluence-style section anchor to a URL.
 */
function appendConfluenceAnchor(url: string | undefined, section: string | undefined): string | undefined {
    if (!url || !section) return url;
    const anchor = section.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    return `${url}#${anchor}`;
}

export interface GapDetectorConfig {
    similarityThreshold: number;     // Max score to consider "undocumented" (default 0.5)
    minTopicMentions: number;        // Min mentions before flagging (default 3)
    maxEntitiesPerRun: number;       // Max entities to analyze per run
}

export interface GapResult {
    findings: CreateDocAuditFindingType[];
    entitiesScanned: number;
    topicsScanned: number;
}

const DEFAULT_CONFIG: GapDetectorConfig = {
    similarityThreshold: 0.5,
    minTopicMentions: 3,
    maxEntitiesPerRun: 50,
};

// --- Entity filtering helpers ---

/**
 * Known Jira/Atlassian bot names, app names, and system accounts.
 * These get ingested as "person" entities but are NOT real people.
 */
const JIRA_BOT_PATTERNS = [
    /^system$/i,
    /^slack$/i,
    /^trello$/i,
    /^jira\b/i,                  // "Jira Outlook", "Jira Service Management Widget", etc.
    /^confluence\b/i,
    /\bwidget$/i,
    /\bnotification/i,           // "Chat Notifications"
    /\bmigrator$/i,              // "Proforma Migrator"
    /\bautomation\b/i,
    /\bbot$/i,
    /^opsgenie\b/i,              // "Opsgenie Incident Timeline"
    /^statuspage\b/i,
    /^bitbucket\b/i,
    /^microsoft\s+teams\b/i,
    /^fake-system/i,             // "fake-system-app-prod"
    /^app[_-]/i,
    /\bspreadsheet/i,            // "Jira Spreadsheets"
    /^slackbot$/i,
    /^pidraxbot$/i,
    /^atlas\b/i,                 // "Atlas for Jira Cloud"
    /^atlassian\b/i,             // "Atlassian Assist"
];

function isJiraBotOrApp(entity: KnowledgeEntityType): boolean {
    const name = entity.name;
    // Check against known patterns
    if (JIRA_BOT_PATTERNS.some(pattern => pattern.test(name))) return true;
    // If the entity only has Jira sources and the name doesn't look human, it's likely an app
    const metadata = entity.metadata as Record<string, any>;
    if (!metadata.email && !metadata.slackUserId && !metadata.role) {
        // No email, no slack ID, no role — and the name has no space (not "First Last")
        if (!name.includes(' ') && name.length > 15) return true; // Long single-word names like "fake-system-app-prod"
    }
    return false;
}

/**
 * Generic entity names that are too broad to be useful as documentation pages.
 * These are typically Slack channel names or category labels.
 */
const GENERIC_NAMES = new Set([
    'product', 'engineering', 'general', 'random', 'social',
    'support', 'sales', 'marketing', 'design', 'operations',
    'management', 'leadership', 'team', 'all-hands', 'announcements',
]);

function isGenericEntityName(name: string): boolean {
    return GENERIC_NAMES.has(name.toLowerCase().trim());
}

export class GapDetector {
    private knowledgeDocsRepo: MongoDBKnowledgeDocumentsRepository;
    private knowledgeEntitiesRepo: MongoDBKnowledgeEntitiesRepository;
    private relationshipResolver: RelationshipResolver;
    private logger: PrefixLogger;
    private config: GapDetectorConfig;

    constructor(
        knowledgeDocsRepo: MongoDBKnowledgeDocumentsRepository,
        knowledgeEntitiesRepo: MongoDBKnowledgeEntitiesRepository,
        logger: PrefixLogger,
        config: Partial<GapDetectorConfig> = {}
    ) {
        this.knowledgeDocsRepo = knowledgeDocsRepo;
        this.knowledgeEntitiesRepo = knowledgeEntitiesRepo;
        this.relationshipResolver = new RelationshipResolver(
            knowledgeEntitiesRepo,
            knowledgeDocsRepo,
            logger.child('resolver')
        );
        this.logger = logger;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Run gap detection for a project
     */
    async detect(projectId: string, auditRunId: string): Promise<GapResult> {
        this.logger.log(`Starting gap detection for project ${projectId}`);

        const findings: CreateDocAuditFindingType[] = [];
        let entitiesScanned = 0;

        // --- Always create a Company Overview finding ---
        try {
            const overviewFinding = await this.createCompanyOverviewFinding(projectId, auditRunId);
            if (overviewFinding) {
                findings.push(overviewFinding);
                this.logger.log('Added company overview as gap finding');
            }
        } catch (error) {
            this.logger.log(`Error creating company overview finding: ${error}`);
        }

        // Get all entities that SHOULD have documentation — including people and topics
        const documentableTypes = ['system', 'customer', 'project', 'process', 'person', 'topic'];
        const BATCH_SIZE = 10;
        
        for (const entityType of documentableTypes) {
            const entities = await this.getEntitiesByType(projectId, entityType);
            const entitiesToCheck = entities.slice(0, this.config.maxEntitiesPerRun);
            this.logger.log(`Checking ${entitiesToCheck.length} ${entityType} entities for documentation gaps (parallel batches of ${BATCH_SIZE})`);

            // Process entities in parallel batches of 10
            for (let i = 0; i < entitiesToCheck.length; i += BATCH_SIZE) {
                const batch = entitiesToCheck.slice(i, i + BATCH_SIZE);
                const results = await Promise.allSettled(
                    batch.map(entity => this.checkEntityDocumentation(projectId, entity, auditRunId))
                );

                for (const result of results) {
                    if (result.status === 'fulfilled' && result.value) {
                        findings.push(result.value);
                    } else if (result.status === 'rejected') {
                        this.logger.log(`Entity check failed: ${result.reason}`);
                    }
                    entitiesScanned++;
                }
            }
        }

        this.logger.log(`Gap detection complete. Found ${findings.length} undocumented entities out of ${entitiesScanned} scanned`);

        return {
            findings,
            entitiesScanned,
            topicsScanned: entitiesScanned, // For backward compatibility
        };
    }

    /**
     * Create a Company Overview finding — this should ALWAYS be regenerated
     * on each run since it synthesizes all knowledge.
     */
    private async createCompanyOverviewFinding(
        projectId: string,
        auditRunId: string
    ): Promise<CreateDocAuditFindingType | null> {
        // Gather entity summaries from the knowledge graph to give the LLM a full picture
        const entitySummaries: string[] = [];
        for (const type of ['person', 'system', 'customer', 'project', 'process', 'team']) {
            const entities = await this.knowledgeEntitiesRepo.findByProjectId(projectId, { type, limit: 100 });
            if (entities.items.length > 0) {
                const names = entities.items.map(e => {
                    const meta = e.metadata as Record<string, any>;
                    const desc = meta.description || meta.role || '';
                    return desc ? `${e.name} (${desc.substring(0, 80)})` : e.name;
                }).join(', ');
                entitySummaries.push(`${type.toUpperCase()}S: ${names}`);
            }
        }

        // Gather evidence from ALL sources for a broad company overview
        const slackResults = await searchKnowledgeEmbeddings(
            projectId,
            'company overview products services team structure',
            { limit: 10, provider: 'slack' },
            this.logger
        );
        const jiraResults = await searchKnowledgeEmbeddings(
            projectId,
            'project epic feature product service',
            { limit: 5, provider: 'jira' },
            this.logger
        );
        const confluenceResults = await searchKnowledgeEmbeddings(
            projectId,
            'architecture overview onboarding getting started team',
            { limit: 5, provider: 'confluence' },
            this.logger
        );

        const evidence: AuditEvidenceType[] = [];
        for (const r of [...slackResults, ...jiraResults, ...confluenceResults]) {
            if (r.score < 0.2) continue;
            evidence.push({
                provider: r.sourceType.startsWith('slack') ? 'slack' : r.sourceType.startsWith('jira') ? 'jira' : 'confluence',
                sourceType: r.sourceType,
                documentId: r.documentId,
                title: r.title,
                url: r.metadata?.url,
                excerpt: r.content.substring(0, 400),
                timestamp: r.metadata?.sourceCreatedAt,
            });
        }

        // Add entity summaries as a synthetic evidence item so the LLM has all the context
        if (entitySummaries.length > 0) {
            evidence.unshift({
                provider: 'confluence',
                sourceType: 'knowledge_graph',
                documentId: 'kg-summary',
                title: 'Knowledge Graph Summary (all discovered entities)',
                excerpt: entitySummaries.join('\n'),
            });
        }

        const now = new Date().toISOString();
        return {
            projectId,
            type: 'undocumented',
            severity: 'high',
            status: 'pending',
            title: '[Overview] Company Knowledge Base',
            description: 'Comprehensive company overview including org structure, products, tech stack, customers, active projects, and key processes. This is the top-level document for the knowledge base.',
            suggestedFix: 'Generate a detailed company overview document',
            evidence: evidence.slice(0, 15),
            relatedPersonIds: [],
            relatedPersonSlackIds: [],
            auditRunId,
            detectedAt: now,
            smartQuestions: [],
        };
    }

    private async getEntitiesByType(projectId: string, type: string): Promise<KnowledgeEntityType[]> {
        const result = await this.knowledgeEntitiesRepo.findByProjectId(projectId, {
            type,
            limit: 200,
        });

        // Filter out misclassified entities — names that look like person names
        // shouldn't be documented as projects/systems/customers
        if (type !== 'person') {
            const personEntities = await this.knowledgeEntitiesRepo.findByProjectId(projectId, {
                type: 'person',
                limit: 500,
            });
            const personNames = new Set(personEntities.items.map(p => p.name.toLowerCase()));

            return result.items.filter(entity => {
                const nameLower = entity.name.toLowerCase();
                // Skip if this entity name matches a known person
                if (personNames.has(nameLower)) {
                    this.logger.log(`Skipping misclassified ${type} "${entity.name}" — matches a person entity`);
                    return false;
                }
                // Heuristic: skip entities whose names look like "First Last" person names
                // (2-3 capitalized words that are NOT technical terms)
                const TECHNICAL_WORDS = new Set([
                    'system', 'service', 'architecture', 'pipeline', 'authentication',
                    'billing', 'dashboard', 'database', 'server', 'client', 'platform',
                    'overview', 'deep', 'dive', 'issue', 'rotation', 'process', 'manual',
                    'pool', 'key', 'redis', 'migration', 'analysis', 'review', 'incident',
                    'deployment', 'monitoring', 'infrastructure', 'integration', 'api',
                ]);
                const words = entity.name.trim().split(/\s+/);
                if (words.length >= 2 && words.length <= 3) {
                    const hasNoTechnicalWords = words.every(w =>
                        /^[A-Z][a-z]+$/.test(w) && !TECHNICAL_WORDS.has(w.toLowerCase())
                    );
                    if (hasNoTechnicalWords) {
                        this.logger.log(`Skipping likely misclassified ${type} "${entity.name}" — looks like a person name`);
                        return false;
                    }
                }
                // Skip overly generic entity names that are channel/category names, not real projects/systems
                if (isGenericEntityName(entity.name)) {
                    this.logger.log(`Skipping generic ${type} "${entity.name}"`);
                    return false;
                }
                return true;
            });
        }

        // For person entities: filter out Jira bots, apps, integrations, system accounts
        if (type === 'person') {
            return result.items.filter(entity => {
                if (isJiraBotOrApp(entity)) {
                    this.logger.log(`Skipping non-human person "${entity.name}" — Jira bot/app/system`);
                    return false;
                }
                // Skip duplicate person entries (e.g., "saeed.babamohamadi" when "saeed babamohamadi" exists)
                // Keep the one with the most "human-like" name (has spaces)
                if (entity.name.includes('.') && !entity.name.includes(' ')) {
                    const humanName = entity.name.replace(/\./g, ' ');
                    const hasBetterEntry = result.items.some(other =>
                        other.id !== entity.id &&
                        other.name.toLowerCase().replace(/\./g, ' ') === humanName.toLowerCase() &&
                        other.name.includes(' ')
                    );
                    if (hasBetterEntry) {
                        this.logger.log(`Skipping duplicate person "${entity.name}" — better entry exists`);
                        return false;
                    }
                }
                return true;
            });
        }

        return result.items;
    }

    /**
     * Check if an entity has adequate documentation.
     * If not, generate a finding with evidence and template-based content.
     */
    private async checkEntityDocumentation(
        projectId: string,
        entity: KnowledgeEntityType,
        auditRunId: string
    ): Promise<CreateDocAuditFindingType | null> {
        const template = getTemplateForEntityType(entity.type);
        if (!template) return null;

        const metadata = entity.metadata as Record<string, any>;

        // Build search query from entity name + aliases + description
        const searchTerms = [
            entity.name,
            ...(entity.aliases || []),
            metadata.description || '',
        ].filter(Boolean).join(' ');

        // PidraxBot space should be COMPREHENSIVE — create pages for ALL entities
        // regardless of whether existing Confluence pages mention them.
        // Only skip if PidraxBot has already created a dedicated page for this entity.
        const entityNameLower = entity.name.toLowerCase();
        const internalResults = await searchKnowledgeEmbeddings(
            projectId,
            searchTerms,
            { limit: 3, provider: 'internal' },
            this.logger
        );

        const hasInternalDoc = internalResults.some(r => {
            if (r.score < this.config.similarityThreshold) return false;
            const titleLower = (r.title || '').toLowerCase();
            return titleLower.includes(entityNameLower) || entityNameLower.includes(titleLower);
        });
        if (hasInternalDoc) {
            this.logger.log(`Skipping "${entity.name}" — PidraxBot page already exists`);
            return null;
        }

        // --- This entity needs documentation ---

        // Gather evidence from all sources
        const evidence = await this.gatherEvidence(projectId, entity, searchTerms);

        // Add entity metadata as a synthetic evidence item — this is from the knowledge graph
        // and provides structured info the LLM can use even if search evidence is sparse
        const metadataSummaryParts: string[] = [];
        if (metadata.description) metadataSummaryParts.push(`Description: ${metadata.description}`);
        if (metadata.role) metadataSummaryParts.push(`Role: ${metadata.role}`);
        if (metadata.team) metadataSummaryParts.push(`Team: ${metadata.team}`);
        if (metadata.responsibilities?.length) metadataSummaryParts.push(`Responsibilities: ${metadata.responsibilities.join(', ')}`);
        if (metadata.workingOn?.length) metadataSummaryParts.push(`Working on: ${metadata.workingOn.join(', ')}`);
        if (metadata.skills?.length) metadataSummaryParts.push(`Skills: ${metadata.skills.join(', ')}`);
        if (metadata.technologies?.length) metadataSummaryParts.push(`Technologies: ${metadata.technologies.join(', ')}`);
        if (metadata.owner) metadataSummaryParts.push(`Owner: ${metadata.owner}`);
        if (metadata.status) metadataSummaryParts.push(`Status: ${metadata.status}`);
        if (metadata.companyName) metadataSummaryParts.push(`Company: ${metadata.companyName}`);
        if (metadata.industry) metadataSummaryParts.push(`Industry: ${metadata.industry}`);
        if (metadata.healthStatus) metadataSummaryParts.push(`Health: ${metadata.healthStatus}`);
        if (metadata.steps?.length) metadataSummaryParts.push(`Steps: ${metadata.steps.join(' → ')}`);
        if (metadata.tools?.length) metadataSummaryParts.push(`Tools: ${metadata.tools.join(', ')}`);
        if (metadata.dependencies?.length) metadataSummaryParts.push(`Dependencies: ${metadata.dependencies.join(', ')}`);
        if (entity.aliases?.length) metadataSummaryParts.push(`Also known as: ${entity.aliases.join(', ')}`);

        if (metadataSummaryParts.length > 0) {
            evidence.unshift({
                provider: 'confluence',
                sourceType: 'knowledge_graph',
                documentId: `entity:${entity.id}`,
                title: `Knowledge Graph: ${entity.type} "${entity.name}"`,
                excerpt: metadataSummaryParts.join('\n'),
            });
        }

        // Even with zero search evidence, if we have knowledge graph data, create the finding
        if (evidence.length === 0) {
            return null; // Truly nothing known about this entity
        }

        // Resolve relevant people using the knowledge graph
        const relevantPeople = await this.relationshipResolver.resolveForEntity(projectId, entity.id);

        // Generate smart questions for the people (skip for person entities — we don't ask people about themselves)
        let smartQuestions: SmartQuestionType[] = [];
        if (entity.type !== 'person') {
            smartQuestions = await this.generateSmartQuestions(
                entity,
                template,
                evidence,
                relevantPeople
            );
        }

        // Build the finding
        const now = new Date().toISOString();
        const category = template.category;

        return {
            projectId,
            type: 'undocumented',
            severity: evidence.length >= 5 ? 'high' : evidence.length >= 3 ? 'medium' : 'low',
            status: 'pending',
            title: `${template.titlePrefix} ${entity.name}`,
            description: `No documentation exists for ${entity.type} "${entity.name}". Found ${evidence.length} references across Slack and Jira.`,
            suggestedFix: metadata.description || `Documentation needed for ${entity.name}`,
            evidence,
            relatedPersonIds: relevantPeople.map(p => p.entityId),
            relatedPersonSlackIds: relevantPeople.map(p => p.slackUserId),
            auditRunId,
            detectedAt: now,
            smartQuestions,
        };
    }

    /**
     * Gather evidence from Slack, Jira about an entity
     */
    private async gatherEvidence(
        projectId: string,
        entity: KnowledgeEntityType,
        searchTerms: string
    ): Promise<AuditEvidenceType[]> {
        const evidence: AuditEvidenceType[] = [];

        // Run all three searches in PARALLEL
        const [slackResults, jiraResults, confluenceResults] = await Promise.all([
            searchKnowledgeEmbeddings(projectId, searchTerms, { limit: 8, provider: 'slack' }, this.logger),
            searchKnowledgeEmbeddings(projectId, searchTerms, { limit: 5, provider: 'jira' }, this.logger),
            searchKnowledgeEmbeddings(projectId, searchTerms, { limit: 5, provider: 'confluence' }, this.logger),
        ]);

        for (const r of slackResults) {
            if (r.score < 0.3) continue;
            evidence.push({
                provider: 'slack',
                sourceType: r.sourceType,
                documentId: r.documentId,
                title: r.title,
                url: r.metadata?.url,
                excerpt: r.content.substring(0, 400),
                timestamp: r.metadata?.sourceCreatedAt,
            });
        }

        for (const r of jiraResults) {
            if (r.score < 0.3) continue;
            evidence.push({
                provider: 'jira',
                sourceType: r.sourceType,
                documentId: r.documentId,
                title: r.title,
                url: r.metadata?.url,
                excerpt: r.content.substring(0, 400),
                timestamp: r.metadata?.sourceCreatedAt,
            });
        }

        for (const r of confluenceResults) {
            if (r.score < 0.3) continue;
            // Try to extract a heading from the content for section deep-linking
            const headingMatch = r.content.match(/^#+\s*(.+)/m) || r.content.match(/<h[1-6][^>]*>([^<]+)/i);
            const sectionName = headingMatch ? headingMatch[1].trim() : undefined;
            evidence.push({
                provider: 'confluence',
                sourceType: r.sourceType,
                documentId: r.documentId,
                title: r.title,
                url: appendConfluenceAnchor(r.metadata?.url, sectionName),
                excerpt: r.content.substring(0, 500),
                timestamp: r.metadata?.sourceCreatedAt,
            });
        }

        return evidence;
    }

    /**
     * Generate smart, targeted questions for team members.
     * Uses the template to know what sections need filling.
     */
    private async generateSmartQuestions(
        entity: KnowledgeEntityType,
        template: DocumentTemplate,
        evidence: AuditEvidenceType[],
        relevantPeople: RelevantPerson[]
    ): Promise<SmartQuestionType[]> {
        if (relevantPeople.length === 0) return [];

        const peopleSummary = relevantPeople.slice(0, 4).map(p =>
            `- ${p.name}: ${p.reasons.join(', ')}`
        ).join('\n');

        const evidenceSummary = evidence.slice(0, 8).map((e, i) =>
            `[${e.provider.toUpperCase()}-${i + 1}] ${e.title}: ${e.excerpt.substring(0, 200)}`
        ).join('\n\n');

        const requiredSections = template.sections
            .filter(s => s.required)
            .map(s => `- ${s.title}: ${s.description}`)
            .join('\n');

        const systemPrompt = `You are generating targeted questions for a documentation effort.
We are documenting a ${entity.type} called "${entity.name}" and need to fill in missing information.

RULES:
1. State what you already know from evidence FIRST, then ask for confirmation or detail
2. Target each question to the person most likely to know (based on their involvement reason)
3. Ask about SPECIFIC missing sections from the documentation template
4. Make questions answerable with a short response (yes/no + detail, not "explain everything")
5. Max 3 questions per person, max 8 questions total
6. Reference specific evidence when asking (e.g., "In Slack, you mentioned X -- can you clarify Y?")

Output a JSON array:
[{"targetPersonName": "name", "question": "the question", "reason": "why this person"}]

ONLY output valid JSON.`;

        const prompt = `ENTITY: ${entity.type} "${entity.name}"

REQUIRED DOCUMENTATION SECTIONS WE NEED TO FILL:
${requiredSections}

EVIDENCE WE ALREADY HAVE:
${evidenceSummary}

PEOPLE TO ASK (with their relevance):
${peopleSummary}

Generate targeted questions to fill the missing documentation sections.`;

        try {
            const { text } = await generateText({
                model: openai("gpt-4o-mini"),
                system: systemPrompt,
                prompt,
                maxTokens: 1500,
            });

            const cleaned = text.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '');
            const parsed = JSON.parse(cleaned);
            if (!Array.isArray(parsed)) return [];

            const questions: SmartQuestionType[] = [];
            for (const q of parsed) {
                const person = relevantPeople.find(p =>
                    p.name.toLowerCase() === q.targetPersonName?.toLowerCase()
                );
                if (!person) continue;

                questions.push({
                    question: q.question,
                    targetUserId: person.slackUserId,
                    targetUserName: person.name,
                    reason: q.reason || '',
                    answered: false,
                });
            }

            return questions;
        } catch (error) {
            this.logger.log(`Error generating smart questions: ${error}`);
            return [];
        }
    }
}
