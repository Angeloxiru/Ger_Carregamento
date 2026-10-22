/**
 * Cargas.gs - Gravação e leitura de cargas no banco
 * Usado pelo painel (importar, listar, excluir) e pelas telas.
 */

// ============= LEITURA =============

/**
 * CARGA_buscar_ - Carga pelo número, com a transportadora
 * @returns {Object|null}
 */
function CARGA_buscar_(numeroCarga) {
  return DB_primeiro_(
    'SELECT c.*, COALESCE(t.nome, \'\') AS transportadora, COALESCE(t.documento, \'\') AS documento ' +
    'FROM carga c LEFT JOIN transportadora t ON t.id = c.transportadora_id WHERE c.numero = ?',
    [normalizarCarga_(numeroCarga)]
  );
}

/**
 * CARGA_buscarOuErro_ - Igual a CARGA_buscar_, mas com erro amigável
 */
function CARGA_buscarOuErro_(numeroCarga) {
  const carga = CARGA_buscar_(numeroCarga);
  if (!carga) {
    throw new Error('Carga "' + normalizarCarga_(numeroCarga) + '" não encontrada. Ela pode ter sido excluída no painel.');
  }
  return carga;
}

/**
 * CARGA_numerosNotas_ - Números das NFs já gravadas na carga
 * @returns {Object} { numeroNF: true }
 */
function CARGA_numerosNotas_(numeroCarga) {
  const mapa = {};
  DB_consultar_(
    'SELECT n.numero FROM nota_fiscal n JOIN carga c ON c.id = n.carga_id WHERE c.numero = ?',
    [normalizarCarga_(numeroCarga)]
  ).forEach(function(l) { mapa[String(l.numero).trim()] = true; });
  return mapa;
}

// ============= IMPORTAÇÃO =============

/**
 * CARGA_importarNotas_ - Grava notas e itens de uma carga (tudo ou nada)
 * Cria a carga se não existir. NFs que já estão na carga são ignoradas,
 * mantendo status de entrega e leituras do carregamento.
 * @param {String} numeroCarga
 * @param {Array} notas - saída do XML_extrairDadosNFe_
 * @returns {Object} { novas: [numeroNF], ignoradas: [numeroNF], itens }
 */
function CARGA_importarNotas_(numeroCarga, notas) {
  const carga = normalizarCarga_(numeroCarga);
  const existentes = CARGA_numerosNotas_(carga);
  const vistas = {};
  const novas = [];
  const ignoradas = [];

  notas.forEach(function(nf) {
    const num = String(nf.numeroNF).trim();
    if (existentes[num] || vistas[num]) { ignoradas.push(num); return; }
    vistas[num] = true;
    novas.push(nf);
  });

  const transp = notas.filter(function(nf) { return soDigitos_(nf.cnpjTransportadora); })[0];
  const docTransp = transp ? soDigitos_(transp.cnpjTransportadora) : '';
  const comandos = [];

  if (docTransp) {
    comandos.push({
      sql: 'INSERT INTO transportadora (documento, nome) VALUES (?, ?) ' +
           'ON CONFLICT (documento) DO UPDATE SET nome = CASE WHEN excluded.nome <> \'\' THEN excluded.nome ELSE transportadora.nome END',
      args: [docTransp, transp.nomeTransportadora || '']
    });
  }

  comandos.push({
    sql: 'INSERT OR IGNORE INTO carga (numero) VALUES (?)',
    args: [carga]
  });
  comandos.push({
    sql: 'UPDATE carga SET transportadora_id = COALESCE(transportadora_id, (SELECT id FROM transportadora WHERE documento = ?)), ' +
         'atualizado_em = ? WHERE numero = ?',
    args: [docTransp, dataIso_(), carga]
  });

  let totalItens = 0;
  novas.forEach(function(nf) {
    const num = String(nf.numeroNF).trim();
    comandos.push({
      sql: 'INSERT OR IGNORE INTO nota_fiscal (carga_id, numero, serie, chave_acesso, emitida_em, destinatario, destinatario_doc, ' +
           'logradouro, bairro, cidade, uf, cep, peso_kg, valor_total, condicao_pagamento, arquivo_xml) ' +
           'VALUES ((SELECT id FROM carga WHERE numero = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [
        carga, num, nf.serie || '', nf.chaveAcesso || '', nf.emitidaEm || '',
        nf.destinatario || '', soDigitos_(nf.destinatarioDoc),
        (nf.logradouro || '') + (nf.numero ? ', ' + nf.numero : ''),
        nf.bairro || '', nf.cidade || '', nf.uf || '', soDigitos_(nf.cep),
        Number(nf.peso) || 0, Number(nf.valorTotal) || 0,
        nf.condicaoPagamento || '', nf.arquivo || ''
      ]
    });

    (nf.itens || []).forEach(function(it) {
      totalItens++;
      comandos.push({
        sql: 'INSERT OR IGNORE INTO nota_item (nota_id, n_item, codigo_produto, descricao, ean, ean_trib, codigo_barras, ' +
             'unidade_com, qtd_com, unidade_trib, qtd_trib, qtd_esperada) ' +
             'SELECT n.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM nota_fiscal n JOIN carga c ON c.id = n.carga_id ' +
             'WHERE c.numero = ? AND n.numero = ?',
        args: [
          it.nItem, it.codigoProduto, it.descricao, it.ean, it.eanTrib, it.codigoBarras,
          it.unidadeCom, it.qtdCom, it.unidadeTrib, it.qtdTrib, it.qtdEsperada,
          carga, num
        ]
      });
    });
  });

  // Notas novas numa carga já carregada: o carregamento volta para "em andamento".
  // A rota é destravada, porque a NF nova precisa entrar na ordem de entrega.
  if (novas.length > 0) {
    comandos.push({
      sql: 'UPDATE carga SET status_carregamento = \'EM_ANDAMENTO\', carregamento_fim = NULL ' +
           'WHERE numero = ? AND status_carregamento = \'FINALIZADO\'',
      args: [carga]
    });
    comandos.push({
      sql: 'UPDATE carga SET rota_travada_em = NULL WHERE numero = ?',
      args: [carga]
    });
  }

  DB_transacao_(comandos);

  return {
    novas: novas.map(function(nf) { return String(nf.numeroNF).trim(); }),
    ignoradas: ignoradas,
    itens: totalItens
  };
}

// ============= EXCLUSÃO =============

/**
 * CARGA_excluir_ - Apaga a carga e tudo que depende dela (tudo ou nada)
 * Fica no banco: geo_cache (endereços servem para outras cargas) e
 * api_uso (histórico de cobrança das transportadoras).
 * @returns {Boolean} true se a carga existia
 */
function CARGA_excluir_(numeroCarga) {
  const carga = normalizarCarga_(numeroCarga);
  const idCarga = '(SELECT id FROM carga WHERE numero = ?)';

  const r = DB_transacao_([
    { sql: 'DELETE FROM carregamento_leitura WHERE carga_id = ' + idCarga, args: [carga] },
    { sql: 'DELETE FROM nota_item WHERE nota_id IN (SELECT id FROM nota_fiscal WHERE carga_id = ' + idCarga + ')', args: [carga] },
    { sql: 'DELETE FROM nota_fiscal WHERE carga_id = ' + idCarga, args: [carga] },
    { sql: 'DELETE FROM log_acesso WHERE carga_numero = ?', args: [carga] },
    { sql: 'DELETE FROM carga WHERE numero = ?', args: [carga] }
  ]);

  return r[4].afetadas > 0;
}
