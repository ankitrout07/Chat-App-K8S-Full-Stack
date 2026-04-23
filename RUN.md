# 🚀 Launching TunnelPro: Quantum Chat

TunnelPro is a high-performance, real-time messaging platform designed for cloud-native scalability. This guide will help you get the system up and running in minutes.

---

## 🛠 Prerequisites

Ensure your environment has the following tools:
- **Node.js** (v22+)
- **PostgreSQL** (v14+)
- **Redis** (Optional, for clustering)
- **Docker** & **Kubectl** (For Kubernetes deployment)
- **Make** (For automated operations)

---

## ⚡ Quick Start (Local Development)

The fastest way to start the engine is using the `Makefile`.

### 1. Initialize the Environment
Install all backend dependencies:
```bash
make install
```

### 2. Database Preparation
Ensure PostgreSQL is running and you have a database named `chatapp`. Then initialize the schema:
```bash
make db-init
```

### 3. Launch the Protocol
Start the local server:
```bash
make run
```
*Access the interface at: [http://localhost:3000](http://localhost:3000)*

---

## ☸️ Kubernetes (AKS/Local) Deployment

Deploying TunnelPro to a cluster is streamlined through the `Makefile`.

1. **Deploy the Stack**:
   ```bash
   make k8s-deploy
   ```

2. **Verify Cluster Health**:
   ```bash
   make k8s-status
   ```

3. **Access the Tunnel**:
   ```bash
   make k8s-proxy
   ```
   *Access via proxy at: [http://localhost:3000](http://localhost:3000)*

---

## 💬 Operational Testing

Once launched, verify the following core features:

1. **Identify**: Click **Identify** to register or login to your persistent profile.
2. **Quantum Bridge**: Switch between `#general`, `#dev-ops`, and `#k8s-logs` channels in the sidebar.
3. **Direct Decryption**: Click on an online user in the "Direct Messages" section to start a private session.
4. **System Intelligence**: Visit the **Monitoring** tab to see real-time K8s pod health and memory usage.
5. **Appearance**: Use the **Appearance** tab to toggle between Dark, Light, and Solarized themes.

---

## ☁️ Production Deployment (Azure VM)

For a standard Linux VM deployment:
1. Clone the repository.
2. Run `make install`.
3. Open port `3000` in your Azure NSG.
4. Run `make run`.

---

## 🆘 Troubleshooting

- **Protocol Connection Error**: Ensure the `.env` file in the `backend/` directory has correct database credentials.
- **Heartbeat Flatline**: If the monitoring dashboard shows no stats, verify the backend is connected to the Redis service.
- **WebSocket Handshake**: If using an Ingress controller, ensure WebSocket support (Upgrade headers) is enabled.

---

> [!TIP]
> Run `make help` at any time to see the full list of operational commands.
