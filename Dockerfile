# Dexter headless bridge — runs bridge/server.ts (NOT the interactive ink CLI)
FROM oven/bun:1 AS base
WORKDIR /app

# curl is needed for the container healthcheck (docker-compose-cryonith.yml)
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
# Skip the postinstall's `playwright install chromium` here — the browser tool
# isn't needed for headless research-over-HTTP use and chromium is a heavy,
# slow download on Pi/arm64. Remove PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD if you
# want the `browser` tool available too.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 8090
CMD ["bun", "run", "bridge/server.ts"]
