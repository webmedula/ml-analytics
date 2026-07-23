# tiny-analytics

Serviço **separado** de análises de mercado do Mercado Livre, para rodar ao lado do
`tiny-pedidos-nf` (que continua cuidando só da emissão de nota). Assim você atualiza e
experimenta aqui sem nunca reiniciar/arriscar o serviço que emite as NFs.

Primeira análise incluída: **Catálogo / Buy Box** — varre seus anúncios de catálogo e mostra,
para cada um, se você está ganhando/empatado/perdendo a página do produto e qual o preço
sugerido pelo Mercado Livre para reassumir o Buy Box (`price_to_win`).

## 1. Criar um aplicativo PRÓPRIO no Mercado Livre

Este serviço usa um aplicativo do ML **separado** do `tiny-pedidos-nf` (o ML trabalha com ~1
token por usuário+app; usar o mesmo app dos dois derrubaria um o login do outro).

1. Em https://developers.mercadolivre.com.br/ crie um **novo aplicativo**.
2. Em "URI de redirect", cadastre a URL pública deste serviço + `/oauth/ml/callback`
   (ex: `https://SEU-DOMINIO-ANALYTICS/oauth/ml/callback`).
3. Copie o **Client ID** e o **Client Secret**.

## 2. Configurar

```bash
cp .env.example .env
```

Preencha `ML_CLIENT_ID`, `ML_CLIENT_SECRET` e `ML_REDIRECT_URI` (igual ao cadastrado no app).
Se quiser proteger as rotas `/api/*`, defina `SERVICE_API_KEY`.

## 3. Rodar localmente

```bash
npm install
npm run dev
```

Abra `http://localhost:3010`, clique em **Conectar ao Mercado Livre** e autorize (só uma vez;
o token é renovado sozinho depois).

## 4. Deploy (Docker / EasyPanel)

O `push` na branch `main` builda e publica a imagem em
`ghcr.io/SEU-USUARIO/tiny-analytics:latest` (workflow em `.github/workflows`).

No EasyPanel, crie um **novo serviço** (pode ser no mesmo projeto do `tiny-pedidos-nf`)
apontando para essa imagem, com:

- Variáveis: `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI` (URL pública deste serviço),
  `SERVICE_API_KEY` (opcional), `PORT=3010`.
- Um volume próprio em `/app/data` (guarda o token do ML e o cache da análise).
- Um domínio próprio.

Depois do deploy, acesse a URL do serviço e conecte ao Mercado Livre uma vez.

## Endpoints

- `GET /health` — status, versão e `mlAuthenticated`.
- `GET /oauth/ml/login` — inicia o login no Mercado Livre.
- `GET /api/catalog/competition` — resultado da análise (`?refresh=1` força revarredura).
- `POST /api/catalog/refresh` — dispara a varredura em background.

## Ajustes

- `CATALOG_SCAN_MAX_ITEMS` (padrão 500) — teto de anúncios por varredura.
- `CATALOG_SCAN_INTERVAL_HOURS` (padrão 6) — frequência da varredura em background.

## Testes

```bash
npm test
```
