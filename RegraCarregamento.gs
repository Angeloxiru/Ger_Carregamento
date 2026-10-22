/**
 * RegraCarregamento.gs - Regra de conferência de uma leitura
 *
 * Esta regra roda nos dois lados:
 * - no coletor, para dar a resposta na hora (verde/vermelho) sem esperar o servidor;
 * - no servidor, que confere de novo antes de gravar.
 * O código destas funções é enviado à tela do coletor por REGRA_fonteCliente_(),
 * então as duas pontas usam exatamente a mesma regra.
 *
 * Por isso: só "var" e "function" aqui, sem nada do Apps Script.
 */

var REGRA_EPS = 1e-6;

/**
 * Arredonda para 6 casas (evita 0.1 + 0.2 = 0.30000000000000004)
 */
function REGRA_arred_(valor) {
  return Math.round(Number(valor || 0) * 1e6) / 1e6;
}

/**
 * Quantidade de uma leitura: unidades inteiras, no mínimo 1
 */
function REGRA_quantidade_(valor) {
  var q = Math.floor(Number(valor));
  return q >= 1 ? q : 1;
}

/**
 * Quanto ainda falta carregar de um item
 */
function REGRA_pendente_(item) {
  return Math.max(0, REGRA_arred_(item.esperada - item.lida));
}

/**
 * Nota completa: todos os itens com a quantidade esperada
 */
function REGRA_notaCompleta_(nota) {
  for (var i = 0; i < nota.itens.length; i++) {
    if (REGRA_pendente_(nota.itens[i]) > REGRA_EPS) return false;
  }
  return true;
}

/**
 * REGRA_avaliarLeitura_ - Decide o que fazer com uma leitura
 * Não altera a nota: devolve as quantidades a somar em cada item.
 *
 * - tipo CONFIRMACAO: toque num item sem código de barras (itemId)
 * - a quantidade é sempre um número inteiro de unidades (vazio ou inválido = 1)
 * - outros tipos: procura o código entre os itens da nota. Se o mesmo código
 *   aparece em mais de um item, a quantidade é distribuída na ordem dos itens.
 *
 * @param {Object} nota - { itens: [{id, codigoBarras, esperada, lida}] }
 * @param {Object} leitura - { tipo, codigo, quantidade, itemId }
 * @returns {Object} { resultado, alocacoes: [{itemId, quantidade}], pendente }
 *   resultado: ACEITA | NAO_PERTENCE | EXCEDENTE | NOTA_FINALIZADA
 */
function REGRA_avaliarLeitura_(nota, leitura) {
  var quantidade = REGRA_quantidade_(leitura.quantidade);

  if (REGRA_notaCompleta_(nota)) {
    return { resultado: 'NOTA_FINALIZADA', alocacoes: [], pendente: 0 };
  }

  var candidatos = [];
  var i;
  if (leitura.tipo === 'CONFIRMACAO') {
    for (i = 0; i < nota.itens.length; i++) {
      if (nota.itens[i].id === leitura.itemId && !nota.itens[i].codigoBarras) candidatos.push(nota.itens[i]);
    }
  } else {
    var codigo = normalizarCodigoBarras_(leitura.codigo);
    for (i = 0; codigo && i < nota.itens.length; i++) {
      if (nota.itens[i].codigoBarras === codigo) candidatos.push(nota.itens[i]);
    }
  }

  if (candidatos.length === 0) {
    return { resultado: 'NAO_PERTENCE', alocacoes: [], pendente: 0 };
  }

  var totalPendente = 0;
  for (i = 0; i < candidatos.length; i++) totalPendente = REGRA_arred_(totalPendente + REGRA_pendente_(candidatos[i]));

  if (quantidade > totalPendente + REGRA_EPS) {
    return { resultado: 'EXCEDENTE', alocacoes: [], pendente: totalPendente };
  }

  var alocacoes = [];
  var restante = quantidade;
  for (i = 0; i < candidatos.length && restante > REGRA_EPS; i++) {
    var p = REGRA_pendente_(candidatos[i]);
    if (p <= REGRA_EPS) continue;
    var q = Math.min(p, restante);
    alocacoes.push({ itemId: candidatos[i].id, quantidade: REGRA_arred_(q) });
    restante = REGRA_arred_(restante - q);
  }

  return { resultado: 'ACEITA', alocacoes: alocacoes, pendente: REGRA_arred_(totalPendente - quantidade) };
}

/**
 * REGRA_aplicar_ - Soma as alocações nos itens (altera a nota)
 */
function REGRA_aplicar_(nota, alocacoes) {
  alocacoes.forEach(function(a) {
    for (var i = 0; i < nota.itens.length; i++) {
      if (nota.itens[i].id === a.itemId) {
        nota.itens[i].lida = REGRA_arred_(nota.itens[i].lida + a.quantidade);
        return;
      }
    }
  });
}

/**
 * REGRA_fonteCliente_ - Código-fonte da regra para embutir na tela do coletor
 */
function REGRA_fonteCliente_() {
  return [
    'var REGRA_EPS = ' + REGRA_EPS + ';',
    normalizarCodigoBarras_.toString(),
    REGRA_arred_.toString(),
    REGRA_quantidade_.toString(),
    REGRA_pendente_.toString(),
    REGRA_notaCompleta_.toString(),
    REGRA_avaliarLeitura_.toString(),
    REGRA_aplicar_.toString()
  ].join('\n\n');
}
