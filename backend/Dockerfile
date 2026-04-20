FROM node:18-slim

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy dependency manifests from the backend folder
COPY package*.json ./

# Install production dependencies
RUN npm install --only=production

# Copy the server code and the frontend assets
COPY server.js .
COPY app/ ./app/

# Environment defaults
ENV PORT=3000
EXPOSE 3000

# Explicitly call YOUR server, not the default-static-site.js
CMD [ "node", "server.js" ]