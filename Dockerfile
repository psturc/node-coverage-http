# =========================================================
# 🧱 Base builder stage — installs dependencies
# =========================================================
FROM node:20-slim AS base

# Set working dir
WORKDIR /app

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install --frozen-lockfile --production

# Copy application source
COPY . .

# =========================================================
# 🚀 Production image
# =========================================================
FROM node:20-slim AS production

WORKDIR /app

# Copy from base stage
COPY --from=base /app /app

# Command for production run
CMD ["node", "app.js"]

# =========================================================
# 🧪 Test image with coverage wrapper (based on production)
# =========================================================
FROM production AS test

# Switch to root temporarily to install devDependencies
USER root

# Install devDependencies (c8, etc.) on top of production dependencies
RUN yarn install --frozen-lockfile

# Environment variables for test
ENV COVERAGE_PORT=9095
ENV NODE_ENV=test

# Note: Coverage data is stored purely in-memory (no filesystem writes!)
# No volume mounts or writable directories needed!

# Switch back to non-root user
USER 65532:65532

# Command for test mode - Run app.js through the coverage wrapper
CMD ["node", "/app/server/coverage_server.js", "/app/app.js"]

