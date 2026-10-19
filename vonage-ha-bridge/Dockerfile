# syntax=docker/dockerfile:1

ARG NODE_VERSION=26-alpine
FROM node:${NODE_VERSION}

ARG VERSION=dev
ARG GITHUB_SHA
ARG BUILD_DATE
ARG UID=10001
ARG DEPENDENCY_REFRESH=0

ENV APP_VERSION=${VERSION} \
    NODE_ENV=production

LABEL org.opencontainers.image.description="Vonage to Home Assistant bridge for SMS and voice." \
      org.opencontainers.image.documentation="https://github.com/ebertek/vonage-ha-bridge#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/ebertek/vonage-ha-bridge" \
      org.opencontainers.image.title="Vonage HA Bridge" \
      org.opencontainers.image.url="https://github.com/ebertek/vonage-ha-bridge" \
      org.opencontainers.image.vendor="ebertek" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${GITHUB_SHA}" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app

RUN adduser \
    -D \
    -h /app \
    -s /sbin/nologin \
    -u "${UID}" \
    appuser

COPY package.json ./

RUN --mount=type=cache,target=/root/.npm \
    echo "Dependency refresh: ${DEPENDENCY_REFRESH}" && \
    npm install --omit=dev --no-audit --no-fund --package-lock=false

COPY src/ ./src/

USER ${UID}

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["CMD-SHELL", "wget --quiet --tries=1 --spider http://127.0.0.1:3000/health"]

CMD ["node", "src/server.js"]
