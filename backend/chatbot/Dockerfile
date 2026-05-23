FROM node:20-alpine
WORKDIR /app

COPY backend/sdk/ ./backend/sdk/
COPY backend/chatbot/package*.json ./backend/chatbot/
RUN cd backend/chatbot && npm ci --only=production
COPY backend/chatbot/ ./backend/chatbot/

WORKDIR /app/backend/chatbot
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "index.js"]
