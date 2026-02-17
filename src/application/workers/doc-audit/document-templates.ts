/**
 * Document Category Templates v2
 * 
 * Designed for three consumers:
 * 1. Humans reading and verifying docs
 * 2. Agents planning tasks and creating Jira tickets
 * 3. Agents finding patterns across past projects to guide new features
 *
 * Each section answers a specific question that both humans and agents need.
 * The structure forces completeness — when an employee reviews, they fill every gap.
 */

export type DocumentCategory = 'customer' | 'system' | 'project' | 'process' | 'incident' | 'person' | 'overview';

export interface TemplateSection {
    id: string;
    title: string;
    description: string;           // Instructions for the LLM
    required: boolean;
    placeholder: string;           // What to show if section can't be filled
}

export interface DocumentTemplate {
    category: DocumentCategory;
    titlePrefix: string;           // e.g., "[System]" for Slack messages
    confluenceIcon: string;        // Emoji/icon for Slack notifications
    sections: TemplateSection[];
    llmInstructions: string;       // System prompt for the LLM when generating this doc
}

// ---------------------------------------------------------------------------
// PROJECT Template — the most critical one for agent pattern-matching
// ---------------------------------------------------------------------------

export const PROJECT_TEMPLATE: DocumentTemplate = {
    category: 'project',
    titlePrefix: '[Project]',
    confluenceIcon: ':rocket:',
    sections: [
        {
            id: 'overview',
            title: 'Overview',
            description: 'Project name, status (planned/in-progress/completed/abandoned), category (feature/infrastructure/migration/integration/fix/optimization), dates, owner, team, related systems, customer impact.',
            required: true,
            placeholder: 'Project overview needs to be written.',
        },
        {
            id: 'context_motivation',
            title: 'Context & Motivation',
            description: 'What was the situation BEFORE this project? What problem existed? What triggered it — customer request, incident, roadmap goal, tech debt? Why now?',
            required: true,
            placeholder: 'Context and motivation need to be documented.',
        },
        {
            id: 'goal_success_criteria',
            title: 'Goal & Success Criteria',
            description: 'What should be true when this is done? List measurable outcomes. What does "done" look like — specific, not vague (e.g. "p95 latency under 200ms" not "improve performance").',
            required: true,
            placeholder: 'Goals and success criteria need to be defined.',
        },
        {
            id: 'outcome',
            title: 'Outcome',
            description: 'What was the actual result? Did it meet the goals? What metrics changed? What is the state NOW after this project?',
            required: true,
            placeholder: 'Outcome needs to be documented once the project is complete.',
        },
        {
            id: 'approach_implementation',
            title: 'Approach & Implementation',
            description: 'Step-by-step: what was built, changed, or configured? Include architecture, data flow, APIs, infrastructure. Enough detail that someone could re-implement or modify it.',
            required: true,
            placeholder: 'Approach and implementation need to be documented.',
        },
        {
            id: 'key_files_locations',
            title: 'Key Files & Locations',
            description: 'File paths, services, repos, config locations relevant to this project and what each does in this context.',
            required: false,
            placeholder: 'Key files and locations need to be listed.',
        },
        {
            id: 'decisions_tradeoffs',
            title: 'Decisions & Trade-offs',
            description: 'For EACH key decision: what options were considered, which was chosen, WHY, what trade-off was accepted, and would you choose differently today? This is the MOST VALUABLE section for future agents planning similar work.',
            required: true,
            placeholder: 'Decisions and trade-offs need to be documented — this is critical.',
        },
        {
            id: 'problems_solutions',
            title: 'Problems & Solutions',
            description: 'What went wrong? For each problem: what happened, root cause, how it was solved, time spent. Blockers hit and how they were resolved.',
            required: false,
            placeholder: 'Problems encountered need to be documented.',
        },
        {
            id: 'lessons_learned',
            title: 'Lessons Learned',
            description: 'What would you tell someone doing a similar project? What went well, what didn\'t, what would the team do differently?',
            required: true,
            placeholder: 'Lessons learned need to be captured.',
        },
        {
            id: 'patterns_reusability',
            title: 'Patterns & Reusability',
            description: 'What parts of this project could be reused for similar work? For each pattern: name it, describe when to use it, and how to adapt it. This enables agents to mix patterns from multiple projects for new features.',
            required: true,
            placeholder: 'Reusable patterns need to be identified.',
        },
        {
            id: 'dependencies_prerequisites',
            title: 'Dependencies & Prerequisites',
            description: 'What must exist before this project can start? Permissions, access, infrastructure, other projects that must complete first.',
            required: false,
            placeholder: 'Dependencies need to be listed.',
        },
        {
            id: 'risks_warnings',
            title: 'Risks & Warnings',
            description: 'Known issues that could come back. Things that look fine but are fragile. What NOT to do if modifying this.',
            required: false,
            placeholder: 'Risks and warnings need to be documented.',
        },
    ],
    llmInstructions: `You are generating a detailed Project documentation page. This serves THREE purposes:
1. A permanent record for humans to read and verify
2. Input for agents planning Jira tasks for similar future features
3. A source of reusable patterns that agents can mix-and-match across projects

CRITICAL SECTIONS:
- "Decisions & Trade-offs" — For each decision, ALWAYS include: options considered, chosen option, WHY, trade-off accepted. Agents will use this to pre-answer design questions for new features.
- "Patterns & Reusability" — Name each reusable pattern clearly. Agents will search for these when composing approaches for new features that are similar to a mix of past projects.
- "Context & Motivation" — The BEFORE state. Agents use this to match new tasks to similar starting situations.
- "Outcome" — The AFTER state. Combined with Context, agents can predict expected outcomes.

RULES:
- Be SPECIFIC. Include actual tech names, API endpoints, file paths, config values.
- Every claim MUST have a source: [Source: Slack #channel, Jan 15] or [Source: JIRA-KEY].
- Mark uncertain items with "NEEDS VERIFICATION:" prefix.
- Mark missing info with "OPEN QUESTION:" prefix — these force reviewers to fill gaps.
- Emphasize the WHY behind every decision, not just the WHAT.
- The "Approach & Implementation" section should be detailed enough that an agent could generate step-by-step Jira subtasks from it.`,
};

// ---------------------------------------------------------------------------
// SYSTEM Template — for services, infrastructure, tools
// ---------------------------------------------------------------------------

export const SYSTEM_TEMPLATE: DocumentTemplate = {
    category: 'system',
    titlePrefix: '[System]',
    confluenceIcon: ':gear:',
    sections: [
        {
            id: 'overview',
            title: 'Overview',
            description: 'System name, type (service/database/infrastructure/tool/library/external API), status (active/deprecated/migrating), owner, tech stack. One paragraph: what is this and why does it exist?',
            required: true,
            placeholder: 'System description needs to be documented.',
        },
        {
            id: 'how_it_works',
            title: 'How It Works',
            description: 'Architecture: components, data flow, how it fits into the larger system. Key endpoints/interfaces: what they do, input, output. Data model: what data it stores, schema, relationships.',
            required: true,
            placeholder: 'Architecture and behavior need to be documented.',
        },
        {
            id: 'configuration',
            title: 'Configuration',
            description: 'Environment variables, config files, feature flags that control behavior. What needs to be set up for this to work.',
            required: false,
            placeholder: 'Configuration needs to be documented.',
        },
        {
            id: 'how_to_use',
            title: 'How to Use It',
            description: 'Setup/access instructions: how to get access, how to run locally, credentials needed. Common operations: step-by-step for typical tasks.',
            required: true,
            placeholder: 'Usage instructions need to be documented.',
        },
        {
            id: 'troubleshooting',
            title: 'Troubleshooting',
            description: 'For each common symptom: likely cause and fix. What to check when things go wrong.',
            required: false,
            placeholder: 'Troubleshooting guide needs to be created.',
        },
        {
            id: 'dependencies',
            title: 'Dependencies',
            description: 'Depends on: list of systems this needs. Depended on by: list of systems that use this.',
            required: true,
            placeholder: 'Dependencies need to be mapped.',
        },
        {
            id: 'known_issues',
            title: 'Known Issues & Limitations',
            description: 'Known bugs, performance limits, tech debt. For each: what it is, workaround if any.',
            required: false,
            placeholder: 'No known issues documented.',
        },
        {
            id: 'history',
            title: 'History',
            description: 'Major changes and incidents. Date + what happened (e.g. "Migrated from Redis 5 to 7", "Connection pool exhaustion incident AUTH-50").',
            required: false,
            placeholder: 'History needs to be documented.',
        },
    ],
    llmInstructions: `You are generating a detailed System/Service documentation page. A new engineer should be able to read this and understand what this system does, how it works, and how to start working on it.

For agents: this document is used when an agent receives a task that touches this system. The agent needs to know:
- What the system does and how it connects to other systems (for impact assessment)
- How to use it (for implementation steps)
- Known issues (for risk assessment)
- Dependencies (for task ordering)

RULES:
- Be technically specific. Include actual technology names, endpoints, config keys.
- For each fact, note the source: [Source: Slack #channel, date] or [Source: JIRA-KEY].
- Include WHY architecture decisions were made, not just what was decided.
- Mark uncertain info with "NEEDS VERIFICATION:" prefix.
- Mark gaps with "OPEN QUESTION:" prefix.
- The "How to Use It" section must be step-by-step actionable.`,
};

// ---------------------------------------------------------------------------
// CUSTOMER Template
// ---------------------------------------------------------------------------

export const CUSTOMER_TEMPLATE: DocumentTemplate = {
    category: 'customer',
    titlePrefix: '[Customer]',
    confluenceIcon: ':briefcase:',
    sections: [
        {
            id: 'profile',
            title: 'Profile',
            description: 'Company name, industry, account status (active/churned/prospect/pilot), account owner, since when.',
            required: true,
            placeholder: 'Customer profile needs to be documented.',
        },
        {
            id: 'relationship',
            title: 'Relationship',
            description: 'Key contacts: for each person include name, title, role, attitude, authority level, best contact method. Communication style: how to talk to this customer — formal/informal, technical/business, sensitivities.',
            required: true,
            placeholder: 'Relationship details need to be documented.',
        },
        {
            id: 'products_services',
            title: 'Products & Services',
            description: 'What they use, what they pay for. Product/service details, tier, customizations.',
            required: true,
            placeholder: 'Product usage needs to be documented.',
        },
        {
            id: 'projects_history',
            title: 'Projects & History',
            description: 'Timeline of projects and events: date, what happened, outcome. Include active and past projects.',
            required: true,
            placeholder: 'Project history needs to be documented.',
        },
        {
            id: 'active_issues',
            title: 'Active Issues',
            description: 'Current open issues: status, owner, impact on the customer.',
            required: false,
            placeholder: 'No active issues documented.',
        },
        {
            id: 'risks_sensitivities',
            title: 'Risks & Sensitivities',
            description: 'Contract renewal dates, competitor mentions, executive involvement, past escalations. Things to be careful about.',
            required: false,
            placeholder: 'Risks and sensitivities need to be assessed.',
        },
    ],
    llmInstructions: `You are generating a detailed Customer Profile. A new sales engineer or account manager should read this and understand everything about this customer.

For agents: this document is used when an agent creates tasks related to customer work. The agent needs:
- Who the customer is and what they use (for scoping)
- Key contacts and communication style (for stakeholder management)
- Active issues and risks (for priority assessment)

RULES:
- Be specific with names, dates, contract details.
- For key contacts, include personality/attitude notes if available from Slack context.
- Note the source: [Source: Slack #channel, date] or [Source: JIRA-KEY].
- Mark uncertain info with "NEEDS VERIFICATION:" prefix.
- Mark gaps with "OPEN QUESTION:" prefix.`,
};

// ---------------------------------------------------------------------------
// PERSON Template
// ---------------------------------------------------------------------------

export const PERSON_TEMPLATE: DocumentTemplate = {
    category: 'person',
    titlePrefix: '[Person]',
    confluenceIcon: ':bust_in_silhouette:',
    sections: [
        {
            id: 'profile',
            title: 'Profile',
            description: 'Name, role/title, team, reports to, location/timezone.',
            required: true,
            placeholder: 'Profile information needs to be documented.',
        },
        {
            id: 'responsibilities',
            title: 'Responsibilities',
            description: 'What does this person own or lead? List specific areas of ownership (e.g. "Billing service: primary maintainer", "On-call rotation lead for infrastructure").',
            required: true,
            placeholder: 'Responsibilities need to be documented.',
        },
        {
            id: 'expertise',
            title: 'Expertise',
            description: 'What should people come to this person for? Specific technical domains, business knowledge, tools they know deeply.',
            required: true,
            placeholder: 'Areas of expertise need to be documented.',
        },
        {
            id: 'current_work',
            title: 'Current Work',
            description: 'Active projects and tasks. Include Jira ticket references if available.',
            required: false,
            placeholder: 'Current work needs to be listed.',
        },
        {
            id: 'past_projects',
            title: 'Past Projects',
            description: 'Projects this person has worked on and their role in each (e.g. "ML Pipeline — Lead engineer", "Billing Migration — Backend contributor").',
            required: false,
            placeholder: 'Past projects need to be listed.',
        },
        {
            id: 'systems_owned',
            title: 'Systems & Services Owned',
            description: 'Which systems, services, or components this person owns or is the primary contact for.',
            required: false,
            placeholder: 'System ownership needs to be documented.',
        },
        {
            id: 'contact',
            title: 'Contact & Preferences',
            description: 'Best way to reach them, working hours, OOO schedule.',
            required: false,
            placeholder: 'Contact information needs to be added.',
        },
    ],
    llmInstructions: `You are generating a Person Profile page. This helps new team members understand who this person is, what they do, and when to reach out.

For agents: this document is used to identify the right person to assign tasks to, and to understand who to consult for specific domains.

RULES:
- Focus on professional context: role, expertise, ownership.
- Include specific project names, system names, and Jira references.
- Note the source: [Source: Slack #channel, date] or [Source: JIRA-KEY].
- Mark uncertain items with "NEEDS VERIFICATION:" prefix.
- Don't include sensitive personal information.
- List actual current work items from evidence.`,
};

// ---------------------------------------------------------------------------
// PROCESS Template
// ---------------------------------------------------------------------------

export const PROCESS_TEMPLATE: DocumentTemplate = {
    category: 'process',
    titlePrefix: '[Process]',
    confluenceIcon: ':clipboard:',
    sections: [
        {
            id: 'overview',
            title: 'Overview',
            description: 'Process name, category (deployment/release/onboarding/incident/maintenance/approval), frequency (daily/weekly/per-release/as-needed), owner.',
            required: true,
            placeholder: 'Process overview needs to be documented.',
        },
        {
            id: 'when_to_use',
            title: 'When to Use This',
            description: 'Under what circumstances should someone follow this process? Trigger conditions.',
            required: true,
            placeholder: 'Trigger conditions need to be defined.',
        },
        {
            id: 'prerequisites',
            title: 'Prerequisites',
            description: 'What must be true before starting: access, tools, approvals, prior steps completed.',
            required: true,
            placeholder: 'Prerequisites need to be listed.',
        },
        {
            id: 'steps',
            title: 'Steps',
            description: 'Numbered, detailed steps. Each step should be specific and actionable. Include what to type, what to click, what commands to run.',
            required: true,
            placeholder: 'Process steps need to be documented.',
        },
        {
            id: 'decision_points',
            title: 'Decision Points',
            description: 'Where in this process do you need to make a judgment call? For each decision point: the conditions, what to do for each case, and the default if unsure.',
            required: false,
            placeholder: 'Decision points need to be documented.',
        },
        {
            id: 'common_mistakes',
            title: 'Common Mistakes',
            description: 'Things that commonly go wrong: what happens and how to avoid or fix each.',
            required: false,
            placeholder: 'Common mistakes need to be documented.',
        },
        {
            id: 'verification',
            title: 'After Completion',
            description: 'What should be true after this process is done? How to verify it worked correctly?',
            required: false,
            placeholder: 'Verification steps need to be defined.',
        },
    ],
    llmInstructions: `You are generating a detailed Process documentation page. Anyone should be able to follow this without prior knowledge.

For agents: this document is used when an agent needs to execute or plan around a process. The agent needs:
- When to trigger this process (for task scheduling)
- Exact steps (for automation or step-by-step guidance)
- Decision points (for handling branching logic)

RULES:
- Steps MUST be NUMBERED and SPECIFIC. Not "deploy the service" but "1. Run 'kubectl apply -f deploy.yaml' in the production cluster."
- Include specific tool names, URLs, commands.
- Note who is responsible for each step if different people do different parts.
- Include timing: how long each step takes, what order they must happen in.
- Mark uncertain info with "NEEDS VERIFICATION:" prefix.
- Mark gaps with "OPEN QUESTION:" prefix.`,
};

// ---------------------------------------------------------------------------
// INCIDENT Template
// ---------------------------------------------------------------------------

export const INCIDENT_TEMPLATE: DocumentTemplate = {
    category: 'incident',
    titlePrefix: '[Incident]',
    confluenceIcon: ':warning:',
    sections: [
        {
            id: 'summary',
            title: 'Summary',
            description: 'Incident ID if available, title, severity (critical/high/medium/low), status (resolved/mitigated/ongoing), date, duration, affected systems, affected customers.',
            required: true,
            placeholder: 'Incident summary needs to be written.',
        },
        {
            id: 'what_happened',
            title: 'What Happened',
            description: 'Timeline of events: timestamps with what happened at each point, from detection through resolution.',
            required: true,
            placeholder: 'Timeline needs to be documented.',
        },
        {
            id: 'root_cause',
            title: 'Root Cause',
            description: 'Why did this happen? Technical and organizational causes. Be specific.',
            required: true,
            placeholder: 'Root cause needs to be determined.',
        },
        {
            id: 'fix_applied',
            title: 'Fix Applied',
            description: 'What was done to resolve it — specific changes, commands, deploys. Was this a temporary or permanent fix?',
            required: true,
            placeholder: 'Fix needs to be documented.',
        },
        {
            id: 'people_involved',
            title: 'People Involved',
            description: 'Who detected it, who responded, who fixed it.',
            required: false,
            placeholder: 'Responders need to be documented.',
        },
        {
            id: 'prevention',
            title: 'Prevention & Follow-up',
            description: 'What actions were taken to prevent recurrence? Follow-up Jira tickets? Monitoring added?',
            required: true,
            placeholder: 'Prevention measures need to be identified.',
        },
        {
            id: 'lessons_learned',
            title: 'Lessons Learned',
            description: 'What we learned. What we would do differently.',
            required: false,
            placeholder: 'Lessons learned need to be captured.',
        },
    ],
    llmInstructions: `You are generating a detailed Incident documentation page. This is a permanent record and learning resource.

For agents: this document is used to:
- Recognize similar symptoms and suggest fixes based on past incidents
- Understand system fragilities when planning changes
- Generate risk assessments for tasks touching affected systems

RULES:
- Be precise about timeline: exact dates and times if available.
- Include the technical root cause, not just symptoms.
- Name the people involved and their roles.
- Include what monitoring caught or missed.
- Mark uncertain info with "NEEDS VERIFICATION:" prefix.
- Link to Jira tickets and Slack threads.`,
};

// ---------------------------------------------------------------------------
// OVERVIEW Template (Company)
// ---------------------------------------------------------------------------

export const OVERVIEW_TEMPLATE: DocumentTemplate = {
    category: 'overview',
    titlePrefix: '[Overview]',
    confluenceIcon: ':office:',
    sections: [
        {
            id: 'company',
            title: 'Company Overview',
            description: 'What the company does in one paragraph. Products offered. Customers served.',
            required: true,
            placeholder: 'Company overview needs to be documented.',
        },
        {
            id: 'organization',
            title: 'Organization',
            description: 'Teams: name, what they own, who leads. People: name, role, key responsibilities.',
            required: true,
            placeholder: 'Organization needs to be documented.',
        },
        {
            id: 'tech_stack',
            title: 'Technology Stack',
            description: 'Frontend, backend, infrastructure, databases, integrations. Specify WHAT PARTS of platforms are used (e.g. "AWS: EC2, S3, RDS" not just "AWS").',
            required: true,
            placeholder: 'Tech stack needs to be documented.',
        },
        {
            id: 'products',
            title: 'Products & Services',
            description: 'All products and services. Brief description, target audience, current status.',
            required: true,
            placeholder: 'Products need to be listed.',
        },
        {
            id: 'customers',
            title: 'Customer Portfolio',
            description: 'Key customers: who they are, what they use, account status.',
            required: false,
            placeholder: 'Customer portfolio needs to be documented.',
        },
        {
            id: 'active_initiatives',
            title: 'Active Initiatives',
            description: 'What the company is currently working on: goal, owner, timeline.',
            required: false,
            placeholder: 'Active initiatives need to be listed.',
        },
        {
            id: 'key_processes',
            title: 'Key Processes',
            description: 'Release cycle, on-call rotation, code freeze schedule, deployment procedures, and who owns each.',
            required: false,
            placeholder: 'Key processes need to be documented.',
        },
        {
            id: 'glossary',
            title: 'Glossary & Key Terms',
            description: 'Internal terminology, system codenames, abbreviations.',
            required: false,
            placeholder: 'Glossary needs to be built.',
        },
    ],
    llmInstructions: `You are generating a comprehensive Company Overview page. A new employee should read this and understand what the company does, how it's organized, and what's happening — without asking anyone.

For agents: this is the TOP-LEVEL context document. Agents read this first to understand:
- The overall business and products (for scoping)
- Org structure and ownership (for task assignment)  
- Tech stack (for implementation decisions)
- Active work (for conflict and priority assessment)

RULES:
- Be COMPREHENSIVE. Cover every known team, product, system, customer.
- Include specific technology versions and infrastructure details.
- Include people's names and their roles.
- Note the source: [Source: Slack, Jira, Confluence].
- Mark uncertain items with "NEEDS VERIFICATION:" prefix.
- This is the MOST IMPORTANT document — make it detailed.`,
};

// ---------------------------------------------------------------------------
// Template Registry
// ---------------------------------------------------------------------------

export const TEMPLATES: Record<DocumentCategory, DocumentTemplate> = {
    customer: CUSTOMER_TEMPLATE,
    system: SYSTEM_TEMPLATE,
    project: PROJECT_TEMPLATE,
    process: PROCESS_TEMPLATE,
    incident: INCIDENT_TEMPLATE,
    person: PERSON_TEMPLATE,
    overview: OVERVIEW_TEMPLATE,
};

/**
 * Get the appropriate template for an entity type
 */
export function getTemplateForEntityType(entityType: string): DocumentTemplate | null {
    switch (entityType) {
        case 'customer': return CUSTOMER_TEMPLATE;
        case 'system': return SYSTEM_TEMPLATE;
        case 'project': return PROJECT_TEMPLATE;
        case 'process': return PROCESS_TEMPLATE;
        case 'person': return PERSON_TEMPLATE;
        case 'overview': return OVERVIEW_TEMPLATE;
        case 'topic': return SYSTEM_TEMPLATE; // Topics often describe systems/architecture
        case 'team': return null; // Teams are documented as part of org chart
        default: return null;
    }
}

/**
 * Build the LLM prompt for generating a document from a template
 */
export function buildGenerationPrompt(
    template: DocumentTemplate,
    entityName: string,
    evidenceText: string,
    existingKnowledge: string = ''
): string {
    const sectionPrompts = template.sections.map(s => {
        const requiredTag = s.required ? ' (REQUIRED — must fill in)' : ' (include if info available)';
        return `## ${s.title}${requiredTag}\n${s.description}`;
    }).join('\n\n');

    return `Generate a comprehensive documentation page for: "${entityName}"

DOCUMENT TYPE: ${template.category.toUpperCase()}

SECTIONS TO FILL IN:
${sectionPrompts}

EXISTING KNOWLEDGE ABOUT THIS TOPIC:
${existingKnowledge || 'None available.'}

EVIDENCE FROM TEAM COMMUNICATIONS AND TOOLS:
${evidenceText}

FORMAT RULES:
- Use Confluence-compatible HTML.
- Each section should be an <h2> heading.
- Use <ul>/<li> for lists, <p> for paragraphs, <table> for structured data.
- Bold important terms with <strong>.
- IMPORTANT: For source citations, you MUST use clickable links. Evidence items have URLs in the format (https://...). Render them as: <a href="URL">Source: Slack #channel-name</a> or <a href="URL">Source: Jira TICKET-123</a>. NEVER output raw URLs or text-only citations.
- For items needing verification: <ac:structured-macro ac:name="note"><ac:rich-text-body><p>NEEDS VERIFICATION: your text here</p></ac:rich-text-body></ac:structured-macro>
- For open questions: <ac:structured-macro ac:name="warning"><ac:rich-text-body><p>OPEN QUESTION: your question here</p></ac:rich-text-body></ac:structured-macro>
- If a required section has NO information, still include the heading with the placeholder text wrapped in a warning macro.
- Do NOT include the document title as an <h1> -- Confluence handles that.
- Be detailed, specific, and cite sources. Every fact should trace back to evidence with a clickable link.`;
}
