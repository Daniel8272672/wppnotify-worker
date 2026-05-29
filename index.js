import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";

const { Client, LocalAuth } = pkg;

const WPPNOTIFY_URL = process.env.WPPNOTIFY_URL;
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "10000", 10);

if (!WPPNOTIFY_URL || !WORKER_TOKEN) {
  console.error("Defina WPPNOTIFY_URL e WORKER_TOKEN");
  process.exit(1);
}

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

const lastStatus = new Map();
let monitoredJids = [];
let presenceFunctionExposed = false;

async function ingest(phone_number, status, extra = {}) {
  try {
    const res = await fetch(WPPNOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-token": WORKER_TOKEN },
      body: JSON.stringify({ phone_number, status, occurred_at: new Date().toISOString(), ...extra }),
    });
    if (!res.ok) console.error("ingest failed", res.status, await res.text());
  } catch (e) {
    console.error("ingest error", e.message);
  }
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

async function exposePresenceFunction() {
  if (presenceFunctionExposed || !client.pupPage) return;
  try {
    await client.pupPage.exposeFunction("__wppnotifyPresenceEvent", (payload) => {
      handlePresence({ ...payload, source: "event" }).catch((e) =>
        console.error("presence event error", e.message)
      );
    });
    presenceFunctionExposed = true;
  } catch (e) {
    if (String(e.message || "").includes("already exists")) presenceFunctionExposed = true;
    else console.error("exposeFunction error", e.message);
  }
}

async function subscribeJids(jids) {
  if (!jids.length || !client.pupPage) return;
  const results = await client.pupPage.evaluate(async (ids) => {
    const Store = window.Store;
    if (!Store || !Store.Presence || !Store.WidFactory) {
      return ids.map((j) => `${j}:no-store`);
    }

    const serialize = (wid) => wid?._serialized || (wid?.toString ? wid.toString() : String(wid || ""));

    const emit = (presence) => {
      try {
        if (!presence) return;
        const jid = serialize(presence.id);
        if (!jid.includes("@c.us")) return;
        const chatstate =
          presence.chatstate?.type ||
          presence.chatstate?.attributes?.type ||
          (presence.isOnline ? "available" : "unavailable");
        window.__wppnotifyPresenceEvent?.({
          jid,
          state: chatstate,
          isOnline: Boolean(presence.isOnline),
        });
      } catch (e) {}
    };

    const out = [];
    for (const jid of ids) {
      try {
        const wid = Store.WidFactory.createWid(jid);
        const serialized = serialize(wid) || jid;

        let presence = Store.Presence.get(serialized);
        if (!presence && Store.Presence.find) {
          presence = await Store.Presence.find(wid).catch(() => null);
        }
        if (!presence) {
          out.push(`${jid}:nopresence`);
          continue;
        }

        if (typeof presence.subscribe === "function") {
          await presence.subscribe().catch(() => {});
        } else if (Store.PresenceUtils?.sendPresenceSubscription) {
          await Store.PresenceUtils.sendPresenceSubscription(wid).catch(() => {});
        }

        if (!presence.__wppnotifyHooked && typeof presence.on === "function") {
          presence.__wppnotifyHooked = true;
          presence.on("change:isOnline", () => emit(presence));
          presence.on("change:chatstate", () => emit(presence));
          presence.on("change", () => emit(presence));
        }

        out.push(jid);
      } catch (e) {
        out.push(`${jid}:${String(e.message || "erro").slice(0, 40)}`);
      }
    }
    return out;
  }, jids);

  const ok = results.filter((r) => !r.includes(":")).length;
  const failed = results.filter((r) => r.includes(":"));
  console.log(`Presença assinada para ${ok}/${jids.length} contatos monitorados.`);
  if (failed.length) console.log("  falhas:", failed.join(", "));
}

async function refreshSubscriptions() {
  try {
    monitoredJids = await fetchMonitoredContacts();
    await exposePresenceFunction();
    await subscribeJids(monitoredJids);
  } catch (e) {
    console.error("refreshSubscriptions error", e.message);
  }
}

async function pollPresence() {
  if (!monitoredJids.length || !client.pupPage) return;
  try {
    const statuses = await client.pupPage.evaluate((ids) => {
      const Store = window.Store;
      if (!Store || !Store.Presence || !Store.WidFactory) return [];
      const serialize = (wid) => wid?._serialized || String(wid || "");
      return ids.map((jid) => {
        const wid = Store.WidFactory.createWid(jid);
        const presence = Store.Presence.get(serialize(wid)) || Store.Presence.get(jid);
        const chatstate =
          presence?.chatstate?.type ||
          presence?.chatstate?.attributes?.type ||
          (presence?.isOnline ? "available" : "unavailable");
        return {
          jid,
          state: chatstate,
          isOnline: Boolean(presence?.isOnline),
          hasPresence: Boolean(presence),
        };
      });
    }, monitoredJids);

    for (const item of statuses) {
      if (!item.hasPresence) continue;
      await handlePresence({ ...item, source: "poll" });
    }
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
  await sleep(2000);
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
  presenceFunctionExposed = false;
});

client.on("presence_update", async ({ id, presences }) => {
  if (!id) return;
  const jid = id._serialized || id;
  const list = Array.isArray(presences) ? presences : [];
  const me = list.find?.((p) => (p.id?._serialized || p.id) === jid) ?? list[0];
  await handlePresence({
    jid,
    state: me?.chatstate?.type,
    isOnline: me?.isOnline ?? (me?.lastSeen === null ? true : undefined),
    source: "native-event",
  });
});

setInterval(async () => {
  await refreshSubscriptions();
  await sleep(1500);
  await pollPresence();
}, POLL_INTERVAL_MS);

client.initialize();
