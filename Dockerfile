# IMAGEM BASE — deliberadamente a mesma que ja subia antes.
#
# A v27 trocou pra node:24 por causa do node:sqlite (SQLite nativo, sem dependencia compilada). O
# deploy parou de subir exatamente nessa versao, e a imagem base e a unica coisa que ela mudou fora
# do codigo. Voltar isola a causa: se subir agora, era a imagem; se nao subir, o problema esta no
# build ou no upload, e nao adianta mexer em codigo.
#
# Com Node 20 nao existe node:sqlite: o servico sobe e funciona, e /health informa o banco como
# indisponivel. Nada mais depende dele.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
VOLUME ["/app/data"]
EXPOSE 3010
CMD ["node", "dist/index.js"]
