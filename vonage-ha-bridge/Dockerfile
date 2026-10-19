# syntax=docker/dockerfile:1

ARG NODE_VERSION=26
ARG ALPINE_VERSION=3.24

# Build stage
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS builder

ARG DEPENDENCY_REFRESH=0

WORKDIR /app

COPY package.json ./

RUN --mount=type=cache,target=/root/.npm \
    echo "Dependency refresh: ${DEPENDENCY_REFRESH}" && \
    npm install --omit=dev --no-audit --no-fund --package-lock=false

# Runtime stage
FROM alpine:${ALPINE_VERSION}

ARG VERSION=dev
ARG GITHUB_SHA
ARG BUILD_DATE
ARG UID=10001

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

# hadolint ignore=DL3018
RUN apk add --no-cache libstdc++ libatomic dumb-init \
    && addgroup -S -g "${UID}" appuser \
    && adduser -S -D -H -s /sbin/nologin \
        -u "${UID}" -G appuser appuser

WORKDIR /app

COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /app/node_modules ./node_modules

COPY src/ ./src/
COPY package.json ./

USER ${UID}

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["CMD-SHELL", "wget --quiet --tries=1 --spider http://127.0.0.1:3000/health"]

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "src/server.js"]
