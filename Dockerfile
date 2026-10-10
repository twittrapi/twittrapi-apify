# Based on Apify's TypeScript template. Images: https://docs.apify.com/sdk/js/docs/guides/docker-images
# The build context is the repository root.
FROM apify/actor-node:24 AS builder

COPY --chown=myuser:myuser package*.json ./
# The TwittrAPI SDK is vendored as a tarball until it is published on npm (see README, "SDK").
COPY --chown=myuser:myuser vendor ./vendor
RUN npm ci --include=dev --audit=false

COPY --chown=myuser:myuser . ./
RUN npm run build

# Final image
FROM apify/actor-node:24

COPY --chown=myuser:myuser package*.json ./
COPY --chown=myuser:myuser vendor ./vendor
RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional --audit=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -rf ~/.npm

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist
COPY --chown=myuser:myuser . ./

CMD ["node", "dist/main.js"]
