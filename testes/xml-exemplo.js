/**
 * Monta XMLs de NF-e de exemplo para os testes (estrutura nfeProc real,
 * só com as tags que o sistema lê).
 */

function item(n, p) {
  return '<det nItem="' + n + '"><prod>' +
    '<cProd>' + p.cProd + '</cProd>' +
    '<cEAN>' + (p.cEAN || p.cEANTrib) + '</cEAN>' +
    '<xProd>' + p.xProd + '</xProd>' +
    '<uCom>' + (p.uCom || 'CX') + '</uCom>' +
    '<qCom>' + (p.qCom || p.qTrib) + '</qCom>' +
    '<cEANTrib>' + p.cEANTrib + '</cEANTrib>' +
    '<uTrib>' + (p.uTrib || 'CX') + '</uTrib>' +
    '<qTrib>' + p.qTrib + '</qTrib>' +
    '</prod></det>';
}

function montarXml(nf) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe>' +
    '<infNFe Id="NFe4325' + String(nf.numero).padStart(39, '0') + '" versao="4.00">' +
    '<ide><serie>1</serie><nNF>' + nf.numero + '</nNF><dhEmi>2026-10-20T08:00:00-03:00</dhEmi></ide>' +
    '<dest><CNPJ>' + (nf.docDest || '11222333000181') + '</CNPJ><xNome>' + nf.cliente + '</xNome>' +
    '<enderDest><xLgr>' + nf.rua + '</xLgr><nro>' + nf.nro + '</nro><xBairro>' + nf.bairro + '</xBairro>' +
    '<xMun>' + nf.cidade + '</xMun><UF>RS</UF><CEP>96800000</CEP></enderDest></dest>' +
    nf.itens.map(function(p, i) { return item(i + 1, p); }).join('') +
    '<total><ICMSTot><vNF>' + (nf.valor || '100.00') + '</vNF></ICMSTot></total>' +
    '<transp><transporta><CNPJ>04252011000110</CNPJ><xNome>Transportes Xiru Ltda</xNome></transporta>' +
    '<vol><pesoB>' + (nf.peso || '10.500') + '</pesoB></vol></transp>' +
    '<infAdic><infCpl>Pedido 1|Condicao de pagamento: ' + (nf.pagamento || '28 DIAS') + '|Obs</infCpl></infAdic>' +
    '</infNFe></NFe></nfeProc>';
}

/**
 * Carga de exemplo com casos especiais:
 * - NF 1001: item com GTIN-14 com zero à esquerda e item "SEM GTIN"
 * - NF 1002: mesmo código de barras em dois itens (3 + 2) e quantidade fracionada
 * - NF 1003: item simples, pagamento à vista
 */
const NOTAS = [
  {
    numero: 1001, cliente: 'Mercado Bom Preço', rua: 'Rua Marechal Floriano', nro: '100', bairro: 'Centro', cidade: 'Santa Cruz do Sul',
    itens: [
      { cProd: 'A10', xProd: 'Erva-mate 1kg', cEANTrib: '07891000100103', qTrib: '3.0000' },
      { cProd: 'A20', xProd: 'Cuia de porongo', cEANTrib: 'SEM GTIN', qTrib: '2.0000' }
    ]
  },
  {
    numero: 1002, cliente: 'Armazém do Gaúcho', rua: 'Av. Brasil', nro: '55', bairro: 'Centro', cidade: 'Venâncio Aires',
    itens: [
      { cProd: 'B10', xProd: 'Charque 5kg', cEANTrib: '7891000200206', qTrib: '3' },
      { cProd: 'B10', xProd: 'Charque 5kg (bonificação)', cEANTrib: '7891000200206', qTrib: '2' },
      { cProd: 'B30', xProd: 'Queijo colonial', cEANTrib: '7891000300305', uTrib: 'KG', qTrib: '2.5000' }
    ]
  },
  {
    numero: 1003, cliente: 'Bar do Tchê', rua: 'Rua Júlio de Castilhos', nro: '9', bairro: 'Centro', cidade: 'Venâncio Aires', pagamento: 'A VISTA',
    itens: [
      { cProd: 'C10', xProd: 'Chimarrão pronto', cEANTrib: '7891000400404', qTrib: '1' }
    ]
  }
];

function arquivosBase64(notas) {
  return (notas || NOTAS).map(function(nf) {
    return { nome: 'NF' + nf.numero + '.xml', base64: Buffer.from(montarXml(nf), 'utf8').toString('base64') };
  });
}

module.exports = { montarXml: montarXml, arquivosBase64: arquivosBase64, NOTAS: NOTAS };
