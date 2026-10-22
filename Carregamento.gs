/**
 * Carregamento.gs - Funções chamadas pela tela do coletor
 * Todas exigem o token do link de carregamento (o QR code da tela do motorista).
 *
 * Fluxo:
 * 1. CARREG_abrir: notas na ordem inversa da rota, com itens e quantidades lidas
 * 2. CARREG_registrar: o coletor envia as leituras em lotes; o servidor confere
 *    cada uma com a mesma regra do coletor (RegraCarregamento.gs) e grava
 * 3. CARREG_desfazer: estorna uma leitura aceita
 * 4. CARREG_estado: quantidades atuais (para ver leituras de outro coletor)
 */

const CARREG_MAX_LOTE = 200;

/**
 * CARREG_estadoItens_ - Notas e itens da carga com as quantidades lidas
 * @returns {Object} { notas: [{id, numero, ..., itens: [...]}], porId: {notaId: nota} }
 */
function CARREG_estadoItens_(cargaId) {
  const r = DB_consultas_([
    {
      sql: 'SELECT id, numero, destinatario, cidade, uf, ordem_entrega FROM nota_fiscal WHERE carga_id = ? ' +
           'ORDER BY COALESCE(ordem_entrega, 0) DESC, numero',
      args: [cargaId]
    },
    {
      sql: 'SELECT item_id, nota_id, n_item, codigo_produto, descricao, codigo_barras, unidade_trib, qtd_esperada, qtd_lida ' +
           'FROM vw_item_carregamento WHERE carga_id = ? ORDER BY nota_id, n_item',
      args: [cargaId]
    }
  ]);

  const porId = {};
  const notas = r[0].map(function(n) {
    porId[n.id] = {
      id: n.id,
      numero: String(n.numero),
      destinatario: n.destinatario,
      cidade: n.cidade,
      uf: n.uf,
      ordemEntrega: n.ordem_entrega,
      itens: []
    };
    return porId[n.id];
  });

  r[1].forEach(function(it) {
    const nota = porId[it.nota_id];
    if (!nota) return;
    nota.itens.push({
      id: it.item_id,
      nItem: it.n_item,
      codigoProduto: it.codigo_produto,
      descricao: it.descricao,
      codigoBarras: it.codigo_barras,
      unidade: it.unidade_trib,
      esperada: it.qtd_esperada,
      lida: it.qtd_lida
    });
  });

  return { notas: notas, porId: porId };
}

/**
 * Mapa compacto { itemId: qtdLida } para o coletor atualizar a tela
 */
function CARREG_mapaLidas_(notas) {
  const mapa = {};
  notas.forEach(function(n) {
    n.itens.forEach(function(it) { mapa[it.id] = it.lida; });
  });
  return mapa;
}

/**
 * CARREG_abrir - Dados da tela do coletor
 * @param {String} numeroCarga
 * @param {String} token - Token do link de carregamento
 */
function CARREG_abrir(numeroCarga, token) {
  try {
    const carga = normalizarCarga_(numeroCarga);
    const tokenValido = CONFIG.REGEX_CARGA.test(carga) && validarToken_(carga, token, PERFIL.CARREGAMENTO);
    registrarLog_(carga, tokenValido, PERFIL.CARREGAMENTO);
    exigirToken_(carga, token, PERFIL.CARREGAMENTO);

    const dados = CARGA_buscarOuErro_(carga);
    const estado = CARREG_estadoItens_(dados.id);
    if (estado.notas.length === 0) {
      return { sucesso: false, erro: 'A carga "' + carga + '" não possui notas.' };
    }
    const semOrdem = estado.notas.filter(function(n) { return !n.ordemEntrega; }).length;
    if (semOrdem > 0) {
      return { sucesso: false, erro: 'O motorista ainda não salvou a ordem da rota. Peça para ele tocar em "Salvar ordem" e gerar o QR code de novo.' };
    }

    return {
      sucesso: true,
      numeroCarga: carga,
      transportadora: dados.transportadora,
      status: dados.status_carregamento,
      notas: estado.notas
    };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  }
}

/**
 * CARREG_registrar - Recebe um lote de leituras do coletor
 * Leituras já recebidas (mesmo id) não são gravadas de novo.
 * @param {String} numeroCarga
 * @param {String} token
 * @param {Array} leituras - [{id, notaId, codigo, quantidade, tipo, itemId, lidoEm, dispositivo}]
 * @returns {Object} { sucesso, resultados: [{id, resultado}], lidas: {itemId: qtd}, status }
 */
function CARREG_registrar(numeroCarga, token, leituras) {
  const lock = LockService.getScriptLock();
  try {
    const carga = exigirToken_(numeroCarga, token, PERFIL.CARREGAMENTO);
    leituras = (leituras || []).slice(0, CARREG_MAX_LOTE);
    lock.waitLock(20000);

    const dados = CARGA_buscarOuErro_(carga);
    const estado = CARREG_estadoItens_(dados.id);

    // Leituras deste lote que já estão no banco (reenvio depois de falha de rede)
    const jaGravadas = {};
    if (leituras.length) {
      const ids = leituras.map(function(l) { return String(l.id); });
      DB_consultar_(
        'SELECT id, resultado FROM carregamento_leitura WHERE id IN (' + DB_marcadores_(ids.length) + ')',
        ids
      ).forEach(function(l) { jaGravadas[l.id] = l.resultado; });
    }

    const agora = dataIso_();
    const comandos = [];
    const resultados = [];
    let aceitas = 0;

    leituras.forEach(function(l) {
      const id = String(l.id || '').substring(0, 64);
      if (!id) return;
      if (jaGravadas[id]) {
        resultados.push({ id: id, resultado: jaGravadas[id], repetida: true });
        return;
      }

      const nota = estado.porId[l.notaId];
      if (!nota) {
        resultados.push({ id: id, resultado: 'INVALIDA', erro: 'Nota não pertence a esta carga' });
        return;
      }

      const tipo = ['CODIGO_BARRAS', 'DIGITADO', 'CONFIRMACAO'].indexOf(l.tipo) !== -1 ? l.tipo : 'CODIGO_BARRAS';
      const leitura = {
        tipo: tipo,
        codigo: String(l.codigo || '').substring(0, 64),
        quantidade: l.quantidade,
        itemId: l.itemId
      };
      const av = REGRA_avaliarLeitura_(nota, leitura);
      const quantidade = REGRA_arred_(l.quantidade) > 0 ? REGRA_arred_(l.quantidade) : 1;
      const comum = [dados.id, nota.id];
      const fim = [tipo, av.resultado, String(l.dispositivo || '').substring(0, 60), String(l.lidoEm || agora).substring(0, 30)];

      if (av.resultado === 'ACEITA') {
        REGRA_aplicar_(nota, av.alocacoes);
        aceitas++;
        av.alocacoes.forEach(function(a, i) {
          comandos.push({
            sql: 'INSERT OR IGNORE INTO carregamento_leitura (id, carga_id, nota_id, item_id, codigo_lido, quantidade, tipo, resultado, dispositivo, lido_em) ' +
                 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            args: [i === 0 ? id : id + '#' + (i + 1)].concat(comum, [a.itemId, leitura.codigo, a.quantidade], fim)
          });
        });
      } else {
        comandos.push({
          sql: 'INSERT OR IGNORE INTO carregamento_leitura (id, carga_id, nota_id, item_id, codigo_lido, quantidade, tipo, resultado, dispositivo, lido_em) ' +
               'VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)',
          args: [id].concat(comum, [leitura.codigo, quantidade], fim)
        });
      }
      resultados.push({ id: id, resultado: av.resultado });
    });

    // Situação do carregamento depois deste lote
    const todasCompletas = estado.notas.every(REGRA_notaCompleta_);
    let status = dados.status_carregamento;
    if (aceitas > 0 && status === 'NAO_INICIADO') status = 'EM_ANDAMENTO';
    if (todasCompletas) status = 'FINALIZADO';
    else if (status === 'FINALIZADO') status = 'EM_ANDAMENTO';

    if (status !== dados.status_carregamento) {
      comandos.push({
        sql: 'UPDATE carga SET status_carregamento = ?, carregamento_inicio = COALESCE(carregamento_inicio, ?), ' +
             'carregamento_fim = ?, atualizado_em = ? WHERE id = ?',
        args: [status, agora, status === 'FINALIZADO' ? agora : null, agora, dados.id]
      });
    }

    DB_transacao_(comandos);

    return {
      sucesso: true,
      resultados: resultados,
      lidas: CARREG_mapaLidas_(estado.notas),
      status: status
    };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * CARREG_desfazer - Estorna uma leitura aceita (botão "Desfazer")
 * @param {String} numeroCarga
 * @param {String} token
 * @param {String} leituraId - id enviado pelo coletor
 */
function CARREG_desfazer(numeroCarga, token, leituraId) {
  const lock = LockService.getScriptLock();
  try {
    const carga = exigirToken_(numeroCarga, token, PERFIL.CARREGAMENTO);
    lock.waitLock(20000);

    const dados = CARGA_buscarOuErro_(carga);
    const id = String(leituraId || '');
    const agora = dataIso_();
    const r = DB_transacao_([
      {
        sql: 'UPDATE carregamento_leitura SET estornada_em = ? ' +
             'WHERE carga_id = ? AND (id = ? OR id LIKE ?) AND resultado = \'ACEITA\' AND estornada_em IS NULL',
        args: [agora, dados.id, id, id + '#%']
      },
      {
        sql: 'UPDATE carga SET status_carregamento = \'EM_ANDAMENTO\', carregamento_fim = NULL, atualizado_em = ? ' +
             'WHERE id = ? AND status_carregamento = \'FINALIZADO\' AND changes() > 0',
        args: [agora, dados.id]
      }
    ]);

    const estado = CARREG_estadoItens_(dados.id);
    const atual = DB_primeiro_('SELECT status_carregamento FROM carga WHERE id = ?', [dados.id]);
    return {
      sucesso: r[0].afetadas > 0,
      erro: r[0].afetadas > 0 ? '' : 'Leitura não encontrada ou já desfeita.',
      lidas: CARREG_mapaLidas_(estado.notas),
      status: atual ? atual.status_carregamento : dados.status_carregamento
    };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * CARREG_estado - Quantidades lidas e status (consulta leve, sem trava)
 */
function CARREG_estado(numeroCarga, token) {
  try {
    const carga = exigirToken_(numeroCarga, token, PERFIL.CARREGAMENTO);
    const dados = CARGA_buscarOuErro_(carga);
    const estado = CARREG_estadoItens_(dados.id);
    return { sucesso: true, lidas: CARREG_mapaLidas_(estado.notas), status: dados.status_carregamento };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  }
}
