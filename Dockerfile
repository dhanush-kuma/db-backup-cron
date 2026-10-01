FROM node:20-alpine

RUN apk add --no-cache postgresql-client mysql-client

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

CMD ["npm", "start"]
