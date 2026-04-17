# syntax=docker/dockerfile:1
# checkov:skip=CKV_DOCKER_3 Justification: UID is provided externally via build arg

ARG NODE_VERSION=22-alpine
FROM node:${NODE_VERSION}

ARG VERSION=dev
ARG GITHUB_SHA
ARG BUILD_DATE
ARG UID=10001

ENV APP_VERSION=$VERSION
ENV NODE_ENV=production

LABEL org.opencontainers.image.description="Vonage to Home Assistant bridge for SMS and voice."
LABEL org.opencontainers.image.documentation="https://github.com/ebertek/vonage-ha-bridge#readme"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/ebertek/vonage-ha-bridge"
LABEL org.opencontainers.image.title="Vonage HA Bridge"
LABEL org.opencontainers.image.url="https://github.com/ebertek/vonage-ha-bridge"
LABEL org.opencontainers.image.vendor="ebertek"

LABEL org.opencontainers.image.created=$BUILD_DATE
LABEL org.opencontainers.image.revision=$GITHUB_SHA
LABEL org.opencontainers.image.version=$VERSION

WORKDIR /app

RUN adduser \
    -D \
    -h /app \
    -s /sbin/nologin \
    -u "${UID}" \
    appuser

COPY package.json package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

COPY src ./src

RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "src/server.js"]
