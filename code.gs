/**
 * ROTA GAÚCHA - Roteirização e Carregamento
 * Versão: 4.0
 *
 * Arquitetura:
 * - Drive "CargasEmRota" = Arquivo dos XMLs (uma pasta por carga)
 * - Banco Turso = Dados (cargas, notas, itens, leituras do carregamento, geocache, uso de API)
 * - Planilha Google Sheets = Só o menu de configuração (não guarda dados)
 * - PainelControle.html = Interface admin (protegida por senha)
 * - MotoristaView.html = Interface do motorista (link com token)
 * - CarregamentoView.html = Interface do coletor (QR code gerado na tela do motorista)
 *
 * Arquivos do backend:
 * - code.gs          Configuração, segurança, web app, menu e utilidades
 * - Turso.gs         Acesso ao banco (HTTP)
 * - Schema.gs        SQL das tabelas (gerado de sql/schema.sql)
 * - Cargas.gs        Gravação e leitura de cargas no banco
 * - Painel.gs        Funções do painel (sincronizar, upload, excluir, listar)
 * - Motorista.gs     Funções da tela do motorista
 * - Carregamento.gs  Funções da tela do coletor
 * - XMLProcessor.gs  Leitura dos XMLs de NF-e
 * - Geo.gs           Geocodificação com cache e registro de uso de API
 *
 * Funções terminadas em "_" são privadas: o Apps Script não deixa que sejam
 * chamadas pelo navegador (google.script.run).
 */

// ============= CONFIGURAÇÕES GLOBAIS =============

const CONFIG = {
  VERSAO: '4.0',
  PASTA_CARGAS: 'CargasEmRota',
  ENDERECO_PARTIDA_PADRAO: 'Stock Center, BR 471, km 121 - Santa Cruz do Sul - RS',

  // Número da carga: C + números + sufixo opcional (ex: C123, C123A)
  REGEX_CARGA: /^C\d+[A-Z]?$/i,

  // Bloqueio de tentativas de senha do painel
  MAX_TENTATIVAS_SENHA: 10,
  JANELA_TENTATIVAS_SEG: 600
};

// Chaves das Propriedades do Script (Configurações do projeto > Propriedades do script)
const PROP = {
  MAPS_API_KEY: 'MAPS_API_KEY',
  ADMIN_SENHA_HASH: 'ADMIN_SENHA_HASH',
  TOKEN_SEGREDO: 'TOKEN_SEGREDO',
  ENDERECO_PARTIDA: 'ENDERECO_PARTIDA',
  TURSO_URL: 'TURSO_URL',
  TURSO_TOKEN: 'TURSO_TOKEN'
};

// Perfis de link: cada um tem um token diferente para a mesma carga
const PERFIL = {
  MOTORISTA: 'MOTORISTA',
  CARREGAMENTO: 'CARREGAMENTO'
};

// ============= PROPRIEDADES =============

function obterPropriedade_(chave) {
  return PropertiesService.getScriptProperties().getProperty(chave) || '';
}

function salvarPropriedade_(chave, valor) {
  PropertiesService.getScriptProperties().setProperty(chave, valor);
}

function obterMapsApiKey_() {
  return obterPropriedade_(PROP.MAPS_API_KEY);
}

function obterEnderecoPartida_() {
  return obterPropriedade_(PROP.ENDERECO_PARTIDA) || CONFIG.ENDERECO_PARTIDA_PADRAO;
}

// ============= SEGURANÇA: TOKENS DOS LINKS =============

/**
 * Converte bytes assinados (Apps Script) em string hexadecimal
 */
function bytesParaHex_(bytes) {
  return bytes.map(function(byte) {
    const v = byte < 0 ? 256 + byte : byte;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

/**
 * Gera o token do link de uma carga (HMAC-SHA256 com o TOKEN_SEGREDO).
 * O link do motorista usa o mesmo formato da versão 3; o do carregamento
 * assina "CARREGAMENTO:<carga>", então um link não abre a tela do outro.
 * @param {String} numeroCarga - Ex: "C123"
 * @param {String} [perfil] - PERFIL.MOTORISTA (padrão) ou PERFIL.CARREGAMENTO
 * @returns {String} Token
 */
function gerarToken_(numeroCarga, perfil) {
  const carga = normalizarCarga_(numeroCarga);
  const segredo = obterPropriedade_(PROP.TOKEN_SEGREDO);
  if (!segredo) {
    throw new Error('O segredo dos links não foi gerado. Na planilha, use o menu 🚚 Rota Gaúcha > Configurar sistema.');
  }

  const mensagem = perfil === PERFIL.CARREGAMENTO ? PERFIL.CARREGAMENTO + ':' + carga : carga;
  const assinatura = Utilities.computeHmacSha256Signature(mensagem, segredo, Utilities.Charset.UTF_8);
  return bytesParaHex_(assinatura).substring(0, 16);
}

/**
 * Valida token do link
 */
function validarToken_(numeroCarga, token, perfil) {
  if (!numeroCarga || !token || !obterPropriedade_(PROP.TOKEN_SEGREDO)) return false;
  return String(token).trim() === gerarToken_(numeroCarga, perfil);
}

/**
 * Exige token válido e devolve o número da carga normalizado
 */
function exigirToken_(numeroCarga, token, perfil) {
  const carga = normalizarCarga_(numeroCarga);
  if (!CONFIG.REGEX_CARGA.test(carga) || !validarToken_(carga, token, perfil)) {
    throw new Error('🔒 Link inválido ou expirado. Peça um link novo.');
  }
  return carga;
}

/**
 * Link do motorista para uma carga
 */
function gerarLinkMotorista_(numeroCarga) {
  return ScriptApp.getService().getUrl() + '?carga=' + encodeURIComponent(numeroCarga) +
         '&token=' + gerarToken_(numeroCarga, PERFIL.MOTORISTA);
}

/**
 * Link do coletor (vai dentro do QR code)
 */
function gerarLinkCarregamento_(numeroCarga) {
  return ScriptApp.getService().getUrl() + '?page=carregamento&carga=' + encodeURIComponent(numeroCarga) +
         '&token=' + gerarToken_(numeroCarga, PERFIL.CARREGAMENTO);
}

// ============= SEGURANÇA: SENHA DO PAINEL =============

function hashSenha_(senha) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    'rota-gaucha-painel:' + senha,
    Utilities.Charset.UTF_8
  );
  return bytesParaHex_(bytes);
}

/**
 * Garante que quem chamou informou a senha do painel.
 * Lança erro (que chega ao navegador) se a senha estiver errada.
 * @param {String} senha - Senha digitada no painel
 */
function exigirAdmin_(senha) {
  const hashSalvo = obterPropriedade_(PROP.ADMIN_SENHA_HASH);
  if (!hashSalvo) {
    throw new Error('SEM_SENHA: A senha do painel ainda não foi definida. Na planilha, use o menu 🚚 Rota Gaúcha > Configurar sistema.');
  }

  const cache = CacheService.getScriptCache();
  const tentativas = parseInt(cache.get('falhas_senha') || '0', 10);
  if (tentativas >= CONFIG.MAX_TENTATIVAS_SENHA) {
    throw new Error('BLOQUEADO: Muitas tentativas de senha. Aguarde 10 minutos.');
  }

  if (!senha || hashSenha_(String(senha)) !== hashSalvo) {
    cache.put('falhas_senha', String(tentativas + 1), CONFIG.JANELA_TENTATIVAS_SEG);
    throw new Error('SENHA_INVALIDA: Senha incorreta.');
  }
}

/**
 * PAINEL_login - Confere a senha do painel (chamado pela tela de login)
 * @returns {Object} { sucesso: true }
 */
function PAINEL_login(senha) {
  exigirAdmin_(senha);
  return { sucesso: true };
}

// ============= LOG DE ACESSOS =============

/**
 * Registra acesso a um link (tabela log_acesso). Falhas não interrompem a tela.
 */
function registrarLog_(numeroCarga, tokenValido, perfil) {
  try {
    DB_executar_(
      'INSERT INTO log_acesso (carga_numero, perfil, token_valido) VALUES (?, ?, ?)',
      [normalizarCarga_(numeroCarga), perfil, tokenValido ? 1 : 0]
    );
  } catch (erro) {
    console.error('Erro ao registrar log:', erro);
  }
}

// ============= WEB APP =============

/**
 * doGet - Serve as páginas web
 * ?page=painel -> PainelControle.html
 * ?page=api -> ApiUsage.html
 * ?page=carregamento&carga=C123&token=... -> CarregamentoView.html (coletor)
 * ?carga=C123&token=... -> MotoristaView.html (padrão)
 */
function doGet(e) {
  const parametros = (e && e.parameter) || {};
  const page = parametros.page || 'motorista';

  if (page === 'painel' || page === 'admin') {
    return HtmlService.createTemplateFromFile('PainelControle')
      .evaluate()
      .setTitle('Rota Gaúcha - Painel de Controle')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (page === 'api') {
    return HtmlService.createTemplateFromFile('ApiUsage')
      .evaluate()
      .setTitle('Rota Gaúcha - Uso de API')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (page === 'carregamento') {
    const tplCarreg = HtmlService.createTemplateFromFile('CarregamentoView');
    tplCarreg.cargaParam = parametros.carga || '';
    tplCarreg.tokenParam = parametros.token || '';
    return tplCarreg
      .evaluate()
      .setTitle('Rota Gaúcha - Carregamento')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  const template = HtmlService.createTemplateFromFile('MotoristaView');
  template.cargaParam = parametros.carga || '';
  template.tokenParam = parametros.token || '';
  template.mapsApiKey = obterMapsApiKey_();

  return template
    .evaluate()
    .setTitle('Rota Gaúcha - Área do Motorista')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * obterURLPagina - Retorna a URL do web app com parâmetro de página
 * @param {String} pagina - 'painel' ou 'api'
 */
function obterURLPagina(pagina) {
  const permitidas = ['painel', 'api'];
  const destino = permitidas.indexOf(pagina) !== -1 ? pagina : 'painel';
  return ScriptApp.getService().getUrl() + '?page=' + destino;
}

/**
 * include - Inclui conteúdo de arquivos HTML (CSS e JS) nos templates
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ============= MENU DA PLANILHA =============

/**
 * onOpen - Cria menu ao abrir planilha
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🚚 Rota Gaúcha')
    .addItem('🔗 Obter links de acesso', 'MENU_obterLinks')
    .addItem('🔄 Sincronizar cargas do Drive', 'MENU_sincronizarCargas')
    .addItem('📊 Uso de API por transportador', 'MENU_resumoUsoAPI')
    .addSeparator()
    .addItem('🔧 Configurar sistema', 'WEBAPP_configurarSistema')
    .addItem('🗄️ Testar e atualizar o banco', 'MENU_atualizarBanco')
    .addItem('📥 Importar _GeoCache da versão 3', 'MENU_importarGeoCacheV3')
    .addToUi();
}

/**
 * MENU_obterLinks - Mostra o link do painel
 */
function MENU_obterLinks() {
  const ui = SpreadsheetApp.getUi();
  const baseURL = ScriptApp.getService().getUrl();

  if (!baseURL) {
    ui.alert('O Web App ainda não foi implantado. Use Implantar > Nova implantação no editor do Apps Script.');
    return;
  }

  const urlPainel = baseURL + '?page=painel';
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,Arial;padding:8px 16px">' +
      '<h3 style="margin:0 0 8px">🔧 Painel de Controle</h3>' +
      '<input type="text" value="' + urlPainel + '" style="width:100%;padding:8px;font-family:monospace" onclick="this.select()" readonly>' +
      '<p><a href="' + urlPainel + '" target="_blank">Abrir painel</a></p>' +
      '<p style="color:#555;font-size:13px">Os links dos motoristas ficam no painel, um por carga. O QR code do carregamento aparece na tela do motorista.</p>' +
    '</div>'
  ).setWidth(480).setHeight(220);

  ui.showModalDialog(html, 'Links do Sistema');
}

/**
 * MENU_sincronizarCargas - Sincroniza Drive e banco pelo menu
 */
function MENU_sincronizarCargas() {
  const ui = SpreadsheetApp.getUi(); // só funciona dentro da planilha
  const resultado = sincronizarCargas_();
  ui.alert(resultado.sucesso
    ? '✅ ' + resultado.mensagem
    : '❌ ' + resultado.erro);
}

/**
 * MENU_resumoUsoAPI - Mostra resumo de uso de API por transportador
 */
function MENU_resumoUsoAPI() {
  const ui = SpreadsheetApp.getUi(); // só funciona dentro da planilha
  const resumo = API_resumoPorPeriodo_(30);

  if (resumo.dados.length === 0) {
    ui.alert('Nenhum registro de uso de API nos últimos 30 dias.');
    return;
  }

  const tipos = resumo.tipos;
  let custoGeral = 0;
  let linhas = '';

  resumo.dados.forEach(function(r) {
    custoGeral += r.custoTotal;
    linhas += '<tr><td>' + escaparHtml_(formatarCnpj_(r.cnpj)) + '</td><td>' + escaparHtml_(r.nome) + '</td>' +
      tipos.map(function(t) { return '<td style="text-align:center">' + (r.tipos[t] || 0) + '</td>'; }).join('') +
      '<td style="text-align:right">$' + r.custoTotal.toFixed(4) + '</td></tr>';
  });

  const cab = tipos.map(function(t) { return '<th>' + escaparHtml_(t) + '</th>'; }).join('');
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,Arial;padding:8px">' +
      '<style>td,th{padding:6px;border:1px solid #ddd;font-size:12px}th{background:#E8F5E9}</style>' +
      '<h3>Uso de API - Últimos 30 dias</h3>' +
      '<table style="border-collapse:collapse;width:100%"><tr><th>CNPJ</th><th>Transportadora</th>' + cab + '<th>Custo (USD)</th></tr>' +
      linhas +
      '<tr style="font-weight:bold;background:#FFF9C4"><td colspan="' + (tipos.length + 2) + '" style="text-align:right">TOTAL</td><td style="text-align:right">$' + custoGeral.toFixed(4) + '</td></tr>' +
      '</table>' +
      '<p style="color:#666;font-size:11px">Estimativa sem a faixa gratuita mensal do Google. Detalhes na tabela api_uso do banco.</p>' +
    '</div>'
  ).setWidth(720).setHeight(420);

  ui.showModalDialog(html, 'Uso de API por Transportador');
}

/**
 * MENU_atualizarBanco - Testa a conexão e cria/atualiza as tabelas
 */
function MENU_atualizarBanco() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = DB_migrar_();
    const totais = DB_primeiro_(
      'SELECT (SELECT COUNT(*) FROM carga) AS cargas, (SELECT COUNT(*) FROM nota_fiscal) AS notas, ' +
      '(SELECT COUNT(*) FROM nota_item) AS itens, (SELECT COUNT(*) FROM geo_cache) AS enderecos'
    );
    ui.alert('Banco conectado',
      '✅ Estrutura do banco na versão ' + r.versao + ' (' + r.comandos + ' comandos aplicados).\n\n' +
      'Cargas: ' + totais.cargas + '\nNotas: ' + totais.notas + '\nItens: ' + totais.itens +
      '\nEndereços no cache: ' + totais.enderecos,
      ui.ButtonSet.OK);
  } catch (erro) {
    ui.alert('❌ Não foi possível acessar o banco:\n\n' + erro.message);
  }
}

/**
 * MENU_importarGeoCacheV3 - Copia a aba _GeoCache da planilha da versão 3
 * para a tabela geo_cache (evita geocodificar de novo os mesmos endereços)
 */
function MENU_importarGeoCacheV3() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt(
    'Importar _GeoCache da versão 3',
    'Cole o link ou o ID da planilha da versão 3 (a que tem a aba _GeoCache).',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const texto = resp.getResponseText().trim();
  const id = (texto.match(/\/d\/([a-zA-Z0-9_-]+)/) || [null, texto])[1];

  try {
    const aba = SpreadsheetApp.openById(id).getSheetByName('_GeoCache');
    if (!aba || aba.getLastRow() < 2) {
      ui.alert('A planilha não tem a aba _GeoCache ou ela está vazia.');
      return;
    }
    const linhas = aba.getRange(2, 1, aba.getLastRow() - 1, 5).getValues();
    const importados = GEO_importarLinhas_(linhas);
    ui.alert('✅ ' + importados + ' endereço(s) importado(s) para o banco.');
  } catch (erro) {
    ui.alert('❌ Erro ao importar: ' + erro.message);
  }
}

/**
 * WEBAPP_configurarSistema - Assistente de configuração (menu da planilha)
 * Define: senha do painel, chave do Google Maps, banco Turso e segredo dos links.
 */
function WEBAPP_configurarSistema() {
  // getUi() só funciona dentro da planilha: chamadas vindas da web param aqui
  const ui = SpreadsheetApp.getUi();

  // 1. Senha do painel
  const temSenha = !!obterPropriedade_(PROP.ADMIN_SENHA_HASH);
  const respSenha = ui.prompt(
    '1/5 - Senha do Painel',
    (temSenha ? 'Já existe uma senha. Digite uma nova para trocar ou deixe em branco para manter.' :
                'Defina a senha de acesso ao Painel de Controle (mínimo 6 caracteres).'),
    ui.ButtonSet.OK_CANCEL
  );
  if (respSenha.getSelectedButton() !== ui.Button.OK) return;

  const novaSenha = respSenha.getResponseText().trim();
  if (novaSenha) {
    if (novaSenha.length < 6) {
      ui.alert('A senha precisa ter pelo menos 6 caracteres. Nada foi alterado.');
      return;
    }
    salvarPropriedade_(PROP.ADMIN_SENHA_HASH, hashSenha_(novaSenha));
  } else if (!temSenha) {
    ui.alert('É obrigatório definir uma senha na primeira configuração.');
    return;
  }

  // 2. Chave do Google Maps (usada só para exibir o mapa na tela do motorista)
  const chaveAtual = obterMapsApiKey_();
  const respChave = ui.prompt(
    '2/5 - Chave do Google Maps',
    (chaveAtual ? 'Chave atual termina em ...' + chaveAtual.slice(-6) + '. Cole uma nova para trocar ou deixe em branco para manter.' :
                  'Cole a chave de API do Google Maps (Maps JavaScript API). Deixe em branco para usar a tela sem mapa.'),
    ui.ButtonSet.OK_CANCEL
  );
  if (respChave.getSelectedButton() !== ui.Button.OK) return;
  const novaChave = respChave.getResponseText().trim();
  if (novaChave) salvarPropriedade_(PROP.MAPS_API_KEY, novaChave);

  // 3. URL do banco Turso
  const urlAtual = obterPropriedade_(PROP.TURSO_URL);
  const respUrl = ui.prompt(
    '3/5 - Banco Turso (URL)',
    (urlAtual ? 'URL atual: ' + urlAtual + '\nCole uma nova para trocar ou deixe em branco para manter.' :
                'Cole a URL do banco (ex: libsql://rota-gaucha-seuusuario.turso.io).\nNo site do Turso: Databases > seu banco > URL.'),
    ui.ButtonSet.OK_CANCEL
  );
  if (respUrl.getSelectedButton() !== ui.Button.OK) return;
  const novaUrl = respUrl.getResponseText().trim();
  if (novaUrl) {
    if (!/^(libsql|https):\/\/[^\s]+$/i.test(novaUrl)) {
      ui.alert('A URL precisa começar com libsql:// ou https://. Nada foi alterado no banco.');
      return;
    }
    salvarPropriedade_(PROP.TURSO_URL, novaUrl);
  }

  // 4. Token do banco Turso
  const temToken = !!obterPropriedade_(PROP.TURSO_TOKEN);
  const respToken = ui.prompt(
    '4/5 - Banco Turso (token)',
    (temToken ? 'Já existe um token salvo. Cole um novo para trocar ou deixe em branco para manter.' :
                'Cole o token do banco.\nNo site do Turso: Databases > seu banco > Create Token (leitura e escrita, sem expiração).'),
    ui.ButtonSet.OK_CANCEL
  );
  if (respToken.getSelectedButton() !== ui.Button.OK) return;
  const novoToken = respToken.getResponseText().trim();
  if (novoToken) salvarPropriedade_(PROP.TURSO_TOKEN, novoToken);

  // 5. Segredo dos links (gerado uma única vez)
  let avisoLinks = '';
  if (!obterPropriedade_(PROP.TOKEN_SEGREDO)) {
    salvarPropriedade_(PROP.TOKEN_SEGREDO, Utilities.getUuid() + Utilities.getUuid());
    avisoLinks = '\n🔗 Segredo dos links gerado.';
  }

  // Estrutura do banco
  let avisoBanco = '';
  if (DB_configurado_()) {
    try {
      const r = DB_migrar_();
      avisoBanco = '\n🗄️ Banco conectado. Estrutura na versão ' + r.versao + '.';
    } catch (erro) {
      avisoBanco = '\n❌ Banco: ' + erro.message + '\nConfira a URL e o token e rode esta configuração de novo.';
    }
  } else {
    avisoBanco = '\n⚠️ Banco não configurado: o sistema não funciona sem ele.';
  }

  ui.alert(
    'Sistema configurado',
    '✅ Configuração salva!' + avisoLinks + avisoBanco +
    '\n\nSe ainda não publicou o Web App:\n1. Implantar > Nova implantação\n2. Tipo: Aplicativo da Web\n3. Executar como: Eu\n4. Quem pode acessar: Qualquer pessoa',
    ui.ButtonSet.OK
  );
}

// ============= GATILHOS (compatibilidade) =============

/**
 * PRINCIPAL_processarNovaCarga - Sincroniza cargas (para gatilho de tempo)
 * Mantida com o nome da versão 3 para quem já usa gatilho.
 */
function PRINCIPAL_processarNovaCarga() {
  const resultado = sincronizarCargas_();
  console.log(resultado.sucesso ? resultado.mensagem : resultado.erro);
}

// ============= FUNÇÕES AUXILIARES =============

/**
 * buscarOuCriarPasta_ - Busca ou cria pasta no Drive
 */
function buscarOuCriarPasta_(nomePasta) {
  const pastas = DriveApp.getFoldersByName(nomePasta);
  return pastas.hasNext() ? pastas.next() : DriveApp.createFolder(nomePasta);
}

/**
 * escaparHtml_ - Escapa texto para inserir em HTML gerado no servidor
 */
function escaparHtml_(texto) {
  return String(texto === null || texto === undefined ? '' : texto)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * soDigitos_ - Remove tudo que não é dígito
 */
function soDigitos_(valor) {
  return String(valor === null || valor === undefined ? '' : valor).replace(/\D/g, '');
}

/**
 * formatarCnpj_ - CNPJ/CPF com máscara
 */
function formatarCnpj_(valor) {
  const digitos = soDigitos_(valor);
  if (!digitos) return '';
  if (digitos.length > 11) {
    return digitos.padStart(14, '0').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (digitos.length === 11) {
    return digitos.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  }
  return String(valor);
}

/**
 * normalizarCarga_ - Padroniza número da carga (maiúsculo, sem espaços)
 */
function normalizarCarga_(numeroCarga) {
  return String(numeroCarga || '').trim().toUpperCase();
}

/**
 * normalizarCodigoBarras_ - Padroniza um código de barras para comparação
 * "SEM GTIN" ou vazio → null. Só dígitos: tira os zeros à esquerda, para que
 * GTIN-14 "07891234567895" e EAN-13 "7891234567895" sejam o mesmo código.
 * A mesma regra existe em CarregamentoView-js.html (normalizarCodigo).
 */
function normalizarCodigoBarras_(codigo) {
  const texto = String(codigo === null || codigo === undefined ? '' : codigo).trim().toUpperCase().replace(/\s+/g, '');
  if (!texto || texto === 'SEMGTIN') return null;
  if (/^\d+$/.test(texto)) {
    const semZeros = texto.replace(/^0+/, '');
    return semZeros || null;
  }
  return texto;
}

/**
 * dataIso_ - Data em texto ISO-8601 UTC sem milissegundos (padrão do banco)
 */
function dataIso_(data) {
  return (data || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
