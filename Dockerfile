# =====================================
# ETAPA 1: Construcción del frontend
# =====================================
FROM node:22-alpine AS frontend-build

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# =====================================
# ETAPA 2: Servidor frontend con Nginx
# =====================================
FROM nginx:alpine AS frontend

COPY nginx/default.conf /etc/nginx/conf.d/default.conf

COPY --from=frontend-build /app/dist /usr/share/nginx/html

EXPOSE 80

# =====================================
# ETAPA 3: Backend Express
# =====================================
FROM node:22-alpine AS backend

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev

COPY server ./server

EXPOSE 3001

CMD ["npm", "run", "server"]