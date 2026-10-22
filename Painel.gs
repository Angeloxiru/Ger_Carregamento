/**
 * Painel.gs - Funções do Painel de Controle
 * Todas as funções públicas exigem a senha do painel no primeiro parâmetro.
 */

// ============= SINCRONIZAÇÃO DRIVE ↔ BANCO =============

/**
 * PAINEL_atualizarCargas - Sincroniza pasta "CargasEmRota" com o banco
 * @param {String} senha - Senha do painel
 */
function PAINEL_atualizarCargas(senha) {
  exigirAdmin_(senha);
  return sincronizarCargas_();
}

/**
 * sincronizarCargas_ - Lógica de sincronização
 * 1. Para cada subpasta do Drive (ex: C123):
 *    - Sem carga no banco: cria a carga e processa os XMLs
 *    - Com carga e com XMLs novos: acrescenta só as NFs que ainda não estão no banco
 * 2. Exclui do banco as cargas que não têm mais pasta no Drive
 * @returns {Object} { sucesso, mensagem, criadas, atualizadas, removidas }
 */
function sincronizarCargas_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { sucesso: false, erro: 'Outra sincronização está em andamento. Tente de novo em instantes.' };
  }

  try {
    const pastaCargas = buscarOuCriarPasta_(CONFIG.PASTA_CARGAS);
    const subpastas = pastaCargas.getFolders();
    const cargasNoDrive = {};
    const criadas = [];
    const atualizadas = [];

    // Quantas NFs cada carga tem no banco (uma consulta só)
    const notasNoBanco = {};
    DB_consultar_('SELECT numero, total_notas FROM vw_carga_resumo').forEach(function(l) {
      notasNoBanco[l.numero] = l.total_notas;
    });

    while (subpastas.hasNext()) {
      const pasta = subpastas.next();
      const nomeCarga = normalizarCarga_(pasta.getName());
      if (!CONFIG.REGEX_CARGA.test(nomeCarga)) continue;
      cargasNoDrive[nomeCarga] = true;

      const resultado = processarPastaCarga_(pasta, nomeCarga, notasNoBanco[nomeCarga]);
      if (resultado === 'criada') criadas.push(nomeCarga);
      if (resultado === 'atualizada') atualizadas.push(nomeCarga);
    }

    // Remover do banco as cargas sem pasta correspondente
    const removidas = [];
    Object.keys(notasNoBanco).forEach(function(numero) {
      if (!cargasNoDrive[numero]) {
        CARGA_excluir_(numero);
        removidas.push(numero);
      }
    });

    const partes = [];
    partes.push(Object.keys(cargasNoDrive).length + ' carga(s) no Drive');
    if (criadas.length) partes.push('novas: ' + criadas.join(', '));
    if (atualizadas.length) partes.push('com NFs novas: ' + atualizadas.join(', '));
    if (removidas.length) partes.push('removidas: ' + removidas.join(', '));

    return {
      sucesso: true,
      mensagem: partes.join(' | '),
      criadas: criadas,
      atualizadas: atualizadas,
      removidas: removidas
    };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * processarPastaCarga_ - Cria ou completa uma carga no banco
 * @param {Folder} pasta
 * @param {String} nomeCarga
 * @param {Number|undefined} notasNoBanco - NFs já gravadas (undefined = carga nova)
 * @returns {String} 'criada', 'atualizada' ou 'sem_mudanca'
 */
function processarPastaCarga_(pasta, nomeCarga, notasNoBanco) {
  const nova = notasNoBanco === undefined;

  // Carga existente: só relê os XMLs se houver mais arquivos que NFs no banco
  if (!nova && contarXMLs_(pasta) <= notasNoBanco) return 'sem_mudanca';

  const notas = XML_processarPasta_(pasta);
  const r = CARGA_importarNotas_(nomeCarga, notas);
  if (!nova && r.novas.length === 0) return 'sem_mudanca';

  const numerosNovos = {};
  r.novas.forEach(function(n) { numerosNovos[n] = true; });
  pregeocodificarNotas_(notas.filter(function(nf) { return numerosNovos[String(nf.numeroNF).trim()]; }), nomeCarga);
  return nova ? 'criada' : 'atualizada';
}

/**
 * contarXMLs_ - Conta arquivos .xml em uma pasta
 */
function contarXMLs_(pasta) {
  let total = 0;
  const arquivos = pasta.getFiles();
  while (arquivos.hasNext()) {
    if (arquivos.next().getName().toLowerCase().endsWith('.xml')) total++;
  }
  return total;
}

/**
 * pregeocodificarNotas_ - Geocodifica os endereços já na importação,
 * para que a tela do motorista abra rápido. Falhas são ignoradas aqui
 * (a tela do motorista tenta de novo).
 */
function pregeocodificarNotas_(notas, nomeCarga) {
  if (!notas.length) return;
  try {
    const entregas = notas.map(function(nf) {
      return {
        endereco: nf.logradouro + (nf.numero ? ', ' + nf.numero : ''),
        bairro: nf.bairro,
        cidade: nf.cidade,
        uf: nf.uf
      };
    });
    GEO_geocodificarEntregas_(entregas, nomeCarga);
    const partida = obterEnderecoPartida_();
    GEO_geocodificarEndereco_(partida, partida, '', nomeCarga);
  } catch (erro) {
    console.log('Pré-geocodificação falhou (será refeita no acesso do motorista): ' + erro);
  }
}

// ============= LISTAGEM =============

/**
 * PAINEL_listarCargasComLinks - Lista todas as cargas com links e status
 * @param {String} senha - Senha do painel
 * @returns {Object} { sucesso, cargas: [...], banco, mapaConfigurado }
 */
function PAINEL_listarCargasComLinks(senha) {
  exigirAdmin_(senha);

  try {
    const banco = DB_status_();
    if (!banco.ok) {
      return { sucesso: true, cargas: [], banco: banco, mapaConfigurado: !!obterMapsApiKey_() };
    }

    const cargas = DB_consultar_('SELECT * FROM vw_carga_resumo').map(function(c) {
      let status = 'Ativa';
      if (c.total_notas > 0 && c.notas_entregues === c.total_notas) status = 'Concluída';
      else if (c.notas_entregues > 0) status = 'Em andamento';

      return {
        numero: c.numero,
        transportadora: c.transportadora,
        cnpj: formatarCnpj_(c.documento),
        totalEntregas: c.total_notas,
        concluidas: c.notas_entregues,
        pendentes: c.total_notas - c.notas_entregues,
        cidades: c.cidades,
        pesoTotal: c.peso_kg,
        status: status,
        rotaSalva: c.total_notas > 0 && c.notas_com_ordem === c.total_notas,
        rotaTravada: !!c.rota_travada_em,
        carregamento: {
          status: c.status_carregamento,
          descricao: c.status_carregamento_desc,
          notasCarregadas: c.notas_carregadas,
          qtdEsperada: c.qtd_esperada,
          qtdLida: c.qtd_lida,
          itensSemCodigo: c.itens_sem_codigo,
          inicio: c.carregamento_inicio,
          fim: c.carregamento_fim
        },
        link: gerarLinkMotorista_(c.numero)
      };
    }).filter(function(c) { return c.totalEntregas > 0; });

    cargas.sort(function(a, b) {
      return a.numero.localeCompare(b.numero, 'pt-BR', { numeric: true });
    });

    return {
      sucesso: true,
      cargas: cargas,
      banco: banco,
      mapaConfigurado: !!obterMapsApiKey_()
    };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  }
}

/**
 * PAINEL_detalheCarga - Notas, itens e leituras recusadas de uma carga
 * @param {String} senha
 * @param {String} numeroCarga
 */
function PAINEL_detalheCarga(senha, numeroCarga) {
  exigirAdmin_(senha);

  try {
    const carga = CARGA_buscarOuErro_(numeroCarga);
    const r = DB_consultas_([
      {
        sql: 'SELECT n.id, n.numero, n.destinatario, n.cidade, n.uf, n.ordem_entrega, n.status_entrega, n.concluida_em, ' +
             'v.total_itens, v.itens_completos, v.qtd_esperada, v.qtd_lida, v.completa ' +
             'FROM nota_fiscal n JOIN vw_nota_carregamento v ON v.nota_id = n.id ' +
             'WHERE n.carga_id = ? ORDER BY COALESCE(n.ordem_entrega, 999999), n.numero',
        args: [carga.id]
      },
      {
        sql: 'SELECT item_id, nota_id, n_item, codigo_produto, descricao, codigo_barras, unidade_trib, qtd_esperada, qtd_lida, completo ' +
             'FROM vw_item_carregamento WHERE carga_id = ? ORDER BY nota_id, n_item',
        args: [carga.id]
      },
      {
        sql: 'SELECT nota, codigo_lido, quantidade, motivo, lido_em FROM vw_leitura_recusada WHERE carga = ? ORDER BY lido_em DESC LIMIT 50',
        args: [carga.numero]
      }
    ]);

    const itensPorNota = {};
    r[1].forEach(function(it) {
      (itensPorNota[it.nota_id] = itensPorNota[it.nota_id] || []).push(it);
    });

    return {
      sucesso: true,
      numero: carga.numero,
      transportadora: carga.transportadora,
      statusCarregamento: carga.status_carregamento,
      rotaTravada: !!carga.rota_travada_em,
      notas: r[0].map(function(n) {
        n.itens = itensPorNota[n.id] || [];
        return n;
      }),
      recusadas: r[2]
    };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  }
}

/**
 * PAINEL_destravarRota - Libera o motorista para mudar a ordem das entregas
 * As leituras do carregamento continuam valendo.
 */
function PAINEL_destravarRota(senha, numeroCarga) {
  exigirAdmin_(senha);

  try {
    const carga = CARGA_buscarOuErro_(numeroCarga);
    DB_executar_('UPDATE carga SET rota_travada_em = NULL, atualizado_em = ? WHERE id = ?', [dataIso_(), carga.id]);
    return { sucesso: true, mensagem: 'Rota da carga ' + carga.numero + ' destravada. O motorista já pode mudar a ordem.' };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  }
}

/**
 * PAINEL_reiniciarCarregamento - Apaga as leituras, volta o carregamento ao
 * início e destrava a rota (para quando o caminhão precisa ser descarregado)
 */
function PAINEL_reiniciarCarregamento(senha, numeroCarga) {
  exigirAdmin_(senha);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const carga = CARGA_buscarOuErro_(numeroCarga);
    DB_transacao_([
      { sql: 'DELETE FROM carregamento_leitura WHERE carga_id = ?', args: [carga.id] },
      {
        sql: 'UPDATE carga SET status_carregamento = \'NAO_INICIADO\', carregamento_inicio = NULL, carregamento_fim = NULL, ' +
             'rota_travada_em = NULL, atualizado_em = ? WHERE id = ?',
        args: [dataIso_(), carga.id]
      }
    ]);
    return { sucesso: true, mensagem: 'Carregamento da carga ' + carga.numero + ' reiniciado. As leituras foram apagadas e a rota foi destravada.' };
  } catch (erro) {
    return { sucesso: false, erro: erro.message || String(erro) };
  } finally {
    lock.releaseLock();
  }
}

// ============= UPLOAD =============

/**
 * PAINEL_uploadXMLs - Salva XMLs no Drive e já processa a carga
 * @param {String} senha - Senha do painel
 * @param {String} numeroCarga - Ex: "C123"
 * @param {Array} arquivos - [{nome, base64}] (conteúdo em base64 preserva a codificação)
 */
function PAINEL_uploadXMLs(senha, numeroCarga, arquivos) {
  exigirAdmin_(senha);

  try {
    numeroCarga = normalizarCarga_(numeroCarga);
    if (!/^C\d+$/.test(numeroCarga)) {
      return { sucesso: false, erro: 'Formato de carga inválido. Use C seguido de números (ex: C123).' };
    }
    if (!arquivos || arquivos.length === 0) {
      return { sucesso: false, erro: 'Nenhum arquivo foi enviado.' };
    }

    const pastaRaiz = buscarOuCriarPasta_(CONFIG.PASTA_CARGAS);
    const pastasCarga = pastaRaiz.getFoldersByName(numeroCarga);
    const pastaCarga = pastasCarga.hasNext() ? pastasCarga.next() : pastaRaiz.createFolder(numeroCarga);

    const salvos = [];
    const ignorados = [];

    arquivos.forEach(function(arquivo) {
      const nome = String(arquivo.nome || '');
      if (!nome.toLowerCase().endsWith('.xml')) {
        ignorados.push(nome + ' (não é XML)');
        return;
      }

      try {
        const bytes = Utilities.base64Decode(arquivo.base64);
        const blob = Utilities.newBlob(bytes, 'text/xml', nome);

        if (!XML_validarEstruturaNFe_(XML_lerTexto_(blob))) {
          ignorados.push(nome + ' (não é uma NF-e válida)');
          return;
        }

        // Substitui arquivo com o mesmo nome
        const existentes = pastaCarga.getFilesByName(nome);
        while (existentes.hasNext()) existentes.next().setTrashed(true);

        pastaCarga.createFile(blob);
        salvos.push(nome);
      } catch (erroArquivo) {
        ignorados.push(nome + ' (' + erroArquivo.message + ')');
      }
    });

    if (salvos.length === 0) {
      return { sucesso: false, erro: 'Nenhum XML válido foi salvo.', ignorados: ignorados };
    }

    // Processar a carga imediatamente
    const sinc = sincronizarCargas_();

    return {
      sucesso: true,
      numeroCarga: numeroCarga,
      arquivosProcessados: salvos.length,
      ignorados: ignorados,
      sincronizacao: sinc.sucesso ? sinc.mensagem : sinc.erro
    };
  } catch (erro) {
    return { sucesso: false, erro: 'Erro ao fazer upload: ' + (erro.message || erro) };
  }
}

// ============= EXCLUSÃO =============

/**
 * PAINEL_excluirCarga - Exclui uma carga: pasta do Drive para a lixeira e
 * todos os dados dela no banco (notas, itens, leituras e logs)
 * @param {String} senha - Senha do painel
 * @param {String} numeroCarga - Ex: "C123"
 */
function PAINEL_excluirCarga(senha, numeroCarga) {
  exigirAdmin_(senha);

  const lock = LockService.getScriptLock();
  try {
    numeroCarga = normalizarCarga_(numeroCarga);
    if (!CONFIG.REGEX_CARGA.test(numeroCarga)) {
      return { sucesso: false, erro: 'Número de carga inválido.' };
    }
    lock.waitLock(20000);

    const pastaRaiz = buscarOuCriarPasta_(CONFIG.PASTA_CARGAS);
    const pastas = pastaRaiz.getFoldersByName(numeroCarga);
    let pastaExcluida = false;
    while (pastas.hasNext()) {
      pastas.next().setTrashed(true);
      pastaExcluida = true;
    }

    const noBanco = CARGA_excluir_(numeroCarga);

    if (!pastaExcluida && !noBanco) {
      return { sucesso: false, erro: 'Carga "' + numeroCarga + '" não encontrada nem no Drive nem no banco.' };
    }

    return {
      sucesso: true,
      numeroCarga: numeroCarga,
      mensagem: 'Carga ' + numeroCarga + ' excluída do banco. A pasta foi para a lixeira do Drive.'
    };
  } catch (erro) {
    return { sucesso: false, erro: 'Erro ao excluir carga: ' + (erro.message || erro) };
  } finally {
    lock.releaseLock();
  }
}
