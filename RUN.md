# 🚀 How to Run TunnelPro

TunnelPro is a full-stack, real-time chat application optimized for high-performance messaging and Kubernetes scalability.

---

## 🛠 Prerequisites

Ensure you have the following installed:
- **Node.js** (v16+)
- **PostgreSQL** (v14+)
- **Docker** & **Kubectl** (if deploying to K8S)
- **Make** (standard on Mac/Linux)

---

## ⚡ Quick Start (The One-Liner Way)

If you have a local PostgreSQL database named `chatapp` ready:

1. **Install Dependencies**
   ```bash
   make install
   ```

2. **Initialize Database Schema**
   ```bash
   make db-init
   ```

3. **Run Locally**
   ```bash
   make run
   ```
   *Access at: [http://localhost:3000](http://localhost:3000)*

---

## ☸️ Kubernetes Deployment

To deploy to a K8S cluster (local `minikube` or remote `AKS/GKE`):

1. **Apply Manifests**
   ```bash
   make k8s-deploy
   ```

2. **Check Status**
   ```bash
   make k8s-status
   ```

3. **Access via Port-Forward**
   ```bash
   make k8s-proxy
   ```
   *Access at: [http://localhost:3000](http://localhost:3000)*

---

## ☁️ Deploying to an Azure VM

If you are deploying to a static Azure VM (Ubuntu/Debian):

1. **Clone & Setup Environment**
   ```bash
   git clone https://github.com/ankitrout07/Chat-App-K8S-Full-Stack.git
   cd Chat-App-K8S-Full-Stack
   make install
   ```

2. **Configure External Access**
   Ensure port `3000` is open in your Azure Network Security Group (NSG).

3. **Launch**
   ```bash
   make run
   ```
   *Access from any PC via: `http://<VM_PUBLIC_IP>:3000`*

---

## 💬 Features to Test

1. **Registration**: Create an account via the Sign-In modal.
2. **Global Channels**: Chat in `#general` or `#dev-ops`.
3. **Private DMs**: Click on any online user in the sidebar to start a private one-on-one session.
4. **Monitoring**: View the **Cluster Pulse** animation and live metrics in the Monitoring tab.
5. **Themes**: Toggle between Dark, Light, and Solarized modes via the Sidebar.

---

## 🆘 Troubleshooting

- **Database Connection Failed**: Verify your PG credentials and ensure the `chatapp` database exists.
- **WebSocket Handshake Error**: If behind a proxy (Nginx), ensure `Upgrade` and `Connection` headers are passed.
- **Redis Not Found**: The app will automatically fall back to local memory if Redis isn't running, but clustering won't be available.

---
> [!TIP]
> Use `make help` to see a full list of all available commands.
