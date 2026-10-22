/**
 * Turso.gs - Acesso ao banco Turso (libSQL) pela API HTTP
 *
 * O Turso aceita comandos SQL por HTTPS (protocolo "Hrana over HTTP"):
 *   POST https://<banco>.turso.io/v2/pipeline
 *   Authorization: Bearer <token>
 *
 * Funções:
 *   DB_consultar_(sql, args)   → [ {coluna: valor} ]
 *   DB_primeiro_(sql, args)    → {coluna: valor} | null
 *   DB_executar_(sql, args)    → { afetadas, ultimoId }
 *   DB_transacao_(comandos)    → tudo ou nada; comandos = [{sql, args}]
 *   DB_migrar_()               → cria/atualiza tabelas, views e lookups
 *
 * Os "?" do SQL recebem os valores de args, na ordem.
 */

// ============= CONFIGURAÇÃO =============

/**
 * URL HTTPS do banco a partir da propriedade TURSO_URL
 * Aceita "libsql://banco-org.turso.io" ou "https://banco-org.turso.io"
 */
function DB_url_() {
  const bruta = obterPropriedade_(PROP.TURSO_URL).trim().replace(/\/+$/, '');
  if (!bruta) {
    throw new Error('SEM_BANCO: O banco Turso não foi configurado. Na planilha, use o menu 🚚 Rota Gaúcha > Configurar sistema.');
  }
  return bruta.replace(/^libsql:\/\//i, 'https://').replace(/^wss?:\/\//i, 'https://');
}

function DB_configurado_() {
  return !!(obterPropriedade_(PROP.TURSO_URL) && obterPropriedade_(PROP.TURSO_TOKEN));
}

// ============= CONVERSÃO DE VALORES =============

/**
 * Converte um valor JavaScript para o formato do Turso
 */
function DB_valor_(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    if (!isFinite(v)) return { type: 'null' };
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  if (v instanceof Date) return { type: 'text', value: dataIso_(v) };
  return { type: 'text', value: String(v) };
}

/**
 * Converte um valor vindo do Turso para JavaScript
 */
function DB_lerValor_(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'float') return Number(v.value);
  if (v.type === 'blob') return v.base64;
  return v.value;
}

function DB_stmt_(sql, args) {
  return { sql: sql, args: (args || []).map(DB_valor_) };
}

/**
 * Transforma o resultado de um execute em lista de objetos
 */
function DB_linhas_(resultado) {
  const colunas = (resultado.cols || []).map(function(c) { return c.name; });
  return (resultado.rows || []).map(function(linha) {
    const obj = {};
    colunas.forEach(function(nome, i) { obj[nome] = DB_lerValor_(linha[i]); });
    return obj;
  });
}

// ============= HTTP =============

/**
 * Envia uma lista de requisições ao Turso e devolve os resultados
 * @param {Array} requisicoes - itens do pipeline (execute, batch...)
 * @returns {Array} results
 */
function DB_pipeline_(requisicoes) {
  const corpo = { requests: requisicoes.concat([{ type: 'close' }]) };
  const opcoes = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + obterPropriedade_(PROP.TURSO_TOKEN).trim() },
    payload: JSON.stringify(corpo),
    muteHttpExceptions: true
  };

  let resposta = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      resposta = UrlFetchApp.fetch(DB_url_() + '/v2/pipeline', opcoes);
    } catch (erroRede) {
      if (tentativa === 3) throw new Error('Sem conexão com o banco: ' + erroRede.message);
      Utilities.sleep(400 * tentativa);
      continue;
    }
    const codigo = resposta.getResponseCode();
    // 5xx e 429: tenta de novo; o resto é definitivo
    if ((codigo >= 500 || codigo === 429) && tentativa < 3) {
      Utilities.sleep(400 * tentativa);
      continue;
    }
    break;
  }

  const codigo = resposta.getResponseCode();
  const texto = resposta.getContentText();
  if (codigo === 401 || codigo === 403) {
    throw new Error('SEM_BANCO: O banco recusou o token (HTTP ' + codigo + '). Gere um token novo no Turso e salve em Configurar sistema.');
  }
  if (codigo !== 200) {
    throw new Error('Erro no banco (HTTP ' + codigo + '): ' + texto.substring(0, 300));
  }

  return JSON.parse(texto).results || [];
}

function DB_erroDe_(resultado) {
  const e = resultado && resultado.error;
  return new Error('Erro no banco: ' + (e ? (e.message || JSON.stringify(e)) : 'resposta inesperada'));
}

// ============= CONSULTAS =============

/**
 * DB_executar_ - Executa um comando
 * @returns {Object} { linhas, afetadas, ultimoId }
 */
function DB_executar_(sql, args) {
  const r = DB_pipeline_([{ type: 'execute', stmt: DB_stmt_(sql, args) }])[0];
  if (!r || r.type !== 'ok') throw DB_erroDe_(r);
  const res = r.response.result;
  return {
    linhas: DB_linhas_(res),
    afetadas: res.affected_row_count || 0,
    ultimoId: res.last_insert_rowid ? Number(res.last_insert_rowid) : null
  };
}

function DB_consultar_(sql, args) {
  return DB_executar_(sql, args).linhas;
}

function DB_primeiro_(sql, args) {
  return DB_consultar_(sql, args)[0] || null;
}

/**
 * DB_consultas_ - Várias consultas de leitura em uma única ida ao banco
 * @param {Array} consultas - [{sql, args}]
 * @returns {Array} [ [linhas], [linhas], ... ] na mesma ordem
 */
function DB_consultas_(consultas) {
  const resultados = DB_pipeline_(consultas.map(function(c) {
    return { type: 'execute', stmt: DB_stmt_(c.sql, c.args) };
  }));
  // O último resultado é o do "close"
  return resultados.slice(0, consultas.length).map(function(r) {
    if (!r || r.type !== 'ok') throw DB_erroDe_(r);
    return DB_linhas_(r.response.result);
  });
}

/**
 * DB_transacao_ - Executa comandos em uma transação (tudo ou nada)
 * Cada passo só roda se o anterior deu certo; se algum falhar, ROLLBACK.
 * @param {Array} comandos - [{sql, args}]
 * @returns {Array} [{ linhas, afetadas, ultimoId }] na mesma ordem dos comandos
 */
function DB_transacao_(comandos) {
  if (!comandos || comandos.length === 0) return [];

  const passos = [{ stmt: DB_stmt_('BEGIN') }];
  comandos.forEach(function(c) {
    passos.push({
      condition: { type: 'ok', step: passos.length - 1 },
      stmt: DB_stmt_(c.sql, c.args)
    });
  });
  const passoCommit = passos.length;
  passos.push({ condition: { type: 'ok', step: passoCommit - 1 }, stmt: DB_stmt_('COMMIT') });
  passos.push({ condition: { type: 'not', cond: { type: 'ok', step: passoCommit } }, stmt: DB_stmt_('ROLLBACK') });

  const r = DB_pipeline_([{ type: 'batch', batch: { steps: passos } }])[0];
  if (!r || r.type !== 'ok') throw DB_erroDe_(r);

  const resultado = r.response.result;
  const erros = resultado.step_errors || [];
  for (let i = 0; i < erros.length; i++) {
    if (erros[i]) {
      const comando = i >= 1 && i <= comandos.length ? ' [comando ' + i + ': ' + comandos[i - 1].sql.substring(0, 80) + ']' : '';
      throw new Error('Erro no banco: ' + (erros[i].message || JSON.stringify(erros[i])) + comando);
    }
  }
  if (!resultado.step_results[passoCommit]) {
    throw new Error('Erro no banco: a transação não foi concluída.');
  }

  return comandos.map(function(c, i) {
    const res = resultado.step_results[i + 1];
    return {
      linhas: DB_linhas_(res),
      afetadas: res.affected_row_count || 0,
      ultimoId: res.last_insert_rowid ? Number(res.last_insert_rowid) : null
    };
  });
}

/**
 * DB_marcadores_ - "?, ?, ?" para cláusulas IN
 */
function DB_marcadores_(quantidade) {
  return new Array(quantidade).fill('?').join(', ');
}

// ============= ESTRUTURA DO BANCO =============

/**
 * Colunas criadas depois da primeira versão do schema.
 * O CREATE TABLE IF NOT EXISTS não altera tabela que já existe, então
 * DB_migrar_ acrescenta estas colunas nos bancos criados antes delas.
 */
const DB_COLUNAS_NOVAS = [
  { tabela: 'carga', coluna: 'rota_travada_em', tipo: 'TEXT' }
];

/**
 * DB_alterTablesPendentes_ - ALTER TABLE das colunas que faltam em tabelas existentes
 */
function DB_alterTablesPendentes_() {
  const tabelas = {};
  DB_COLUNAS_NOVAS.forEach(function(c) { tabelas[c.tabela] = true; });
  const nomes = Object.keys(tabelas);
  const colunas = DB_consultas_(nomes.map(function(t) {
    return { sql: 'SELECT name FROM pragma_table_info(?)', args: [t] };
  }));

  const existentes = {};
  nomes.forEach(function(t, i) {
    existentes[t] = {};
    colunas[i].forEach(function(l) { existentes[t][l.name] = true; });
  });

  return DB_COLUNAS_NOVAS.filter(function(c) {
    const tabelaExiste = Object.keys(existentes[c.tabela]).length > 0;
    return tabelaExiste && !existentes[c.tabela][c.coluna];
  }).map(function(c) {
    return { sql: 'ALTER TABLE ' + c.tabela + ' ADD COLUMN ' + c.coluna + ' ' + c.tipo };
  });
}

/**
 * DB_migrar_ - Cria ou atualiza tabelas, views e lookups (pode rodar sempre)
 * @returns {Object} { versao, comandos }
 */
function DB_migrar_() {
  const alteracoes = DB_alterTablesPendentes_();
  DB_transacao_(alteracoes.concat(SCHEMA_SQL.map(function(sql) { return { sql: sql }; })));
  const v = DB_primeiro_('SELECT MAX(versao) AS versao FROM schema_versao');
  return { versao: v ? v.versao : 0, comandos: SCHEMA_SQL.length };
}

/**
 * DB_status_ - Situação do banco para o painel
 */
function DB_status_() {
  if (!DB_configurado_()) return { configurado: false, ok: false, mensagem: 'Banco não configurado' };
  try {
    const v = DB_primeiro_('SELECT MAX(versao) AS versao FROM schema_versao');
    const versao = v ? v.versao : 0;
    return {
      configurado: true,
      ok: versao >= SCHEMA_VERSAO,
      versao: versao,
      mensagem: versao >= SCHEMA_VERSAO ? 'Banco conectado' : 'Estrutura do banco desatualizada'
    };
  } catch (erro) {
    return { configurado: true, ok: false, mensagem: erro.message };
  }
}
