FROM node:24.14.1-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY process/ ./process/
RUN mkdir result && chown node:node result

USER node
ENTRYPOINT ["node", "/app/index.js"]
CMD ["/input/ad_data.csv"]
