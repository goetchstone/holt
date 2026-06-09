# app/Dockerfile
#
# Multi-stage build for Holt business management platform.
# Stage 1: Install dependencies (cached unless package.json changes)
# Stage 2: Build the Next.js application
# Stage 3: Production image with only what's needed to run

# ---------------------------------------------------------------------------
# Stage 1 -- Install dependencies
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps

WORKDIR /app

# Copy only the files needed for dependency installation.
# This layer is cached until package.json or package-lock.json changes.
COPY package.json package-lock.json ./

# --ignore-scripts skips postinstall scripts that try to compile native addons.
# The canvas override in package.json (→ empty-npm-package) prevents pdfjs-dist
# from pulling in native canvas. Do NOT use --omit=optional here — that strips
# sharp, which Next.js 15 requires for production image optimization.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 2 -- Build the application
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /app

# Pull in cached node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy the rest of the application source
COPY . .

# Generate Prisma client (needs the schema file present)
RUN npx prisma generate

# Build Next.js
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 -- Production image
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install runtime dependencies:
#   poppler-utils     -- PDF image extraction (pdfimages CLI)
#   su-exec           -- lightweight step-down from root to node user
#   postgresql-client -- pg_dump/pg_restore for database backup/restore
# These layers are static and must stay above the GIT_COMMIT ARG so they
# remain cached across deploys. Synology Docker lacks seccomp support, so
# re-running apk on every build fails.
RUN apk add --no-cache poppler-utils su-exec postgresql-client

# Copy the static public/ directory (served at the web root: brand assets,
# robots.txt, etc.). The directory must exist for Next.js production startup to
# scan it.
COPY --from=builder --chown=node:node /app/public ./public

# Create the data directory for user uploads (inventory photos, line drawings).
# Uploads live in /data/uploads rather than /public/uploads so Next.js does not
# try to scandir the Docker volume on startup (fails on Synology due to user
# namespace remapping). Files are served via /api/uploads/[...path].ts instead.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

# Git commit hash, passed in via docker-compose build args.
# Exposed at /api/health so operators can verify which code is running.
# Placed after static RUN layers so changing the commit does not invalidate
# the apk/mkdir cache.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

# Copy production artifacts, owned by the built-in node user (uid 1000).
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/next.config.js ./next.config.js

# Entrypoint runs as root to fix volume permissions, then drops to node.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node_modules/.bin/next", "start"]
