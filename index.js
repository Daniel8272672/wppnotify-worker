import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";

const { Client, LocalAuth } = pkg;

const WPPNOTIFY_URL = process.env.WPPNOTIFY_URL;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);

if (!WPPNOTIFY_URL || !WORKER_TOKEN) {
  console.error("Defina WPPNOTIFY_URL e WORKER_TOKEN");
  process.exit(1);
}

// URL do endpoint de status/QR (derivada do endpoint de ingestão).
const WORKER_QR_URL =
  process.env.WORKER_QR_URL || WPPNOTIFY_URL.replace(/\/ingest\/?$/, "/worker-qr");

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

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
  puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

const lastStatus = new Map(); // jid -> 'online' | 'offline'

async function ingest(phone_number, status, extra = {}) {
  try {
    const res = await fetch(WPPNOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-token": WORKER_TOKEN },
      body: JSON.stringify({ phone_number, status, occurred_at: new Date().toISOString(), ...extra }),
    });
    if (!res.ok) console.error("ingest failed", res.status, await res.text());
  } catch (e) { console.error("ingest error", e.message); }
}

client.on("qr", (qr) => {
  console.log("\n📱 Escaneie o QR Code no WhatsApp:\n");
  qrcode.generate(qr, { small: true });
  console.log("\n➡️  Ou abra Configurações no app WppNotify para escanear o QR Code direto na tela.\n");
  reportStatus("qr", qr);
});

client.on("ready", async () => {
  console.log("✅ Worker conectado ao WhatsApp");
  reportStatus("connected");
  const contacts = await client.getContacts();
  console.log(`Inscrevendo presença de ${contacts.length} contatos...`);
  for (const c of contacts) {
    if (c.isMyContact && c.id?._serialized) {
      try { await client.subscribeToPresence?.(c.id._serialized); } catch {}
    }
  }
});

client.on("authenticated", () => {
  console.log("🔐 Autenticado");
  reportStatus("connecting");
});

client.on("auth_failure", (msg) => {
  console.error("❌ Falha de autenticação:", msg);
  reportStatus("disconnected");
});

client.on("disconnected", (reason) => {
  console.error("🔌 Desconectado:", reason);
  reportStatus("disconnected");
});

client.on("presence_update", async ({ id, presences }) => {
  if (!id || !presences) return;
  const jid = id._serialized || id;
  const phone = jid.split("@")[0];
  const me = presences.find?.((p) => p.id?._serialized === jid) ?? presences[0];
  const isOnline = me?.isOnline ?? me?.lastSeen === null;
  const status = isOnline ? "online" : "offline";
  if (lastStatus.get(jid) === status) return;
  lastStatus.set(jid, status);
  console.log(`[${new Date().toISOString()}] ${phone} → ${status}`);
  await ingest(phone, status);
});

// Fallback polling para contatos sem presence_update
setInterval(async () => {
  try {
    const chats = await client.getChats();
    for (const chat of chats.slice(0, 100)) {
      if (chat.isGroup) continue;
      const jid = chat.id._serialized;
      try {
        const presence = await chat.getContact().then((c) => c.getAbout?.()).catch(() => null);
        // No-op: polling apenas mantém a sessão ativa
      } catch {}
    }
  } catch {}
}, POLL_INTERVAL_MS);

client.initialize();
