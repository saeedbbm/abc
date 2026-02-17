export interface Citation {
  id: string;
  source: 'slack' | 'confluence' | 'jira';
  label: string;
  detail: string;
  date: string;
}

export interface KBSection {
  id: string;
  heading: string;
  paragraphs: { text: string; confidence: 'verified' | 'inferred' | 'needs-verification'; citations: Citation[] }[];
}

export interface KBDocument {
  id: string;
  title: string;
  category: string;
  status: 'verified' | 'needs-review' | 'conflict' | 'new';
  lastUpdated: string;
  author: string;
  verifiedBy?: string;
  sections: KBSection[];
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  actions?: { label: string; type: 'epic' | 'kb' | 'terminal' }[];
}

export interface SlackMsg {
  id: string;
  channel: string;
  author: string;
  initials: string;
  timestamp: string;
  content: string;
  reactions?: { emoji: string; count: number }[];
  highlighted?: boolean;
}

export interface JiraTicket {
  id: string;
  key: string;
  title: string;
  type: 'Epic' | 'Story' | 'Task' | 'Bug';
  status: 'To Do' | 'In Progress' | 'Done' | 'In Review';
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  assignee: string;
  reporter: string;
  sprint: string;
  description: string;
  acceptanceCriteria: string[];
  stories?: { key: string; title: string; status: string }[];
}

export interface ConfluencePage {
  id: string;
  title: string;
  space: string;
  breadcrumb: string[];
  content: { type: 'heading' | 'paragraph' | 'callout'; text: string; highlighted?: boolean }[];
}

// ─── Slack Messages ──────────────────────────────────────
export const slackMessages: SlackMsg[] = [
  {
    id: 'slack-1',
    channel: '#backend-ops',
    author: 'David Chen',
    initials: 'DC',
    timestamp: 'Aug 12, 2025 · 2:34 PM',
    content: 'Pushed the async pipeline changes. Image processing now runs on Redis/Celery with a 60s timeout. S3 policies updated for the new bucket structure. Let me know if you hit any issues.',
    reactions: [{ emoji: '👍', count: 4 }, { emoji: '🚀', count: 2 }],
    highlighted: true,
  },
  {
    id: 'slack-2',
    channel: '#backend-ops',
    author: 'Sarah Park',
    initials: 'SP',
    timestamp: 'Aug 12, 2025 · 2:41 PM',
    content: 'Nice work David! Quick q — is the 60s timeout configurable per job type or hardcoded?',
  },
  {
    id: 'slack-3',
    channel: '#backend-ops',
    author: 'David Chen',
    initials: 'DC',
    timestamp: 'Aug 12, 2025 · 2:45 PM',
    content: 'Currently hardcoded in the Celery config. We could make it env-based pretty easily though. Want me to open a ticket?',
  },
  {
    id: 'slack-4',
    channel: '#backend-ops',
    author: 'Sarah Park',
    initials: 'SP',
    timestamp: 'Aug 12, 2025 · 2:47 PM',
    content: 'Yeah that would be great. Especially if we ever need longer timeouts for heavier workloads.',
  },
];

// ─── Jira Tickets ──────────────────────────────────────
export const jiraTickets: JiraTicket[] = [
  {
    id: 'jira-1',
    key: 'BIX-234',
    title: 'Implement Video Processing Pipeline',
    type: 'Epic',
    status: 'To Do',
    priority: 'High',
    assignee: 'Alex Rivera',
    reporter: 'Pidrax AI',
    sprint: 'Sprint 14 — Q3 Platform',
    description:
      'Extend the existing image processing architecture (Redis/Celery) to support MP4 video enhancement. This involves increasing timeout limits, implementing multipart upload for large files, adding webhook notifications for long-running jobs, and creating a new S3 bucket policy for video assets.',
    acceptanceCriteria: [
      'Videos up to 2GB can be uploaded via multipart upload',
      'Processing timeout is configurable and defaults to 600s for video',
      'Webhook fires on job completion/failure',
      'S3 bucket policy supports video MIME types',
      'Existing image pipeline remains unaffected',
    ],
    stories: [
      { key: 'BIX-235', title: 'Extend Celery config for video timeouts', status: 'To Do' },
      { key: 'BIX-236', title: 'Implement multipart upload endpoint', status: 'To Do' },
      { key: 'BIX-237', title: 'Add webhook notification system', status: 'To Do' },
      { key: 'BIX-238', title: 'Update S3 bucket policies', status: 'To Do' },
    ],
  },
];

// ─── Confluence Pages ──────────────────────────────────
export const confluencePages: ConfluencePage[] = [
  {
    id: 'conf-1',
    title: 'Async Processing Architecture',
    space: 'Engineering',
    breadcrumb: ['Bix', 'Engineering', 'Backend', 'Async Processing Architecture'],
    content: [
      { type: 'heading', text: 'Overview' },
      { type: 'paragraph', text: 'The Bix platform uses a Redis-backed Celery worker pool for all asynchronous processing tasks. Jobs are submitted via the REST API and processed in isolated worker containers.' },
      { type: 'callout', text: '⚠️ Current timeout is set to 60 seconds. This is sufficient for image processing but will need to be increased for video workloads.' , highlighted: true },
      { type: 'heading', text: 'Architecture Diagram' },
      { type: 'paragraph', text: 'Client → API Gateway → Redis Queue → Celery Workers → S3 Storage → Webhook Callback' },
      { type: 'heading', text: 'Configuration' },
      { type: 'paragraph', text: 'Timeout, concurrency, and retry policies are defined in the Celery configuration file. See the backend-ops repository for details.' },
    ],
  },
];

// ─── KB Documents ──────────────────────────────────────
export const kbDocuments: KBDocument[] = [
  {
    id: 'kb-1',
    title: 'Image Processing Architecture',
    category: 'Systems',
    status: 'verified',
    lastUpdated: 'Aug 15, 2025',
    author: 'Pidrax AI',
    verifiedBy: 'David Chen',
    sections: [
      {
        id: 'sec-1',
        heading: 'Overview',
        paragraphs: [
          {
            text: 'The Bix image processing pipeline uses Redis as a message broker and Celery for distributed task execution.',
            confidence: 'verified',
            citations: [
              { id: 'cite-1', source: 'slack', label: 'Slack · #backend-ops', detail: 'David Chen', date: 'Aug 2025' },
              { id: 'cite-1b', source: 'confluence', label: 'Confluence · Async Architecture', detail: 'Engineering', date: 'Jul 2025' },
            ],
          },
          {
            text: 'Jobs are processed with a 60-second timeout, which is hardcoded in the Celery configuration.',
            confidence: 'verified',
            citations: [
              { id: 'cite-2', source: 'slack', label: 'Slack · #backend-ops', detail: 'David Chen', date: 'Aug 2025' },
            ],
          },
        ],
      },
      {
        id: 'sec-2',
        heading: 'S3 Storage',
        paragraphs: [
          {
            text: 'Processed images are stored in a dedicated S3 bucket with policies configured for image MIME types only.',
            confidence: 'verified',
            citations: [
              { id: 'cite-3', source: 'slack', label: 'Slack · #backend-ops', detail: 'David Chen', date: 'Aug 2025' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'kb-2',
    title: 'Video Processing Pipeline',
    category: 'Projects',
    status: 'needs-review',
    lastUpdated: 'Aug 18, 2025',
    author: 'Pidrax AI',
    sections: [
      {
        id: 'sec-3',
        heading: 'Proposed Architecture',
        paragraphs: [
          {
            text: 'The video processing pipeline extends the existing image architecture. The Celery timeout should be increased to 600 seconds to accommodate longer video processing jobs.',
            confidence: 'inferred',
            citations: [
              { id: 'cite-4', source: 'slack', label: 'Slack · #backend-ops', detail: 'David Chen re: timeout', date: 'Aug 2025' },
              { id: 'cite-5', source: 'jira', label: 'Jira · BIX-234', detail: 'Video Processing Epic', date: 'Aug 2025' },
            ],
          },
          {
            text: 'Multipart upload must be implemented for files exceeding 100MB, with chunked transfer encoding and resumable upload support.',
            confidence: 'needs-verification',
            citations: [
              { id: 'cite-6', source: 'jira', label: 'Jira · BIX-236', detail: 'Multipart Upload Story', date: 'Aug 2025' },
            ],
          },
        ],
      },
      {
        id: 'sec-4',
        heading: 'Webhook Notifications',
        paragraphs: [
          {
            text: 'A webhook notification system should fire on job completion or failure, enabling downstream services to react to processing results.',
            confidence: 'needs-verification',
            citations: [
              { id: 'cite-7', source: 'jira', label: 'Jira · BIX-237', detail: 'Webhook Story', date: 'Aug 2025' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'kb-3',
    title: 'Onboarding Process',
    category: 'Processes',
    status: 'verified',
    lastUpdated: 'Jul 20, 2025',
    author: 'Pidrax AI',
    verifiedBy: 'HR Team',
    sections: [
      {
        id: 'sec-5',
        heading: 'New Hire Checklist',
        paragraphs: [
          {
            text: 'All new hires receive access to Slack, Jira, and Confluence on day one. Engineering hires additionally receive GitHub and AWS console access.',
            confidence: 'verified',
            citations: [
              { id: 'cite-8', source: 'confluence', label: 'Confluence · HR Onboarding', detail: 'People Ops', date: 'Jul 2025' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'kb-4',
    title: 'Incident Response Playbook',
    category: 'Incidents',
    status: 'conflict',
    lastUpdated: 'Aug 10, 2025',
    author: 'Pidrax AI',
    sections: [
      {
        id: 'sec-6',
        heading: 'Severity Classification',
        paragraphs: [
          {
            text: 'SEV-1 incidents require an incident commander to be assigned within 5 minutes. The on-call engineer is automatically paged.',
            confidence: 'verified',
            citations: [
              { id: 'cite-9', source: 'confluence', label: 'Confluence · Incident Playbook', detail: 'SRE Team', date: 'Jun 2025' },
            ],
          },
          {
            text: 'The escalation timeout for SEV-1 is 15 minutes before auto-escalating to the engineering director.',
            confidence: 'needs-verification',
            citations: [
              { id: 'cite-10', source: 'slack', label: 'Slack · #sre-incidents', detail: 'conflicting info', date: 'Aug 2025' },
            ],
          },
        ],
      },
    ],
  },
];

// ─── Chat Messages ─────────────────────────────────────
export const chatMessages: ChatMsg[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'Customers want MP4 video enhancement — what should we build?',
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content:
      "Based on Bix's existing image processing architecture, here's what you'll need to support MP4 video enhancement:\n\n**1. Extend Celery timeout**\nThe current 60s timeout won't work for video. Recommend 600s with per-job configuration.\n\n**2. Multipart upload**\nVideos can exceed 100MB. Implement chunked upload with resumable support.\n\n**3. Webhook notifications**\nLong-running jobs need async completion callbacks.\n\n**4. S3 policy update**\nCurrent bucket only allows image MIME types. Add video/* support.\n\nThis builds directly on David's Redis/Celery architecture — no need to rearchitect.",
    citations: [
      { id: 'cite-2', source: 'slack', label: 'Slack · #backend-ops', detail: 'David Chen re: 60s timeout', date: 'Aug 2025' },
      { id: 'cite-1b', source: 'confluence', label: 'Confluence · Async Architecture', detail: 'Engineering', date: 'Jul 2025' },
    ],
    actions: [
      { label: 'Create Epic', type: 'epic' },
      { label: 'Generate KB Doc', type: 'kb' },
    ],
  },
  {
    id: 'msg-3',
    role: 'user',
    content: 'Draft a Jira epic and assign it to Alex.',
  },
  {
    id: 'msg-4',
    role: 'assistant',
    content:
      "Done. I've drafted **BIX-234: Implement Video Processing Pipeline** and assigned it to Alex Rivera.\n\nThe epic includes 4 stories:\n• BIX-235 — Extend Celery config for video timeouts\n• BIX-236 — Implement multipart upload endpoint\n• BIX-237 — Add webhook notification system\n• BIX-238 — Update S3 bucket policies\n\nClick below to review the full epic in the context panel.",
    citations: [
      { id: 'cite-5', source: 'jira', label: 'Jira · BIX-234', detail: 'Video Processing Epic', date: 'Aug 2025' },
    ],
    actions: [
      { label: 'View Epic', type: 'epic' },
      { label: 'Run in Terminal', type: 'terminal' },
    ],
  },
];

// ─── Verification Tasks ──────────────────────────────────
export interface VerificationTask {
  id: string;
  docId: string;
  sectionId: string;
  snippet: string;
  assignee: string;
  dueDate: string;
  status: 'pending' | 'confirmed' | 'needs-edit';
}

export const verificationTasks: VerificationTask[] = [
  {
    id: 'task-1',
    docId: 'kb-2',
    sectionId: 'sec-3',
    snippet: 'The Celery timeout should be increased to 600 seconds…',
    assignee: 'David Chen',
    dueDate: 'Aug 22, 2025',
    status: 'pending',
  },
  {
    id: 'task-2',
    docId: 'kb-2',
    sectionId: 'sec-3',
    snippet: 'Multipart upload must be implemented for files exceeding 100MB…',
    assignee: 'Alex Rivera',
    dueDate: 'Aug 25, 2025',
    status: 'pending',
  },
  {
    id: 'task-3',
    docId: 'kb-2',
    sectionId: 'sec-4',
    snippet: 'A webhook notification system should fire on job completion…',
    assignee: 'Alex Rivera',
    dueDate: 'Aug 25, 2025',
    status: 'pending',
  },
];

// ─── Terminal Lines ─────────────────────────────────────
export const terminalLines = [
  '$ pidrax apply --epic BIX-234',
  '',
  '▸ Analyzing epic dependencies...',
  '▸ Resolving architecture context...',
  '',
  '  ✓ Found existing Celery config at /services/worker/celeryconfig.py',
  '  ✓ Found S3 policy at /infra/terraform/s3.tf',
  '  ✓ Found API routes at /api/routes/upload.py',
  '',
  '▸ Generating changes...',
  '',
  '  [1/4] celeryconfig.py — timeout: 60s → 600s (video)',
  '         + CELERY_VIDEO_TIMEOUT = int(os.environ.get("VIDEO_TIMEOUT", 600))',
  '',
  '  [2/4] upload.py — adding multipart handler',
  '         + @router.post("/upload/multipart")',
  '         + async def multipart_upload(file: UploadFile, chunk_index: int):',
  '',
  '  [3/4] webhooks.py — new file',
  '         + class JobWebhookNotifier:',
  '         +     async def on_complete(self, job_id: str):',
  '',
  '  [4/4] s3.tf — updating bucket policy',
  '         + content_type_whitelist = ["image/*", "video/*"]',
  '',
  '▸ Running validation...',
  '  ✓ Type check passed',
  '  ✓ Unit tests: 47 passed, 0 failed',
  '  ✓ Infrastructure plan: 2 resources to update',
  '',
  '✅ All changes ready. Run `pidrax deploy` to apply.',
];
