FROM node:20-alpine

WORKDIR /srv
COPY api-gateway/package.json api-gateway/package-lock.json ./api-gateway/
RUN npm ci --omit=dev --prefix api-gateway
COPY api-gateway/server.js ./api-gateway/server.js
COPY frontend ./frontend

WORKDIR /srv/api-gateway
EXPOSE 3000
CMD ["sh", "-c", "if [ -s /certs/extra-ca.pem ]; then export NODE_EXTRA_CA_CERTS=/certs/extra-ca.pem; fi; exec node server.js"]
