# Build stage: compile TypeScript with dev dependencies present.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

# Runtime stage: production dependencies and compiled output only.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run unprivileged: the server needs no write access and no host resources.
USER node

EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http-server.js"]
