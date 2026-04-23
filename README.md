# TunnelPro: Quantum Chat & ChatOps Platform

A premium, full-stack chat application with real-time observability and integrated ChatOps, built for modern cloud-native environments. Featuring a "Quantum" glassmorphism UI, dynamic group channels, and a powerful diagnostic bot.

## 🎯 Core Features

### 💬 Quantum Chat & Channels
- **Real-time Messaging**: Powered by Socket.IO with room-based scoping for privacy and performance.
- **Dynamic Group Channels**: Create, join, and manage custom chat rooms (e.g., `#dev-ops`, `#k8s-logs`).
- **Relational Persistence**: Messages are linked to groups and users in PostgreSQL.
- **Premium UI**: Sleek glassmorphism design with Dark, Light, and Solar themes.
- **Rich Interaction**: Typing indicators, read receipts, and delivery tracking.

### 🤖 ChatOps TunnelBot
- **Slash Commands**: Manage and monitor your infrastructure directly from the chat.
- **Live Diagnostics**: Real-time health checks for PostgreSQL and Redis.
- **Resource Monitoring**: Instant insights into server memory, uptime, and active sessions.
- **Ephemeral Responses**: Bot output stays in the channel but is NOT saved to the DB, keeping history clean.

### 📊 Fortress Monitoring Dashboard
- **Real-time Observability**: Live cluster metrics and system performance tracking.
- **Scaling Detection**: Visual indicators for connection health and pod activity.
- **Integrated Insights**: One-click access to system logs and architecture diagrams.

---

## 🤖 Bot Commands (ChatOps)

| Command | Description |
|:---|:---|
| `/help` | List all available bot commands |
| `/db-health` | **Live PostgreSQL Check**: DB size, latency, and row counts |
| `/redis-health` | **Live Redis Check**: Pub/Sub mesh response and latency |
| `/stats` | **System Metrics**: RSS/Heap memory, active sockets, and Node info |
| `/deploy-status`| **Environment Info**: Platform, port, and PID details |
| `/uptime` | Current server uptime |
| `/users` | List all currently online users and their IPs |
| `/groups` | List all available channels and their creators |
| `/whoami` | Show your current session and connection details |

---

## 🏗 Project Structure

```text
Chat-App-K8S-Full-Stack/
├── backend/
│   ├── app/                # Frontend (Quantum UI: HTML/CSS/JS)
│   ├── server.js           # Node.js + Socket.IO + ChatOps Bot Engine
│   ├── Dockerfile          # App Containerization
│   └── package.json        # Node.js Dependencies
├── k8s-manifests/
│   ├── 01-config.yaml      # ConfigMaps & Secrets
│   ├── 02-db-statefulset.yaml    # PostgreSQL Cluster
│   ├── 03-app-deployment.yaml    # Application Deployment
│   ├── 04-ingress.yaml     # Routing & Traffic Management
│   └── 05-redis-statefulset.yaml # Redis for Scaling
├── .github/workflows/      # Azure CI/CD Pipelines
├── Makefile                # Operations Automation
└── README.md               # This Guide
```

---

## 🚀 Quick Start (Local Development)

### 1. Prerequisites
- **Node.js** (v24+)
- **PostgreSQL** & **Redis** (The app will automatically use **In-Memory Fallback** if these are unavailable).

### 2. Setup & Run
Using the provided `Makefile`:

```bash
# 1. Install dependencies
make install

# 2. Launch the application
make run
```

*Manual alternative:* `cd backend && npm install && node server.js`

### 3. Access
Open **http://localhost:3000** in your browser.

---

## 🗄️ Database Schema

The system uses a relational schema with automatic migrations for room-based messaging:

```sql
-- Core user identity
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Channels (Groups)
CREATE TABLE groups (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Messages with relational group linkage
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  room TEXT NOT NULL DEFAULT 'general',
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  delivered_at TIMESTAMP NULL,
  read_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## 🚢 Production Checklist
- [ ] Rotate `JWT_SECRET` and `POSTGRES_PASSWORD` secrets.
- [ ] Enable TLS/SSL on Ingress controllers.
- [ ] Configure Azure Monitor for long-term log retention.
- [ ] Set resource quotas for K8s namespaces.
- [ ] Validate Redis persistence for scaling nodes.

---

## 🤝 Contributing
Contributions are welcome! Please follow the existing code style and ensure all `Makefile` commands pass before submitting a PR.

---

## 📝 License
MIT License. Created with ❤️ for cloud-native engineers.
