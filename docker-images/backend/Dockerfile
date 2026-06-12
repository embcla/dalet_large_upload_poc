# Build stage: compile TypeScript
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage
FROM node:22-bookworm-slim
# ffmpeg/ffprobe are required by M4 (thumbnail/proxy generation); installed
# now so the image doesn't need rebuilding for that milestone.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
