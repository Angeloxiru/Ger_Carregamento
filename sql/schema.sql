-- =====================================================================
-- ROTA GAÚCHA 4.0 - Schema do banco (Turso / libSQL / SQLite)
--
-- Este arquivo é a fonte do schema. O Schema.gs é gerado a partir dele
-- com:  node tools/gerar-schema.js
--
-- Pode ser rodado várias vezes: tudo usa IF NOT EXISTS / INSERT OR IGNORE.
-- Cada comando termina com ";" no fim da linha (o gerador separa por aí).
--
-- Convenções:
--   lkp_*   tabelas de consulta (valores fixos de status e tipos)
--   vw_*    views de leitura usadas pelo painel e pelas telas
--   datas   texto ISO-8601 em UTC (ex: 2026-10-22T18:30:00Z)
--   ON DELETE CASCADE: excluir uma carga apaga notas, itens e leituras
-- =====================================================================

-- ---------------------------------------------------------------------
-- Controle de versão do schema
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_versao (
  versao      INTEGER PRIMARY KEY,
  descricao   TEXT NOT NULL,
  aplicada_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------------------
-- LOOKUPS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lkp_status_entrega (
  codigo    TEXT PRIMARY KEY,
  descricao TEXT NOT NULL,
  ordem     INTEGER NOT NULL
);
INSERT OR IGNORE INTO lkp_status_entrega (codigo, descricao, ordem) VALUES
  ('PENDENTE', 'Pendente', 1),
  ('CONCLUIDA', 'Concluída', 2);

CREATE TABLE IF NOT EXISTS lkp_status_carregamento (
  codigo    TEXT PRIMARY KEY,
  descricao TEXT NOT NULL,
  ordem     INTEGER NOT NULL
);
INSERT OR IGNORE INTO lkp_status_carregamento (codigo, descricao, ordem) VALUES
  ('NAO_INICIADO', 'Não iniciado', 1),
  ('EM_ANDAMENTO', 'Em andamento', 2),
  ('FINALIZADO', 'Finalizado', 3);

CREATE TABLE IF NOT EXISTS lkp_tipo_leitura (
  codigo    TEXT PRIMARY KEY,
  descricao TEXT NOT NULL
);
INSERT OR IGNORE INTO lkp_tipo_leitura (codigo, descricao) VALUES
  ('CODIGO_BARRAS', 'Leitura do código de barras'),
  ('DIGITADO', 'Código digitado à mão'),
  ('CONFIRMACAO', 'Confirmação com toque (item sem código de barras)');

CREATE TABLE IF NOT EXISTS lkp_resultado_leitura (
  codigo    TEXT PRIMARY KEY,
  descricao TEXT NOT NULL,
  aceita    INTEGER NOT NULL CHECK (aceita IN (0, 1))
);
INSERT OR IGNORE INTO lkp_resultado_leitura (codigo, descricao, aceita) VALUES
  ('ACEITA', 'Leitura aceita', 1),
  ('NAO_PERTENCE', 'Código não pertence a esta nota', 0),
  ('EXCEDENTE', 'Quantidade acima do esperado', 0),
  ('NOTA_FINALIZADA', 'Nota já estava completa', 0);

CREATE TABLE IF NOT EXISTS lkp_tipo_api (
  codigo        TEXT PRIMARY KEY,
  descricao     TEXT NOT NULL,
  custo_por_mil REAL NOT NULL DEFAULT 0,
  ordem         INTEGER NOT NULL
);
INSERT OR IGNORE INTO lkp_tipo_api (codigo, descricao, custo_por_mil, ordem) VALUES
  ('Mapa', 'Maps JavaScript API (Dynamic Maps)', 7.00, 1),
  ('Geocoding', 'Geocodificação pelo Apps Script (sem custo no Cloud)', 0, 2),
  ('Directions', 'Directions API (registros antigos)', 10.00, 3),
  ('Routes', 'Routes API (registros antigos)', 5.00, 4);

-- ---------------------------------------------------------------------
-- CADASTROS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transportadora (
  id        INTEGER PRIMARY KEY,
  documento TEXT NOT NULL UNIQUE,          -- CNPJ ou CPF, só dígitos
  nome      TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------------------
-- CARGA
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carga (
  id                    INTEGER PRIMARY KEY,
  numero                TEXT NOT NULL UNIQUE,   -- C123, C123A
  transportadora_id     INTEGER REFERENCES transportadora(id) ON DELETE SET NULL,
  status_carregamento   TEXT NOT NULL DEFAULT 'NAO_INICIADO'
                        REFERENCES lkp_status_carregamento(codigo),
  ordem_salva_em        TEXT,
  carregamento_inicio   TEXT,
  carregamento_fim      TEXT,
  criado_em             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  atualizado_em         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------------------
-- NOTA FISCAL (uma linha por NF-e da carga)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nota_fiscal (
  id                   INTEGER PRIMARY KEY,
  carga_id             INTEGER NOT NULL REFERENCES carga(id) ON DELETE CASCADE,
  numero               TEXT NOT NULL,          -- nNF
  serie                TEXT NOT NULL DEFAULT '',
  chave_acesso         TEXT NOT NULL DEFAULT '',
  emitida_em           TEXT NOT NULL DEFAULT '',
  destinatario         TEXT NOT NULL DEFAULT '',
  destinatario_doc     TEXT NOT NULL DEFAULT '',
  logradouro           TEXT NOT NULL DEFAULT '',  -- "Rua X, 123" (como a versão 3)
  bairro               TEXT NOT NULL DEFAULT '',
  cidade               TEXT NOT NULL DEFAULT '',
  uf                   TEXT NOT NULL DEFAULT '',
  cep                  TEXT NOT NULL DEFAULT '',
  peso_kg              REAL NOT NULL DEFAULT 0,
  valor_total          REAL NOT NULL DEFAULT 0,
  condicao_pagamento   TEXT NOT NULL DEFAULT '',
  arquivo_xml          TEXT NOT NULL DEFAULT '',
  ordem_entrega        INTEGER,                -- preenchida quando o motorista salva a rota
  status_entrega       TEXT NOT NULL DEFAULT 'PENDENTE'
                       REFERENCES lkp_status_entrega(codigo),
  concluida_em         TEXT,
  criado_em            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (carga_id, numero)
);
CREATE INDEX IF NOT EXISTS ix_nota_carga_ordem ON nota_fiscal (carga_id, ordem_entrega);

-- ---------------------------------------------------------------------
-- ITENS DA NOTA (det/prod do XML)
--   codigo_barras = cEANTrib normalizado (NULL quando "SEM GTIN" ou vazio)
--   qtd_esperada  = qTrib (cada leitura conta 1 unidade tributável)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nota_item (
  id              INTEGER PRIMARY KEY,
  nota_id         INTEGER NOT NULL REFERENCES nota_fiscal(id) ON DELETE CASCADE,
  n_item          INTEGER NOT NULL,           -- atributo nItem do <det>
  codigo_produto  TEXT NOT NULL DEFAULT '',   -- cProd
  descricao       TEXT NOT NULL DEFAULT '',   -- xProd
  ean             TEXT NOT NULL DEFAULT '',   -- cEAN (original)
  ean_trib        TEXT NOT NULL DEFAULT '',   -- cEANTrib (original)
  codigo_barras   TEXT,                       -- código usado na leitura
  unidade_com     TEXT NOT NULL DEFAULT '',   -- uCom
  qtd_com         REAL NOT NULL DEFAULT 0,    -- qCom
  unidade_trib    TEXT NOT NULL DEFAULT '',   -- uTrib
  qtd_trib        REAL NOT NULL DEFAULT 0,    -- qTrib
  qtd_esperada    REAL NOT NULL DEFAULT 0,
  UNIQUE (nota_id, n_item)
);
CREATE INDEX IF NOT EXISTS ix_item_nota ON nota_item (nota_id);
CREATE INDEX IF NOT EXISTS ix_item_codigo ON nota_item (codigo_barras);

-- ---------------------------------------------------------------------
-- LEITURAS DO CARREGAMENTO (uma linha por bipe ou confirmação)
--   id vem do coletor (UUID): reenviar a mesma leitura não duplica.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carregamento_leitura (
  id            TEXT PRIMARY KEY,
  carga_id      INTEGER NOT NULL REFERENCES carga(id) ON DELETE CASCADE,
  nota_id       INTEGER NOT NULL REFERENCES nota_fiscal(id) ON DELETE CASCADE,
  item_id       INTEGER REFERENCES nota_item(id) ON DELETE CASCADE,
  codigo_lido   TEXT NOT NULL DEFAULT '',
  quantidade    REAL NOT NULL DEFAULT 1,
  tipo          TEXT NOT NULL REFERENCES lkp_tipo_leitura(codigo),
  resultado     TEXT NOT NULL REFERENCES lkp_resultado_leitura(codigo),
  dispositivo   TEXT NOT NULL DEFAULT '',
  lido_em       TEXT NOT NULL,                -- hora no coletor
  recebido_em   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  estornada_em  TEXT                          -- "desfazer leitura"
);
CREATE INDEX IF NOT EXISTS ix_leitura_item ON carregamento_leitura (item_id, resultado, estornada_em);
CREATE INDEX IF NOT EXISTS ix_leitura_carga ON carregamento_leitura (carga_id, recebido_em);

-- ---------------------------------------------------------------------
-- GEOCODIFICAÇÃO (cache permanente, compartilhado entre cargas)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_cache (
  chave      TEXT PRIMARY KEY,               -- endereço normalizado (minúsculo)
  endereco   TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  precisao   TEXT NOT NULL DEFAULT 'exato' CHECK (precisao IN ('exato', 'aproximado', 'manual')),
  criado_em  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------------------
-- USO DE API (histórico de cobrança; fica mesmo depois de excluir a carga)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_uso (
  id                 INTEGER PRIMARY KEY,
  ocorrido_em        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  carga_numero       TEXT NOT NULL DEFAULT '',
  documento          TEXT NOT NULL DEFAULT '',
  transportadora     TEXT NOT NULL DEFAULT '',
  tipo               TEXT NOT NULL REFERENCES lkp_tipo_api(codigo),
  quantidade         INTEGER NOT NULL DEFAULT 1,
  custo_usd          REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_api_uso_data ON api_uso (ocorrido_em);

-- ---------------------------------------------------------------------
-- LOG DE ACESSO AOS LINKS (apagado junto com a carga)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS log_acesso (
  id            INTEGER PRIMARY KEY,
  ocorrido_em   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  carga_numero  TEXT NOT NULL DEFAULT '',
  perfil        TEXT NOT NULL CHECK (perfil IN ('MOTORISTA', 'CARREGAMENTO')),
  token_valido  INTEGER NOT NULL CHECK (token_valido IN (0, 1))
);
CREATE INDEX IF NOT EXISTS ix_log_carga ON log_acesso (carga_numero);

-- =====================================================================
-- VIEWS
-- =====================================================================

-- Item com o que já foi lido (só leituras aceitas e não estornadas)
DROP VIEW IF EXISTS vw_item_carregamento;
CREATE VIEW vw_item_carregamento AS
SELECT
  i.id              AS item_id,
  i.nota_id,
  n.carga_id,
  i.n_item,
  i.codigo_produto,
  i.descricao,
  i.codigo_barras,
  i.unidade_trib,
  i.qtd_esperada,
  COALESCE(l.qtd_lida, 0)                           AS qtd_lida,
  MAX(i.qtd_esperada - COALESCE(l.qtd_lida, 0), 0)  AS qtd_pendente,
  CASE WHEN COALESCE(l.qtd_lida, 0) >= i.qtd_esperada THEN 1 ELSE 0 END AS completo
FROM nota_item i
JOIN nota_fiscal n ON n.id = i.nota_id
LEFT JOIN (
  SELECT item_id, SUM(quantidade) AS qtd_lida
  FROM carregamento_leitura
  WHERE resultado = 'ACEITA' AND estornada_em IS NULL
  GROUP BY item_id
) l ON l.item_id = i.id;

-- Nota com o progresso do carregamento
DROP VIEW IF EXISTS vw_nota_carregamento;
CREATE VIEW vw_nota_carregamento AS
SELECT
  n.id                AS nota_id,
  n.carga_id,
  n.numero,
  n.destinatario,
  n.cidade,
  n.uf,
  n.ordem_entrega,
  COUNT(v.item_id)                    AS total_itens,
  COALESCE(SUM(v.completo), 0)        AS itens_completos,
  COALESCE(SUM(v.qtd_esperada), 0)    AS qtd_esperada,
  COALESCE(SUM(MIN(v.qtd_lida, v.qtd_esperada)), 0) AS qtd_lida,
  CASE WHEN COUNT(v.item_id) = COALESCE(SUM(v.completo), 0) THEN 1 ELSE 0 END AS completa
FROM nota_fiscal n
LEFT JOIN vw_item_carregamento v ON v.nota_id = n.id
GROUP BY n.id;

-- Resumo da carga para o painel
DROP VIEW IF EXISTS vw_carga_resumo;
CREATE VIEW vw_carga_resumo AS
SELECT
  c.id                    AS carga_id,
  c.numero,
  COALESCE(t.documento, '') AS documento,
  COALESCE(t.nome, '')      AS transportadora,
  c.status_carregamento,
  sc.descricao             AS status_carregamento_desc,
  c.ordem_salva_em,
  c.carregamento_inicio,
  c.carregamento_fim,
  c.criado_em,
  (SELECT COUNT(*) FROM nota_fiscal n WHERE n.carga_id = c.id) AS total_notas,
  (SELECT COUNT(*) FROM nota_fiscal n WHERE n.carga_id = c.id AND n.status_entrega = 'CONCLUIDA') AS notas_entregues,
  (SELECT COUNT(DISTINCT UPPER(TRIM(n.cidade)) || '|' || UPPER(n.uf)) FROM nota_fiscal n WHERE n.carga_id = c.id) AS cidades,
  (SELECT COALESCE(SUM(n.peso_kg), 0) FROM nota_fiscal n WHERE n.carga_id = c.id) AS peso_kg,
  (SELECT COUNT(*) FROM nota_fiscal n WHERE n.carga_id = c.id AND n.ordem_entrega IS NOT NULL) AS notas_com_ordem,
  (SELECT COUNT(*) FROM vw_nota_carregamento v WHERE v.carga_id = c.id AND v.completa = 1) AS notas_carregadas,
  (SELECT COALESCE(SUM(v.qtd_esperada), 0) FROM vw_nota_carregamento v WHERE v.carga_id = c.id) AS qtd_esperada,
  (SELECT COALESCE(SUM(v.qtd_lida), 0) FROM vw_nota_carregamento v WHERE v.carga_id = c.id) AS qtd_lida,
  (SELECT COUNT(*) FROM nota_item i JOIN nota_fiscal n ON n.id = i.nota_id
     WHERE n.carga_id = c.id AND i.codigo_barras IS NULL) AS itens_sem_codigo
FROM carga c
LEFT JOIN transportadora t ON t.id = c.transportadora_id
JOIN lkp_status_carregamento sc ON sc.codigo = c.status_carregamento;

-- Leituras recusadas (auditoria de código errado e excesso)
DROP VIEW IF EXISTS vw_leitura_recusada;
CREATE VIEW vw_leitura_recusada AS
SELECT
  l.id, c.numero AS carga, n.numero AS nota, l.codigo_lido, l.quantidade,
  r.descricao AS motivo, l.dispositivo, l.lido_em
FROM carregamento_leitura l
JOIN carga c ON c.id = l.carga_id
JOIN nota_fiscal n ON n.id = l.nota_id
JOIN lkp_resultado_leitura r ON r.codigo = l.resultado
WHERE r.aceita = 0;

INSERT OR IGNORE INTO schema_versao (versao, descricao) VALUES
  (1, 'Schema inicial: cargas, notas, itens, carregamento, geocache, uso de API');
