'use strict';

/**
 * ACELERA TIME — Bot WhatsApp
 * Stack: Baileys (WhatsApp Web) + Firebase Admin (Firestore) + node-cron
 * Hospedagem: Railway (gratuito)
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const admin    = require('firebase-admin');
const cron     = require('node-cron');
const express  = require('express');
const pino     = require('pino');
const QRCode   = require('qrcode-terminal');

// ─────────────────────────────────────────────────────────────────────────────
// Firebase Setup
// ─────────────────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db     = admin.firestore();
const FS_DOC = 'aceleratime/state'; // mesmo documento usado pelo sistema web

// ─────────────────────────────────────────────────────────────────────────────
// Configurações (variáveis de ambiente no Railway)
// ─────────────────────────────────────────────────────────────────────────────
const GESTOR_NUMBER = (process.env.GESTOR_NUMBER || '').replace(/\D/g, '');
const GESTOR_JID    = GESTOR_NUMBER ? `${GESTOR_NUMBER}@s.whatsapp.net` : '';
const GROUP_JID     = process.env.GROUP_ID || ''; // ex: 120363xxxx@g.us
const AUTH_DIR      = process.env.AUTH_DIR || './auth_info';
const PORT          = process.env.PORT || 3000;
const TIMEZONE      = process.env.TIMEZONE || 'America/Recife';

// Números autorizados a usar comandos além do gestor (separados por vírgula)
const AUTHORIZED_NUMBERS = (process.env.AUTHORIZED_NUMBERS || '')
  .split(',').map(n => n.replace(/\D/g, '').trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// Express — Health Check
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.get('/', (_, res) => res.json({
  status: 'ok',
  bot: 'ACELERA TIME Bot',
  uptime: `${Math.floor(process.uptime())}s`,
  connected: !!sock?.user,
}));
app.listen(PORT, () => console.log(`✅ Health check rodando na porta ${PORT}`));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const pad     = n => n < 10 ? '0' + n : String(n);
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
};
const fmtDate = s => {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
};
const fmtNow = () => {
  const n = new Date();
  return `${pad(n.getHours())}:${pad(n.getMinutes())}`;
};

async function getState() {
  try {
    const snap = await db.doc(FS_DOC).get();
    if (!snap.exists) return {};
    return JSON.parse(snap.data().data || '{}');
  } catch (e) {
    console.error('Erro ao ler Firestore:', e.message);
    return {};
  }
}

function isAuthorizedJid(jid) {
  if (!jid) return false;
  if (jid === GESTOR_JID) return true;
  if (GROUP_JID && jid === GROUP_JID) return true;
  const num = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
  return AUTHORIZED_NUMBERS.includes(num);
}

// ─────────────────────────────────────────────────────────────────────────────
// Geradores de Relatório
// ─────────────────────────────────────────────────────────────────────────────
function buildResumo(STATE) {
  const pedidos   = STATE.pedidos || [];
  const estoque   = STATE.estoque || [];
  const embarques = STATE.embarques || [];
  const coletas   = STATE.coletas || [];
  const hoje      = todayStr();

  const emProd    = pedidos.filter(p => p.status === 'em_producao').length;
  const prontos   = pedidos.filter(p => p.status === 'pronto').length;
  const novos     = pedidos.filter(p => p.status === 'novo').length;
  const atrasados = pedidos.filter(p =>
    p.prazo < hoje && !['expedido','cancelado'].includes(p.status)
  ).length;
  const urgentes  = pedidos.filter(p =>
    p.prioridade === 'urgente' && !['expedido','cancelado'].includes(p.status)
  ).length;

  const estBaixo  = estoque.filter(e =>
    (e.quantidade_atual || 0) <= (e.estoque_minimo || 0)
  ).length;

  const embHoje   = embarques.filter(e => e.data_embarque === hoje).length;
  const embBloq   = embarques.filter(e => e.status === 'bloqueado').length;
  const embRota   = embarques.filter(e => e.status === 'em_rota').length;

  const colHoje   = coletas.filter(c => c.data_coleta === hoje).length;
  const colProb   = coletas.filter(c => c.status === 'problema').length;

  return (
    `⚡ *ACELERA TIME — Status Geral*\n` +
    `📅 ${fmtDate(hoje)} às ${fmtNow()}\n\n` +
    `*📦 PRODUÇÃO*\n` +
    `🆕 Novos pedidos: *${novos}*\n` +
    `⚙️ Em produção: *${emProd}*\n` +
    `✅ Prontos p/ embarque: *${prontos}*\n` +
    (urgentes  ? `🔴 Urgentes: *${urgentes}*\n` : '') +
    (atrasados ? `⚠️ Atrasados: *${atrasados}*\n` : '') +
    `\n*🏭 ESTOQUE*\n` +
    (estBaixo ? `🔴 Itens abaixo do mínimo: *${estBaixo}*` : `✅ Todos os itens OK`) +
    `\n\n*🚚 EMBARQUES HOJE*\n` +
    `📅 Agendados: *${embHoje}* | 🚛 Em rota: *${embRota}*\n` +
    (embBloq ? `🚫 Bloqueados: *${embBloq}*\n` : '') +
    `\n*📥 COLETAS HOJE*\n` +
    `📅 Agendadas: *${colHoje}*` +
    (colProb ? ` | ⚠️ Com problema: *${colProb}*` : '')
  );
}

function buildProducao(STATE) {
  const pedidos = STATE.pedidos || [];
  const hoje    = todayStr();
  const ativos  = pedidos
    .filter(p => !['expedido','cancelado'].includes(p.status))
    .sort((a, b) => {
      if (a.prioridade === 'urgente' && b.prioridade !== 'urgente') return -1;
      if (b.prioridade === 'urgente' && a.prioridade !== 'urgente') return 1;
      return (a.prazo || '').localeCompare(b.prazo || '');
    });

  if (ativos.length === 0) return '✅ Nenhum pedido em aberto no momento.';

  const STATUS_ICONS = {
    novo: '🆕',
    em_producao: '⚙️',
    pronto: '✅ Pronto',
    expedido: '📦 Expedido',
  };

  const lines = ativos.slice(0, 12).map(p => {
    const vencido = p.prazo < hoje ? ' ⚠️ *VENCIDO*' : (p.prazo === hoje ? ' 🎯 HOJE' : '');
    const urgente = p.prioridade === 'urgente' ? '🔴 ' : '';
    const st      = STATUS_ICONS[p.status] || p.status;
    return `*${urgente}${p.numero}*${vencido}\n` +
           `  ${st} | ${p.produto} × ${p.quantidade}\n` +
           `  👤 ${p.cliente} | 🏢 ${p.unidade || '—'} | 📅 ${fmtDate(p.prazo)}`;
  });

  return `⚙️ *PRODUÇÃO — ${fmtDate(hoje)}*\n\n` +
    lines.join('\n\n') +
    (ativos.length > 12 ? `\n\n_...e mais ${ativos.length - 12} pedido(s)_` : '');
}

function buildEstoque(STATE) {
  const estoque = STATE.estoque || [];
  const baixo   = estoque.filter(e => (e.quantidade_atual || 0) <= (e.estoque_minimo || 0));
  const ok      = estoque.filter(e => (e.quantidade_atual || 0) > (e.estoque_minimo || 0));

  if (baixo.length === 0) return `✅ *ESTOQUE OK!*\n${ok.length} ite${ok.length === 1 ? 'm' : 'ns'} acima do mínimo.`;

  return (
    `🏭 *ESTOQUE — Alertas*\n\n` +
    baixo.map(e =>
      `🔴 *${e.nome}*\n` +
      `  Atual: ${e.quantidade_atual || 0} ${e.unidade_medida || 'un'} | ` +
      `Mínimo: ${e.estoque_minimo || 0}`
    ).join('\n\n') +
    `\n\n_Total OK: ${ok.length} iten(s)_`
  );
}

function buildEmbarques(STATE) {
  const embarques = STATE.embarques || [];
  const hoje      = todayStr();
  const ativos    = embarques
    .filter(e => e.data_embarque >= hoje && e.status !== 'entregue')
    .sort((a, b) => (a.data_embarque || '').localeCompare(b.data_embarque || ''));

  if (ativos.length === 0) return '✅ Nenhum embarque pendente.';

  const ST = {
    agendado: '📅',
    em_rota:  '🚛 Em rota',
    bloqueado:'🚫 *BLOQUEADO*',
    entregue: '✅',
  };

  return (
    `🚚 *EMBARQUES PENDENTES*\n\n` +
    ativos.slice(0, 10).map(e =>
      `*${e.numero_nf || e.numero || e.id}* ${ST[e.status] || e.status}\n` +
      `  👤 ${e.cliente || '—'} | 📅 ${fmtDate(e.data_embarque)}\n` +
      `  📍 ${e.destino || e.unidade || '—'}`
    ).join('\n\n') +
    (ativos.length > 10 ? `\n\n_...e mais ${ativos.length - 10}_` : '')
  );
}

function buildColetas(STATE) {
  const coletas = STATE.coletas || [];
  const hoje    = todayStr();
  const ativas  = coletas
    .filter(c => c.data_coleta >= hoje && c.status !== 'coletado')
    .sort((a, b) => (a.data_coleta || '').localeCompare(b.data_coleta || ''));

  if (ativas.length === 0) return '✅ Nenhuma coleta pendente.';

  const ST = {
    agendado:  '📅',
    andamento: '🔄 Em andamento',
    problema:  '⚠️ *PROBLEMA*',
    coletado:  '✅',
  };

  return (
    `📥 *COLETAS PENDENTES*\n\n` +
    ativas.slice(0, 10).map(c =>
      `*${c.numero || c.id}* ${ST[c.status] || c.status}\n` +
      `  🏭 ${c.fornecedor || c.origem || '—'} | 📅 ${fmtDate(c.data_coleta)}`
    ).join('\n\n') +
    (ativas.length > 10 ? `\n\n_...e mais ${ativas.length - 10}_` : '')
  );
}

function buildRelatorioCompleto(STATE) {
  return (
    buildResumo(STATE) +
    '\n\n━━━━━━━━━━━━━━━━━━━━\n\n' +
    buildProducao(STATE) +
    '\n\n━━━━━━━━━━━━━━━━━━━━\n\n' +
    buildEstoque(STATE) +
    '\n\n━━━━━━━━━━━━━━━━━━━━\n\n' +
    buildEmbarques(STATE) +
    '\n\n━━━━━━━━━━━━━━━━━━━━\n\n' +
    buildColetas(STATE)
  );
}

function buildAjuda() {
  return (
    `⚡ *ACELERA TIME Bot*\n\n` +
    `*Comandos disponíveis:*\n\n` +
    `▪ *status* — resumo geral do sistema\n` +
    `▪ *produção* — pedidos ativos\n` +
    `▪ *estoque* — alertas de estoque baixo\n` +
    `▪ *embarques* — embarques pendentes\n` +
    `▪ *coletas* — coletas pendentes\n` +
    `▪ *relatório* — relatório completo\n` +
    `▪ *ajuda* — esta mensagem\n\n` +
    `*📅 Automático:*\n` +
    `• Relatório diário: 7h e 18h\n` +
    `• Relatório semanal: segunda 8h\n` +
    `• Alertas em tempo real a cada 5 min`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Alertas em Tempo Real
// ─────────────────────────────────────────────────────────────────────────────
const sentAlerts = new Set(); // evita repetir o mesmo alerta

async function checkAndSendAlerts() {
  if (!sock?.user) return;
  try {
    const STATE   = await getState();
    const pedidos  = STATE.pedidos || [];
    const estoque  = STATE.estoque || [];
    const embarques= STATE.embarques || [];
    const hoje     = todayStr();

    const sendAlert = async (key, msg) => {
      if (sentAlerts.has(key)) return;
      sentAlerts.add(key);
      if (GESTOR_JID) await sock.sendMessage(GESTOR_JID, { text: `🚨 *ALERTA ACELERA TIME*\n\n${msg}` });
      await sleep(600);
    };

    // Pedidos atrasados
    for (const p of pedidos) {
      if (p.prazo < hoje && !['expedido','cancelado'].includes(p.status)) {
        await sendAlert(
          `atrasado_${p.id}_${hoje}`,
          `⚠️ *PEDIDO ATRASADO*\n${p.numero} — ${p.cliente}\nProduto: ${p.produto} × ${p.quantidade}\nPrazo era: ${fmtDate(p.prazo)}\nStatus atual: ${p.status}`
        );
      }
    }

    // Pedidos urgentes novos
    for (const p of pedidos) {
      if (p.prioridade === 'urgente' && p.status === 'novo') {
        await sendAlert(
          `urgente_${p.id}`,
          `🔴 *PEDIDO URGENTE*\n${p.numero} — ${p.cliente}\nProduto: ${p.produto} × ${p.quantidade}\nPrazo: ${fmtDate(p.prazo)}`
        );
      }
    }

    // Estoque crítico
    for (const e of estoque) {
      if ((e.quantidade_atual || 0) <= (e.estoque_minimo || 0)) {
        await sendAlert(
          `estoque_${e.id}_${hoje}`,
          `🔴 *ESTOQUE CRÍTICO*\n${e.nome}\nAtual: ${e.quantidade_atual || 0} ${e.unidade_medida || 'un'}\nMínimo: ${e.estoque_minimo || 0}\nRequer reposição urgente!`
        );
      }
    }

    // Embarques bloqueados
    for (const e of embarques) {
      if (e.status === 'bloqueado') {
        await sendAlert(
          `embarque_bloq_${e.id}`,
          `🚫 *EMBARQUE BLOQUEADO*\nNF/Ref: ${e.numero_nf || e.numero || e.id}\nCliente: ${e.cliente || '—'}\nData prevista: ${fmtDate(e.data_embarque)}\nVerificar urgente!`
        );
      }
    }

    // Limpar alertas do dia anterior para permitir reenvio no dia seguinte
    // (Remove keys com datas de ontem)
    const ontem = (() => {
      const d = new Date(); d.setDate(d.getDate() - 1);
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    })();
    for (const key of sentAlerts) {
      if (key.includes(ontem)) sentAlerts.delete(key);
    }
  } catch (err) {
    console.error('Erro nos alertas:', err.message);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Processar Comandos
// ─────────────────────────────────────────────────────────────────────────────
async function handleCommand(text, jid, msg) {
  const t = text.toLowerCase().trim();
  let STATE;

  if (t === 'ajuda' || t === 'help' || t === '?') {
    return buildAjuda();
  }

  if (t.includes('status') || t.includes('resumo') || t === 'oi' || t === 'olá') {
    STATE = await getState();
    return buildResumo(STATE);
  }

  if (t.includes('produção') || t.includes('producao') || t === 'prod') {
    STATE = await getState();
    return buildProducao(STATE);
  }

  if (t.includes('estoque') || t.includes('stock')) {
    STATE = await getState();
    return buildEstoque(STATE);
  }

  if (t.includes('embarque')) {
    STATE = await getState();
    return buildEmbarques(STATE);
  }

  if (t.includes('coleta')) {
    STATE = await getState();
    return buildColetas(STATE);
  }

  if (t.includes('relat') || t.includes('completo') || t.includes('tudo')) {
    STATE = await getState();
    return buildRelatorioCompleto(STATE);
  }

  return null; // comando não reconhecido
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron Jobs — Relatórios Agendados
// ─────────────────────────────────────────────────────────────────────────────
function setupCronJobs() {
  const sendToAll = async (msg) => {
    if (!sock?.user) return;
    if (GROUP_JID)  await sock.sendMessage(GROUP_JID,  { text: msg }).catch(console.error);
    if (GESTOR_JID) await sock.sendMessage(GESTOR_JID, { text: msg }).catch(console.error);
  };

  // Relatório matinal — 7h (seg–sáb)
  cron.schedule('0 7 * * 1-6', async () => {
    console.log('⏰ Cron: relatório matinal 7h');
    const STATE = await getState();
    await sendToAll('🌅 *BOM DIA! — Relatório Matinal*\n\n' + buildResumo(STATE));
  }, { timezone: TIMEZONE });

  // Relatório final — 18h (seg–sáb)
  cron.schedule('0 18 * * 1-6', async () => {
    console.log('⏰ Cron: relatório final 18h');
    const STATE = await getState();
    await sendToAll('🌆 *Relatório Final do Dia*\n\n' + buildResumo(STATE));
  }, { timezone: TIMEZONE });

  // Relatório semanal — Segunda 8h
  cron.schedule('0 8 * * 1', async () => {
    console.log('⏰ Cron: relatório semanal');
    const STATE = await getState();
    await sendToAll(
      '📋 *RELATÓRIO SEMANAL — ACELERA TIME*\n' +
      `Semana de ${fmtDate(todayStr())}\n\n` +
      buildRelatorioCompleto(STATE)
    );
  }, { timezone: TIMEZONE });

  console.log(`✅ Cron jobs ativos (fuso: ${TIMEZONE}): 7h, 18h e segunda 8h`);
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Connection
// ─────────────────────────────────────────────────────────────────────────────
let sock;
let alertInterval;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth:               state,
    logger:             pino({ level: 'silent' }),
    printQRInTerminal:  true,
    browser:            ['ACELERA TIME Bot', 'Chrome', '120.0'],
    connectTimeoutMs:   60_000,
    defaultQueryTimeoutMs: 60_000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 ────────────────────────────────────────────');
      console.log('   Escaneie o QR Code com o WhatsApp do número BOT');
      console.log('────────────────────────────────────────────────\n');
      QRCode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`🔴 Conexão encerrada (código ${statusCode}). Reconectar: ${shouldReconnect}`);
      if (alertInterval) clearInterval(alertInterval);
      if (shouldReconnect) {
        await sleep(4000);
        connectToWhatsApp();
      } else {
        console.log('❌ Sessão encerrada pelo usuário. Delete a pasta auth_info e reinicie.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      console.log('✅ Bot conectado! Número:', sock.user?.id);
      setupCronJobs();
      // Verifica alertas a cada 5 minutos
      alertInterval = setInterval(checkAndSendAlerts, 5 * 60 * 1000);
      // Primeira verificação imediata
      setTimeout(checkAndSendAlerts, 10_000);
    }
  });

  // Handler de mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const jid  = msg.key.remoteJid;
      if (!isAuthorizedJid(jid)) continue;

      const text = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        ''
      ).trim();

      if (!text) continue;

      console.log(`💬 Mensagem de ${jid}: "${text}"`);

      const reply = await handleCommand(text, jid, msg);
      if (reply) {
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
console.log('🚀 Iniciando ACELERA TIME Bot...');
console.log(`   Gestor: ${GESTOR_JID || '(não configurado)'}`);
console.log(`   Grupo:  ${GROUP_JID  || '(não configurado)'}`);
console.log(`   Fuso:   ${TIMEZONE}`);

connectToWhatsApp().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
