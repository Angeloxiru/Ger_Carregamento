/**
 * Testes ponta a ponta do backend (npm test)
 *
 * Cada teste cria um ambiente novo: banco SQLite em memória falando o
 * protocolo do Turso, Drive em memória e as funções reais dos arquivos .gs.
 */
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { criarAmbiente } = require('./ambiente');
const { arquivosBase64, NOTAS } = require('./xml-exemplo');
const { lerComandos } = require('../tools/gerar-schema');

const SENHA = 'senha123';
const testes = [];
function teste(nome, fn) { testes.push({ nome: nome, fn: fn }); }
/** Copia valores criados dentro do vm (outro "realm") para comparar com deepStrictEqual */
function js(valor) { return JSON.parse(JSON.stringify(valor)); }

/** Ambiente configurado, com banco criado e a carga C100 importada */
function comCarga() {
  const amb = criarAmbiente();
  amb.configurar({ senha: SENHA });
  amb.gas.DB_migrar_();
  const r = amb.gas.PAINEL_uploadXMLs(SENHA, 'c100', arquivosBase64());
  assert.ok(r.sucesso, JSON.stringify(r));
  amb.tokenMotorista = amb.gas.gerarToken_('C100', 'MOTORISTA');
  amb.tokenCarreg = amb.gas.gerarToken_('C100', 'CARREGAMENTO');
  return amb;
}

/** Salva a ordem da rota: 1001 → 1002 → 1003 */
function salvarOrdem(amb) {
  const r = amb.gas.MOTORISTA_salvarOrdemRota('C100', amb.tokenMotorista, { 1001: 1, 1002: 2, 1003: 3 });
  assert.ok(r.sucesso, JSON.stringify(r));
}

let seq = 0;
function leitura(notaId, codigo, extra) {
  return Object.assign({ id: 'L' + (++seq), notaId: notaId, codigo: codigo, quantidade: 1, tipo: 'CODIGO_BARRAS', lidoEm: '2026-10-22T12:00:00Z', dispositivo: 'teste' }, extra || {});
}

function contar(amb, tabela, where) {
  return amb.db.prepare('SELECT COUNT(*) AS n FROM ' + tabela + (where ? ' WHERE ' + where : '')).get().n;
}

// =====================================================================

teste('schema.sql e Schema.gs estão sincronizados', function() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  const amb = criarAmbiente();
  assert.deepStrictEqual(js(amb.gas.__SCHEMA), lerComandos(sql),
    'Rode "npm run schema" depois de alterar sql/schema.sql');
});

teste('migração cria tudo e pode rodar de novo', function() {
  const amb = criarAmbiente();
  amb.configurar();
  const r1 = amb.gas.DB_migrar_();
  const r2 = amb.gas.DB_migrar_();
  assert.strictEqual(r1.versao, 2);
  assert.strictEqual(r2.versao, 2);
  assert.strictEqual(contar(amb, 'lkp_resultado_leitura'), 4);
  assert.ok(amb.gas.DB_status_().ok);
});

teste('transação desfaz tudo quando um comando falha', function() {
  const amb = criarAmbiente();
  amb.configurar();
  amb.gas.DB_migrar_();
  assert.throws(function() {
    amb.gas.DB_transacao_([
      { sql: 'INSERT INTO transportadora (documento, nome) VALUES (?, ?)', args: ['1', 'A'] },
      { sql: 'INSERT INTO tabela_que_nao_existe VALUES (1)' }
    ]);
  }, /Erro no banco/);
  assert.strictEqual(contar(amb, 'transportadora'), 0);
});

teste('token errado do banco dá erro claro', function() {
  const amb = criarAmbiente();
  amb.configurar();
  amb.propriedades.TURSO_TOKEN = 'outro';
  assert.throws(function() { amb.gas.DB_consultar_('SELECT 1'); }, /recusou o token/);
});

teste('upload grava notas, itens e transportadora', function() {
  const amb = comCarga();
  assert.strictEqual(contar(amb, 'carga'), 1);
  assert.strictEqual(contar(amb, 'nota_fiscal'), 3);
  assert.strictEqual(contar(amb, 'nota_item'), 6);
  const t = amb.db.prepare('SELECT * FROM transportadora').get();
  assert.strictEqual(t.documento, '04252011000110');

  const semGtin = amb.db.prepare("SELECT * FROM nota_item WHERE codigo_produto = 'A20'").get();
  assert.strictEqual(semGtin.codigo_barras, null);
  assert.strictEqual(semGtin.ean_trib, 'SEM GTIN');
  const gtin14 = amb.db.prepare("SELECT * FROM nota_item WHERE codigo_produto = 'A10'").get();
  assert.strictEqual(gtin14.codigo_barras, '7891000100103');
  assert.strictEqual(gtin14.qtd_esperada, 3);

  const nf = amb.db.prepare("SELECT * FROM nota_fiscal WHERE numero = '1003'").get();
  assert.strictEqual(nf.condicao_pagamento, 'A VISTA');
  assert.strictEqual(nf.logradouro, 'Rua Júlio de Castilhos, 9');
  assert.strictEqual(nf.peso_kg, 10.5);
});

teste('reenviar os mesmos XMLs não duplica; NF nova é acrescentada', function() {
  const amb = comCarga();
  amb.gas.PAINEL_uploadXMLs(SENHA, 'C100', arquivosBase64());
  assert.strictEqual(contar(amb, 'nota_fiscal'), 3);

  const nova = [{ numero: 1004, cliente: 'Loja Nova', rua: 'Rua A', nro: '1', bairro: 'B', cidade: 'Santa Cruz do Sul',
    itens: [{ cProd: 'D1', xProd: 'Item', cEANTrib: '7891000500501', qTrib: '1' }] }];
  const r = amb.gas.PAINEL_uploadXMLs(SENHA, 'C100', arquivosBase64(nova));
  assert.ok(r.sucesso);
  assert.strictEqual(contar(amb, 'nota_fiscal'), 4);
  assert.strictEqual(contar(amb, 'nota_item'), 7);
});

teste('painel lista a carga com resumo do carregamento', function() {
  const amb = comCarga();
  const r = amb.gas.PAINEL_listarCargasComLinks(SENHA);
  assert.ok(r.sucesso, r.erro);
  assert.strictEqual(r.cargas.length, 1);
  const c = r.cargas[0];
  assert.strictEqual(c.totalEntregas, 3);
  assert.strictEqual(c.cidades, 2);
  assert.strictEqual(c.rotaSalva, false);
  assert.strictEqual(c.carregamento.status, 'NAO_INICIADO');
  assert.strictEqual(c.carregamento.qtdEsperada, 13);
  assert.strictEqual(c.carregamento.itensSemCodigo, 1);
  assert.ok(/\?carga=C100&token=/.test(c.link));
});

teste('painel exige senha', function() {
  const amb = comCarga();
  assert.throws(function() { amb.gas.PAINEL_listarCargasComLinks('errada'); }, /SENHA_INVALIDA/);
});

teste('motorista abre a carga com coordenadas e o geocache evita consultas repetidas', function() {
  const amb = comCarga();
  const antes = amb.geocodificacoes.total;
  const r = amb.gas.MOTORISTA_buscarCarga('C100', amb.tokenMotorista);
  assert.ok(r.sucesso, r.erro);
  assert.strictEqual(r.entregas.length, 3);
  assert.ok(r.entregas.every(function(e) { return typeof e.lat === 'number'; }));
  assert.strictEqual(amb.geocodificacoes.total, antes, 'endereços já estavam no cache desde a importação');
  assert.strictEqual(r.transportadora, 'Transportes Xiru Ltda');
  assert.strictEqual(contar(amb, 'log_acesso', "perfil = 'MOTORISTA' AND token_valido = 1"), 1);
});

teste('token do carregamento não abre a tela do motorista e vice-versa', function() {
  const amb = comCarga();
  salvarOrdem(amb);
  assert.ok(!amb.gas.MOTORISTA_buscarCarga('C100', amb.tokenCarreg).sucesso);
  assert.ok(!amb.gas.CARREG_abrir('C100', amb.tokenMotorista).sucesso);
  assert.ok(amb.gas.CARREG_abrir('C100', amb.tokenCarreg).sucesso);
});

teste('QR code só depois de salvar a ordem; ordem de carregamento é a inversa da rota', function() {
  const amb = comCarga();
  const antes = amb.gas.MOTORISTA_carregamento('C100', amb.tokenMotorista);
  assert.ok(!antes.sucesso && antes.semOrdem);

  salvarOrdem(amb);
  const r = amb.gas.MOTORISTA_carregamento('C100', amb.tokenMotorista);
  assert.ok(r.sucesso, r.erro);
  assert.ok(r.link.indexOf('?page=carregamento&carga=C100&token=' + amb.tokenCarreg) !== -1);

  const ab = amb.gas.CARREG_abrir('C100', amb.tokenCarreg);
  assert.deepStrictEqual(js(ab.notas.map(function(n) { return n.numero; })), ['1003', '1002', '1001']);
});

teste('leituras: aceita, código de outra nota, excedente, reenvio e GTIN-14', function() {
  const amb = comCarga();
  salvarOrdem(amb);
  const notas = amb.gas.CARREG_abrir('C100', amb.tokenCarreg).notas;
  const n1001 = notas[2];
  const n1003 = notas[0];

  const l1 = leitura(n1003.id, '7891000400404');
  const errado = leitura(n1003.id, '7891000100103');
  const r = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [errado, l1]);
  assert.ok(r.sucesso, r.erro);
  assert.deepStrictEqual(js(r.resultados.map(function(x) { return x.resultado; })), ['NAO_PERTENCE', 'ACEITA']);
  assert.strictEqual(r.status, 'EM_ANDAMENTO');

  // Nota 1003 completa: nova leitura é recusada
  const extra = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [leitura(n1003.id, '7891000400404')]);
  assert.strictEqual(extra.resultados[0].resultado, 'NOTA_FINALIZADA');

  // Reenvio da mesma leitura (falha de rede) não soma de novo
  const reenvio = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [l1]);
  assert.ok(reenvio.resultados[0].repetida);
  assert.strictEqual(reenvio.lidas[n1003.itens[0].id], 1);

  // GTIN lido com 13 dígitos casa com cEANTrib de 14 dígitos; quantidade 4 > 3 é excedente
  const exc = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [leitura(n1001.id, '7891000100103', { quantidade: 4 })]);
  assert.strictEqual(exc.resultados[0].resultado, 'EXCEDENTE');
  const ok = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [leitura(n1001.id, '07891000100103', { quantidade: 3 })]);
  assert.strictEqual(ok.resultados[0].resultado, 'ACEITA');
  assert.strictEqual(ok.lidas[n1001.itens[0].id], 3);

  const det = amb.gas.PAINEL_detalheCarga(SENHA, 'C100');
  assert.strictEqual(det.recusadas.length, 3);
});

teste('mesmo código em dois itens: quantidade distribuída; item sem GTIN confirmado com toque', function() {
  const amb = comCarga();
  salvarOrdem(amb);
  const notas = amb.gas.CARREG_abrir('C100', amb.tokenCarreg).notas;
  const n1002 = notas[1];
  const n1001 = notas[2];

  const r = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [
    leitura(n1002.id, '7891000200206', { quantidade: 4 }),
    leitura(n1002.id, '7891000200206'),
    leitura(n1002.id, '7891000300305', { quantidade: 2, tipo: 'DIGITADO' }),
    leitura(n1001.id, '', { tipo: 'CONFIRMACAO', itemId: n1001.itens[1].id, quantidade: 2 })
  ]);
  assert.deepStrictEqual(js(r.resultados.map(function(x) { return x.resultado; })), ['ACEITA', 'ACEITA', 'ACEITA', 'ACEITA']);
  assert.strictEqual(r.lidas[n1002.itens[0].id], 3);
  assert.strictEqual(r.lidas[n1002.itens[1].id], 2);
  assert.strictEqual(r.lidas[n1002.itens[2].id], 2);
  assert.strictEqual(r.lidas[n1001.itens[1].id], 2);
  // A leitura de 4 virou duas linhas (3 no primeiro item, 1 no segundo)
  assert.strictEqual(contar(amb, 'carregamento_leitura', "id LIKE 'L%#2'"), 1);

  // Confirmação com toque não vale para item que tem código de barras
  const t = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [
    leitura(n1001.id, '', { tipo: 'CONFIRMACAO', itemId: n1001.itens[0].id })
  ]);
  assert.strictEqual(t.resultados[0].resultado, 'NAO_PERTENCE');
});

teste('carregamento finaliza, desfazer reabre, e o painel reinicia', function() {
  const amb = comCarga();
  salvarOrdem(amb);
  const notas = amb.gas.CARREG_abrir('C100', amb.tokenCarreg).notas;
  const [n1003, n1002, n1001] = notas;

  const ultima = leitura(n1001.id, '7891000100103', { quantidade: 3 });
  const r = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [
    leitura(n1003.id, '7891000400404'),
    leitura(n1002.id, '7891000200206', { quantidade: 5 }),
    leitura(n1002.id, '7891000300305', { quantidade: 2 }),
    leitura(n1001.id, '', { tipo: 'CONFIRMACAO', itemId: n1001.itens[1].id, quantidade: 2 }),
    ultima
  ]);
  assert.strictEqual(r.status, 'FINALIZADO');
  let c = amb.db.prepare("SELECT * FROM carga WHERE numero = 'C100'").get();
  assert.ok(c.carregamento_inicio && c.carregamento_fim);

  const d = amb.gas.CARREG_desfazer('C100', amb.tokenCarreg, ultima.id);
  assert.ok(d.sucesso, d.erro);
  assert.strictEqual(d.status, 'EM_ANDAMENTO');
  assert.strictEqual(d.lidas[n1001.itens[0].id], 0);
  assert.ok(!amb.gas.CARREG_desfazer('C100', amb.tokenCarreg, ultima.id).sucesso, 'não desfaz duas vezes');

  const r2 = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [leitura(n1001.id, '7891000100103', { quantidade: 3 })]);
  assert.strictEqual(r2.status, 'FINALIZADO');

  const lista = amb.gas.PAINEL_listarCargasComLinks(SENHA).cargas[0];
  assert.strictEqual(lista.carregamento.notasCarregadas, 3);
  assert.strictEqual(lista.carregamento.qtdLida, 13);

  assert.ok(amb.gas.PAINEL_reiniciarCarregamento(SENHA, 'C100').sucesso);
  assert.strictEqual(contar(amb, 'carregamento_leitura'), 0);
  c = amb.db.prepare("SELECT * FROM carga WHERE numero = 'C100'").get();
  assert.strictEqual(c.status_carregamento, 'NAO_INICIADO');
});

teste('nota nova numa carga já carregada volta o carregamento para em andamento', function() {
  const amb = comCarga();
  amb.db.prepare("UPDATE carga SET status_carregamento = 'FINALIZADO'").run();
  amb.gas.PAINEL_uploadXMLs(SENHA, 'C100', arquivosBase64([{ numero: 1005, cliente: 'X', rua: 'R', nro: '1', bairro: 'B', cidade: 'Santa Cruz do Sul',
    itens: [{ cProd: 'E1', xProd: 'Item', cEANTrib: '7891000600601', qTrib: '1' }] }]));
  assert.strictEqual(amb.db.prepare("SELECT status_carregamento s FROM carga").get().s, 'EM_ANDAMENTO');
});

teste('quantidade é sempre unidade inteira (fração vira inteiro, zero ou vazio vira 1)', function() {
  const amb = comCarga();
  salvarOrdem(amb);
  const n1002 = amb.gas.CARREG_abrir('C100', amb.tokenCarreg).notas[1];
  const r = amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [
    leitura(n1002.id, '7891000200206', { quantidade: 2.7 }),
    leitura(n1002.id, '7891000200206', { quantidade: 0 }),
    leitura(n1002.id, '7891000200206', { quantidade: '' })
  ]);
  assert.strictEqual(r.lidas[n1002.itens[0].id], 3, '2 + 1 no primeiro item');
  assert.strictEqual(r.lidas[n1002.itens[1].id], 1, 'a terceira leitura vai para o segundo item');
  assert.strictEqual(contar(amb, 'carregamento_leitura', 'quantidade <> CAST(quantidade AS INTEGER)'), 0);
});

teste('rota trava ao gerar o carregamento e destrava pelo painel', function() {
  const amb = comCarga();
  salvarOrdem(amb);
  assert.ok(!amb.gas.MOTORISTA_buscarCarga('C100', amb.tokenMotorista).rotaTravada);

  assert.ok(amb.gas.MOTORISTA_carregamento('C100', amb.tokenMotorista).rotaTravada);
  assert.ok(amb.gas.MOTORISTA_buscarCarga('C100', amb.tokenMotorista).rotaTravada);
  assert.ok(amb.gas.PAINEL_listarCargasComLinks(SENHA).cargas[0].rotaTravada);
  const recusa = amb.gas.MOTORISTA_salvarOrdemRota('C100', amb.tokenMotorista, { 1001: 3, 1002: 2, 1003: 1 });
  assert.ok(!recusa.sucesso && recusa.rotaTravada);
  assert.strictEqual(amb.db.prepare("SELECT ordem_entrega o FROM nota_fiscal WHERE numero = '1001'").get().o, 1, 'ordem não mudou');

  assert.ok(amb.gas.PAINEL_destravarRota(SENHA, 'C100').sucesso);
  assert.ok(amb.gas.MOTORISTA_salvarOrdemRota('C100', amb.tokenMotorista, { 1001: 3, 1002: 2, 1003: 1 }).sucesso);
  const ordem = amb.gas.CARREG_abrir('C100', amb.tokenCarreg).notas.map(function(n) { return n.numero; });
  assert.deepStrictEqual(js(ordem), ['1001', '1002', '1003'], 'carregamento segue a rota nova, invertida');
});

teste('reiniciar carregamento e NF nova também destravam a rota', function() {
  const amb = comCarga();
  salvarOrdem(amb);
  amb.gas.MOTORISTA_carregamento('C100', amb.tokenMotorista);
  amb.gas.PAINEL_reiniciarCarregamento(SENHA, 'C100');
  assert.ok(!amb.gas.MOTORISTA_buscarCarga('C100', amb.tokenMotorista).rotaTravada);

  amb.gas.MOTORISTA_carregamento('C100', amb.tokenMotorista);
  amb.gas.PAINEL_uploadXMLs(SENHA, 'C100', arquivosBase64([{ numero: 1006, cliente: 'Y', rua: 'R', nro: '2', bairro: 'B', cidade: 'Santa Cruz do Sul',
    itens: [{ cProd: 'F1', xProd: 'Item', cEANTrib: '7891000700701', qTrib: '1' }] }]));
  assert.ok(!amb.gas.MOTORISTA_buscarCarga('C100', amb.tokenMotorista).rotaTravada, 'NF nova precisa entrar na rota');
  assert.ok(amb.gas.MOTORISTA_carregamento('C100', amb.tokenMotorista).semOrdem);
});

teste('banco criado na versão 1 recebe a coluna nova ao migrar', function() {
  const amb = criarAmbiente();
  amb.configurar();
  amb.db.exec("CREATE TABLE carga (id INTEGER PRIMARY KEY, numero TEXT NOT NULL UNIQUE, transportadora_id INTEGER, " +
    "status_carregamento TEXT NOT NULL DEFAULT 'NAO_INICIADO', ordem_salva_em TEXT, carregamento_inicio TEXT, carregamento_fim TEXT, " +
    "criado_em TEXT NOT NULL DEFAULT '', atualizado_em TEXT NOT NULL DEFAULT '')");
  amb.db.exec("INSERT INTO carga (numero) VALUES ('C1')");
  const r = amb.gas.DB_migrar_();
  assert.strictEqual(r.versao, 2);
  const cols = amb.db.prepare('SELECT name FROM pragma_table_info(?)').all('carga').map(function(c) { return c.name; });
  assert.ok(cols.indexOf('rota_travada_em') !== -1);
  assert.strictEqual(contar(amb, 'carga'), 1, 'dados existentes ficam');
  amb.gas.DB_migrar_();
});

teste('entregas: concluir e desfazer', function() {
  const amb = comCarga();
  const r = amb.gas.MOTORISTA_concluirEntregas('C100', amb.tokenMotorista, ['1001', '1002']);
  assert.deepStrictEqual(js(Array.from(r.alteradas).sort()), ['1001', '1002']);
  assert.strictEqual(contar(amb, 'nota_fiscal', "status_entrega = 'CONCLUIDA' AND concluida_em IS NOT NULL"), 2);
  amb.gas.MOTORISTA_reabrirEntregas('C100', amb.tokenMotorista, ['1002']);
  assert.strictEqual(contar(amb, 'nota_fiscal', "status_entrega = 'CONCLUIDA'"), 1);
  const lista = amb.gas.PAINEL_listarCargasComLinks(SENHA).cargas[0];
  assert.strictEqual(lista.status, 'Em andamento');
});

teste('excluir a carga apaga tudo dela no banco (e só dela)', function() {
  const amb = comCarga();
  amb.gas.PAINEL_uploadXMLs(SENHA, 'C200', arquivosBase64([NOTAS[0]]));
  salvarOrdem(amb);
  amb.gas.MOTORISTA_buscarCarga('C100', amb.tokenMotorista);
  const notas = amb.gas.CARREG_abrir('C100', amb.tokenCarreg).notas;
  amb.gas.CARREG_registrar('C100', amb.tokenCarreg, [leitura(notas[0].id, '7891000400404'), leitura(notas[0].id, '999')]);

  const r = amb.gas.PAINEL_excluirCarga(SENHA, 'C100');
  assert.ok(r.sucesso, r.erro);
  assert.strictEqual(contar(amb, 'carga'), 1);
  assert.strictEqual(contar(amb, 'nota_fiscal'), 1, 'sobra só a NF da C200');
  assert.strictEqual(contar(amb, 'nota_item'), 2);
  assert.strictEqual(contar(amb, 'carregamento_leitura'), 0);
  assert.strictEqual(contar(amb, 'log_acesso', "carga_numero = 'C100'"), 0);
  assert.ok(contar(amb, 'geo_cache') > 0, 'endereços ficam para outras cargas');
  assert.ok(contar(amb, 'api_uso', "carga_numero = 'C100'") > 0, 'histórico de cobrança fica');
  assert.ok(!amb.gas.PAINEL_excluirCarga(SENHA, 'C100').sucesso);
});

teste('sincronização remove do banco a carga cuja pasta saiu do Drive', function() {
  const amb = comCarga();
  amb.gas.PAINEL_uploadXMLs(SENHA, 'C200', arquivosBase64([NOTAS[0]]));
  const raiz = amb.gas.DriveApp.getFoldersByName('CargasCarregamento').next();
  raiz.getFoldersByName('C100').next().setTrashed(true);
  const r = amb.gas.PAINEL_atualizarCargas(SENHA);
  assert.ok(r.sucesso, r.erro);
  assert.deepStrictEqual(js(Array.from(r.removidas)), ['C100']);
  assert.strictEqual(contar(amb, 'nota_fiscal'), 1);
});

teste('uso de API agrupado por transportadora', function() {
  const amb = comCarga();
  amb.gas.MOTORISTA_buscarCarga('C100', amb.tokenMotorista);
  const r = amb.gas.API_resumoPorPeriodo_(1);
  assert.strictEqual(r.dados.length, 1);
  assert.strictEqual(r.dados[0].cnpj, '04252011000110');
  assert.strictEqual(r.dados[0].tipos.Mapa, 1);
  assert.ok(Math.abs(r.dados[0].custoTotal - 0.007) < 1e-9);
  assert.strictEqual(r.custos.Mapa, 7);
});

teste('sem segredo dos links nenhum token é aceito', function() {
  const amb = comCarga();
  delete amb.propriedades.TOKEN_SEGREDO;
  assert.ok(!amb.gas.MOTORISTA_buscarCarga('C100', amb.tokenMotorista).sucesso);
});

teste('importar _GeoCache da versão 3', function() {
  const amb = criarAmbiente();
  amb.configurar();
  amb.gas.DB_migrar_();
  const n = amb.gas.GEO_importarLinhas_([
    ['Rua A, 1, Centro, Santa Cruz do Sul, RS', -29.7, -52.4, new Date(), 'exato'],
    ['Rua B, 2, Centro, Venâncio Aires, RS', '-29.6', '-52.2', new Date(), 'aproximado'],
    ['', '', '', '', '']
  ]);
  assert.strictEqual(n, 2);
  assert.strictEqual(contar(amb, 'geo_cache', "precisao = 'aproximado'"), 1);
});

teste('a regra enviada ao coletor funciona igual no navegador', function() {
  const amb = criarAmbiente();
  const navegador = vm.createContext({});
  vm.runInContext(amb.gas.REGRA_fonteCliente_(), navegador);
  const nota = { itens: [
    { id: 1, codigoBarras: '789', esperada: 3, lida: 0 },
    { id: 2, codigoBarras: '789', esperada: 2, lida: 0 },
    { id: 3, codigoBarras: null, esperada: 1, lida: 0 }
  ] };
  const av = navegador.REGRA_avaliarLeitura_(nota, { tipo: 'CODIGO_BARRAS', codigo: '000789', quantidade: 4 });
  assert.strictEqual(av.resultado, 'ACEITA');
  assert.deepStrictEqual(js(av.alocacoes), [{ itemId: 1, quantidade: 3 }, { itemId: 2, quantidade: 1 }]);
  navegador.REGRA_aplicar_(nota, av.alocacoes);
  assert.strictEqual(navegador.REGRA_avaliarLeitura_(nota, { codigo: '789', quantidade: 2 }).resultado, 'EXCEDENTE');
  assert.strictEqual(navegador.REGRA_avaliarLeitura_(nota, { tipo: 'CONFIRMACAO', itemId: 3 }).resultado, 'ACEITA');
  assert.strictEqual(navegador.REGRA_avaliarLeitura_(nota, { codigo: 'SEM GTIN' }).resultado, 'NAO_PERTENCE');
});

// =====================================================================

let falhas = 0;
testes.forEach(function(t) {
  try {
    t.fn();
    console.log('  ✓ ' + t.nome);
  } catch (e) {
    falhas++;
    console.log('  ✗ ' + t.nome + '\n      ' + (e.stack || e).toString().split('\n').slice(0, 12).join('\n      '));
  }
});
console.log('\n' + (testes.length - falhas) + ' de ' + testes.length + ' testes passaram');
process.exit(falhas ? 1 : 0);
