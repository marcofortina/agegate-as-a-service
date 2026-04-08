FROM node:20-alpine
WORKDIR /app
RUN mkdir -p /data && chmod 777 /data
COPY package*.json ./
RUN npm ci --only=production
COPY server.js proxy.js agegate-sdk.js tracing.js ./
EXPOSE 8080
CMD ["npm", "start"]
