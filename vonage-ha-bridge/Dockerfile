FROM node:22-alpine

ARG BUILD_DATE
ARG GITHUB_SHA
ARG VERSION

LABEL org.opencontainers.image.created=$BUILD_DATE
LABEL org.opencontainers.image.revision=$GITHUB_SHA
LABEL org.opencontainers.image.version=$VERSION

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 3000

CMD ["npm", "start"]
