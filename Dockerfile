# Cloud Run image for the recruiting-ops analytics app (C3).
# Multi-stage: deps -> build -> minimal standalone runner. The build is env-free
# (all configuration reads happen at request time), so no secrets ever enter a
# layer; runtime env arrives from Secret Manager via Cloud Run.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN node -e "const sharp=require('sharp'); sharp({create:{width:1,height:1,channels:4,background:{r:0,g:0,b:0,alpha:1}}}).png().toBuffer().then((buffer)=>{if(buffer.length===0)throw new Error('sharp native smoke failed')})"

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Match the Cloud Run Job heap so the reviewed image and CI build share the
# same memory boundary instead of Node's smaller CI/container default.
ENV NODE_OPTIONS=--max-old-space-size=3072
# Match the repo's verified build path (webpack; turbopack is not the gated bundler here).
RUN ./node_modules/.bin/next build --webpack

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run injects PORT; HOSTNAME must bind all interfaces inside the container.
ENV HOSTNAME=0.0.0.0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/scripts/recruiting-ops/staging-hydration-job-launcher.mjs ./staging-hydration-job-launcher.mjs
COPY --from=build --chown=nextjs:nodejs /app/scripts/employee-referral-report-operator-launcher.mjs ./employee-referral-report-operator-launcher.mjs
USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
