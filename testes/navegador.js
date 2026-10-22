/**
 * Teste das telas no Chromium (npm run test:telas)
 *
 * Monta as páginas como o HtmlService do Apps Script faria (includes e
 * variáveis do template), troca o google.script.run por chamadas às funções
 * reais dos .gs (com o Turso falso) e simula o leitor de código de barras
 * digitando o código e apertando Enter.
 *
 * Salva capturas de tela em testes/capturas/.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');
const { criarAmbiente } = require('./ambiente');
const { arquivosBase64 } = require('./xml-exemplo');

const RAIZ = path.join(__dirname, '..');
const CAPTURAS = path.join(__dirname, 'capturas');
const SENHA = 'senha123';

function playwright() {
  try { return require('playwright'); } catch (e) {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
  }
}

/** Faz o papel do HtmlService: includes, scriptlets e variáveis */
function montarPagina(arquivo, variaveis, amb) {
  let html = fs.readFileSync(path.join(RAIZ, arquivo + '.html'), 'utf8');
  for (let i = 0; i < 5; i++) {
    html = html.replace(/<\?!=\s*include\('([^']+)'\);?\s*\?>/g, function(_, nome) {
      return fs.readFileSync(path.join(RAIZ, nome + '.html'), 'utf8');
    });
  }
  html = html.replace(/<\?!=\s*REGRA_fonteCliente_\(\)\s*\?>/g, function() { return amb.gas.REGRA_fonteCliente_(); });
  html = html.replace(/<\?=\s*(\w+)\s*\?>/g, function(_, nome) {
    return String(variaveis[nome] || '').replace(/[&<>"']/g, function(c) { return '&#' + c.charCodeAt(0) + ';'; });
  });
  assert.ok(!/<\?/.test(html), 'sobrou scriptlet sem tratar em ' + arquivo);
  return html;
}

/** google.script.run → função exposta pelo Playwright */
const SHIM = `
  window.google = { script: {} };
  Object.defineProperty(window.google.script, 'run', { get: function() {
    var ok = function() {}, falha = function() {};
    var runner = new Proxy({}, { get: function(_, nome) {
      if (nome === 'withSuccessHandler') return function(f) { ok = f; return runner; };
      if (nome === 'withFailureHandler') return function(f) { falha = f; return runner; };
      return function() {
        var args = Array.prototype.slice.call(arguments);
        window.__gas(nome, JSON.stringify(args)).then(function(txt) {
          var r = JSON.parse(txt);
          if (r.erro) falha(new Error(r.erro)); else ok(r.valor);
        });
      };
    }});
    return runner;
  }});
`;

async function abrir(browser, amb, arquivo, variaveis, opcoes) {
  const contexto = await browser.newContext(Object.assign({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 }, opcoes || {}));
  const page = await contexto.newPage();
  const erros = [];
  page.on('pageerror', function(e) { erros.push(e.message); });
  page.on('dialog', function(d) { d.accept(); });
  await page.exposeFunction('__gas', function(nome, argsJson) {
    if (amb.semInternet && nome !== 'CARREG_abrir') return JSON.stringify({ erro: 'Sem conexão (simulado)' });
    try {
      const valor = amb.gas[nome].apply(null, JSON.parse(argsJson));
      return JSON.stringify({ valor: valor === undefined ? null : valor });
    } catch (e) {
      return JSON.stringify({ erro: e.message });
    }
  });
  await page.addInitScript(SHIM);
  const html = montarPagina(arquivo, variaveis, amb);
  await page.route('http://localhost/app', function(rota) {
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  await page.goto('http://localhost/app');
  page.erros = erros;
  return page;
}

async function ler(page, codigo, qtd) {
  if (qtd) await page.fill('#qtd', String(qtd));
  await page.focus('#codigo');
  await page.keyboard.type(codigo);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
}

async function texto(page, seletor) {
  return (await page.textContent(seletor)).trim();
}

async function principal() {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const amb = criarAmbiente();
  amb.configurar({ senha: SENHA });
  amb.gas.DB_migrar_();
  assert.ok(amb.gas.PAINEL_uploadXMLs(SENHA, 'C100', arquivosBase64()).sucesso);
  const tokenMot = amb.gas.gerarToken_('C100', 'MOTORISTA');
  const tokenCar = amb.gas.gerarToken_('C100', 'CARREGAMENTO');

  const { chromium } = playwright();
  const browser = await chromium.launch();

  // ---------- Motorista: rota e QR code ----------
  const mot = await abrir(browser, amb, 'MotoristaView', { cargaParam: 'C100', tokenParam: tokenMot, mapsApiKey: '' });
  await mot.waitForSelector('.parada');
  assert.strictEqual(await mot.locator('.parada').count(), 3);
  await mot.screenshot({ path: path.join(CAPTURAS, '1-motorista-rota.png') });
  await mot.click('#btnCarregar'); // confirma "gerar carregamento e travar a rota" (dialog aceito)
  await mot.waitForSelector('.qr-imagem');
  assert.strictEqual(await mot.locator('.ordem-btns').count(), 0, 'sem ▲▼ com a rota travada');
  assert.ok(await mot.isDisabled('#btnSalvar'));
  assert.ok(await mot.isDisabled('#btnRecalcular'));
  await mot.waitForTimeout(400); // fim da animação do modal

  // O QR code precisa decodificar exatamente para o link do coletor
  await mot.addScriptTag({ path: require.resolve('jsqr/dist/jsQR.js') });
  const lido = await mot.evaluate(function() {
    var img = document.querySelector('.qr-imagem');
    var c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    var dados = ctx.getImageData(0, 0, c.width, c.height);
    var r = jsQR(dados.data, c.width, c.height);
    return r ? r.data : null;
  });
  assert.strictEqual(lido, amb.gas.gerarLinkCarregamento_('C100'));
  const ordemSalva = amb.db.prepare('SELECT COUNT(*) n FROM nota_fiscal WHERE ordem_entrega IS NOT NULL').get().n;
  assert.strictEqual(ordemSalva, 3, 'Carregar salvou a ordem antes de gerar o QR');
  await mot.screenshot({ path: path.join(CAPTURAS, '2-motorista-qrcode.png') });
  await mot.click('#modalCarregamento .btn-icone');
  await mot.screenshot({ path: path.join(CAPTURAS, '2b-motorista-rota-travada.png') });
  console.log('  ✓ motorista: rota, QR code (decodificado: ' + lido + ') e rota travada');

  // A ordem de carregamento é a inversa da que o motorista salvou
  const ordemRota = amb.db.prepare('SELECT numero FROM nota_fiscal ORDER BY ordem_entrega').all().map(function(l) { return l.numero; });
  const ordemCarga = ordemRota.slice().reverse();

  // ---------- Coletor ----------
  const col = await abrir(browser, amb, 'CarregamentoView', { cargaParam: 'C100', tokenParam: tokenCar });
  await col.waitForSelector('.item');
  assert.strictEqual(await texto(col, '#notaNumero'), 'NF ' + ordemCarga[0]);
  await col.screenshot({ path: path.join(CAPTURAS, '3-coletor-inicio.png') });

  const ITENS = {
    '1001': async function() {
      await ler(col, '9999999999999');
      assert.ok(/não está nesta nota/.test(await texto(col, '#retorno')));
      await ler(col, '7891000100103');
      await ler(col, '7891000100103');
      assert.ok(/\(2\/3\)/.test(await texto(col, '#retorno')));
      await col.screenshot({ path: path.join(CAPTURAS, '4-coletor-leitura.png') });
      await ler(col, '7891000100103', 5);
      assert.ok(/Passou da quantidade. Falta 1/.test(await texto(col, '#retorno')));
      await col.screenshot({ path: path.join(CAPTURAS, '5-coletor-excedente.png') });
      await col.fill('#qtd', '');
      await ler(col, '07891000100103');
      // Item sem GTIN: confirmar 2 com o toque
      await col.fill('#qtd', '2');
      await col.click('.item.sem-codigo button');
    },
    '1002': async function() {
      await ler(col, '7891000400404');
      assert.ok(/NF 1003/.test(await texto(col, '#retorno')), 'avisa de qual nota é o produto');
      await ler(col, '7891000200206', 4);
      await ler(col, '7891000200206');
      await ler(col, '7891000300305', 2);
    },
    '1003': async function() {
      // Lê, desfaz e lê de novo
      await ler(col, '7891000400404');
      await col.click('#btnDesfazer');
      await col.waitForFunction(function() { return /desfeita/.test(document.getElementById('retorno').textContent); });
      assert.strictEqual(await texto(col, '#notaNumero'), 'NF 1003');
      await ler(col, '7891000400404');
    }
  };

  for (let i = 0; i < ordemCarga.length; i++) {
    const nf = ordemCarga[i];
    assert.strictEqual(await texto(col, '#notaNumero'), 'NF ' + nf);
    await ITENS[nf]();
    if (i < ordemCarga.length - 1) {
      await col.waitForSelector('#notaCompleta:not(.oculto)');
      if (i === 0) await col.screenshot({ path: path.join(CAPTURAS, '6-coletor-nota-completa.png') });
      await col.click('#btnProxima');
    }
  }

  await col.waitForSelector('#telaFim:not(.oculto)', { timeout: 8000 });
  await col.screenshot({ path: path.join(CAPTURAS, '7-coletor-finalizado.png') });
  const carga = amb.db.prepare("SELECT status_carregamento s FROM carga WHERE numero = 'C100'").get();
  assert.strictEqual(carga.s, 'FINALIZADO');
  assert.deepStrictEqual(col.erros, [], 'erros de JavaScript no coletor');
  console.log('  ✓ coletor: ordem inversa, erros, quantidade, item sem GTIN, desfazer e finalização');

  // ---------- Coletor sem internet ----------
  const { NOTAS } = require('./xml-exemplo');
  assert.ok(amb.gas.PAINEL_uploadXMLs(SENHA, 'C300', arquivosBase64([NOTAS[1]])).sucesso);
  amb.gas.MOTORISTA_salvarOrdemRota('C300', amb.gas.gerarToken_('C300', 'MOTORISTA'), { 1002: 1 });
  const off = await abrir(browser, amb, 'CarregamentoView', { cargaParam: 'C300', tokenParam: amb.gas.gerarToken_('C300', 'CARREGAMENTO') });
  await off.waitForSelector('.item');
  amb.semInternet = true;
  await ler(off, '7891000200206', 4);
  await ler(off, '7891000300305', 2);
  await off.waitForFunction(function() { return /sem enviar/.test(document.getElementById('sincTexto').textContent); });
  await off.screenshot({ path: path.join(CAPTURAS, '10-coletor-sem-internet.png') });
  await off.reload(); // fecha e abre a tela: a fila continua no aparelho
  await off.waitForSelector('.item');
  assert.strictEqual(await off.evaluate(function() { return Est.fila.length; }), 2);
  assert.strictEqual(amb.db.prepare("SELECT COUNT(*) n FROM carregamento_leitura l JOIN carga c ON c.id = l.carga_id WHERE c.numero = 'C300'").get().n, 0);
  amb.semInternet = false;
  await off.evaluate(function() { window.dispatchEvent(new Event('online')); });
  await off.waitForFunction(function() { return Est.fila.length === 0; }, null, { timeout: 8000 });
  const lidas = amb.db.prepare("SELECT SUM(l.quantidade) q FROM carregamento_leitura l JOIN carga c ON c.id = l.carga_id WHERE c.numero = 'C300' AND l.resultado = 'ACEITA'").get().q;
  assert.strictEqual(lidas, 6);
  console.log('  ✓ coletor sem internet: leituras guardadas no aparelho e enviadas quando a conexão volta');

  // ---------- Painel ----------
  const painel = await abrir(browser, amb, 'PainelControle', {}, { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await painel.fill('#loginSenha', SENHA);
  await painel.click('#formLogin button[type=submit]');
  await painel.waitForSelector('.carga');
  assert.ok(/Finalizado/.test(await texto(painel, '.carga:has-text("C100") .carga-carreg')));
  await painel.screenshot({ path: path.join(CAPTURAS, '8-painel.png') });
  await painel.click('.carga:has-text("C100") >> text=Itens');
  await painel.waitForSelector('.det-nota');
  await painel.click('.det-nota summary');
  await painel.screenshot({ path: path.join(CAPTURAS, '9-painel-itens.png') });
  await painel.click('#detCorpo >> text=Destravar rota'); // dialog aceito
  await painel.waitForFunction(function() {
    return !/Destravar/.test(document.getElementById('detCorpo').textContent) && document.querySelector('.det-nota');
  });
  assert.strictEqual(amb.db.prepare("SELECT rota_travada_em r FROM carga WHERE numero = 'C100'").get().r, null);
  await painel.click('#detCorpo >> text=Fechar');
  await painel.click('.carga:has-text("C100") .btn-perigo.btn-icone'); // excluir (dialog aceito)
  await painel.waitForFunction(function() { return document.querySelectorAll('.carga').length === 1; });
  assert.strictEqual(amb.db.prepare("SELECT COUNT(*) n FROM nota_fiscal n JOIN carga c ON c.id = n.carga_id WHERE c.numero = 'C100'").get().n, 0);
  assert.strictEqual(amb.db.prepare('SELECT COUNT(*) n FROM nota_item').get().n, 3, 'só os itens da C300');
  assert.deepStrictEqual(painel.erros.concat(mot.erros, off.erros), [], 'erros de JavaScript no painel/motorista');
  console.log('  ✓ painel: situação do carregamento, itens, destravar rota e exclusão');

  await browser.close();
  console.log('\nCapturas em testes/capturas/');
}

principal().catch(function(e) {
  console.error('  ✗ ' + (e.stack || e));
  process.exit(1);
});
