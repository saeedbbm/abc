# Pidrax

AI Knowledge Bot for Engineering Teams. Connects to Slack, Jira, and Confluence to build and maintain a verified knowledge base.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your API keys

# Start development server
npm run dev
```

## Docker

```bash
docker compose up
```

## Scripts

- `npm run dev` — Start development server
- `npm run build` — Build for production
- `npm run setup:qdrant` — Create Qdrant vector collection
- `npm run setup:indexes` — Create MongoDB indexes
- `npm run sync-worker` — Run background sync worker
