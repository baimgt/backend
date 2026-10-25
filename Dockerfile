FROM node:20-alpine

# Set production environment
ENV NODE_ENV=production

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies cleanly
RUN npm install --omit=dev

# Copy the rest of the application files with ownership to node user
COPY --chown=node:node . .

# Run as non-root user for security against container escape & backdoors
USER node

# Expose backend port
EXPOSE 8080

# Run backend
CMD ["npm", "start"]
