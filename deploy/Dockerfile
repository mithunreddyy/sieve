# Self-hosted Sieve proxy for a team. It listens on all interfaces INSIDE the container; publish the
# port only behind something that provides TLS and authentication (the proxy has no login of its own).
FROM oven/bun:1.4
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production
ENV SIEVE_HOME=/data SIEVE_PROXY_HOST=0.0.0.0
VOLUME /data
EXPOSE 8787
CMD ["bun", "packages/cli/src/main.ts", "proxy"]
