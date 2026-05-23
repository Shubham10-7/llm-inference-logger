FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_CHATBOT_URL=http://localhost:3001
ARG VITE_INGESTION_URL=http://localhost:4000
ENV VITE_CHATBOT_URL=$VITE_CHATBOT_URL
ENV VITE_INGESTION_URL=$VITE_INGESTION_URL
RUN npm run build

FROM node:20-alpine
RUN npm install -g serve
WORKDIR /app
COPY --from=builder /app/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s \
  CMD wget -qO- http://localhost:3000 || exit 1
CMD ["serve", "-s", "dist", "-l", "3000"]
