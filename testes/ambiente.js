/**
 * Ambiente de testes: roda os arquivos .gs no Node, simulando os serviços
 * do Google Apps Script e o banco Turso (protocolo HTTP "v2/pipeline")
 * sobre um SQLite em memória.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { DOMParser } = require('@xmldom/xmldom');

const RAIZ = path.join(__dirname, '..');

// ============= TURSO FALSO =============

function criarTursoFalso() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const estat = { requisicoes: 0 };

  function valorJs(v) {
    if (!v || v.type === 'null') return null;
    if (v.type === 'integer') return Number(v.value);
    if (v.type === 'float') return Number(v.value);
    return v.value;
  }

  function valorHrana(v) {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    return { type: 'text', value: String(v) };
  }

  function executar(stmt) {
    const args = (stmt.args || []).map(valorJs);
    const sql = stmt.sql;
    const preparado = db.prepare(sql);
    const retornaLinhas = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    if (retornaLinhas) {
      const linhas = preparado.all(...args);
      const cols = linhas.length ? Object.keys(linhas[0]) : [];
      return {
        cols: cols.map(function(n) { return { name: n }; }),
        rows: linhas.map(function(l) { return cols.map(function(c) { return valorHrana(l[c]); }); }),
        affected_row_count: /\bRETURNING\b/i.test(sql) ? linhas.length : 0,
        last_insert_rowid: null
      };
    }
    const r = preparado.run(...args);
    return { cols: [], rows: [], affected_row_count: Number(r.changes), last_insert_rowid: String(r.lastInsertRowid) };
  }

  function avaliarCondicao(cond, resultados, erros) {
    if (!cond) return true;
    if (cond.type === 'ok') return !!resultados[cond.step];
    if (cond.type === 'error') return !!erros[cond.step];
    if (cond.type === 'not') return !avaliarCondicao(cond.cond, resultados, erros);
    if (cond.type === 'and') return cond.conds.every(function(c) { return avaliarCondicao(c, resultados, erros); });
    if (cond.type === 'or') return cond.conds.some(function(c) { return avaliarCondicao(c, resultados, erros); });
    throw new Error('condição desconhecida ' + cond.type);
  }

  function pipeline(corpo) {
    estat.requisicoes++;
    return {
      results: corpo.requests.map(function(req) {
        if (req.type === 'close') return { type: 'ok', response: { type: 'close' } };
        if (req.type === 'execute') {
          try {
            return { type: 'ok', response: { type: 'execute', result: executar(req.stmt) } };
          } catch (e) {
            return { type: 'error', error: { message: e.message } };
          }
        }
        if (req.type === 'batch') {
          const resultados = [];
          const erros = [];
          req.batch.steps.forEach(function(passo, i) {
            resultados[i] = null;
            erros[i] = null;
            if (!avaliarCondicao(passo.condition, resultados, erros)) return;
            try {
              resultados[i] = executar(passo.stmt);
            } catch (e) {
              erros[i] = { message: e.message };
            }
          });
          return { type: 'ok', response: { type: 'batch', result: { step_results: resultados, step_errors: erros } } };
        }
        return { type: 'error', error: { message: 'tipo desconhecido' } };
      })
    };
  }

  return { db: db, pipeline: pipeline, estat: estat };
}

// ============= XML SERVICE =============

function elemento(no) {
  if (!no) return null;
  function filhos(nome, ns) {
    const lista = [];
    for (let i = 0; i < no.childNodes.length; i++) {
      const c = no.childNodes[i];
      if (c.nodeType !== 1) continue;
      if (c.localName !== nome) continue;
      if (ns && c.namespaceURI !== ns.uri) continue;
      lista.push(c);
    }
    return lista;
  }
  return {
    getName: function() { return no.localName; },
    getChild: function(nome, ns) { return elemento(filhos(nome, ns)[0]); },
    getChildren: function(nome, ns) { return filhos(nome, ns).map(elemento); },
    getChildText: function(nome, ns) {
      const c = filhos(nome, ns)[0];
      return c ? c.textContent : null;
    },
    getAttribute: function(nome) {
      return no.hasAttribute(nome) ? { getValue: function() { return no.getAttribute(nome); } } : null;
    }
  };
}

const XmlService = {
  getNamespace: function(uri) { return { uri: uri }; },
  parse: function(texto) {
    let erro = null;
    const doc = new DOMParser({
      errorHandler: { error: function(e) { erro = e; }, fatalError: function(e) { erro = e; } }
    }).parseFromString(texto, 'text/xml');
    if (erro || !doc.documentElement) throw new Error('XML inválido: ' + erro);
    return { getRootElement: function() { return elemento(doc.documentElement); } };
  }
};

// ============= DRIVE =============

function iterador(lista) {
  let i = 0;
  return { hasNext: function() { return i < lista.length; }, next: function() { return lista[i++]; } };
}

function criarDrive() {
  const raizes = [];

  function blob(bytes, tipo, nome) {
    const buf = Buffer.from(bytes);
    return {
      getName: function() { return nome; },
      getBytes: function() { return Array.from(buf); },
      getDataAsString: function(charset) {
        return buf.toString(/8859-1|latin/i.test(charset || '') ? 'latin1' : 'utf8');
      }
    };
  }

  function pasta(nome) {
    const p = {
      nome: nome, lixo: false, pastas: [], arquivos: [],
      getName: function() { return p.nome; },
      setTrashed: function(v) { p.lixo = v; },
      getFolders: function() { return iterador(p.pastas.filter(function(x) { return !x.lixo; })); },
      getFoldersByName: function(n) { return iterador(p.pastas.filter(function(x) { return !x.lixo && x.nome === n; })); },
      createFolder: function(n) { const nova = pasta(n); p.pastas.push(nova); return nova; },
      getFiles: function() { return iterador(p.arquivos.filter(function(x) { return !x.lixo; })); },
      getFilesByName: function(n) { return iterador(p.arquivos.filter(function(x) { return !x.lixo && x.getName() === n; })); },
      createFile: function(b) {
        const a = { lixo: false, b: b, getName: function() { return b.getName(); }, getBlob: function() { return b; }, setTrashed: function(v) { a.lixo = v; } };
        p.arquivos.push(a);
        return a;
      }
    };
    return p;
  }

  const DriveApp = {
    getFoldersByName: function(n) { return iterador(raizes.filter(function(x) { return !x.lixo && x.nome === n; })); },
    createFolder: function(n) { const p = pasta(n); raizes.push(p); return p; }
  };

  return { DriveApp: DriveApp, blob: blob };
}

// ============= MONTAGEM DO CONTEXTO =============

function assinado(buf) {
  return Array.from(buf).map(function(b) { return b > 127 ? b - 256 : b; });
}

function criarAmbiente() {
  const turso = criarTursoFalso();
  const drive = criarDrive();
  const propriedades = {};
  const cache = {};
  const geocodificacoes = { total: 0 };

  const Utilities = {
    Charset: { UTF_8: 'UTF_8' },
    DigestAlgorithm: { SHA_256: 'sha256', MD5: 'md5' },
    computeHmacSha256Signature: function(msg, chave) {
      return assinado(crypto.createHmac('sha256', chave).update(msg, 'utf8').digest());
    },
    computeDigest: function(alg, texto) {
      return assinado(crypto.createHash(alg).update(texto, 'utf8').digest());
    },
    getUuid: function() { return crypto.randomUUID(); },
    sleep: function() {},
    base64Decode: function(b64) { return Array.from(Buffer.from(b64, 'base64')); },
    newBlob: function(bytes, tipo, nome) { return drive.blob(bytes, tipo, nome); },
    formatDate: function(d) { return d.toISOString(); }
  };

  const contexto = {
    console: { log: function() {}, error: function() {} },
    Buffer: Buffer,
    PropertiesService: {
      getScriptProperties: function() {
        return {
          getProperty: function(k) { return propriedades[k] === undefined ? null : propriedades[k]; },
          setProperty: function(k, v) { propriedades[k] = v; }
        };
      }
    },
    CacheService: {
      getScriptCache: function() {
        return { get: function(k) { return cache[k] || null; }, put: function(k, v) { cache[k] = v; } };
      }
    },
    LockService: {
      getScriptLock: function() {
        return { tryLock: function() { return true; }, waitLock: function() {}, releaseLock: function() {} };
      }
    },
    Utilities: Utilities,
    ScriptApp: { getService: function() { return { getUrl: function() { return 'https://script.google.com/macros/s/TESTE/exec'; } }; } },
    UrlFetchApp: {
      fetch: function(url, opcoes) {
        if (/\/v2\/pipeline$/.test(url)) {
          if (opcoes.headers.Authorization !== 'Bearer token-teste') {
            return { getResponseCode: function() { return 401; }, getContentText: function() { return 'unauthorized'; } };
          }
          const resposta = JSON.stringify(turso.pipeline(JSON.parse(opcoes.payload)));
          return { getResponseCode: function() { return 200; }, getContentText: function() { return resposta; } };
        }
        return { getResponseCode: function() { return 404; }, getContentText: function() { return ''; } };
      }
    },
    Maps: {
      newGeocoder: function() {
        const g = {
          setRegion: function() { return g; },
          setLanguage: function() { return g; },
          geocode: function(consulta) {
            geocodificacoes.total++;
            const h = crypto.createHash('md5').update(consulta).digest();
            return {
              status: 'OK',
              results: [{
                address_components: [{ types: ['administrative_area_level_1'], short_name: 'RS' }],
                geometry: { location: { lat: -29 - h[0] / 255, lng: -52 - h[1] / 255 }, location_type: 'ROOFTOP' }
              }]
            };
          }
        };
        return g;
      }
    },
    XmlService: XmlService,
    DriveApp: drive.DriveApp
  };
  vm.createContext(contexto);

  const arquivos = fs.readdirSync(RAIZ).filter(function(f) { return f.endsWith('.gs'); }).sort();
  const fonte = arquivos.map(function(f) {
    return '// ==== ' + f + ' ====\n' + fs.readFileSync(path.join(RAIZ, f), 'utf8');
  }).join('\n\n');
  vm.runInContext(fonte + '\n;globalThis.__CONFIG = CONFIG; globalThis.__PERFIL = PERFIL; globalThis.__SCHEMA = SCHEMA_SQL;', contexto, { filename: 'gas.js' });

  return {
    gas: contexto,
    db: turso.db,
    turso: turso,
    propriedades: propriedades,
    geocodificacoes: geocodificacoes,
    configurar: function(opcoes) {
      opcoes = opcoes || {};
      propriedades.TURSO_URL = 'libsql://teste-org.turso.io';
      propriedades.TURSO_TOKEN = 'token-teste';
      propriedades.TOKEN_SEGREDO = 'segredo-de-teste';
      propriedades.ADMIN_SENHA_HASH = contexto.hashSenha_(opcoes.senha || 'senha123');
      propriedades.MAPS_API_KEY = 'chave-mapa';
    }
  };
}

module.exports = { criarAmbiente: criarAmbiente };
