// api/estoque.js
// Agrupa: salvar-solicitacao, salvar-entrada, salvar-saida-direta,
// buscar-registros, processar-validacao-base.
// Uso: POST /api/estoque  { action: 'salvar-entrada', ... }

const { getDb } = require('../lib/db');
const { proximoSequencial, incrementarSequencial } = require('../lib/sequencial');
const { ultimoPrecoItem } = require('../lib/ultimoPreco');
const { enviarEmail } = require('../lib/email');

const EMAIL_ENGENHARIA = process.env.EMAIL_ENGENHARIA || '';
const MESES_EXT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function formatarDataBR(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function normalizar(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function enviarEmailSolicitacao(db, pedidoId, data, setor, solicitante, itens) {
  const { data: usuarios } = await db.from('usuarios').select('email').ilike('nome', solicitante).limit(1);
  const emailDest = usuarios && usuarios.length ? usuarios[0].email || '' : '';
  if (!emailDest) return;

  const linhasHtml = itens.map((it) =>
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;">${it.item}</td>` +
    `<td style="padding:6px 10px;border:1px solid #ddd;">${it.cat}</td>` +
    `<td style="padding:6px 10px;border:1px solid #ddd;text-align:center;">${it.qtd}</td></tr>`
  ).join('');

  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#006633;padding:18px 20px;border-radius:8px 8px 0 0;">
      <h2 style="color:#F5C800;margin:0;">DTEL — Confirmação de Solicitação</h2></div>
    <div style="background:#f9f9f9;padding:20px;border:1px solid #ddd;border-radius:0 0 8px 8px;">
      <p>Olá, <strong>${solicitante}</strong>! Sua solicitação foi recebida e está em análise.</p>
      <table style="width:100%;border-collapse:collapse;margin:12px 0;">
        <tr style="background:#003D1F;color:#fff;"><th style="padding:8px 10px;text-align:left;">Pedido</th>
        <th style="padding:8px 10px;text-align:left;">${pedidoId}</th>
        <th style="padding:8px 10px;text-align:left;">Data</th>
        <th style="padding:8px 10px;text-align:left;">${formatarDataBR(data)}</th></tr>
        <tr style="background:#f0f0f0;"><th colspan="2" style="padding:8px 10px;text-align:left;">Setor</th>
        <td colspan="2" style="padding:8px 10px;">${setor}</td></tr>
      </table>
      <h4>Itens solicitados:</h4>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#003D1F;color:#fff;"><th style="padding:8px 10px;border:1px solid #005229;">Item</th>
        <th style="padding:8px 10px;border:1px solid #005229;">Categoria</th>
        <th style="padding:8px 10px;border:1px solid #005229;">Qtd</th></tr>
        ${linhasHtml}
      </table>
      <p style="color:#999;font-size:12px;">Você receberá outro e-mail quando o pedido for processado.</p>
    </div></div>`;

  try {
    await enviarEmail({ to: emailDest, cc: EMAIL_ENGENHARIA || undefined, subject: `DTEL — Solicitação ${pedidoId} recebida`, htmlBody: html });
  } catch (e) { console.error('Erro e-mail solicitação:', e.message); }
}

async function enviarEmailValidacao(db, pedidoId, solicitante, itens) {
  const { data: usuarios } = await db.from('usuarios').select('email').ilike('nome', solicitante).limit(1);
  const emailDest = usuarios && usuarios.length ? usuarios[0].email || '' : '';
  if (!emailDest) return;

  const linhasHtml = itens.map((it) => {
    const cor = it.atendido ? '#DCFCE7' : '#FEE2E2';
    const status = it.atendido ? '✓ Atendido' : '✗ Indisponível';
    return `<tr style="background:${cor};"><td style="padding:6px 10px;border:1px solid #ddd;">${it.item}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;text-align:center;">${it.qtdSoli}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;text-align:center;">${it.atendido ? it.qtdDispo : '—'}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;text-align:center;font-weight:bold;">${status}</td></tr>`;
  }).join('');

  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#006633;padding:18px 20px;border-radius:8px 8px 0 0;">
      <h2 style="color:#F5C800;margin:0;">DTEL — Pedido Processado</h2></div>
    <div style="background:#f9f9f9;padding:20px;border:1px solid #ddd;border-radius:0 0 8px 8px;">
      <p>Olá, <strong>${solicitante}</strong>! Seu pedido <strong>${pedidoId}</strong> foi processado.</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#003D1F;color:#fff;"><th style="padding:8px 10px;border:1px solid #005229;">Item</th>
        <th style="padding:8px 10px;border:1px solid #005229;">Qtd Solicitada</th>
        <th style="padding:8px 10px;border:1px solid #005229;">Qtd Disponibilizada</th>
        <th style="padding:8px 10px;border:1px solid #005229;">Status</th></tr>
        ${linhasHtml}
      </table>
    </div></div>`;

  try {
    await enviarEmail({ to: emailDest, cc: EMAIL_ENGENHARIA || undefined, subject: `DTEL — Pedido ${pedidoId} processado`, htmlBody: html });
  } catch (e) { console.error('Erro e-mail validação:', e.message); }
}

async function acaoSalvarSolicitacao(db, body) {
  const { pedidoId, data, setor, solicitante, itens } = body;
  if (!pedidoId || !data || !setor || !solicitante || !Array.isArray(itens) || !itens.length) {
    return { status: 400, json: { ok: false, erro: 'Dados incompletos.' } };
  }

  const linhas = itens.map((it) => ({
    pedido_id: pedidoId, data, item: it.item, categoria: it.cat,
    qtd_soli: parseInt(it.qtd) || 0, qtd_dispo: parseInt(it.qtd) || 0,
    setor, solicitante, responsavel: '', disponivel: false,
  }));

  const { data: inseridos, error } = await db.from('pendentes').insert(linhas).select('id');
  if (error) throw error;

  await incrementarSequencial();
  await enviarEmailSolicitacao(db, pedidoId, data, setor, solicitante, itens);

  return { status: 200, json: { ok: true, total: itens.length, ids: (inseridos || []).map((r) => r.id) } };
}

async function acaoSalvarEntrada(db, body) {
  const { data, nf, setor, responsavel, just, itens } = body;
  if (!data || !setor || !responsavel || !Array.isArray(itens) || !itens.length) {
    return { status: 400, json: { ok: false, erro: 'Dados incompletos.' } };
  }

  const pedidoId = await proximoSequencial();

  const { data: produtos, error: prodErr } = await db.from('produtos').select('id,nome,saldo');
  if (prodErr) throw prodErr;
  const prodMap = {};
  (produtos || []).forEach((p) => { prodMap[p.nome.toLowerCase()] = p; });

  const linhasRegistro = [];
  for (const it of itens) {
    const qtd = parseInt(it.qtd) || 0;
    linhasRegistro.push({
      pedido: pedidoId, data, nf: nf || '', item: it.item, categoria: it.cat,
      qtd_soli: qtd, qtd_dispo: qtd, preco: parseFloat(it.preco) || 0,
      setor, solicitante: just || responsavel, responsavel,
      tipo: 'Entrada', justificativa: just || 'Entrada de estoque',
    });

    const chave = String(it.item).toLowerCase();
    if (prodMap[chave]) {
      const novoSaldo = (parseInt(prodMap[chave].saldo) || 0) + qtd;
      await db.from('produtos').update({ saldo: novoSaldo }).eq('id', prodMap[chave].id);
      prodMap[chave].saldo = novoSaldo;
    } else {
      const { data: novo } = await db.from('produtos').insert({ nome: it.item, categoria: it.cat, saldo: qtd }).select('id,nome,saldo').limit(1);
      if (novo && novo.length) prodMap[chave] = novo[0];
    }
  }

  const { error: regErr } = await db.from('registros').insert(linhasRegistro);
  if (regErr) throw regErr;

  return { status: 200, json: { ok: true, total: itens.length, pedido: pedidoId } };
}

async function acaoSalvarSaidaDireta(db, body) {
  const { data, setor, solicitante, itens } = body;
  if (!data || !setor || !solicitante || !Array.isArray(itens) || !itens.length) {
    return { status: 400, json: { ok: false, erro: 'Dados incompletos.' } };
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const pedidoId = '#SAI-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + pad(now.getHours()) + pad(now.getMinutes());

  const { data: produtos, error: prodErr } = await db.from('produtos').select('id,nome,saldo');
  if (prodErr) throw prodErr;
  const prodMap = {};
  (produtos || []).forEach((p) => { prodMap[p.nome.toLowerCase()] = p; });

  const linhasRegistro = [];
  for (const it of itens) {
    const qtd = parseInt(it.qtd) || 0;
    const ultimoPreco = await ultimoPrecoItem(it.item);

    linhasRegistro.push({
      pedido: pedidoId, data, nf: '', item: it.item, categoria: it.cat,
      qtd_soli: qtd, qtd_dispo: qtd, preco: ultimoPreco,
      setor, solicitante, responsavel: solicitante,
      tipo: 'Saída', justificativa: 'Saída direta / baixa emergencial',
    });

    const chave = String(it.item).toLowerCase();
    if (prodMap[chave]) {
      const novoSaldo = Math.max(0, (parseInt(prodMap[chave].saldo) || 0) - qtd);
      await db.from('produtos').update({ saldo: novoSaldo }).eq('id', prodMap[chave].id);
      prodMap[chave].saldo = novoSaldo;
    }
  }

  const { error: regErr } = await db.from('registros').insert(linhasRegistro);
  if (regErr) throw regErr;

  return { status: 200, json: { ok: true, total: itens.length, pedido: pedidoId } };
}

async function acaoBuscarRegistros(db, body) {
  const { setor, mes, ano, tipo } = body;

  // Busca paginada: o Supabase/PostgREST limita cada resposta a, no máximo,
  // 1000 linhas por padrão. Sem paginar com .range(), combinações de filtro
  // que retornem mais que isso ficam truncadas silenciosamente.
  const PAGE_SIZE = 1000;
  let rows = [];
  let from = 0;
  while (true) {
    let query = db.from('registros').select('*');
    if (setor) query = query.ilike('setor', setor);
    if (ano) query = query.gte('data', `${ano}-01-01`).lte('data', `${ano}-12-31`);
    if (tipo && tipo !== 'todos') query = query.ilike('tipo', normalizar(tipo) === 'saida' ? 'Sa%da' : tipo);

    const { data: page, error } = await query
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;

    rows = rows.concat(page || []);
    if (!page || page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  let resultado = (rows || []).map((r) => {
    const dt = r.data ? new Date(r.data) : null;
    const valid = dt && !isNaN(dt.getTime());
    const mesNum = valid ? String(dt.getUTCMonth() + 1).padStart(2, '0') : '';
    const mesExt = valid ? MESES_EXT[dt.getUTCMonth()] : '';
    const anoStr = valid ? String(dt.getUTCFullYear()) : '';
    let tipoNorm = String(r.tipo || '').trim();
    const tipoLow = normalizar(tipoNorm);
    if (tipoLow === 'saida') tipoNorm = 'Saída';
    if (tipoLow === 'entrada') tipoNorm = 'Entrada';
    return {
      pedido: r.pedido || '', data: r.data || '', mes: mesExt, mesNum, ano: anoStr,
      nf: r.nf || '', item: r.item || '', cat: r.categoria || '',
      qtdSoli: r.qtd_soli || 0, qtdDispo: r.qtd_dispo || 0, preco: r.preco || 0,
      setor: r.setor || '', solicitante: r.solicitante || '', responsavel: r.responsavel || '',
      tipo: tipoNorm, justificativa: r.justificativa || '',
    };
  });

  if (mes) resultado = resultado.filter((r) => r.mesNum === mes);

  return { status: 200, json: resultado };
}

async function acaoProcessarValidacaoBase(db, body) {
  const { itensPendentes } = body;
  if (!Array.isArray(itensPendentes) || !itensPendentes.length) {
    return { status: 400, json: { ok: false, erro: 'Nenhum item para processar.' } };
  }

  const { data: produtos, error: prodErr } = await db.from('produtos').select('id,nome,saldo');
  if (prodErr) throw prodErr;
  const prodMap = {};
  (produtos || []).forEach((p) => { prodMap[p.nome.toLowerCase()] = p; });

  let processados = 0;
  const agrupado = {};
  const linhasRegistro = [];

  for (const it of itensPendentes) {
    const pedidoId = String(it.pedido || '');
    const qtdSoliInt = parseInt(it.qtd) || 0;
    const disponivel = it.disponivel === true || it.disponivel === 'SIM' || it.disponivel === 'true';

    if (disponivel) {
      const qtdDispo = parseInt(it.qtdDispo) || qtdSoliInt || 0;
      const ultimoPreco = await ultimoPrecoItem(it.item);

      linhasRegistro.push({
        pedido: pedidoId, data: it.data, nf: '', item: it.item, categoria: it.cat,
        qtd_soli: qtdSoliInt, qtd_dispo: qtdDispo, preco: ultimoPreco,
        setor: it.setor, solicitante: it.solicitante, responsavel: it.responsavel,
        tipo: 'Saída', justificativa: 'Validado via Base de Solicitação',
      });

      const chave = String(it.item).toLowerCase();
      if (prodMap[chave]) {
        const novoSaldo = Math.max(0, (parseInt(prodMap[chave].saldo) || 0) - qtdDispo);
        await db.from('produtos').update({ saldo: novoSaldo }).eq('id', prodMap[chave].id);
        prodMap[chave].saldo = novoSaldo;
      }
      processados++;
    } else {
      linhasRegistro.push({
        pedido: pedidoId, data: it.data, nf: '', item: it.item, categoria: it.cat,
        qtd_soli: qtdSoliInt, qtd_dispo: 0, preco: 0,
        setor: it.setor, solicitante: it.solicitante, responsavel: it.responsavel,
        tipo: 'Saída', justificativa: 'Solicitar Pedidos de compra',
      });
      processados++;
    }

    if (!agrupado[pedidoId]) agrupado[pedidoId] = { solicitante: it.solicitante, itens: [] };
    agrupado[pedidoId].itens.push({
      item: it.item, qtdSoli: it.qtd,
      qtdDispo: disponivel ? parseInt(it.qtdDispo) || 0 : 0, atendido: disponivel,
    });
  }

  const { error: regErr } = await db.from('registros').insert(linhasRegistro);
  if (regErr) throw regErr;

  // Remove da tabela "pendentes" apenas os itens que foram de fato processados
  // agora (identificados pelo id), preservando os demais itens ainda pendentes.
  const idsProcessados = itensPendentes.map((it) => it.id).filter((id) => id !== undefined && id !== null);
  if (idsProcessados.length) {
    const { error: delErr } = await db.from('pendentes').delete().in('id', idsProcessados);
    if (delErr) throw delErr;
  }

  for (const [pedidoId, dados] of Object.entries(agrupado)) {
    await enviarEmailValidacao(db, pedidoId, dados.solicitante, dados.itens);
  }

  return { status: 200, json: { ok: true, processados } };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, erro: 'Método não permitido.' });

  try {
    const body = req.body || {};
    const db = getDb();
    let resultado;

    switch (body.action) {
      case 'salvar-solicitacao': resultado = await acaoSalvarSolicitacao(db, body); break;
      case 'salvar-entrada': resultado = await acaoSalvarEntrada(db, body); break;
      case 'salvar-saida-direta': resultado = await acaoSalvarSaidaDireta(db, body); break;
      case 'buscar-registros': resultado = await acaoBuscarRegistros(db, body); break;
      case 'processar-validacao-base': resultado = await acaoProcessarValidacaoBase(db, body); break;
      default: return res.status(400).json({ ok: false, erro: 'Ação inválida: ' + body.action });
    }

    return res.status(resultado.status).json(resultado.json);
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message });
  }
};
