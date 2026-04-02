FROM oven/bun:1-slim

# Install Python + uvx for stdio MCP backends (grafana, plane)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip pipx curl \
    && pipx install uv \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production

COPY src/ src/
COPY tsconfig.json ./

RUN bun build src/index.ts --target=bun --minify --outfile=dist/server.js

EXPOSE 3100

ENTRYPOINT ["bun", "dist/server.js"]
CMD ["/app/mcpx.json"]
