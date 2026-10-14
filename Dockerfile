FROM node:22.22.2-bookworm-slim AS web
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
FROM rust:1.90.0-bookworm AS rust
WORKDIR /app
COPY server/Cargo.toml server/Cargo.lock ./server/
RUN mkdir -p server/src/bin && printf '\n' > server/src/lib.rs && for entry in server/src/main.rs server/src/bin/tickgrove.rs server/src/bin/tickgrove-mcp.rs server/src/bin/tickgrove-admin.rs server/src/bin/trading-service.rs server/src/bin/trading-cli.rs server/src/bin/trading-mcp.rs server/src/bin/trading-admin.rs; do printf 'fn main() {}\n' > "$entry"; done && CARGO_BUILD_JOBS=1 cargo build --locked --release --manifest-path server/Cargo.toml --bin tickgrove-server --bin tickgrove --bin tickgrove-mcp --bin tickgrove-admin && rm -rf server/src
COPY server ./server
RUN touch server/src/lib.rs server/src/main.rs server/src/bin/tickgrove*.rs && CARGO_BUILD_JOBS=1 cargo build --locked --release --manifest-path server/Cargo.toml --bin tickgrove-server --bin tickgrove --bin tickgrove-mcp --bin tickgrove-admin
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap libstdc++6 tzdata ca-certificates && rm -rf /var/lib/apt/lists/* && useradd -m -u 10001 tickgrove
WORKDIR /app
COPY --from=web /app/node_modules ./node_modules
COPY --from=web /app/dist ./dist
COPY --from=web /app/src ./src
COPY --from=web /app/scripts ./scripts
COPY --from=web /app/extensions ./extensions
COPY --from=web /app/examples ./examples
COPY --from=web /app/server/COPYING ./licenses/AGPL-3.0.txt
COPY --from=web /app/docs ./docs
COPY --from=web /app/.env.example ./.env.example
COPY --from=rust /app/server/target/release/tickgrove-server /usr/local/bin/tickgrove-server
COPY --from=rust /app/server/target/release/tickgrove-mcp /usr/local/bin/tickgrove-mcp
COPY --from=rust /app/server/target/release/tickgrove /usr/local/bin/tickgrove
COPY --from=rust /app/server/target/release/tickgrove-admin /usr/local/bin/tickgrove-admin
RUN ln -s tickgrove-server /usr/local/bin/trading-service && ln -s tickgrove /usr/local/bin/trading-cli && ln -s tickgrove-mcp /usr/local/bin/trading-mcp && ln -s tickgrove-admin /usr/local/bin/trading-admin
RUN mkdir /app/var && chown tickgrove:tickgrove /app/var
USER tickgrove
ENV TRADING_ROOT=/app TRADING_DATA_DIR=/app/var TRADING_BIND=0.0.0.0:8787 TRADING_NODE=/usr/local/bin/node
EXPOSE 8787
CMD ["tickgrove-server"]
