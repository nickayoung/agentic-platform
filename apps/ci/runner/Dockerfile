# kairos-ci runner: clones one commit from Artifacts and runs the repo's checks (typecheck, lint, rule tests,
# workerd tests). Stateless; one container instance per run.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && useradd --create-home --uid 10001 ci
COPY server.mjs /app/server.mjs
USER ci
WORKDIR /home/ci
ENV CI=true NODE_ENV=test
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
