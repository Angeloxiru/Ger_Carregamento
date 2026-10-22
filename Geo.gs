/**
 * Geo.gs - Geocodificação com cache e registro de uso de API
 *
 * Geocodificação:
 * - As coordenadas ficam na tabela geo_cache e NÃO expiram (endereço não
 *   muda de lugar). Para corrigir um ponto errado, altere lat/lng no banco
 *   e marque precisao = 'manual'.
 * - Endereços novos são geocodificados pelo serviço Maps do Apps Script
 *   (Maps.newGeocoder), que usa a cota do Apps Script e não a conta de
 *   faturamento do Google Cloud.
 */

// ============= CACHE DE GEOCODIFICAÇÃO =============

/**
 * GEO_normalizar_ - Normaliza endereço para uso como chave
 */
function GEO_normalizar_(endereco) {
  return String(endereco || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * GEO_carregarCache_ - Busca no banco só as chaves pedidas
 * @param {Array<String>} chaves - endereços (serão normalizados)
 * @returns {Object} chave normalizada → {lat, lng, aproximado}
 */
function GEO_carregarCache_(chaves) {
  const mapa = {};
  const unicas = {};
  chaves.forEach(function(c) { unicas[GEO_normalizar_(c)] = true; });
  const lista = Object.keys(unicas);

  // Lotes de 200 para não estourar o limite de parâmetros do SQLite
  for (let i = 0; i < lista.length; i += 200) {
    const lote = lista.slice(i, i + 200);
    DB_consultar_(
      'SELECT chave, lat, lng, precisao FROM geo_cache WHERE chave IN (' + DB_marcadores_(lote.length) + ')',
      lote
    ).forEach(function(l) {
      mapa[l.chave] = { lat: l.lat, lng: l.lng, aproximado: l.precisao === 'aproximado' };
    });
  }
  return mapa;
}

/**
 * GEO_salvar_ - Grava endereços novos no cache
 * @param {Array} novos - [[endereco, lat, lng, precisao]]
 */
function GEO_salvar_(novos) {
  if (!novos.length) return;
  DB_transacao_(novos.map(function(n) {
    return {
      sql: 'INSERT OR IGNORE INTO geo_cache (chave, endereco, lat, lng, precisao) VALUES (?, ?, ?, ?, ?)',
      args: [GEO_normalizar_(n[0]), n[0], n[1], n[2], n[3]]
    };
  }));
}

/**
 * GEO_chaveEntrega_ - Chave de cache de uma entrega
 * Mesmo formato da versão 3, para aproveitar o cache importado.
 */
function GEO_chaveEntrega_(e) {
  return e.endereco + ', ' + e.bairro + ', ' + e.cidade + ', ' + e.uf;
}

/**
 * GEO_chaveCidade_ - Chave de cache do centro de uma cidade
 */
function GEO_chaveCidade_(cidade, uf) {
  const c = String(cidade || '').trim().toUpperCase();
  return uf ? c + ', ' + uf + ', Brasil' : c + ', Brasil';
}

/**
 * GEO_consultarGoogle_ - Geocodifica um endereço pelo serviço Maps do Apps Script
 * Rejeita resultados de outro estado (UF diferente da informada).
 * @returns {Object|null} {lat, lng, aproximado}
 */
function GEO_consultarGoogle_(consulta, uf) {
  const resposta = Maps.newGeocoder().setRegion('br').setLanguage('pt-BR').geocode(consulta);
  if (!resposta || resposta.status !== 'OK' || !resposta.results || resposta.results.length === 0) {
    return null;
  }

  const ufEsperada = String(uf || '').trim().toUpperCase();
  for (let i = 0; i < resposta.results.length; i++) {
    const r = resposta.results[i];
    const estado = (r.address_components || []).filter(function(c) {
      return c.types.indexOf('administrative_area_level_1') !== -1;
    })[0];

    if (ufEsperada && estado && String(estado.short_name).toUpperCase() !== ufEsperada) continue;

    return {
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      aproximado: r.geometry.location_type === 'APPROXIMATE'
    };
  }
  return null;
}

/**
 * GEO_geocodificarEntregas_ - Coordenadas para uma lista de entregas
 * Ordem de tentativa: cache → endereço completo → centro da cidade (aproximado).
 * @param {Array} entregas - [{endereco, bairro, cidade, uf}]
 * @param {String} numeroCarga - Para o registro de uso
 * @returns {Array} [{lat, lng, aproximado} | null] na mesma ordem
 */
function GEO_geocodificarEntregas_(entregas, numeroCarga) {
  const chavesBusca = [];
  entregas.forEach(function(e) {
    chavesBusca.push(GEO_chaveEntrega_(e));
    chavesBusca.push(GEO_chaveCidade_(e.cidade, e.uf));
  });
  const cache = GEO_carregarCache_(chavesBusca);
  const novos = [];
  let consultas = 0;
  let cotaEsgotada = false;

  function resolver(chave, consulta, uf) {
    const norm = GEO_normalizar_(chave);
    if (cache[norm]) return cache[norm];
    if (cotaEsgotada) return null;

    try {
      consultas++;
      const r = GEO_consultarGoogle_(consulta, uf);
      if (r) {
        cache[norm] = r;
        novos.push([chave, r.lat, r.lng, r.aproximado ? 'aproximado' : 'exato']);
      }
      return r;
    } catch (erro) {
      // Cota diária do Apps Script esgotada ou serviço fora: para de consultar
      console.log('Geocodificação interrompida: ' + erro);
      cotaEsgotada = true;
      return null;
    }
  }

  const resultado = entregas.map(function(e) {
    const chave = GEO_chaveEntrega_(e);
    const exato = resolver(chave, chave + ', Brasil', e.uf);
    if (exato) return exato;

    const chaveCidade = GEO_chaveCidade_(e.cidade, e.uf);
    const cidade = resolver(chaveCidade, chaveCidade, e.uf);
    if (!cidade) return null;

    // Guarda o endereço com a posição da cidade para não consultar de novo
    const aproximado = { lat: cidade.lat, lng: cidade.lng, aproximado: true };
    if (!cotaEsgotada) {
      cache[GEO_normalizar_(chave)] = aproximado;
      novos.push([chave, cidade.lat, cidade.lng, 'aproximado']);
    }
    return aproximado;
  });

  try {
    GEO_salvar_(novos);
  } catch (erro) {
    console.log('Não foi possível salvar o cache de endereços: ' + erro);
  }
  if (consultas > 0) API_registrarUso_('Geocoding', numeroCarga, consultas);

  return resultado;
}

/**
 * GEO_geocodificarEndereco_ - Coordenadas de um endereço avulso (ex: partida)
 */
function GEO_geocodificarEndereco_(chave, consulta, uf, numeroCarga) {
  const cache = GEO_carregarCache_([chave]);
  const norm = GEO_normalizar_(chave);
  if (cache[norm]) return cache[norm];

  try {
    const r = GEO_consultarGoogle_(consulta, uf);
    API_registrarUso_('Geocoding', numeroCarga, 1);
    if (r) GEO_salvar_([[chave, r.lat, r.lng, r.aproximado ? 'aproximado' : 'exato']]);
    return r;
  } catch (erro) {
    console.log('Erro ao geocodificar ' + chave + ': ' + erro);
    return null;
  }
}

/**
 * GEO_importarLinhas_ - Importa linhas da aba _GeoCache da versão 3
 * @param {Array} linhas - [[Endereco, Latitude, Longitude, DataCache, Precisao]]
 * @returns {Number} linhas válidas enviadas
 */
function GEO_importarLinhas_(linhas) {
  const validas = linhas.filter(function(l) {
    return l[0] && !isNaN(parseFloat(l[1])) && !isNaN(parseFloat(l[2]));
  }).map(function(l) {
    return [String(l[0]), parseFloat(l[1]), parseFloat(l[2]), l[4] === 'aproximado' ? 'aproximado' : 'exato'];
  });

  for (let i = 0; i < validas.length; i += 300) {
    GEO_salvar_(validas.slice(i, i + 300));
  }
  return validas.length;
}

// ============= RASTREAMENTO DE USO DE API =============

/**
 * API_registrarUso_ - Registra chamadas de API para cobrança por transportador
 * @param {String} tipoAPI - 'Mapa' ou 'Geocoding' (ver lkp_tipo_api)
 * @param {String} numeroCarga - Ex: 'C123'
 * @param {Number} quantidade - Número de chamadas
 */
function API_registrarUso_(tipoAPI, numeroCarga, quantidade) {
  if (!quantidade || quantidade <= 0) return;

  try {
    const carga = normalizarCarga_(numeroCarga);
    DB_executar_(
      'INSERT INTO api_uso (carga_numero, documento, transportadora, tipo, quantidade, custo_usd) ' +
      'SELECT ?, COALESCE(t.documento, \'\'), COALESCE(t.nome, \'\'), l.codigo, ?, ? * l.custo_por_mil / 1000.0 ' +
      'FROM lkp_tipo_api l ' +
      'LEFT JOIN carga c ON c.numero = ? ' +
      'LEFT JOIN transportadora t ON t.id = c.transportadora_id ' +
      'WHERE l.codigo = ?',
      [carga, quantidade, quantidade, carga, tipoAPI]
    );
  } catch (erro) {
    console.log('Erro ao registrar uso de API: ' + erro);
  }
}

/**
 * API_resumoPorPeriodo_ - Resumo de uso agrupado por CNPJ
 * @param {Date|Number} inicio - Data inicial ou quantidade de dias para trás
 * @param {Date} [fim] - Data final (padrão: agora)
 * @returns {Object} { dados: [{cnpj, nome, tipos:{Tipo: qtd}, total, custoTotal}], tipos: [String], custos }
 */
function API_resumoPorPeriodo_(inicio, fim) {
  if (typeof inicio === 'number') {
    const d = new Date();
    d.setDate(d.getDate() - inicio);
    inicio = d;
  }
  fim = fim || new Date();

  const r = DB_consultas_([
    {
      sql: 'SELECT documento, MAX(transportadora) AS nome, tipo, SUM(quantidade) AS qtd, SUM(custo_usd) AS custo ' +
           'FROM api_uso WHERE ocorrido_em BETWEEN ? AND ? GROUP BY documento, tipo',
      args: [dataIso_(inicio), dataIso_(fim)]
    },
    { sql: 'SELECT codigo, custo_por_mil FROM lkp_tipo_api ORDER BY ordem' }
  ]);

  const resumo = {};
  const tiposVistos = {};
  r[0].forEach(function(l) {
    const cnpj = l.documento || 'SEM_CNPJ';
    if (!resumo[cnpj]) {
      resumo[cnpj] = { cnpj: cnpj, nome: l.nome || 'Desconhecido', tipos: {}, total: 0, custoTotal: 0 };
    }
    resumo[cnpj].tipos[l.tipo] = (resumo[cnpj].tipos[l.tipo] || 0) + l.qtd;
    resumo[cnpj].total += l.qtd;
    resumo[cnpj].custoTotal += l.custo || 0;
    tiposVistos[l.tipo] = true;
  });

  const custos = {};
  r[1].forEach(function(l) { custos[l.codigo] = l.custo_por_mil; });
  const tipos = r[1].map(function(l) { return l.codigo; }).filter(function(t) { return tiposVistos[t]; });

  const dados = Object.keys(resumo).map(function(k) { return resumo[k]; })
    .sort(function(a, b) { return b.custoTotal - a.custoTotal; });

  return { dados: dados, tipos: tipos, custos: custos };
}

/**
 * API_buscarCotacaoDolar_ - Cotação USD/BRL (PTAX do Banco Central), com cache de 6h
 * @returns {Object} {cotacao, fonte}
 */
function API_buscarCotacaoDolar_() {
  const cache = CacheService.getScriptCache();
  const salvo = cache.get('cotacao_usd');
  if (salvo) return JSON.parse(salvo);

  try {
    const hoje = new Date();
    for (let i = 0; i <= 6; i++) {
      const dia = new Date(hoje);
      dia.setDate(dia.getDate() - i);
      const data = Utilities.formatDate(dia, 'America/Sao_Paulo', 'MM-dd-yyyy');
      const url = "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='" + data + "'&$top=1&$format=json";
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      if (json.value && json.value.length > 0) {
        const resultado = { cotacao: json.value[0].cotacaoVenda || json.value[0].cotacaoCompra, fonte: 'BCB PTAX ' + data.replace(/-/g, '/') };
        cache.put('cotacao_usd', JSON.stringify(resultado), 6 * 3600);
        return resultado;
      }
    }
  } catch (e) {
    console.log('Erro ao buscar cotação: ' + e);
  }

  return { cotacao: 5.50, fonte: 'valor padrão (sem conexão com o BCB)' };
}

/**
 * API_buscarUsoPorPeriodo - Dados da página "Uso de API" (exige senha do painel)
 * @param {String} senha - Senha do painel
 * @param {String} dataInicio - YYYY-MM-DD
 * @param {String} dataFim - YYYY-MM-DD
 */
function API_buscarUsoPorPeriodo(senha, dataInicio, dataFim) {
  exigirAdmin_(senha);

  const inicio = dataInicio ? new Date(dataInicio + 'T00:00:00') : new Date(0);
  const fim = dataFim ? new Date(dataFim + 'T23:59:59') : new Date();
  const resumo = API_resumoPorPeriodo_(inicio, fim);
  const cambio = API_buscarCotacaoDolar_();

  return {
    dados: resumo.dados,
    tipos: resumo.tipos,
    custos: resumo.custos,
    cotacao: cambio.cotacao,
    fonteCotacao: cambio.fonte
  };
}
