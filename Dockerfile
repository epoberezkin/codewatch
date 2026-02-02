FROM node:24-alpine

RUN apk add --no-cache git curl

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/server/index.js"]
