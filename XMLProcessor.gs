/**
 * XMLProcessor.gs - Leitura dos XMLs de NF-e
 * Aceita tanto o XML "nfeProc" (com protocolo) quanto o "NFe" puro.
 * Além do destinatário e do endereço, lê os itens (det/prod) para o carregamento.
 */

function nfeNamespace_() {
  return XmlService.getNamespace('http://www.portalfiscal.inf.br/nfe');
}

/**
 * XML_processarPasta_ - Processa todos os XMLs de uma pasta do Drive
 * NFs repetidas (mesmo número) entram uma vez só.
 * @param {Folder} pasta - Pasta da carga no Drive
 * @returns {Array} Dados das notas fiscais
 */
function XML_processarPasta_(pasta) {
  const notas = [];
  const vistas = {};
  const arquivos = pasta.getFiles();

  while (arquivos.hasNext()) {
    const arquivo = arquivos.next();
    if (!arquivo.getName().toLowerCase().endsWith('.xml')) continue;

    try {
      const nf = XML_extrairDadosNFe_(XML_lerTexto_(arquivo.getBlob()));
      if (!nf) continue;

      const chave = String(nf.numeroNF).trim();
      if (vistas[chave]) continue;
      vistas[chave] = true;
      nf.arquivo = arquivo.getName();
      notas.push(nf);
    } catch (erro) {
      console.error('Erro ao processar XML ' + arquivo.getName() + ': ' + erro);
    }
  }

  return notas;
}

/**
 * XML_lerTexto_ - Lê o conteúdo do XML respeitando a codificação declarada
 * (UTF-8 ou ISO-8859-1), evitando acentos corrompidos.
 * @param {Blob} blob
 * @returns {String}
 */
function XML_lerTexto_(blob) {
  const inicio = blob.getDataAsString('ISO-8859-1').substring(0, 200);
  const declarada = inicio.match(/encoding\s*=\s*["']([^"']+)["']/i);
  const charset = declarada && /8859-1|latin/i.test(declarada[1]) ? 'ISO-8859-1' : 'UTF-8';
  return blob.getDataAsString(charset).replace(/^﻿/, '');
}

/**
 * XML_obterInfNFe_ - Encontra o elemento infNFe (nfeProc > NFe > infNFe ou NFe > infNFe)
 */
function XML_obterInfNFe_(root) {
  const ns = nfeNamespace_();
  let nfe = root;
  if (root.getName() === 'nfeProc') nfe = root.getChild('NFe', ns);
  if (!nfe || nfe.getName() !== 'NFe') return null;
  return nfe.getChild('infNFe', ns);
}

/**
 * XML_numero_ - Converte texto numérico do XML ("12.5000") em número
 */
function XML_numero_(texto) {
  const v = parseFloat(String(texto || '').replace(',', '.'));
  return isNaN(v) ? 0 : v;
}

/**
 * XML_extrairDadosNFe_ - Extrai dados relevantes do texto de uma NF-e
 * @param {String} xmlTexto
 * @returns {Object|null} Dados da NF ou null se não houver destinatário
 */
function XML_extrairDadosNFe_(xmlTexto) {
  const ns = nfeNamespace_();
  const infNFe = XML_obterInfNFe_(XmlService.parse(xmlTexto).getRootElement());
  if (!infNFe) throw new Error('Estrutura do XML não reconhecida como NF-e');

  const ide = infNFe.getChild('ide', ns);
  const dest = infNFe.getChild('dest', ns);
  if (!dest) {
    console.log('Destinatário não encontrado no XML');
    return null;
  }

  const destinatario = XML_extrairDadosDestinatario_(dest);
  const transp = infNFe.getChild('transp', ns);
  const transportadora = XML_extrairTransportadora_(transp);
  const total = infNFe.getChild('total', ns);
  const icmsTot = total ? total.getChild('ICMSTot', ns) : null;
  const idAttr = infNFe.getAttribute('Id');

  return {
    numeroNF: ide ? ide.getChildText('nNF', ns) : 'N/D',
    serie: ide ? (ide.getChildText('serie', ns) || '') : '',
    emitidaEm: ide ? (ide.getChildText('dhEmi', ns) || ide.getChildText('dEmi', ns) || '') : '',
    chaveAcesso: idAttr ? idAttr.getValue().replace(/^NFe/, '') : '',
    destinatario: destinatario.nome,
    destinatarioDoc: destinatario.documento,
    logradouro: destinatario.logradouro,
    numero: destinatario.numero,
    bairro: destinatario.bairro,
    cidade: destinatario.cidade,
    uf: destinatario.uf,
    cep: destinatario.cep,
    peso: XML_extrairPeso_(transp),
    valorTotal: icmsTot ? XML_numero_(icmsTot.getChildText('vNF', ns)) : 0,
    condicaoPagamento: XML_extrairCondicaoPagamento_(infNFe.getChild('infAdic', ns)),
    cnpjTransportadora: transportadora.cnpj,
    nomeTransportadora: transportadora.nome,
    itens: XML_extrairItens_(infNFe)
  };
}

/**
 * XML_extrairItens_ - Itens da nota (det/prod)
 * A quantidade conferida no carregamento é a tributável (qTrib) e o código
 * lido é o cEANTrib. "SEM GTIN" vira item sem código (confirmado com toque).
 * @returns {Array} [{nItem, codigoProduto, descricao, ean, eanTrib, codigoBarras,
 *                    unidadeCom, qtdCom, unidadeTrib, qtdTrib, qtdEsperada}]
 */
function XML_extrairItens_(infNFe) {
  const ns = nfeNamespace_();
  return infNFe.getChildren('det', ns).map(function(det, i) {
    const prod = det.getChild('prod', ns);
    const atributo = det.getAttribute('nItem');
    const texto = function(tag) { return prod ? String(prod.getChildText(tag, ns) || '').trim() : ''; };
    const qtdTrib = XML_numero_(texto('qTrib'));

    return {
      nItem: atributo ? parseInt(atributo.getValue(), 10) : i + 1,
      codigoProduto: texto('cProd'),
      descricao: texto('xProd'),
      ean: texto('cEAN'),
      eanTrib: texto('cEANTrib'),
      codigoBarras: normalizarCodigoBarras_(texto('cEANTrib')),
      unidadeCom: texto('uCom'),
      qtdCom: XML_numero_(texto('qCom')),
      unidadeTrib: texto('uTrib'),
      qtdTrib: qtdTrib,
      qtdEsperada: qtdTrib
    };
  });
}

/**
 * XML_extrairDadosDestinatario_ - Nome, documento e endereço do destinatário
 */
function XML_extrairDadosDestinatario_(dest) {
  const ns = nfeNamespace_();
  const ender = dest.getChild('enderDest', ns);
  const texto = function(tag, padrao) {
    return ender ? (ender.getChildText(tag, ns) || padrao) : padrao;
  };

  return {
    nome: dest.getChildText('xNome', ns) || 'Destinatário não informado',
    documento: dest.getChildText('CNPJ', ns) || dest.getChildText('CPF', ns) || '',
    logradouro: texto('xLgr', ''),
    numero: texto('nro', 'S/N'),
    bairro: texto('xBairro', ''),
    cidade: texto('xMun', ''),
    uf: texto('UF', ''),
    cep: texto('CEP', '')
  };
}

/**
 * XML_extrairPeso_ - Soma o peso bruto (ou líquido) de todos os volumes, em kg
 */
function XML_extrairPeso_(transp) {
  if (!transp) return 0;
  const ns = nfeNamespace_();

  return transp.getChildren('vol', ns).reduce(function(total, vol) {
    const peso = vol.getChildText('pesoB', ns) || vol.getChildText('pesoL', ns);
    return total + (peso ? XML_numero_(peso) : 0);
  }, 0);
}

/**
 * XML_extrairTransportadora_ - CNPJ e nome da transportadora
 */
function XML_extrairTransportadora_(transp) {
  const ns = nfeNamespace_();
  const transporta = transp ? transp.getChild('transporta', ns) : null;
  if (!transporta) return { cnpj: '', nome: '' };

  return {
    cnpj: transporta.getChildText('CNPJ', ns) || transporta.getChildText('CPF', ns) || '',
    nome: transporta.getChildText('xNome', ns) || ''
  };
}

/**
 * XML_extrairCondicaoPagamento_ - Texto após "Condicao de pagamento:" em infCpl
 * Exemplo: "...Condicao de pagamento: A VISTA|Observacao..." → "A VISTA"
 */
function XML_extrairCondicaoPagamento_(infAdic) {
  if (!infAdic) return '';
  const infCpl = infAdic.getChildText('infCpl', nfeNamespace_());
  if (!infCpl) return '';

  const match = infCpl.match(/Condi[cç][aã]o de pagamento:\s*([^|]+)/i);
  return match && match[1] ? match[1].trim() : '';
}

/**
 * XML_validarEstruturaNFe_ - Confere se o texto é uma NF-e com destinatário
 * @param {String} xmlTexto
 * @returns {Boolean}
 */
function XML_validarEstruturaNFe_(xmlTexto) {
  try {
    const infNFe = XML_obterInfNFe_(XmlService.parse(xmlTexto).getRootElement());
    return !!(infNFe && infNFe.getChild('ide', nfeNamespace_()) && infNFe.getChild('dest', nfeNamespace_()));
  } catch (erro) {
    return false;
  }
}
