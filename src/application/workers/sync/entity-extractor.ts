import { generateObject } from "ai";
import { getFastModel } from "@/lib/ai-model";
import { z } from "zod";
import { MongoDBKnowledgeDocumentsRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-documents.repository";
import { MongoDBKnowledgeEntitiesRepository } from "@/src/infrastructure/repositories/mongodb.knowledge-entities.repository";
import { KnowledgeDocumentType } from "@/src/entities/models/knowledge-document";
import { PrefixLogger } from "@/lib/utils";

// Schema for extracted entities
const ExtractedPerson = z.object({
    name: z.string().describe("Full name of the person"),
    aliases: z.array(z.string()).describe("Alternative names, nicknames, initials, or email addresses"),
    role: z.string().optional().describe("Job title or role"),
    team: z.string().optional().describe("Team or department name"),
    responsibilities: z.array(z.string()).describe("What this person is responsible for or owns"),
    skills: z.array(z.string()).describe("Technical skills or areas of expertise"),
    currentWork: z.array(z.string()).describe("Projects or tasks they are currently working on"),
});

const ExtractedProject = z.object({
    name: z.string().describe("Project name"),
    aliases: z.array(z.string()).describe("Alternative names, abbreviations, or codes (e.g., JIRA keys)"),
    description: z.string().optional().describe("Brief description of the project"),
    status: z.enum(['active', 'completed', 'on-hold', 'planning', 'unknown']).describe("Current status"),
    lead: z.string().optional().describe("Project lead or owner name"),
    members: z.array(z.string()).describe("Names of team members working on this project"),
    technologies: z.array(z.string()).describe("Technologies, tools, or systems used"),
});

const ExtractedTeam = z.object({
    name: z.string().describe("Team name"),
    aliases: z.array(z.string()).describe("Alternative names or abbreviations"),
    lead: z.string().optional().describe("Team lead name"),
    members: z.array(z.string()).describe("Names of team members"),
    responsibilities: z.array(z.string()).describe("What this team is responsible for"),
    ownedSystems: z.array(z.string()).describe("Systems or services owned by this team"),
});

const ExtractedSystem = z.object({
    name: z.string().describe("System or service name"),
    aliases: z.array(z.string()).describe("Alternative names, abbreviations, or API names"),
    description: z.string().optional().describe("Brief description of the system"),
    owner: z.string().optional().describe("Person or team who owns this system"),
    technologies: z.array(z.string()).describe("Technologies used"),
    dependencies: z.array(z.string()).describe("Other systems this depends on"),
});

const ExtractedRelationship = z.object({
    sourceEntity: z.string().describe("Name of the source entity"),
    sourceType: z.enum(['person', 'team', 'project', 'system']).describe("Type of source entity"),
    relationshipType: z.string().describe("Type of relationship (owns, works_on, member_of, leads, depends_on, etc.)"),
    targetEntity: z.string().describe("Name of the target entity"),
    targetType: z.enum(['person', 'team', 'project', 'system']).describe("Type of target entity"),
    confidence: z.number().describe("Confidence score between 0 and 1"),
});

const ExtractionResult = z.object({
    people: z.array(ExtractedPerson).describe("People mentioned or involved"),
    projects: z.array(ExtractedProject).describe("Projects mentioned"),
    teams: z.array(ExtractedTeam).describe("Teams mentioned"),
    systems: z.array(ExtractedSystem).describe("Systems, services, or APIs mentioned"),
    relationships: z.array(ExtractedRelationship).describe("Relationships between entities"),
});

type ExtractionResultType = z.infer<typeof ExtractionResult>;

export interface EntityExtractorOptions {
    batchSize?: number;
    model?: string;
}

export class EntityExtractor {
    private knowledgeDocumentsRepository: MongoDBKnowledgeDocumentsRepository;
    private knowledgeEntitiesRepository: MongoDBKnowledgeEntitiesRepository;
    private logger: PrefixLogger;
    private batchSize: number;
    private model: string;

    constructor(
        knowledgeDocumentsRepository: MongoDBKnowledgeDocumentsRepository,
        knowledgeEntitiesRepository: MongoDBKnowledgeEntitiesRepository,
        options: EntityExtractorOptions = {},
        logger?: PrefixLogger
    ) {
        this.knowledgeDocumentsRepository = knowledgeDocumentsRepository;
        this.knowledgeEntitiesRepository = knowledgeEntitiesRepository;
        this.logger = logger || new PrefixLogger('entity-extractor');
        this.batchSize = options.batchSize || 10;
        this.model = options.model || 'gpt-4o-mini';
    }

    /**
     * Extract entities from a batch of documents
     */
    async extractFromDocuments(
        projectId: string,
        documents: KnowledgeDocumentType[]
    ): Promise<{
        extracted: number;
        entities: {
            people: number;
            projects: number;
            teams: number;
            systems: number;
        };
    }> {
        const stats = {
            extracted: 0,
            entities: {
                people: 0,
                projects: 0,
                teams: 0,
                systems: 0,
            },
        };

        // Process in batches
        for (let i = 0; i < documents.length; i += this.batchSize) {
            const batch = documents.slice(i, i + this.batchSize);
            this.logger.log(`Processing batch ${Math.floor(i / this.batchSize) + 1}/${Math.ceil(documents.length / this.batchSize)}`);

            try {
                const result = await this.extractFromBatch(projectId, batch);
                
                stats.extracted += batch.length;
                stats.entities.people += result.people;
                stats.entities.projects += result.projects;
                stats.entities.teams += result.teams;
                stats.entities.systems += result.systems;
            } catch (error) {
                this.logger.log(`Error processing batch: ${error}`);
            }
        }

        return stats;
    }

    private async extractFromBatch(
        projectId: string,
        documents: KnowledgeDocumentType[]
    ): Promise<{
        people: number;
        projects: number;
        teams: number;
        systems: number;
    }> {
        // Build context from documents
        const context = documents.map((doc, idx) => {
            const sourceInfo = `[Source ${idx + 1}: ${doc.provider}/${doc.sourceType}]`;
            return `${sourceInfo}\nTitle: ${doc.title}\n${doc.content}`;
        }).join('\n\n---\n\n');

        // Get existing entities for context
        const existingEntities = await this.getExistingEntityContext(projectId);

        const systemPrompt = `You are an entity extraction system for a company knowledge base. 
Your task is to identify and extract structured information about people, projects, teams, and systems from the provided documents.

## Instructions
1. Extract ALL entities mentioned, even if only briefly
2. Infer relationships from context (e.g., "Alice is working on the Billing API" means Alice works_on Billing API)
3. Disambiguate entities: if "AC" and "Alice Chen" refer to the same person, merge them
4. Be conservative with confidence scores - only high confidence (>0.8) for explicit mentions
5. Capture aliases, nicknames, and abbreviations

## Existing Entities (for reference/merging)
${existingEntities}

## Important
- Do NOT hallucinate entities that aren't in the documents
- If information is ambiguous, include it with lower confidence
- Extract ownership relationships (who owns what system/project)
- Extract team membership (who is on what team)
- Track what people are currently working on`;

        try {
            const { object } = await generateObject({
                model: getFastModel(),
                schema: ExtractionResult,
                system: systemPrompt,
                prompt: `Extract all entities and relationships from these documents:\n\n${context}`,
            });

            // Store extracted entities
            await this.storeExtractedEntities(projectId, object, documents);

            return {
                people: object.people.length,
                projects: object.projects.length,
                teams: object.teams.length,
                systems: object.systems.length,
            };
        } catch (error) {
            this.logger.log(`Entity extraction failed: ${error}`);
            return { people: 0, projects: 0, teams: 0, systems: 0 };
        }
    }

    private async getExistingEntityContext(projectId: string): Promise<string> {
        const { items: entities } = await this.knowledgeEntitiesRepository.findByProjectId(projectId, { limit: 100 });
        
        if (entities.length === 0) {
            return "No existing entities.";
        }

        return entities.map(e => {
            const aliases = e.aliases.length > 0 ? ` (aliases: ${e.aliases.join(', ')})` : '';
            return `- ${e.type}: ${e.name}${aliases}`;
        }).join('\n');
    }

    private async storeExtractedEntities(
        projectId: string,
        extraction: ExtractionResultType,
        sourceDocuments: KnowledgeDocumentType[]
    ): Promise<void> {
        const now = new Date().toISOString();
        const sourceRefs = sourceDocuments.map(doc => ({
            provider: doc.provider as 'slack' | 'jira' | 'confluence' | 'manual',
            sourceType: `${doc.sourceType}_extraction`,
            sourceId: doc.id,
            lastSeen: now,
            confidence: 0.8,
        }));

        // Store people
        for (const person of extraction.people) {
            await this.knowledgeEntitiesRepository.bulkUpsert([{
                projectId,
                type: 'person',
                name: person.name,
                aliases: person.aliases,
                metadata: {
                    role: person.role,
                    team: person.team,
                    responsibilities: person.responsibilities,
                    skills: person.skills,
                    workingOn: person.currentWork,
                },
                sources: sourceRefs,
            }]);
        }

        // Store projects
        for (const project of extraction.projects) {
            await this.knowledgeEntitiesRepository.bulkUpsert([{
                projectId,
                type: 'project',
                name: project.name,
                aliases: project.aliases,
                metadata: {
                    description: project.description,
                    status: project.status,
                    lead: project.lead,
                    members: project.members,
                    technologies: project.technologies,
                },
                sources: sourceRefs,
            }]);
        }

        // Store teams
        for (const team of extraction.teams) {
            await this.knowledgeEntitiesRepository.bulkUpsert([{
                projectId,
                type: 'team',
                name: team.name,
                aliases: team.aliases,
                metadata: {
                    lead: team.lead,
                    members: team.members,
                    responsibilities: team.responsibilities,
                    ownedSystems: team.ownedSystems,
                },
                sources: sourceRefs,
            }]);
        }

        // Store systems
        for (const system of extraction.systems) {
            await this.knowledgeEntitiesRepository.bulkUpsert([{
                projectId,
                type: 'system',
                name: system.name,
                aliases: system.aliases,
                metadata: {
                    description: system.description,
                    owner: system.owner,
                    technologies: system.technologies,
                    dependencies: system.dependencies,
                },
                sources: sourceRefs,
            }]);
        }

        // Process relationships (update entity references)
        for (const rel of extraction.relationships) {
            await this.processRelationship(projectId, rel);
        }
    }

    private async processRelationship(
        projectId: string,
        relationship: z.infer<typeof ExtractedRelationship>
    ): Promise<void> {
        // Find source entity
        const sourceEntity = await this.knowledgeEntitiesRepository.findByName(
            projectId,
            relationship.sourceEntity,
            relationship.sourceType
        ) || await this.knowledgeEntitiesRepository.findByAlias(
            projectId,
            relationship.sourceEntity,
            relationship.sourceType
        );

        // Find target entity
        const targetEntity = await this.knowledgeEntitiesRepository.findByName(
            projectId,
            relationship.targetEntity,
            relationship.targetType
        ) || await this.knowledgeEntitiesRepository.findByAlias(
            projectId,
            relationship.targetEntity,
            relationship.targetType
        );

        if (!sourceEntity || !targetEntity) {
            return; // Can't link non-existent entities
        }

        // Update source entity with relationship
        const metadata = sourceEntity.metadata as Record<string, any>;
        
        switch (relationship.relationshipType) {
            case 'works_on':
            case 'member_of':
                if (relationship.sourceType === 'person') {
                    const workingOn = metadata.workingOn || [];
                    if (!workingOn.includes(targetEntity.id)) {
                        workingOn.push(targetEntity.id);
                    }
                    await this.knowledgeEntitiesRepository.update(sourceEntity.id, {
                        metadata: { ...metadata, workingOn },
                    }, `Added relationship: works_on ${targetEntity.name}`);
                }
                break;
                
            case 'owns':
            case 'leads':
                if (relationship.targetType === 'project' || relationship.targetType === 'system') {
                    const targetMeta = targetEntity.metadata as Record<string, any>;
                    await this.knowledgeEntitiesRepository.update(targetEntity.id, {
                        metadata: { ...targetMeta, owner: sourceEntity.id },
                    }, `Set owner to ${sourceEntity.name}`);
                }
                break;
                
            case 'depends_on':
                if (relationship.sourceType === 'system') {
                    const dependencies = metadata.dependencies || [];
                    if (!dependencies.includes(targetEntity.id)) {
                        dependencies.push(targetEntity.id);
                    }
                    await this.knowledgeEntitiesRepository.update(sourceEntity.id, {
                        metadata: { ...metadata, dependencies },
                    }, `Added dependency: ${targetEntity.name}`);
                }
                break;
        }
    }

    /**
     * Run extraction on all pending documents for a project
     */
    async processProject(projectId: string): Promise<{
        processed: number;
        entities: {
            people: number;
            projects: number;
            teams: number;
            systems: number;
        };
    }> {
        this.logger.log(`Starting entity extraction for project ${projectId}`);

        // Get all documents (prioritize those not yet processed for extraction)
        const { items: documents } = await this.knowledgeDocumentsRepository.findByProjectId(projectId, {
            limit: 500,
        });

        if (documents.length === 0) {
            this.logger.log('No documents to process');
            return {
                processed: 0,
                entities: { people: 0, projects: 0, teams: 0, systems: 0 },
            };
        }

        this.logger.log(`Processing ${documents.length} documents`);
        const result = await this.extractFromDocuments(projectId, documents);
        
        this.logger.log(`Extraction complete: ${result.extracted} documents processed, ` +
            `${result.entities.people} people, ${result.entities.projects} projects, ` +
            `${result.entities.teams} teams, ${result.entities.systems} systems`);

        return {
            processed: result.extracted,
            entities: result.entities,
        };
    }
}
