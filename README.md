# TunnelPro: Quantum Chat & Observability Platform

A premium, full-stack chat application with real-time observability, built for modern cloud-native environments. Featuring a "Quantum" glassmorphism UI, a real-time monitoring dashboard, and seamless Kubernetes/Azure integration.

## 🎯 Core Features

### 💬 Quantum Chat Interface
- **Real-time Messaging**: Powered by Socket.IO for sub-millisecond latency.
- **Message Persistence**: Robust PostgreSQL backend for history and metadata.
- **Premium UI**: Sleek glassmorphism design with Dark, Light, and Solar themes.
- **Rich Interaction**: Typing indicators, read receipts, and delivery tracking.
- **Advanced Management**: Message search, deletion, and infinite scrolling.

### 📊 Fortress Monitoring Dashboard
- **Real-time Observability**: Live cluster metrics and pod status tracking.
- **Scaling Detection**: Visual indicators for HPA (Horizontal Pod Autoscaler) activity.
- **Cluster Insights**: Integrated view of connection health and system performance.

### 🏗 Infrastructure & DevOps
- **Cloud Native**: Designed for Kubernetes (AKS) and Azure App Service.
- **CI/CD Ready**: Automated GitHub Actions pipeline for Azure deployments.
- **High Availability**: Redis adapter support for horizontal Socket.IO scaling.
- **Operational Excellence**: Comprehensive `Makefile` for streamlined development.

---

## 🏗 Project Structure

```text
Chat-App-K8S-Full-Stack/
├── backend/
│   ├── app/                # Frontend (HTML/CSS/JS)
│   ├── server.js           # Express + Socket.IO Backend
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
- **Node.js** (v22+)
- **PostgreSQL** & **Redis** (Local or via Docker)
- **Make** (Optional, but recommended)

### 2. Setup & Run
Using the provided `Makefile`:

```bash
# 1. Install dependencies
make install

# 2. Initialize Database (Make sure PostgreSQL is running)
make db-init

# 3. Launch the application
make run
```

*Manual alternative:* `cd backend && npm install && node server.js`

### 3. Access
Open **http://localhost:3000** in your browser.

---

## 🛠 Operations (Makefile)

| Command | Description |
|---------|-------------|
| `make install` | Install all backend dependencies |
| `make run` | Start the local development server |
| `make db-init` | Initialize PostgreSQL schema |
| `make docker-build` | Build the application container image |
| `make k8s-deploy` | Apply all Kubernetes manifests to the cluster |
| `make k8s-status` | Check health of K8S pods and services |
| `make k8s-logs` | Stream live application logs |
| `make k8s-proxy` | Port-forward the chat service to localhost:3000 |

---

## ☸️ Kubernetes Deployment (AKS)

1. **Configure Context**: Ensure `kubectl` is pointed to your cluster.
2. **Deploy Stack**:
   ```bash
   make k8s-deploy
   ```
3. **Verify**:
   ```bash
   make k8s-status
   ```
4. **Access**: Use the Ingress controller or run `make k8s-proxy`.

---

## 🚀 CI/CD Pipeline

The project includes a robust GitHub Actions workflow located in `.github/workflows/main_chat-app-tunnel.yml`.

- **Trigger**: Every push to the `main` branch.
- **Process**: Builds the Node.js application, tests, and deploys directly to **Azure Web App**.
- **Environment**: Configured for high-performance production workloads.

---

## 🗄️ Database Schema

The system uses a highly optimized schema for message tracking:

```sql
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  time TEXT NOT NULL,
  delivered_at TIMESTAMP NULL,
  read_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_messages_created_at ON messages(created_at);
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
