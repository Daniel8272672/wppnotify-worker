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
const WORKER_CONTACTS_URL =
  process.env.WORKER_CONTACTS_URL || WPPNOTIFY_URL.replace(/\/ingest\/?$/, "/worker-contacts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toJid(phoneNumber) {
  const clean = String(phoneNumber || "").replace(/\D/g, "");
  return clean ? `${clean}@c.us` : null;
}

function statusFromPresence({ state, isOnline }) {
  const normalized = String(state || "").toLowerCase();
  if (normalized === "composing") return "typing";
  if (normalized === "recording") return "recording";
  if (isOnline === true || normalized === "available") return "online";
  if (isOnline === false || normalized === "unavailable" || normalized === "offline") return "offline";
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
  return (data.contacts || []).map((c) => toJid(c.phone_number)).filter(Boolean);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
  puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

const lastStatus = new Map(); // jid -> 'online' | 'offline'
let monitoredJids = [];
let browserPresenceBridgeInstalled = false;

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

async function handlePresence({ jid, state, isOnline, source = "presence" }) {
  if (!jid) return;
  const status = statusFromPresence({ state, isOnline });
  if (!status) return;
  if (lastStatus.get(jid) === status) return;

  const phone = String(jid).split("@")[0];
  const isFirstOffline = !lastStatus.has(jid) && status === "offline";
  lastStatus.set(jid, status);
  console.log(`[${new Date().toISOString()}] ${phone} → ${status} (${source})`);
  if (!isFirstOffline) await ingest(phone, status, { metadata: { source, state, isOnline } });
}

async function installPresenceBridge() {
  if (browserPresenceBridgeInstalled || !client.pupPage) return;
  browserPresenceBridgeInstalled = true;

  try {
    await client.pupPage.exposeFunction("__wppnotifyPresenceEvent", (payload) => {
      handlePresence({ ...payload, source: "event" }).catch((e) => console.error("presence event error", e.message));
    });
  } catch (e) {
    if (!String(e.message || "").includes("already registered")) throw e;
  }

  await client.pupPage.evaluate(() => {
    if (window.__wppnotifyPresenceBridgeInstalled) return;
    window.__wppnotifyPresenceBridgeInstalled = true;

    const serializeId = (value) => value?._serialized || value?.toString?.() || String(value || "");
    const emit = (presence) => {
      if (!presence) return;
      const jid = serializeId(presence.id);
      if (!jid || !jid.includes("@c.us")) return;
      const chatstate = presence.chatstate || presence.chatstates?.getModelsArray?.().find((item) => item?.type);
      window.__wppnotifyPresenceEvent?.({
        jid,
        state: chatstate?.type || (presence.isOnline ? "available" : "unavailable"),
        isOnline: Boolean(presence.isOnline),
      });
    };

    const presenceStore = window.Store?.Presence;
    presenceStore?.on?.("change:chatstate.type", (chatstate) => {
      const presence = presenceStore.getModelsArray?.().find((item) => item.chatstate === chatstate || serializeId(item.id) === serializeId(chatstate?.id));
      emit(presence);
    });
    presenceStore?.on?.("change:isOnline", emit);
  });
}

async function subscribeJids(jids) {
  if (!jids.length || !client.pupPage) return;
  const subscribed = await client.pupPage.evaluate(async (ids) => {
    const results = [];
    const widFactory = window.Store?.WidFactory || window.require?.("WAWebWidFactory");
    const presenceBridge = window.require?.("WAWebContactPresenceBridge");
    const presenceStore = window.Store?.Presence;

    for (const jid of ids) {
      try {
        const wid = widFactory?.createWid ? widFactory.createWid(jid) : jid;
        if (presenceBridge?.subscribePresence) await presenceBridge.subscribePresence(wid);
        else if (presenceBridge?.subscribeUserPresence) await presenceBridge.subscribeUserPresence(wid);

        const presence = presenceStore?.get?.(wid) || presenceStore?.get?.(jid) || await presenceStore?.find?.(wid).catch?.(() => null);
        await presence?.subscribe?.();
        results.push(jid);
      } catch (error) {
        results.push(`${jid}:erro`);
      }
    }
    return results;
  }, jids);
  console.log(`Presença assinada para ${subscribed.filter((item) => !item.endsWith(":erro")).length}/${jids.length} contatos monitorados.`);
}

async function refreshSubscriptions() {
  try {
    monitoredJids = await fetchMonitoredContacts();
    await installPresenceBridge();
    await subscribeJids(monitoredJids);
  } catch (e) {
    console.error("refreshSubscriptions error", e.message);
  }
}

async function pollPresence() {
  if (!monitoredJids.length || !client.pupPage) return;
  try {
    const statuses = await client.pupPage.evaluate(async (ids) => {
      const widFactory = window.Store?.WidFactory || window.require?.("WAWebWidFactory");
      const presenceStore = window.Store?.Presence;
      return ids.map((jid) => {
        const wid = widFactory?.createWid ? widFactory.createWid(jid) : jid;
        const presence = presenceStore?.get?.(wid) || presenceStore?.get?.(jid);
        const chatstate = presence?.chatstate || presence?.chatstates?.getModelsArray?.().find((item) => item?.type);
        return {
          jid,
          state: chatstate?.type || (presence?.isOnline ? "available" : "unavailable"),
          isOnline: Boolean(presence?.isOnline),
        };
      });
    }, monitoredJids);

    for (const item of statuses) await handlePresence({ ...item, source: "poll" });
  } catch (e) {
    console.error("pollPresence error", e.message);
  }
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
  await refreshSubscriptions();
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
  const me = presences.find?.((p) => p.id?._serialized === jid) ?? presences[0];
  await handlePresence({ jid, state: me?.chatstate?.type, isOnline: me?.isOnline ?? me?.lastSeen === null, source: "legacy-event" });
});

setInterval(async () => {
  await refreshSubscriptions();
  await sleep(1000);
  await pollPresence();
}, POLL_INTERVAL_MS);

client.initialize();
