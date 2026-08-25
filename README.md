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
- `GET /api/conversion` — conversão por anúncio (visitas × vendas).
- `GET /api/questions/pending` — perguntas sem resposta.
- `GET /api/ratings` — diagnóstico de nota por anúncio (`?refresh=1` força revarredura).
- `POST /api/ratings/refresh` — dispara a varredura de notas em background.
- `GET /debug/catalog/:itemId` — JSON cru do ML para um anúncio (diagnóstico manual).

## Diagnóstico de nota / candidatos a recriação

Anúncios com nota baixa performam pior, e a saída óbvia é recriar o anúncio para zerar a
pontuação. Só que isso **só funciona quando as opiniões pertencem ao anúncio (MLB)**. Se o
anúncio é de catálogo — ou é da lista geral mas o ML o sincronizou com um produto de catálogo —
as opiniões pertencem ao **produto** e são compartilhadas com os concorrentes: o anúncio novo
nasce com as mesmas estrelas e você só perdeu histórico de vendas e posicionamento.

`GET /api/ratings` varre **todos** os anúncios ativos (não só os de catálogo), lê a nota pelo id
do anúncio **e** pelo id do produto de catálogo, e compara. Nota e total idênticos = a opinião
vem do produto. Cada anúncio recebe um veredito:

| Veredito | Significado |
|---|---|
| `recriavel` | Nota abaixo do limite e a opinião mora no MLB — recriar zera. |
| `preso_ao_catalogo` | Nota abaixo do limite, mas a opinião é do produto — recriar não adianta. |
| `indefinido` | Nota baixa, mas faltou a nota do produto para comparar. |
| `poucas_opinioes` | Nota baixa com menos opiniões que o mínimo — tende a se diluir sozinha. |
| `nota_ok` / `sem_opinioes` / `sem_dados` | Sem ação. |

O campo `apiDeAvaliacoesDisponivel` vem `false` quando **nenhum** anúncio devolveu nota — sinal
de que o aplicativo do ML deste serviço não tem acesso ao recurso de opiniões. Nesse caso o
painel avisa em vez de mostrar uma lista vazia enganosa.

Esta análise é **somente leitura**: não altera nada no Mercado Livre.

## Ajustes

- `CATALOG_SCAN_MAX_ITEMS` (padrão 500) — teto de anúncios por varredura.
- `CATALOG_SCAN_INTERVAL_HOURS` (padrão 6) — frequência da varredura em background.
- `CONVERSION_MAX_ITEMS` (padrão 500) — teto da varredura de conversão.
- `RATINGS_SCAN_MAX_ITEMS` (padrão 500) — teto da varredura de notas.
- `RATINGS_SCAN_INTERVAL_HOURS` (padrão 12) — frequência da varredura de notas.
- `RATINGS_MIN_SCORE` (padrão 4.5) — abaixo disso o anúncio vira candidato.
- `RATINGS_MIN_REVIEWS` (padrão 3) — mínimo de opiniões para levar a nota a sério.

## Testes

```bash
npm test
```
