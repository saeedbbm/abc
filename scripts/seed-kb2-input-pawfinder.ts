/**
 * Seed PawFinder raw input data into MongoDB.
 * Usage: npx tsx scripts/seed-kb2-input-pawfinder.ts
 *
 * Creates mock input data for PawFinder (pet adoption platform) across multiple sources.
 * Data is SCATTERED so Pidrax can DISCOVER undocumented patterns.
 *
 * Key demo elements:
 * - Matt Chen mentioned as "Matt", "matt.chen", "Matt C." (entity resolution)
 * - Heroku migration only in Slack/PRs — undocumented project
 * - Contradiction: Redis for sessions vs NextAuth JWT (verify system should flag)
 * - Undocumented projects and proposed improvements from scattered conversations
 */

import "dotenv/config";
import { MongoClient } from "mongodb";

const COMPANY_SLUG = "pawfinder";

// ---------------------------------------------------------------------------
// CONFLUENCE (3-4 docs) — high-level architecture, onboarding, adoption flow, retro
// ---------------------------------------------------------------------------
function getConfluenceData(): unknown {
  return {
    results: [
      {
        id: "200001",
        type: "page",
        status: "current",
        title: "PawFinder Architecture Overview",
        space: { id: "3001", key: "ENG", name: "Engineering" },
        version: { number: 3, when: "2024-06-10T00:00:00.000Z", by: { displayName: "Sarah Chen" } },
        body: {
          storage: {
            value: `<h1>PawFinder Architecture Overview</h1>
<h2>Overview</h2>
<p>PawFinder is a pet adoption platform connecting shelters with potential adopters. The system comprises three main applications and shared backend services.</p>
<h2>Repositories</h2>
<ul>
  <li><code>pawfinder-web</code> — Next.js web app (Vercel)</li>
  <li><code>pawfinder-api</code> — REST API for mobile app</li>
  <li><code>pawfinder-mobile</code> — React Native iOS/Android app</li>
</ul>
<h2>Database &amp; Storage</h2>
<ul>
  <li><strong>PostgreSQL</strong> — Primary datastore, hosted on Neon</li>
  <li><strong>Redis</strong> — Session storage and caching (we use Redis for sessions in the web app)</li>
  <li><strong>AWS S3</strong> — Pet image storage with presigned upload URLs</li>
  <li><strong>CloudFront</strong> — CDN for image delivery (24h cache TTL)</li>
</ul>
<h2>Cloud Services</h2>
<ul>
  <li>Vercel — Web app hosting (dev, staging, production)</li>
  <li>AWS S3 + CloudFront — Image pipeline</li>
  <li>Stripe — Donation processing</li>
  <li>Resend — Transactional email</li>
</ul>
<h2>Integrations</h2>
<p>Shelter data sync, adoption application workflow, donation flow. See Adoption Flow Design Doc for matching algorithm details.</p>`,
          },
        },
        _links: { self: "/wiki/200001", webui: "/spaces/ENG/pages/200001" },
      },
      {
        id: "200002",
        type: "page",
        status: "current",
        title: "Onboarding Guide",
        space: { id: "3001", key: "ENG", name: "Engineering" },
        version: { number: 2, when: "2024-05-15T00:00:00.000Z", by: { displayName: "Sarah Chen" } },
        body: {
          storage: {
            value: `<h1>PawFinder Onboarding Guide</h1>
<h2>Team</h2>
<ul>
  <li><strong>Sarah Chen</strong> — Tech Lead</li>
  <li><strong>Matt Chen</strong> — Architect (currently on vacation until the 24th)</li>
  <li><strong>Priya Nair</strong> — Backend engineering</li>
  <li><strong>Alex Kim</strong> — Mobile (pawfinder-mobile)</li>
  <li><strong>Jordan Lee</strong> — DevOps &amp; infrastructure</li>
</ul>
<h2>Slack Channels</h2>
<ul>
  <li>#engineering — Tech discussion, architecture decisions</li>
  <li>#general — Team updates, announcements</li>
  <li>#incident — Production issues, post-mortems</li>
</ul>
<h2>Repo Setup</h2>
<p>Clone pawfinder-web, pawfinder-api, pawfinder-mobile from GitHub. Each has a README with env var setup. Database URLs are in 1Password — ask Sarah for access. Run <code>npm install</code> and <code>npm run dev</code> for local development.</p>
<h2>First Week</h2>
<p>Read the Architecture Overview and Adoption Flow Design Doc. Shadow Priya on a small backend task. Matt C. usually does architecture reviews when he's around — he's out until late June.</p>`,
          },
        },
        _links: { self: "/wiki/200002", webui: "/spaces/ENG/pages/200002" },
      },
      {
        id: "200003",
        type: "page",
        status: "current",
        title: "Adoption Flow Design Doc",
        space: { id: "3001", key: "ENG", name: "Engineering" },
        version: { number: 1, when: "2024-04-01T00:00:00.000Z", by: { displayName: "Priya Nair" } },
        body: {
          storage: {
            value: `<h1>Adoption Flow Design Doc</h1>
<h2>Core Matching Algorithm</h2>
<p>The adoption matching algorithm considers: species preference, size compatibility, age range, housing type, yard availability, and other pets. Each applicant gets a compatibility score (0-100) per animal. Shelters see ranked applicants in their dashboard.</p>
<h2>Shelter Integration</h2>
<p>Shelters can list animals via our admin or bulk CSV import. We sync shelter data nightly. Each shelter has configurable adoption criteria.</p>
<h2>Application Workflow</h2>
<ol>
  <li>Applicant fills multi-step form (housing, experience, why adopt)</li>
  <li>Server action validates via shared Zod schema, creates record</li>
  <li>Shelter receives notification, reviews in dashboard</li>
  <li>Status updates: submitted → under_review → approved/rejected</li>
  <li>Applicant gets email updates (Resend)</li>
</ol>
<h2>Future</h2>
<p>Pet compatibility quiz requested by users — would extend the matching algorithm to a self-service flow. Not yet scoped.</p>`,
          },
        },
        _links: { self: "/wiki/200003", webui: "/spaces/ENG/pages/200003" },
      },
      {
        id: "200004",
        type: "page",
        status: "current",
        title: "Q4 Retrospective",
        space: { id: "3001", key: "ENG", name: "Engineering" },
        version: { number: 1, when: "2024-12-15T00:00:00.000Z", by: { displayName: "Sarah Chen" } },
        body: {
          storage: {
            value: `<h1>Q4 Retrospective</h1>
<h2>Completed Projects</h2>
<ul>
  <li>Adoption application form (multi-step, Zod schema pattern)</li>
  <li>Stripe donation page (Elements integration)</li>
  <li>Shelter map on mobile (Alex)</li>
  <li>API rate limiting (Jordan)</li>
</ul>
<h2>Tech Debt</h2>
<ul>
  <li>Search relevance needs tuning — Matt was going to look at it before vacation</li>
  <li>Image optimization pipeline — Jordan's PR adds Sharp resize-on-upload</li>
  <li>Physical donation form — Priya assigned, not started</li>
</ul>
<h2>Decisions Made</h2>
<ul>
  <li>Use NextAuth for auth — JWT sessions, no server-side session store needed</li>
  <li>ISR with revalidate:300 for animal browse pages</li>
  <li>CloudFront for all user-uploaded images, no Vercel Image Optimization</li>
</ul>`,
          },
        },
        _links: { self: "/wiki/200004", webui: "/spaces/ENG/pages/200004" },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// JIRA (6-8 tickets)
// ---------------------------------------------------------------------------
function getJiraData(): unknown {
  return {
    issues: [
      {
        id: "20019",
        key: "PAW-19",
        fields: {
          summary: "Physical Donation Form",
          issuetype: { name: "Story" },
          status: { name: "To Do" },
          priority: { name: "Medium" },
          assignee: { displayName: "Priya Nair" },
          reporter: { displayName: "Sarah Chen" },
          created: "2024-11-01T00:00:00.000+0000",
          updated: "2024-11-15T00:00:00.000+0000",
          labels: ["donations", "forms"],
          description:
            "Build a donation page for physical items (toys, blankets, food). Users select from a shelter wishlist, enter drop-off or shipping details. Need new table for physical_donations and shelter wishlist. Customer feedback CFB-1001 requested this.",
          comment: {
            comments: [
              {
                author: { displayName: "Priya Nair" },
                created: "2024-11-10T00:00:00.000+0000",
                body: "Will follow the same form pattern we use elsewhere — Zod schema, server action. Need to scope the shipping flow with Sarah.",
              },
            ],
          },
        },
      },
      {
        id: "20022",
        key: "PAW-22",
        fields: {
          summary: "Shelter Map Integration",
          issuetype: { name: "Story" },
          status: { name: "In Progress" },
          priority: { name: "High" },
          assignee: { displayName: "Alex Kim" },
          reporter: { displayName: "Sarah Chen" },
          created: "2024-10-15T00:00:00.000+0000",
          updated: "2024-12-01T00:00:00.000+0000",
          labels: ["mobile", "map"],
          description:
            "Add interactive map to pawfinder-mobile showing shelter locations. Use Mapbox or Google Maps. Tap shelter to see animals. Integrate with shelters table address data.",
        },
      },
      {
        id: "20025",
        key: "PAW-25",
        fields: {
          summary: "Improve Search Relevance",
          issuetype: { name: "Story" },
          status: { name: "Backlog" },
          priority: { name: "Medium" },
          assignee: { displayName: "Matt Chen" },
          reporter: { displayName: "Alex Kim" },
          created: "2024-09-20T00:00:00.000+0000",
          updated: "2024-09-20T00:00:00.000+0000",
          labels: ["search", "algo"],
          description:
            "Search algorithm returns too many irrelevant results. Need to weight breed, age, size, and description keywords better. Consider PostgreSQL full-text search tuning or Algolia.",
          comment: {
            comments: [
              {
                author: { displayName: "Matt Chen" },
                created: "2024-09-25T00:00:00.000+0000",
                body: "I'll dig into this when I'm back. Might need to add a tsvector column and tune the weights.",
              },
            ],
          },
        },
      },
      {
        id: "20028",
        key: "PAW-28",
        fields: {
          summary: "API Rate Limiting",
          issuetype: { name: "Task" },
          status: { name: "Done" },
          priority: { name: "High" },
          assignee: { displayName: "Jordan Lee" },
          reporter: { displayName: "Sarah Chen" },
          created: "2024-08-01T00:00:00.000+0000",
          updated: "2024-10-01T00:00:00.000+0000",
          labels: ["api", "infra"],
          description:
            "Add rate limiting to public pawfinder-api. 100 req/min per API key. Use Redis for rate limit counters. Jordan to implement.",
        },
      },
      {
        id: "20031",
        key: "PAW-31",
        fields: {
          summary: "Mobile Push Notifications",
          issuetype: { name: "Story" },
          status: { name: "In Progress" },
          priority: { name: "Medium" },
          assignee: { displayName: "Alex Kim" },
          reporter: { displayName: "Priya Nair" },
          created: "2024-10-01T00:00:00.000+0000",
          updated: "2024-12-01T00:00:00.000+0000",
          labels: ["mobile", "fcm"],
          description:
            "FCM integration for adoption status updates and shelter announcements. User opts in on profile. Backend needs push token storage and send endpoint.",
        },
      },
      {
        id: "20034",
        key: "PAW-34",
        fields: {
          summary: "Analytics Dashboard",
          issuetype: { name: "Story" },
          status: { name: "Backlog" },
          priority: { name: "Low" },
          assignee: null,
          reporter: { displayName: "Sarah Chen" },
          created: "2024-11-15T00:00:00.000+0000",
          updated: "2024-11-15T00:00:00.000+0000",
          labels: ["admin", "analytics"],
          description:
            "Admin analytics dashboard: adoptions by month, donations by shelter, top breeds, conversion funnel. Read-only, no PII.",
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// SLACK (3-4 channels) — Heroku migration (undocumented), Redis vs JWT contradiction,
// Matt's vacation, casual decisions
// ---------------------------------------------------------------------------
function getSlackData(): unknown {
  return {
    messages_by_channel: [
      {
        channel: { id: "CPAW_ENG", name: "engineering" },
        messages: [
          {
            ts: "1710500000.000000",
            text: "Heads up — Matt is on vacation until the 24th. Anything architecture-related can wait or ping me.",
            user_profile: { name: "sarah.chen" },
          },
          {
            ts: "1710500100.000000",
            text: "Got it. Btw the Redis caching for the animal list is working well — cut our DB load by 40%",
            user_profile: { name: "priya.nair" },
          },
          {
            ts: "1710500200.000000",
            text: "Nice. We moved off Heroku months ago but I never updated the runbook. Everything's on Vercel/Neon now. Should probably document that someday.",
            user_profile: { name: "jordan.lee" },
          },
          {
            ts: "1710500300.000000",
            text: "Yeah the Heroku migration was a pain but worth it. We're on Vercel for web, Neon for Postgres. No more dyno restarts.",
            user_profile: { name: "matt.chen" },
          },
          {
            ts: "1710500400.000000",
            text: "For sessions — we're using Redis for session storage on the web app. Keeps auth fast across serverless.",
            user_profile: { name: "priya.nair" },
          },
          {
            ts: "1710500500.000000",
            text: "Actually Matt C. switched us to NextAuth with JWT last month. Sessions are in the token now, no Redis for that.",
            user_profile: { name: "sarah.chen" },
          },
        ],
      },
      {
        channel: { id: "CPAW_GEN", name: "general" },
        messages: [
          {
            ts: "1711000000.000000",
            text: "Happy Tails Shelter partnership is official! They're our first paid shelter client. Big win for Q1.",
            user_profile: { name: "sarah.chen" },
          },
          {
            ts: "1711000100.000000",
            text: "Congrats! Are we building anything special for them or same flow?",
            user_profile: { name: "alex.kim" },
          },
          {
            ts: "1711000200.000000",
            text: "Same flow for now. They want the pet compatibility quiz thing that keeps coming up in feedback. We should prioritize that.",
            user_profile: { name: "sarah.chen" },
          },
        ],
      },
      {
        channel: { id: "CPAW_INC", name: "incident" },
        messages: [
          {
            ts: "1712000000.000000",
            text: "Seeing connection pool exhaustion on Neon. 502s on /animals. Investigating.",
            user_profile: { name: "jordan.lee" },
          },
          {
            ts: "1712000300.000000",
            text: "Fixed — we had too many serverless connections. Reduced pool size and added connection reuse. Monitoring.",
            user_profile: { name: "jordan.lee" },
          },
        ],
      },
    ],
    user_map: {
      "sarah.chen": { id: "U_SARAH", name: "sarah.chen", real_name: "Sarah Chen" },
      "matt.chen": { id: "U_MATT", name: "matt.chen", real_name: "Matt Chen" },
      "priya.nair": { id: "U_PRIYA", name: "priya.nair", real_name: "Priya Nair" },
      "alex.kim": { id: "U_ALEX", name: "alex.kim", real_name: "Alex Kim" },
      "jordan.lee": { id: "U_JORDAN", name: "jordan.lee", real_name: "Jordan Lee" },
    },
  };
}

// ---------------------------------------------------------------------------
// GITHUB PRs (3-4) — pet compatibility scoring, shelter timeout fix,
// auth migration (undocumented), image optimization
// ---------------------------------------------------------------------------
function getGithubData(): unknown {
  return {
    repos: [
      {
        repo: { name: "pawfinder-web", default_branch: "main", visibility: "private" },
        directory_tree: { path: "pawfinder-web/", entries: [] },
        pull_requests: [
          {
            number: 42,
            title: "feat: add pet compatibility scoring",
            state: "merged",
            base: "main",
            head: "feature/compatibility-scoring",
            author: "Sarah Chen",
            created_at: "2024-09-15T00:00:00Z",
            merged_at: "2024-09-28T00:00:00Z",
            body: "Implements the compatibility scoring algorithm from the Adoption Flow Design Doc. Each applicant gets a 0-100 score per animal based on species, size, age, housing, yard, other pets. Used by shelters to rank applicants. Algorithm is in lib/matching.ts.",
            commits: [
              { sha: "a1b2c3d", message: "add compatibility scoring algorithm" },
              { sha: "e4f5g6h", message: "wire scoring into shelter dashboard" },
            ],
            comments: [
              {
                author: "Priya Nair",
                created_at: "2024-09-20T00:00:00Z",
                body: "Clean implementation. We could expose this as a quiz for users eventually — feedback keeps asking for it.",
              },
            ],
          },
          {
            number: 45,
            title: "fix: shelter API timeout handling",
            state: "merged",
            base: "main",
            head: "fix/shelter-timeout",
            author: "Priya Nair",
            created_at: "2024-10-10T00:00:00Z",
            merged_at: "2024-10-15T00:00:00Z",
            body: "Shelter sync was timing out on large datasets. Increased timeout, added chunked processing, retry with backoff. Addresses CFB-1003 feedback about slow shelter responses.",
            commits: [{ sha: "i7j8k9l", message: "add timeout handling and retry logic for shelter API" }],
          },
          {
            number: 47,
            title: "refactor: migrate auth to NextAuth",
            state: "merged",
            base: "main",
            head: "auth/nextauth-migration",
            author: "Matt Chen",
            created_at: "2024-08-01T00:00:00Z",
            merged_at: "2024-08-20T00:00:00Z",
            body: "Migrating from our custom auth + Redis sessions to NextAuth. JWT strategy — no server-side session store. Handles magic links, adopter accounts. Cleanup from the old Heroku setup — we had session issues there.",
            commits: [
              { sha: "m0n1o2p", message: "add NextAuth config with JWT provider" },
              { sha: "q3r4s5t", message: "remove Redis session dependency" },
              { sha: "u6v7w8x", message: "update all auth checks to use getSession" },
            ],
            comments: [
              {
                author: "Jordan Lee",
                created_at: "2024-08-15T00:00:00Z",
                body: "Nice. One less thing on Redis. The Heroku migration was messy enough — good to simplify auth.",
              },
            ],
          },
          {
            number: 49,
            title: "feat: add image optimization pipeline",
            state: "merged",
            base: "main",
            head: "feature/image-optimization",
            author: "Jordan Lee",
            created_at: "2024-11-01T00:00:00Z",
            merged_at: "2024-11-20T00:00:00Z",
            body: "Sharp resize-on-upload for S3. Creates 3 sizes: thumbnail (150px), medium (600px), full. Original still stored. CloudFront serves optimized URLs. Reduces bandwidth for animal browse.",
            commits: [
              { sha: "y9z0a1b", message: "add Sharp to image upload pipeline" },
              { sha: "c2d3e4f", message: "generate multi-size variants on upload" },
            ],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// CUSTOMER FEEDBACK (4-5)
// ---------------------------------------------------------------------------
function getCustomerFeedbackData(): unknown {
  return {
    tickets: [
      {
        id: 1001,
        status: "new",
        priority: "high",
        type: "bug",
        subject: "App crashes when filtering by age",
        created_at: "2024-12-01T00:00:00Z",
        requester: { name: "Emma Wilson" },
        via: { channel: "ios_app" },
        description:
          "When I filter animals by age (e.g. 1-3 years) on the iOS app, it crashes immediately. Has happened 3 times. iPhone 14, latest iOS. Other filters work fine.",
        tags: ["bug", "ios", "filters"],
      },
      {
        id: 1002,
        status: "open",
        priority: "medium",
        type: "question",
        subject: "Would love to see pet compatibility quiz",
        created_at: "2024-11-20T00:00:00Z",
        requester: { name: "David Park" },
        via: { channel: "web_form" },
        description:
          "Your adoption process is great but it would be amazing to have a quiz — answer a few questions about my lifestyle, living situation, experience, and get matched with compatible pets. Like a dating app for adoptions! I've seen other shelters do this and it really helps narrow down the overwhelming choices.",
        tags: ["feature_request", "quiz", "matching"],
      },
      {
        id: 1003,
        status: "open",
        priority: "high",
        type: "problem",
        subject: "Shelter response times are too slow",
        created_at: "2024-11-15T00:00:00Z",
        requester: { name: "Jennifer Lopez" },
        via: { channel: "web_form" },
        description:
          "When I browse animals, the shelter info and photos sometimes take 10+ seconds to load. On mobile it's worse. I gave up a few times. The Happy Tails Shelter page is particularly slow.",
        tags: ["performance", "shelter", "mobile"],
      },
      {
        id: 1004,
        status: "new",
        priority: "medium",
        type: "question",
        subject: "Great app but needs offline mode",
        created_at: "2024-12-05T00:00:00Z",
        requester: { name: "Marcus Brown" },
        via: { channel: "mobile_app" },
        description:
          "Love PawFinder! One feature request — when I'm at the shelter with spotty wifi, the app doesn't load. Could we save favorites or recently viewed animals for offline? Would make in-person visits so much smoother.",
        tags: ["feature_request", "offline", "mobile"],
      },
      {
        id: 1005,
        status: "new",
        priority: "medium",
        type: "question",
        subject: "Donation process is confusing",
        created_at: "2024-11-28T00:00:00Z",
        requester: { name: "Linda Chen" },
        via: { channel: "web_form" },
        description:
          "I wanted to donate and got lost. The form asks for amount but I wasn't sure if it was one-time or monthly. Also, can I donate physical items like toys? The page only shows money. Maybe a clearer flow or a \"what we need\" section would help.",
        tags: ["ux", "donations", "feedback"],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  const connStr = process.env.MONGODB_CONNECTION_STRING || "mongodb://localhost:27017";
  const client = new MongoClient(connStr);
  await client.connect();
  const db = client.db("pidrax");
  const col = db.collection("kb2_raw_inputs");

  console.log(`Seeding PawFinder raw inputs for company_slug="${COMPANY_SLUG}"...\n`);

  // Delete existing pawfinder data
  const deleted = await col.deleteMany({ company_slug: COMPANY_SLUG });
  console.log(`  Deleted ${deleted.deletedCount} existing document(s)\n`);

  const sources: { source: string; data: unknown; countField: string }[] = [
    { source: "confluence", data: getConfluenceData(), countField: "results" },
    { source: "jira", data: getJiraData(), countField: "issues" },
    { source: "slack", data: getSlackData(), countField: "messages_by_channel" },
    { source: "github", data: getGithubData(), countField: "repos" },
    { source: "customerFeedback", data: getCustomerFeedbackData(), countField: "tickets" },
  ];

  for (const { source, data, countField } of sources) {
    const raw = data as Record<string, unknown>;
    const arr = raw[countField];
    const docCount = Array.isArray(arr) ? arr.length : (raw as any)[countField]?.length ?? 0;

    await col.insertOne({
      company_slug: COMPANY_SLUG,
      source,
      data,
      doc_count: typeof docCount === "number" ? docCount : 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const displayCount =
      source === "confluence"
        ? (data as any).results?.length ?? 0
        : source === "jira"
          ? (data as any).issues?.length ?? 0
          : source === "slack"
            ? (data as any).messages_by_channel?.length ?? 0
            : source === "github"
              ? (data as any).repos?.reduce(
                  (s: number, r: any) => s + (r.pull_requests?.length ?? 0),
                  0,
                ) ?? 0
              : (data as any).tickets?.length ?? 0;

    console.log(`  ✓ ${source}: ${displayCount} items`);
  }

  await client.close();
  console.log("\nDone. Run Pass 1 to build the knowledge base.");
}

main().catch(console.error);
