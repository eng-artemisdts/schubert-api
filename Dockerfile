FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build && pnpm prune --prod

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache ffmpeg yt-dlp \
  && mkdir -p /tmp/schubert-stream-extract \
  && chmod 777 /tmp/schubert-stream-extract

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
