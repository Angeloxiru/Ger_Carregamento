# Rota Gaúcha 4.0: arquitetura e planejamento

Este documento registra como o sistema novo foi pensado, as decisões tomadas e o que fica para as próximas fases.

## 1. Ponto de partida

O repositório `Ger_roteirizacao` (versão 3.0) continua em produção e serviu só de consulta. Dele vieram, sem mudança de comportamento:

- importação dos XMLs de NF-e (upload pelo painel ou pasta `CargasEmRota` no Drive);
- roteirização sem custo: ordem das cidades e, dentro de cada cidade, ordem por proximidade (vizinho mais próximo + 2-opt + or-opt);
- tela do motorista (próxima parada, entregue/desfazer, ▲▼, recalcular, abrir no Maps, cobrar à vista);
- painel com senha, links com HMAC, uso de API por transportadora com PTAX.

## 2. Decisões

| Tema | Decisão | Motivo |
|------|---------|--------|
| Plataforma | Google Apps Script (igual à 3.0) | Mesma implantação, sem conta nova, geocodificação continua gratuita pelo Apps Script |
| Banco | Turso (libSQL) pela API HTTP | O carregamento grava muito mais que a roteirização (um registro por bipe). No Sheets cada gravação leva de 1 a 3 s e entra em fila; o Turso tem tabelas, views e transações |
| Planilha | Fica só com o menu de configuração | Nenhum dado de carga mora mais nela |
| Pasta do Drive | `CargasCarregamento` (a 3.0 usa `CargasEmRota`) | Definido pelo usuário: os dois sistemas rodam na mesma conta Google sem um excluir as cargas do outro |
| Código lido | `cEANTrib` do item | Definido pelo usuário |
| Quantidade | `qTrib` (quantidade tributável), sempre em unidades inteiras | Definido pelo usuário: a operação não trabalha com itens vendidos por peso |
| Rota depois do carregamento | Travada ao tocar em **Carregar**; só o painel destrava | Definido pelo usuário: a ordem do caminhão não pode mudar depois de carregado |
| Ordem do carregamento | Inversa da rota | A última entrega entra primeiro e fica no fundo do caminhão |
| Nota incompleta | Bloqueia: só passa para a próxima nota quando a atual estiver completa | Definido pelo usuário. Item sem código de barras é confirmado com um toque |
| Histórico de uso de API | Fica no banco quando a carga é excluída | Definido pelo usuário: é a base da cobrança das transportadoras |
| Pasta removida do Drive | A sincronização exclui a carga do banco | Definido pelo usuário: mesmo comportamento da 3.0 |

## 3. Visão geral

```
 Celular do motorista              Coletor (Android + leitor)            Computador do escritório
 MotoristaView.html                CarregamentoView.html                 PainelControle.html
   rota, entregas, QR code ──QR──▶   lê o QR, confere os itens             XMLs, cargas, itens, exclusão
        │                                │  fila local + lotes                  │
        └──────────── google.script.run ─┴──────────────────────────────────────┘
                                         │
                         Google Apps Script (Web App, executa como o dono)
     code.gs · Painel.gs · Motorista.gs · Carregamento.gs · RegraCarregamento.gs
     Cargas.gs · XMLProcessor.gs · Geo.gs · Turso.gs · Schema.gs
          │                    │                         │
     Turso (HTTPS)       Google Drive              Maps do Apps Script
  dados de tudo       XMLs em CargasCarregamento geocodificação (cota do Apps Script)
```

## 4. Fluxo completo

1. **Escritório** envia os XMLs da carga (`C123`). O sistema guarda os arquivos no Drive, lê destinatário, endereço, peso, transportadora **e os itens** (`cProd`, `xProd`, `cEAN`, `cEANTrib`, `qCom`, `qTrib`, unidades) e grava tudo no banco numa transação.
2. Os endereços são geocodificados na hora e ficam em `geo_cache` para sempre.
3. **Motorista** abre o link, revisa a rota sugerida (cidade, depois proximidade), ajusta se quiser e toca em **Salvar**.
4. Motorista toca em **Carregar** e confirma. A ordem atual é salva e a **rota fica travada**: ▲▼, Recalcular e Salvar deixam de funcionar (o servidor também recusa). Aparece um **QR code** com o link do carregamento (token próprio, diferente do link do motorista).
5. **Conferente** lê o QR com o coletor. A tela mostra a primeira nota a carregar (última entrega da rota): número da NF, cliente, cidade e a lista de itens.
6. Cada bipe soma 1 unidade no item. Se o campo **Qtd** tiver um número inteiro, aquele bipe vale essa quantidade e o campo se limpa. Itens sem código de barras têm o botão **Confirmar**.
7. Item completo fica verde. Nota completa mostra **Próxima nota** (ou basta ler o primeiro item da próxima). Ao terminar todas, aparece **Carregamento finalizado**.
8. O motorista acompanha o progresso no próprio QR (atualiza a cada 10 s) e o escritório vê tudo no painel, inclusive leituras recusadas.

### Quando a rota destrava

| Situação | O que acontece |
|----------|----------------|
| Escritório toca em **Destravar rota** (detalhes da carga no painel) | Motorista pode mudar a ordem. As leituras feitas continuam valendo; as notas que faltam passam a seguir a rota nova, invertida |
| Escritório toca em **Reiniciar carregamento** | Leituras apagadas, conferência do zero e rota destravada |
| Chega NF nova para a carga | Rota destravada, porque a NF nova precisa entrar na ordem. O motorista salva e toca em **Carregar** de novo |

## 5. Conferência de cada leitura

A regra fica em `RegraCarregamento.gs` e roda **nos dois lados**: o servidor envia o código-fonte dela para a tela do coletor (`REGRA_fonteCliente_`), então coletor e servidor nunca discordam.

| Resultado | Quando | O que o conferente vê |
|-----------|--------|----------------------|
| `ACEITA` | Código é desta nota e cabe na quantidade que falta | Fundo verde, bipe curto, item pisca |
| `NAO_PERTENCE` | Código não está nesta nota | Fundo vermelho, som grave. Se o produto for de outra nota da carga, diz qual NF e cliente |
| `EXCEDENTE` | Quantidade passa do que falta | Fundo vermelho com quanto falta |
| `NOTA_FINALIZADA` | Nota já estava completa | Fundo vermelho |

Detalhes:

- **Só unidades inteiras**: quantidade fracionada vira inteiro (2,7 vira 2) e zero ou vazio vira 1, no coletor e no servidor.
- **Zeros à esquerda**: `07891000100103` (GTIN-14) e `7891000100103` (EAN-13) são o mesmo código.
- **Mesmo código em dois itens** (ex.: venda e bonificação do mesmo produto): a quantidade é distribuída na ordem dos itens.
- **`SEM GTIN`** vira item sem código, confirmado com toque.
- Toda leitura, aceita ou recusada, fica gravada em `carregamento_leitura` (auditoria).

## 6. Coletor sem internet

As leituras entram numa **fila guardada no aparelho** (`localStorage`) e vão ao servidor em lotes de até 100, no máximo 0,6 s depois da primeira leitura pendente. Cada leitura tem um id único (UUID) gerado no coletor: se a rede cair no meio do envio e o lote for reenviado, nada é contado duas vezes. O indicador no topo mostra **Em dia**, **Enviando N** ou **N sem enviar**. Fechar e abrir a tela não perde a fila. Isso é testado em `testes/navegador.js`.

Mais de um coletor na mesma carga funciona: o servidor confere cada lote com trava (`LockService`) e devolve as quantidades oficiais. Se o servidor recusar uma leitura que o coletor tinha aceitado (outro coletor leu antes), a tela avisa.

## 7. Banco de dados

O schema está em [`sql/schema.sql`](../sql/schema.sql). O `Schema.gs` é gerado dele (`npm run schema`) e aplicado pelo menu da planilha. Pode rodar quantas vezes quiser. Versão atual: **2**. Colunas criadas depois da versão 1 ficam listadas em `DB_COLUNAS_NOVAS` (`Turso.gs`), que faz o `ALTER TABLE` em bancos criados antes delas.

### Tabelas

| Tabela | Conteúdo |
|--------|----------|
| `transportadora` | CNPJ/CPF e nome |
| `carga` | Número (C123), transportadora, status do carregamento, `rota_travada_em`, datas |
| `nota_fiscal` | Uma linha por NF: destinatário, endereço, peso, valor, condição de pagamento, ordem de entrega, status da entrega |
| `nota_item` | Itens da NF (`det/prod`), com `codigo_barras` normalizado e `qtd_esperada` |
| `carregamento_leitura` | Cada bipe ou confirmação: código, quantidade, resultado, aparelho, hora, estorno |
| `geo_cache` | Coordenadas por endereço (compartilhado entre cargas) |
| `api_uso` | Carregamentos de mapa e geocodificações por transportadora |
| `log_acesso` | Aberturas dos links (motorista e coletor) |
| `schema_versao` | Versão do schema aplicada |

### Lookups

`lkp_status_entrega`, `lkp_status_carregamento`, `lkp_tipo_leitura`, `lkp_resultado_leitura` e `lkp_tipo_api` (esta guarda o custo por mil chamadas usado na página de uso de API).

### Views

| View | Uso |
|------|-----|
| `vw_item_carregamento` | Item com quantidade lida (aceitas e não estornadas), pendente e se está completo |
| `vw_nota_carregamento` | Progresso por nota |
| `vw_carga_resumo` | Resumo da carga para o painel (notas, entregas, cidades, peso, rota salva, carregamento) |
| `vw_leitura_recusada` | Auditoria de código errado e excesso |

### Exclusão de carga

**Excluir no painel apaga tudo da carga no banco**, numa transação: leituras, itens, notas, logs de acesso e a própria carga. A pasta do Drive vai para a lixeira. Ficam no banco, de propósito:

- `geo_cache`: endereços servem para outras cargas e evitam geocodificar de novo;
- `api_uso`: histórico de cobrança das transportadoras.

As chaves estrangeiras também têm `ON DELETE CASCADE`, mas a exclusão não depende disso: os `DELETE` são explícitos.

### Como o Apps Script fala com o Turso

`Turso.gs` usa `UrlFetchApp` no endpoint `POST https://<banco>.turso.io/v2/pipeline` com `Authorization: Bearer <token>`. Transações usam o tipo `batch` com condições (cada passo só roda se o anterior deu certo; se algo falhar, `ROLLBACK`). Erros 5xx e 429 são tentados de novo até 3 vezes. A URL e o token ficam nas propriedades do script, nunca no código.

## 8. Segurança

- Painel com senha (hash SHA-256), bloqueio após 10 tentativas por 10 minutos.
- Links com HMAC-SHA256 e segredo nas propriedades do script. O link do coletor assina `CARREGAMENTO:<carga>`, então ele não abre a tela do motorista e vice-versa.
- Sem o segredo configurado, nenhum link funciona (a 3.0 aceitava um formato antigo; a 4.0 não).
- O token do Turso nunca vai para o navegador.

## 9. Desempenho e cotas

- Cada chamada ao banco é uma requisição `UrlFetchApp`. A cota diária do Apps Script é de 20 mil chamadas em conta Google gratuita e 100 mil em Google Workspace. Um lote de leituras usa 4 chamadas; abrir a tela do motorista usa cerca de 6.
- O plano gratuito do Turso cobre com folga o volume de uma distribuidora regional.
- O coletor não espera o servidor para responder ao bipe, então a velocidade de leitura não depende da internet.

## 10. Testes

| Comando | O que testa |
|---------|-------------|
| `npm test` | 26 testes do backend. Os arquivos `.gs` reais rodam no Node com os serviços do Google simulados e um Turso falso (SQLite em memória falando o mesmo protocolo HTTP) |
| `npm run test:telas` | As telas no Chromium: motorista gera o QR (o teste decodifica o QR e confere o link), rota travada, coletor confere a carga inteira com leitor simulado, queda de internet, painel (destravar rota) e exclusão. Salva capturas em `testes/capturas/` |

## 11. Próximas fases (sugestões)

1. **Leitura pela câmera** no celular, para quando não houver coletor (biblioteca de leitura de código de barras no navegador).
2. **Foto do caminhão carregado** anexada ao final do carregamento (fica no Drive da carga).
3. **Comprovante de entrega**: foto ou assinatura do cliente na tela do motorista.
4. **Relatórios** a partir das views: tempo médio de carregamento, erros de separação por produto, entregas por dia.
5. **Etiqueta de volume** (código da caixa diferente do GTIN), se a operação passar a etiquetar.
6. **Publicação pelo clasp** (ferramenta do Google para enviar os arquivos do repositório ao Apps Script sem copiar e colar).
