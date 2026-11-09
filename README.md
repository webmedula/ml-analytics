# tiny-analytics

> **v49 (2026-11-09):** filtros da aba Promoções passam a contar e escolher anúncios: "Vale a pena aderir" (há proposta que rende mais que a atual), "Já no melhor", "Sem promoção ativa", além dos antigos. Novos seletores de tipo de promoção e de ordenação (maior ganho, prazo para aderir, nome). Abre em "Todos", ordenado pelo maior ganho; o cabeçalho do anúncio mostra "até +R$ X por venda". A varredura agora guarda também os anúncios sem nenhuma promoção (`semPromocao`), que entram em "Sem promoção ativa" e no filtro "Sem nenhuma oferta do ML", os que mais vendem primeiro.

> **v48 (2026-11-07):** na aba Promoções, cada anúncio mostra no cabeçalho a promoção EM VIGOR (ou "sem promoção ativa") e avisa quando nenhuma proposta é melhor que a atual; a linha ativa mostra "em vigor" em vez de +R$ 0,00.
>
> **v47 (2026-11-06):** o acompanhamento sai da aba Promoções (que volta ao formato da v45, com uma linha de resumo e link) e ganha a aba **Acompanhamento**: **vence em breve agrupado por promoção + dia do fim** (grupo recolhido; ao abrir, uma linha por anúncio com só a melhor substituta — maior "você recebe" entre as propostas abertas sem `semEfeito`, calculada pelo cache atual — e "+N outras"), **ficou sem promoção** por anúncio, **prazo para aderir acabando** (nova situação `PRAZO_ADERIR_ACABANDO`: proposta aberta e interessante — ML banca parte ou "vs. hoje" ≥ 0 —, nunca `semEfeito`, fora se o anúncio já participa dela, sem prazo informado não entra, nem anúncio pausado/finalizado; uma linha por anúncio + proposta; vem do cache de promoções, então continua aparecendo se o banco estiver fora do ar) e **sem data de fim** (recolhido, agrupado por promoção). Os nomes dos tipos são os da aba Promoções (`ROTULO_DO_TIPO`). **Correção da "coberta":** uma programada só cobre a ativa se começar até 2h depois do fim dela (início no passado vale), **terminar depois** do fim da ativa (ou não ter fim) e não for `semEfeito`; a foto passa a guardar a lista de programadas (`programadas_json`, coluna adicionada na migração; fotos da v46 usam a programada única antiga). `GET /api/promocoes/acompanhamento` mantém os campos da v46 e ganha `grupos`, `prazoAderir[]` e `semDataPorPromocao[]`; `promocoes_vencendo` devolve o `resumoEmTexto` agrupado (títulos ⏳ Vencendo / 🚫 Ficou sem promoção / 📅 Prazo para aderir acabando; grupo 100% coberto e sem-data ficam fora; do grupo, só a linha, sem lista de anúncios). Nenhuma variável nova (`PROMOCOES_AVISO_DIAS` vale também para o prazo de adesão) e nenhuma escrita nova no ML.
>
> **v46 (2026-11-05):** acompanhamento de promoções, só leitura. Cada varredura de promoções grava uma "foto" por anúncio no SQLite (`promocoes_fotos`, retenção `PROMOCOES_FOTOS_RETENCAO_DIAS`, padrão 180) e o bloco **"Vencendo / sem promoção"** no topo da aba Promoções mostra: **termina em breve** (ativa com fim em até `PROMOCOES_AVISO_DIAS`, padrão 3; "termina hoje" no dia; "coberta" em cinza quando há programada começando até 2h depois do fim, e a folga aparece quando é maior), **ficou sem promoção** (tinha ativa/programada e não tem mais; sai ao voltar a ter promoção ou após `PROMOCOES_SEM_PROMO_DIAS`, padrão 14; pausado/finalizado não entra) e **sem data informada** (ativa sem fim, só no painel). Varredura truncada ou anúncio com erro gera foto inválida e não entra na comparação. Datas em horário de Brasília. Rotas: `GET /api/promocoes/acompanhamento`, `GET /debug/promocoes/fotos/:itemId`. Ferramenta `promocoes_vencendo` para o Gerente (somente leitura, `resumoEmTexto` pronto). Nenhuma escrita nova no ML.
>
> **v45 (2026-11-05):** "Participar" volta para a relâmpago co-participada (SMART_LIGHTNING), agora com o estoque reservado e formatos alternativos tentados em ordem só enquanto o ML responder 400 (todas as tentativas vão pro histórico). Anúncio com envio por conta do comprador não desconta frete. `/debug/promocoes` traz a tarifa em cada preço proposto, com e sem os dados de envio.
>
> **v44 (2026-11-05):** "vs. hoje" compara com o que o vendedor já recebe na promoção ativa (incluindo a parte do ML), e proposta com preço acima do atual aparece como "não muda" (o ML aplica o menor preço; ex.: OUTUBRO a 2.754,05 com a ativa a 1.733 não dá +847). A aba abre no filtro "ML banca parte", com a ativa do anúncio ao lado para comparar.
>
> **v43 (2026-11-05):** a parte que o ML banca aparece como aproximada (~): `meli_percentage` vem com 1 casa (5,4% vs 5,437% real) e o detalhe em `/seller-promotions/{candidates,offers}/{id}` não traz valor em reais (conferido no MLB3827163247).
>
> **v42 (2026-11-05):** a relâmpago comum (LIGHTNING) candidata some quando o anúncio tem a co-participada (SMART_LIGHTNING) como proposta, como na tela do ML. preço proposto das candidatas igual ao da tela do ML: campanha/relâmpago/oferta do dia = teto da faixa sem passar do preço de hoje; campanha própria = teto da faixa (o % da campanha). O `suggested_discounted_price` da API não é o que a tela mostra (MLB3827163247: 11.11 a 203,69, não 173,69; OUTUBRO a 284,99, não 209,99).
>
> **v41 (2026-11-04):** relâmpago co-participada (SMART_LIGHTNING) sai da adesão pelo painel: a doc do ML não documenta, e o corpo de SMART voltou 400 "Invalid request." no MLB5332741758. Adere-se pela tela do ML.
>
> **v40 (2026-11-04):** recusa do ML ao aderir volta com 200 + `ok:false` (com 502 o proxy apagava o motivo) e `/debug/promocoes-adesoes?key=` mostra a resposta crua. o "você recebe" da aba Promoções passa a usar o frete grátis que o ML cobra naquele preço (`/users/{id}/shipping_options/free?item_id=&item_price=`), em vez do frete médio de 30 dias. No MLB5332741758 bate com a tela: 172,69 − tarifa 20,72 − frete 21,75 = 130,22, e a 237,49 o frete sobe para 25,45 (183,54). A parte que o ML banca continua vindo de `meli_percentage`, que pode diferir alguns reais da tela (relâmpago: API 3,1% = 7,75, tela 10,25).
>
> **v39 (2026-11-04):** "Participar" na aba Promoções simula e adere ali mesmo (antes abria o ml-actions). É a única escrita no ML deste serviço: exige `PROMOCOES_ENABLED=true`, simulação (token de 30 min) e confirmação; histórico em `data/promocoes-adesoes.json`. O Gerente não alcança essas rotas (só chama `/api/assistente/ferramenta/*`). Inclui campanha própria (SELLER_CAMPAIGN). `/debug/promocoes/:itemId` passa a trazer `custosDaVenda` (tarifa e frete grátis no preço de hoje e no cheio) para acertar o "você recebe".
>
> **v38 (2026-11-04):** a aba Promoções passa a bater com a tela do ML, conferido no MLB3752079801.
> Mostra **Ativa** (a que define o preço; o `sale_price` traz `campaign_id` = id da promoção e
> `promotion_id` = `ref_id` da oferta), **Programada** (status `pending`) e **Nova proposta**. A
> campanha própria sem adesão (ex.: "OUTUBRO 2026") volta a aparecer. Candidatas do ML
> (campanha, relâmpago, oferta do dia) não propõem preço acima do de hoje: o preço que a tela do
> ML sugere não vem na API. A aba abre em "Todas".

> **v37 (2026-11-03):** botão **Participar** em cada proposta da aba Promoções. Ele abre o
> ml-actions (v21+) já na simulação da adesão. Este serviço continua só lendo. O link do ml-actions
> passou a ser `https://actions.mcs.ind.br/`.

> **v36 (2026-11-03):** promoções ajustadas com a resposta real do ML. "Hoje" passa a ser o preço
> de venda atual (`/items/{id}/sale_price`, com a promoção ativa) e não o preço cheio. Ofertas que
> o ML cria prontas (SMART, PRICE_MATCHING, SMART_LIGHTNING) contam como proposta enquanto não
> definem o preço, igual à tela. Candidatos usam o preço sugerido, e o convite genérico de
> "desconto próprio" deixa de aparecer como proposta. Nova aba **Promoções** no painel: propostas
> agrupadas por anúncio, com o preço de hoje, a parte que o ML banca, o "você recebe" e a diferença
> por venda. Tem filtros de relâmpago, ML banca, novas (24h) e já participando, e um botão "Varrer agora".

> **v35 (2026-11-03):** **propostas de promoção do ML** (as mesmas da tela
> `/anuncios/lista/promos`: oferta relâmpago, campanhas como 11.11, co-participação em que o ML
> banca parte do desconto). Varredura a cada 6h (`PROMOCOES_SCAN_INTERVAL_HOURS`) via
> `/seller-promotions/items/{id}?app_version=v2`, com estimativa de "você recebe" por venda
> (preço + parte do ML − tarifa pela tabela do ML − frete médio de 30 dias) comparada ao preço
> de hoje. Ferramenta `promocoes_do_ml` para o Gerente; `GET /api/promocoes`,
> `POST /api/promocoes/refresh` e `GET /debug/promocoes/:itemId` (JSON cru, para conferir com a
> tela). Somente leitura: não adere a nada. Se o ML responder 403, ligue a permissão de
> promoções no aplicativo do ML (DevCenter) e refaça o login em `/oauth/ml/login`.

> **v34 (2026-09-24):** novas rotas `GET /api/assistente/ferramentas` e
> `POST /api/assistente/ferramenta/:nome`, usadas pelo **mcs-gerente** (bot do Telegram em serviço
> próprio, que consulta os três sistemas da MCS). Somente leitura, protegidas pelo `x-api-key`.
> O bot do Telegram continua funcionando aqui nesta versão, como plano de volta durante a troca
> de webhook; sai numa versão seguinte, depois que o Gerente estiver estável.

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
