FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/analysis-contracts/package.json packages/analysis-contracts/package.json
COPY services/analysis-service/package.json services/analysis-service/package.json
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY packages/analysis-contracts packages/analysis-contracts
COPY services/analysis-service services/analysis-service
RUN npm run build --workspace @cat-thinking/analysis-contracts \
    && npm run build --workspace @cat-thinking/analysis-service

FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/analysis-contracts/package.json packages/analysis-contracts/package.json
COPY services/analysis-service/package.json services/analysis-service/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @cat-thinking/analysis-contracts --workspace @cat-thinking/analysis-service

FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2 AS runtime
ENV NODE_ENV=production
ENV ANALYSIS_HOST=0.0.0.0
ENV ANALYSIS_PORT=8787
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/packages/analysis-contracts/package.json ./packages/analysis-contracts/package.json
COPY --from=production-dependencies --chown=node:node /app/services/analysis-service/package.json ./services/analysis-service/package.json
COPY --from=build --chown=node:node /app/packages/analysis-contracts/dist ./packages/analysis-contracts/dist
COPY --from=build --chown=node:node /app/services/analysis-service/dist ./services/analysis-service/dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "services/analysis-service/dist/index.js"]
