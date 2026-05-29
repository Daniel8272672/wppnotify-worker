import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

const WPPNOTIFY_URL = process.env.WPPNOTIFY_URL;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const SESSION_DIR = process.env.SESSION_DIR || "./session";
const LOG_LEVEL = process.env.LOG_LEVEL || "warn";

if (!WPPNOTIFY_URL || !WORKER_TOKEN) {
  console.error("Defina WPPNOTIFY_URL e WORKER_TOKEN");
  process.exit(1);
}

const WORKER_QR_URL =
  process.env.WORKER_QR_URL || WPPNOTIFY_URL.replace(/\/ingest\/?$/, "/worker-qr");
const WORKER_CONTACTS_URL =
  process.env.WORKER_CONTACTS_URL || WPPNOTIFY_URL.replace(/\/ingest\/?$/, "/worker-contacts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = pino({ level: LOG_LEVEL });

let sock = null;
let reconnecting = false;
let refreshRunning = false;
let connected = false;
let monitoredJids = [];
let monitoredPhonesByJid = new Map();
const lastStatus = new Map();

function toPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function toJid(phoneNumber) {
  const phone = toPhone(phoneNumber);
  return phone ? `${phone}@s.whatsapp.net` : null;
}

function normalizeJid(jid) {
  const value = String(jid || "");
  if (!value) return null;
  if (value.includes("@s.whatsapp.net")) return value;
  if (value.includes("@c.us")) return value.replace("@c.us", "@s.whatsapp.net");
  const phone = toPhone(value.split("@")[0]);
  return phone ? `${phone}@s.whatsapp.net` : null;
}

function jidToPhone(jid) {
  return toPhone(String(jid || "").split("@")[0]);
}

function statusFromPresence(presence) {
  const state = String(presence?.lastKnownPresence || presence?.type || "").toLowerCase();
  if (state === "composing") return "typing";
  if (state === "recording") return "recording";
  if (state === "available" || state === "paused") return "online";
  if (state === "unavailable") return "offline";
  return null;
}

async function reportStatus(status, qr = null) {
  try {
    const res = await fetch(WORKER_QR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-token": WORKER_TOKEN },
      body: JSON.stringify({ status, qr }),
    });
    if (!res.ok) console.error("reportStatus failed", res.status, await res.text());
  } catch (e) {
    console.error("reportStatus error", e.message);
  }
}

async function fetchMonitoredContacts() {
  const res = await fetch(WORKER_CONTACTS_URL, {
    method: "GET",
    headers: { "x-worker-token": WORKER_TOKEN },
  });
  if (!res.ok) throw new Error(`worker-contacts failed ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const rows = Array.isArray(data.contacts) ? data.contacts : [];
  const nextPhonesByJid = new Map();
  const nextJids = [];

  for (const row of rows) {
    const phone = toPhone(row.phone_number);
    const jid = toJid(phone);
    if (!jid) continue;
    nextJids.push(jid);
    nextPhonesByJid.set(jid, phone);
  }

  monitoredPhonesByJid = nextPhonesByJid;
  return [...new Set(nextJids)];
}

async function ingest(phone_number, status, extra = {}) {
  try {
    const res = await fetch(WPPNOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-token": WORKER_TOKEN },
      body: JSON.stringify({
        phone_number,
        status,
        occurred_at: new Date().toISOString(),
        ...extra,
      }),
    });
    if (!res.ok) console.error("ingest failed", res.status, await res.text());
  } catch (e) {
    console.error("ingest error", e.message);
  }
}

async function handlePresence(jidLike, presence, source = "presence.update") {
  const jid = normalizeJid(jidLike);
  if (!jid || !monitoredPhonesByJid.has(jid)) return;

  const status = statusFromPresence(presence);
  if (!status) return;
  if (lastStatus.get(jid) === status) return;

  const phone = monitoredPhonesByJid.get(jid) || jidToPhone(jid);
  const isFirstOffline = !lastStatus.has(jid) && status === "offline";
  lastStatus.set(jid, status);

  console.log(`[${new Date().toISOString()}] ${phone} → ${status} (${source})`);
  if (!isFirstOffline) {
    await ingest(phone, status, {
      metadata: {
        source,
        lastKnownPresence: presence?.lastKnownPresence || null,
        lastSeen: presence?.lastSeen || null,
      },
    });
  }
}

async function subscribeAll(reason = "refresh") {
  if (!sock || !connected || refreshRunning) return;
  refreshRunning = true;

  try {
    monitoredJids = await fetchMonitoredContacts();

    if (!monitoredJids.length) {
      console.log("Nenhum contato com monitoramento ativo foi retornado pelo app.");
      return;
    }

    console.log(
      `Monitorando ${monitoredJids.length} contato(s): ${monitoredJids
        .map((jid) => monitoredPhonesByJid.get(jid) || jidToPhone(jid))
        .join(", ")}`
    );

    let ok = 0;
    const failures = [];
    for (const jid of monitoredJids) {
      try {
        await sock.presenceSubscribe(jid);
        ok += 1;
        await sleep(250);
      } catch (e) {
        failures.push(`${monitoredPhonesByJid.get(jid) || jidToPhone(jid)}:${e.message}`);
      }
    }

    console.log(`Presença assinada para ${ok}/${monitoredJids.length} contatos monitorados (${reason}).`);
    if (failures.length) console.log("  falhas:", failures.join(", "));
  } catch (e) {
    console.error("subscribeAll error", e.message);
  } finally {
    refreshRunning = false;
  }
}

async function startWorker() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (e) {
    console.error("Não consegui buscar a versão mais recente do WhatsApp Web; usando padrão da biblioteca.", e.message);
  }

  sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("WppNotify"),
    logger,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    syncFullHistory: false,
    ...(version ? { version } : {}),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Escaneie o QR Code no WhatsApp:\n");
      qrcode.generate(qr, { small: true });
      console.log("\n➡️  Ou abra Configurações no app WppNotify para escanear direto na tela.\n");
      await reportStatus("qr", qr);
    }

    if (connection === "connecting") {
      console.log("🔐 Autenticando/conectando ao WhatsApp...");
      await reportStatus("connecting");
    }

    if (connection === "open") {
      connected = true;
      reconnecting = false;
      console.log("✅ Worker conectado ao WhatsApp");
      await reportStatus("connected");
      await sleep(1500);
      await subscribeAll("connect");
    }

    if (connection === "close") {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const message = lastDisconnect?.error?.message || "conexão fechada";
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.error(`🔌 Desconectado: ${message} (status ${statusCode || "sem código"})`);
      await reportStatus("disconnected");

      if (!shouldReconnect) {
        console.error("Sessão encerrada pelo WhatsApp. Apague a pasta session no Railway e escaneie um QR novo.");
        return;
      }

      if (!reconnecting) {
        reconnecting = true;
        console.log("Tentando reconectar em 5 segundos...");
        setTimeout(() => startWorker().catch((e) => console.error("reconnect error", e.message)), 5000);
      }
    }
  });

  sock.ev.on("presence.update", async ({ id, presences }) => {
    const entries = Object.entries(presences || {});
    if (!entries.length) return;

    for (const [participantJid, presence] of entries) {
      await handlePresence(participantJid || id, presence, "presence.update");
    }
  });
}

setInterval(() => {
  subscribeAll("interval").catch((e) => console.error("interval subscribe error", e.message));
}, POLL_INTERVAL_MS);

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("uncaughtException", error);
});

console.log("Iniciando WppNotify worker com Baileys...");
console.log(`App endpoint: ${WPPNOTIFY_URL}`);
console.log(`Contacts endpoint: ${WORKER_CONTACTS_URL}`);
startWorker().catch((e) => {
  console.error("Erro fatal ao iniciar worker", e);
  process.exit(1);
});
