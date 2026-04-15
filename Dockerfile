FROM oven/bun:1-slim

# Install Python + uvx for stdio MCP backends (grafana, plane)
# Also install build tools for native node addons (better-sqlite3 via secure-exec)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip curl \
    build-essential python3-dev \
    && pip3 install --break-system-packages uv \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production && \
    ln -sf cjs/mock node_modules/node-stdlib-browser/mock

COPY src/ src/
COPY tsconfig.json ./

EXPOSE 3100

ENTRYPOINT ["bun", "src/index.ts"]
CMD ["/app/mcpx.json"]
