# Vortex Chat App

Vortex Chat is a full-stack real-time chat application built with Node.js, Express, Socket.IO, PostgreSQL, Redis, and Kubernetes manifests for local or cluster deployment. It includes public channels, direct messaging, file uploads, message reactions, pinned messages, full-text search, Google sign-in support, and a small ChatOps command layer inside the chat UI.

## Features

- Real-time chat with Socket.IO
- Channel-based messaging with seeded default groups: `general`, `dev-ops`, and `k8s-logs`
- Direct messaging and online user presence
- PostgreSQL-backed persistence with automatic schema migration on startup
- Redis adapter support for multi-instance Socket.IO broadcasting
- In-memory fallback mode when PostgreSQL is unavailable
- File uploads served from `/uploads`
- Reactions, pinned messages, threaded replies, delivery state, and read state
- Message search backed by PostgreSQL full-text indexing
- Username/password auth plus optional Google sign-in
- Built-in slash commands such as `/help`, `/stats`, `/db-health`, and `/redis-health`
- Kubernetes manifests for app, PostgreSQL, Redis, and ingress
- GitHub Actions workflow for Azure Web App deployment

## Tech Stack

- Backend: Node.js, Express, Socket.IO
- Database: PostgreSQL
- Realtime scaling: Redis Pub/Sub with `@socket.io/redis-adapter`
- Frontend: static HTML, CSS, and JavaScript served by Express
- Deployment: Docker, Kubernetes manifests, GitHub Actions, Azure Web App

## Project Structure

```text
Chat-App-K8S-Full-Stack/
├── backend/
│   ├── app/
│   │   ├── index.html
│   │   ├── script.js
│   │   └── style.css
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── k8s-manifests/
│   ├── 01-config.yaml
│   ├── 02-db-statefulset.yaml
│   ├── 03-app-deployment.yaml
│   ├── 04-ingress.yaml
│   ├── 05-redis-statefulset.yaml
│   └── init.sql
├── .github/workflows/
│   └── main.yml
├── Makefile
├── RUN.md
└── README.md
```

## Prerequisites

- Node.js 22 or newer
- npm
- PostgreSQL if you want persistent storage locally
- Redis if you want to test multi-instance pub/sub locally
- Docker and `kubectl` for container or Kubernetes workflows
- `make` for the provided shortcuts

## Local Development

### 1. Install dependencies

```bash
make install
```

### 2. Configure environment

The server reads configuration from environment variables. You can run with only Node.js, but PostgreSQL-backed development is recommended.

Common variables:

```bash
PORT=3000
NODE_ENV=development
JWT_SECRET=replace-me

DB_HOST=localhost
DB_NAME=chatapp
DB_USER=postgres
POSTGRES_PASSWORD=postgres

REDIS_HOST=localhost
REDIS_PORT=6379

GOOGLE_CLIENT_ID=your-google-client-id
ALLOWED_ORIGINS=http://localhost:3000
```

Notes:

- If `DATABASE_URL` is set, it is used for PostgreSQL connectivity and SSL is enabled for that connection path.
- If PostgreSQL cannot be reached after startup retries, the app falls back to in-memory demo mode.
- If `GOOGLE_CLIENT_ID` is missing, Google auth is disabled but the app still runs.

### 3. Initialize the database

If you want the local database seeded with the base schema:

```bash
make db-init
```

This applies [k8s-manifests/init.sql](/home/ankit/git/Chat-App-K8S-Full-Stack/k8s-manifests/init.sql:1) to the database named by `DB_NAME` in the `Makefile`, which defaults to `chatapp`.

The server also performs startup migrations automatically, so `db-init` is useful but not strictly required for every run.

### 4. Start the app

```bash
make run
```

Manual equivalent:

```bash
cd backend
npm install
node server.js
```

Open `http://localhost:3000`.

## Makefile Commands

```bash
make help
make install
make run
make db-init
make docker-build
make k8s-deploy
make k8s-delete
make k8s-status
make k8s-logs
make k8s-proxy
```

## Application Endpoints

Key HTTP endpoints exposed by [backend/server.js](/home/ankit/git/Chat-App-K8S-Full-Stack/backend/server.js:1):

- `GET /health` for liveness and readiness checks
- `POST /register` for local account creation
- `POST /login` for local login
- `POST /auth/google` for Google sign-in
- `POST /upload` for file uploads
- `GET /users` for user list
- `GET /groups` and `POST /groups` for channel management
- `GET /messages` for room history
- `GET /search?q=...` for message search

## ChatOps Commands

The chat input supports slash commands processed by the server:

- `/help`
- `/uptime`
- `/stats`
- `/db-health`
- `/redis-health`
- `/deploy-status`
- `/users`
- `/groups`
- `/whoami`

These responses are operational and are not meant to replace external monitoring.

## Database Model

Core schema includes:

- `users`
- `groups`
- `messages`
- `reactions`
- `group_members`

On startup, the app also applies incremental schema updates such as:

- `google_id`, `avatar_url`, `bio`, `status_text`, and `status_emoji` on `users`
- `parent_id`, `is_pinned`, `updated_at`, and `tsv` on `messages`
- a trigger-backed full-text search index on message content

## Docker

Build the local image with:

```bash
make docker-build
```

The default image tag is `local-chat-app:v1`.

## Kubernetes Deployment

The manifests in [k8s-manifests](/home/ankit/git/Chat-App-K8S-Full-Stack/k8s-manifests) provision:

- ConfigMap and Secret for app configuration
- PostgreSQL StatefulSet
- Redis StatefulSet
- Chat app Deployment with 2 replicas
- Service exposing the app internally on port `80`
- Ingress routing for `chat.local`

Deploy everything:

```bash
make k8s-deploy
```

Check status:

```bash
make k8s-status
```

Stream app logs:

```bash
make k8s-logs
```

Port-forward locally:

```bash
make k8s-proxy
```

Then open `http://localhost:3000`.

## Azure Deployment

The workflow at [.github/workflows/main.yml](/home/ankit/git/Chat-App-K8S-Full-Stack/.github/workflows/main.yml:1) builds the `backend/` app and deploys it to Azure Web App `vortex-chat`.

Current workflow behavior:

- Triggers on pushes to `main` and manual dispatch
- Uses Node.js `22.x` during CI
- Runs `npm install` in `backend/`
- Optionally runs `npm run build --if-present`
- Deploys with `azure/webapps-deploy@v3`
- Starts the app with `node server.js`

Required GitHub secrets:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

## Operational Notes

- Production mode enforces HTTPS redirect based on `x-forwarded-proto`.
- Static assets are served from `backend/app`.
- Uploaded files are stored under `backend/app/uploads`.
- The current Kubernetes secret values in [k8s-manifests/01-config.yaml](/home/ankit/git/Chat-App-K8S-Full-Stack/k8s-manifests/01-config.yaml:1) are example defaults and should be rotated before any real deployment.
- The repo includes Kubernetes manifests and an Azure Web App workflow; they are separate deployment paths rather than one combined runtime model.

## Troubleshooting

- If login or registration requests are rejected repeatedly, check the configured rate limits in the server.
- If the app starts but data does not persist, verify PostgreSQL connectivity and credentials.
- If realtime messaging works on one instance but not across replicas, verify Redis connectivity.
- If Google sign-in does not appear to work, confirm `GOOGLE_CLIENT_ID` is set and matches the frontend origin.
- If Kubernetes probes fail, verify `GET /health` is reachable on port `3000`.

## License

MIT
