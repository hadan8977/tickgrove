FROM node:22.22.2-bookworm-slim AS web
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
FROM rust:1.90.0-bookworm AS rust
WORKDIR /app
COPY server/Cargo.toml server/Cargo.lock ./server/
RUN mkdir -p server/src/bin && printf 'fn main() {}\n' > server/src/main.rs && printf 'fn main() {}\n' > server/src/bin/trading-mcp.rs && CARGO_BUILD_JOBS=1 cargo build --locked --release --manifest-path server/Cargo.toml --bins && rm -rf server/src
COPY server ./server
RUN touch server/src/main.rs server/src/bin/trading-mcp.rs && CARGO_BUILD_JOBS=1 cargo build --locked --release --manifest-path server/Cargo.toml --bins
FROM node:22.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap libstdc++6 tzdata ca-certificates && rm -rf /var/lib/apt/lists/* && useradd -m -u 10001 trading
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
COPY --from=rust /app/server/target/release/trading-service /usr/local/bin/trading-service
COPY --from=rust /app/server/target/release/trading-mcp /usr/local/bin/trading-mcp
COPY --from=rust /app/server/target/release/trading-cli /usr/local/bin/trading-cli
COPY --from=rust /app/server/target/release/trading-admin /usr/local/bin/trading-admin
RUN mkdir /app/var && chown trading:trading /app/var
USER trading
ENV TRADING_ROOT=/app TRADING_DATA_DIR=/app/var TRADING_BIND=0.0.0.0:8787 TRADING_NODE=/usr/local/bin/node
EXPOSE 8787
CMD ["trading-service"]
