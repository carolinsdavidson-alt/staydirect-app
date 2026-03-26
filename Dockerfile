FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
# v2 - force rebuild
COPY . .
RUN node seed.js
EXPOSE 3000
CMD ["node", "server.js"]
