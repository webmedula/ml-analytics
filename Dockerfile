# Node 24: e onde node:sqlite existe sem flag experimental. A alternativa (better-sqlite3) exige
# compilacao nativa dentro da alpine, com toolchain nas duas etapas do build.
#
# Chegamos a suspeitar desta linha quando quatro versoes seguidas nao subiam. Nao era ela: o deploy
# passa por GitHub Actions -> ghcr.io, e o EasyPanel estava servindo uma imagem antiga. A v28
# construiu e rodou nesta base sem nenhum problema.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
VOLUME ["/app/data"]
EXPOSE 3010
CMD ["node", "dist/index.js"]
