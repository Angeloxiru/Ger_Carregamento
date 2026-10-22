/**
 * Motorista.gs - Funções chamadas pela tela do motorista
 * Todas exigem o token do link do motorista (gerado no painel).
 */

/**
 * MOTORISTA_buscarCarga - Retorna as entregas da carga com coordenadas
 * As coordenadas vêm do cache (geo_cache); endereços novos são geocodificados
 * pelo serviço Maps do próprio Apps Script.
 * @param {String} numeroCarga - Ex: "C123"
 * @param {String} token - Token do link
 * @returns {Object} { sucesso, numeroCarga, transportadora, origem, entregas, carregamento, erro }
 */
function MOTORISTA_buscarCarga(numeroCarga, token) {
  try {
    const carga = normalizarCarga_(numeroCarga);
    const tokenValido = CONFIG.REGEX_CARGA.test(carga) && validarToken_(carga, token, PERFIL.MOTORISTA);
    registrarLog_(carga, tokenValido, PERFIL.MOTORISTA);
    exigirToken_(carga, token, PERFIL.MOTORISTA);

    const dadosCarga = CARGA_buscarOuErro_(carga);
    const notas = DB_consultar_(
      'SELECT numero, destinatario, logradouro, bairro, cidade, uf, peso_kg, condicao_pagamento, ' +
      'ordem_entrega, status_entrega FROM nota_fiscal WHERE carga_id = ? ORDER BY numero',
      [dadosCarga.id]
    );
    if (notas.length === 0) {
      return { sucesso: false, erro: 'A carga "' + carga + '" não possui entregas.' };
    }

    const entregas = notas.map(function(n) {
      return {
        ordem: n.ordem_entrega || 0,
        numeroNF: String(n.numero),
        destinatario: n.destinatario,
        endereco: n.logradouro,
        bairro: n.bairro,
        cidade: n.cidade,
        uf: n.uf,
        peso: n.peso_kg || 0,
        condicaoPagamento: n.condicao_pagamento,
        concluida: n.status_entrega === 'CONCLUIDA'
      };
    });

    // Coordenadas (cache + geocodificação dos que faltam)
    const coords = GEO_geocodificarEntregas_(entregas, carga);
    entregas.forEach(function(e, i) {
      const c = coords[i];
      e.lat = c ? c.lat : null;
      e.lng = c ? c.lng : null;
      e.aproximado = c ? !!c.aproximado : true;
    });

    const enderecoPartida = obterEnderecoPartida_();
    const coordPartida = GEO_geocodificarEndereco_(enderecoPartida, enderecoPartida, '', carga);

    // Cada abertura da tela carrega o mapa uma vez (SKU Dynamic Maps)
    if (obterMapsApiKey_()) API_registrarUso_('Mapa', carga, 1);

    return {
      sucesso: true,
      numeroCarga: carga,
      transportadora: dadosCarga.transportadora,
      origem: {
        endereco: enderecoPartida,
        lat: coordPartida ? coordPartida.lat : null,
        lng: coordPartida ? coordPartida.lng : null
      },
      entregas: entregas,
      carregamento: { status: dadosCarga.status_carregamento }
    };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  }
}

/**
 * MOTORISTA_salvarOrdemRota - Grava a ordem das entregas (nota_fiscal.ordem_entrega)
 * @param {String} numeroCarga
 * @param {String} token
 * @param {Object} ordemPorNF - { numeroNF: ordem }
 */
function MOTORISTA_salvarOrdemRota(numeroCarga, token, ordemPorNF) {
  const lock = LockService.getScriptLock();
  try {
    const carga = exigirToken_(numeroCarga, token, PERFIL.MOTORISTA);
    lock.waitLock(20000);

    const dadosCarga = CARGA_buscarOuErro_(carga);
    const nfs = Object.keys(ordemPorNF || {});
    if (nfs.length === 0) return { sucesso: false, erro: 'Nenhuma entrega informada.' };

    const comandos = nfs.map(function(nf) {
      return {
        sql: 'UPDATE nota_fiscal SET ordem_entrega = ? WHERE carga_id = ? AND numero = ?',
        args: [parseInt(ordemPorNF[nf], 10) || null, dadosCarga.id, String(nf).trim()]
      };
    });
    comandos.push({
      sql: 'UPDATE carga SET ordem_salva_em = ?, atualizado_em = ? WHERE id = ?',
      args: [dataIso_(), dataIso_(), dadosCarga.id]
    });

    const r = DB_transacao_(comandos);
    const atualizadas = r.slice(0, nfs.length).reduce(function(a, x) { return a + x.afetadas; }, 0);

    return { sucesso: true, mensagem: 'Rota salva! ' + atualizadas + ' entregas atualizadas.' };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * MOTORISTA_concluirEntregas - Marca uma ou mais NFs como concluídas
 * @param {String} numeroCarga
 * @param {String} token
 * @param {Array<String>} nfs - Números das NFs
 * @returns {Object} { sucesso, alteradas: [nf], erro }
 */
function MOTORISTA_concluirEntregas(numeroCarga, token, nfs) {
  return alterarStatusEntregas_(numeroCarga, token, nfs, true);
}

/**
 * MOTORISTA_reabrirEntregas - Desfaz a conclusão de uma ou mais NFs
 */
function MOTORISTA_reabrirEntregas(numeroCarga, token, nfs) {
  return alterarStatusEntregas_(numeroCarga, token, nfs, false);
}

function alterarStatusEntregas_(numeroCarga, token, nfs, concluir) {
  try {
    const carga = exigirToken_(numeroCarga, token, PERFIL.MOTORISTA);
    if (!nfs || nfs.length === 0) return { sucesso: false, erro: 'Nenhuma NF informada.' };

    const dadosCarga = CARGA_buscarOuErro_(carga);
    const lista = nfs.map(function(nf) { return String(nf).trim(); });
    const r = DB_executar_(
      'UPDATE nota_fiscal SET status_entrega = ?, concluida_em = ? ' +
      'WHERE carga_id = ? AND numero IN (' + DB_marcadores_(lista.length) + ') RETURNING numero',
      [concluir ? 'CONCLUIDA' : 'PENDENTE', concluir ? dataIso_() : null, dadosCarga.id].concat(lista)
    );

    if (r.linhas.length === 0) {
      return { sucesso: false, erro: 'NF(s) não encontrada(s) nesta carga.' };
    }
    return { sucesso: true, alteradas: r.linhas.map(function(l) { return String(l.numero); }) };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  }
}

/**
 * MOTORISTA_carregamento - Link do coletor (para o QR code) e progresso
 * Exige a rota salva: a ordem de carregamento é a inversa da rota.
 * @param {String} numeroCarga
 * @param {String} token - Token do link do motorista
 * @returns {Object} { sucesso, link, status, statusDescricao, notas, notasCarregadas, qtdEsperada, qtdLida, erro }
 */
function MOTORISTA_carregamento(numeroCarga, token) {
  try {
    const carga = exigirToken_(numeroCarga, token, PERFIL.MOTORISTA);
    const resumo = DB_primeiro_('SELECT * FROM vw_carga_resumo WHERE numero = ?', [carga]);
    if (!resumo) throw new Error('Carga "' + carga + '" não encontrada.');

    if (resumo.notas_com_ordem < resumo.total_notas) {
      return {
        sucesso: false,
        semOrdem: true,
        erro: 'Salve a ordem da rota antes de gerar o carregamento. As notas são carregadas na ordem inversa das entregas.'
      };
    }

    return {
      sucesso: true,
      link: gerarLinkCarregamento_(carga),
      status: resumo.status_carregamento,
      statusDescricao: resumo.status_carregamento_desc,
      notas: resumo.total_notas,
      notasCarregadas: resumo.notas_carregadas,
      qtdEsperada: resumo.qtd_esperada,
      qtdLida: resumo.qtd_lida,
      inicio: resumo.carregamento_inicio,
      fim: resumo.carregamento_fim
    };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  }
}
