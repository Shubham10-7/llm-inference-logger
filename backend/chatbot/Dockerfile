FROM node:20-alpine
WORKDIR /app

# Install chatbot deps
COPY backend/chatbot/package*.json ./backend/chatbot/
RUN cd backend/chatbot && npm ci --only=production

# Copy SDK (no separate package.json needed — required via relative path)
COPY backend/sdk/ ./backend/sdk/

# Copy source
COPY backend/chatbot/ ./backend/chatbot/

WORKDIR /app/backend/chatbot
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "index.js"]
