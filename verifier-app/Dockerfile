FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js .
COPY agegate-sdk.js .
EXPOSE 8080
CMD ["npm", "start"]
