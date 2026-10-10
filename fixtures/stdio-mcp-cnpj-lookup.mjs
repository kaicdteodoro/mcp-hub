#!/usr/bin/env node
import readline from 'node:readline';

const BRASILAPI_TIMEOUT_MS = parseInt(process.env.BRASILAPI_TIMEOUT_MS ?? '8000', 10);

function writeResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function writeToolResult(id, text) {
  writeResponse(id, { content: [{ type: 'text', text }] });
}

function sanitizeCnpj(raw) {
  return String(raw).replace(/\D/g, '');
}

const TOOLS = [
  {
    name: 'consultarCnpj',
    description:
      'Consulta dados cadastrais de uma empresa brasileira pelo CNPJ via BrasilAPI. ' +
      'Retorna razão social, nome fantasia, situação cadastral (ativa/baixada/suspensa), ' +
      'CNAE principal e secundários, endereço completo, contato e quadro societário.',
    inputSchema: {
      type: 'object',
      properties: {
        cnpj: {
          type: 'string',
          description:
            'CNPJ da empresa, com ou sem formatação ' +
            '(ex: "12.345.678/0001-90" ou "12345678000190")'
        }
      },
      required: ['cnpj']
    }
  }
];

async function handleConsultarCnpj(id, { cnpj } = {}) {
  if (!cnpj) {
    writeError(id, -32602, 'cnpj é obrigatório');
    return;
  }

  const digits = sanitizeCnpj(cnpj);
  if (digits.length !== 14) {
    writeError(id, -32602, `CNPJ inválido: esperado 14 dígitos, recebido ${digits.length}`);
    return;
  }

  const url = `https://brasilapi.com.br/api/cnpj/v1/${digits}`;
  let res, data;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BRASILAPI_TIMEOUT_MS);
    try {
      res = await fetch(url, { signal: controller.signal });
      data = await res.json();
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    const msg =
      e.name === 'AbortError'
        ? `Timeout após ${BRASILAPI_TIMEOUT_MS}ms ao consultar BrasilAPI`
        : `Erro ao consultar BrasilAPI: ${e.message}`;
    writeError(id, -32000, msg);
    return;
  }

  if (!res.ok) {
    const detail = data?.message ?? JSON.stringify(data);
    writeError(id, -32000, `BrasilAPI retornou ${res.status}: ${detail}`);
    return;
  }

  const result = {
    cnpj: data.cnpj,
    razao_social: data.razao_social,
    nome_fantasia: data.nome_fantasia || null,
    situacao_cadastral: data.descricao_situacao_cadastral,
    codigo_situacao_cadastral: data.situacao_cadastral,
    ativo: data.situacao_cadastral === 2,
    data_abertura: data.data_inicio_atividade,
    cnae_principal: {
      codigo: data.cnae_fiscal,
      descricao: data.cnae_fiscal_descricao
    },
    cnaes_secundarios: (data.cnaes_secundarios ?? []).map(c => ({
      codigo: c.codigo,
      descricao: c.descricao
    })),
    endereco: {
      logradouro: data.logradouro,
      numero: data.numero,
      complemento: data.complemento || null,
      bairro: data.bairro,
      municipio: data.municipio,
      uf: data.uf,
      cep: data.cep
    },
    contato: {
      email: data.email || null,
      telefone: data.ddd_telefone_1 || null
    },
    quadro_societario: (data.qsa ?? []).map(s => ({
      nome: s.nome_socio,
      qualificacao: s.qualificacao_socio
    }))
  };

  writeToolResult(id, JSON.stringify(result, null, 2));
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let req;
  try { req = JSON.parse(trimmed); } catch { continue; }

  const { id, method, params } = req;
  if (id === undefined) continue;

  if (method === 'initialize') {
    writeResponse(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      serverInfo: { name: 'cnpj-lookup', version: '1.0.0' },
      capabilities: { tools: {} }
    });
  } else if (method === 'tools/list') {
    writeResponse(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params ?? {};
    if (name === 'consultarCnpj') {
      await handleConsultarCnpj(id, args);
    } else {
      writeError(id, -32601, `Unknown tool: ${name}`);
    }
  } else {
    writeResponse(id, {});
  }
}
