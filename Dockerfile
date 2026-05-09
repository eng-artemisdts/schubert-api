FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache python3 py3-pip ffmpeg \
  && pip3 install --no-cache-dir yt-dlp \
  && mkdir -p /tmp/schubert-stream-extract \
  && chmod 777 /tmp/schubert-stream-extract

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
