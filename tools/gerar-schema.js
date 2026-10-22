/**
 * Gera o Schema.gs a partir de sql/schema.sql
 * Uso: node tools/gerar-schema.js
 *
 * O Apps Script não lê arquivos do repositório, então o SQL vai embutido
 * no Schema.gs como uma lista de comandos.
 */
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');

function lerComandos(sql) {
  const semComentarios = sql
    .split('\n')
    .filter(function(linha) { return !/^\s*--/.test(linha); })
    .map(function(linha) { return linha.replace(/\s+--\s.*$/, ''); })
    .join('\n');

  return semComentarios
    .split(/;\s*$/m)
    .map(function(c) { return c.trim(); })
    .filter(Boolean);
}

function gerar() {
  const sql = fs.readFileSync(path.join(raiz, 'sql', 'schema.sql'), 'utf8');
  const comandos = lerComandos(sql);
  // Maior número entre as linhas "(N, '...')" dos INSERT em schema_versao
  const versao = comandos
    .filter(function(c) { return /^INSERT OR IGNORE INTO schema_versao/.test(c); })
    .map(function(c) { return c.match(/\(\s*(\d+)\s*,/g) || []; })
    .reduce(function(a, b) { return a.concat(b); }, [])
    .map(function(m) { return parseInt(m.replace(/\D/g, ''), 10); })
    .reduce(function(a, b) { return Math.max(a, b); }, 0);

  const conteudo =
    '/**\n' +
    ' * Schema.gs - Comandos SQL do banco (Turso)\n' +
    ' *\n' +
    ' * ARQUIVO GERADO: não edite aqui. Altere sql/schema.sql e rode\n' +
    ' *   node tools/gerar-schema.js\n' +
    ' */\n\n' +
    'const SCHEMA_VERSAO = ' + versao + ';\n\n' +
    'const SCHEMA_SQL = ' + JSON.stringify(comandos, null, 2) + ';\n';

  fs.writeFileSync(path.join(raiz, 'Schema.gs'), conteudo);
  return { comandos: comandos.length, versao: versao };
}

if (require.main === module) {
  const r = gerar();
  console.log('Schema.gs gerado: ' + r.comandos + ' comandos, versão ' + r.versao);
}

module.exports = { gerar: gerar, lerComandos: lerComandos };
