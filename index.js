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
});

client.on("ready", async () => {
  console.log("✅ Worker conectado ao WhatsApp");
  const contacts = await client.getContacts();
  console.log(`Inscrevendo presença de ${contacts.length} contatos...`);
  for (const c of contacts) {
    if (c.isMyContact && c.id?._serialized) {
      try { await client.subscribeToPresence?.(c.id._serialized); } catch {}
    }
  }
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
