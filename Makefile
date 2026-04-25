# Vortex Chat App - Operations Makefile

.PHONY: help install run docker-build k8s-deploy k8s-delete k8s-status k8s-logs k8s-proxy db-init

# Variables
APP_IMAGE ?= local-chat-app:v1
K8S_DIR = k8s-manifests
DB_NAME ?= chatapp

help:
	@echo "Vortex Chat Management Commands:"
	@echo "  install      - Install Node.js dependencies"
	@echo "  run          - Run the application locally"
	@echo "  db-init      - Initialize local PostgreSQL (requires psql)"
	@echo "  docker-build - Build the Docker image locally"
	@echo "  k8s-deploy   - Apply all Kubernetes manifests"
	@echo "  k8s-delete   - Remove all Kubernetes resources"
	@echo "  k8s-status   - Check status of K8S pods and services"
	@echo "  k8s-logs     - Stream logs from the chat-app deployment"
	@echo "  k8s-proxy    - Port-forward to the chat service (port 3000)"

install:
	cd backend && npm install

run:
	cd backend && node server.js

db-init:
	psql $(DB_NAME) < database/init.sql

docker-build:
	cd backend && docker build -t $(APP_IMAGE) .

k8s-deploy:
	kubectl apply -f $(K8S_DIR)/

k8s-delete:
	kubectl delete -f $(K8S_DIR)/

k8s-status:
	kubectl get all -l app=chat-ui
	@echo "\n--- Pods ---"
	kubectl get pods

k8s-logs:
	kubectl logs -f deployment/chat-app

k8s-proxy:
	@echo "Vortex Chat Live at http://localhost:3000"
	kubectl port-forward svc/chat-service 3000:80
