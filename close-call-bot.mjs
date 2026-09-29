#!/usr/bin/env node
// Close Call bot: kendi DID'lerini kaydeder ve aralarında LONG/SHORT çiftleri açar.
// Protokol: flop-labs/technocore-close-call-challenge (close-call-game.md) ve
// UfukNode/technocore-close-call-desk (lib/protocol.js) ile birebir aynı imza metinleri.
// Private key'ler sadece ./keys klasöründe durur; bu script onları asla ekrana yazmaz.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TC = "https://technocore.chat";
const SEASON = "close-1";
const TRADING_ROOM = "close1";
const OFFER_ROOM = "close1-offers"; // Ufuk'un aracı resmi trade'leri buraya atıyor: close1 kayıt trafiğiyle dolup taşıyor
const REFEREE = "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte";
const ROOMS = { price: "d-close1-price", flow: "d-close1-flow", pnl: "d-close1-pnl", state: "d-close1-state", positions: "d-close1-positions" };
const LOCK_SWEEP = 2556;
const MINT = 10000;
const FEE_RATE = 0.01;

const HERE = path.dirname(new URL(import.meta.url).pathname);
const KEY_DIR = path.join(HERE, "keys");
const STATE_FILE = path.join(HERE, "bot-state.json");

const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const DECIMAL_RE = /^[0-9]{1,7}(?:\.[0-9]{1,2})?$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ---------- yardımcılar ----------

function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

function didFromX(x) {
  const raw = Buffer.from(x, "base64url");
  if (raw.length !== 32) throw new Error("Geçersiz Ed25519 public key.");
  return `did:key:z${base58Encode(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { nonces: {}, registered: {}, trades: [] }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadKeys() {
  if (!fs.existsSync(KEY_DIR)) return [];
  return fs.readdirSync(KEY_DIR).filter((f) => f.endsWith(".json")).sort().map((file) => {
    const payload = JSON.parse(fs.readFileSync(path.join(KEY_DIR, file), "utf8"));
    const jwk = payload.privateKeyJwk || payload;
    if (jwk?.kty !== "OKP" || jwk?.crv !== "Ed25519" || !jwk.d || !jwk.x) {
      throw new Error(`${file}: Ed25519 private-key JSON değil.`);
    }
    const did = didFromX(jwk.x);
    if (payload.did && payload.did !== did) throw new Error(`${file}: dosyadaki did ile key uyuşmuyor.`);
    const key = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x }, format: "jwk" });
    return { file, did, key, isMain: file.toLowerCase().startsWith("main") };
  });
}

function sign(key, text) {
  return crypto.sign(null, Buffer.from(text, "utf8"), key).toString("base64url");
}

function nextNonce(state, did) {
  const prev = BigInt(state.nonces[did] || "0");
  const now = BigInt(Date.now());
  const nonce = now > prev ? now : prev + 1n;
  state.nonces[did] = nonce.toString();
  return nonce.toString();
}

function short(did) { return `${did.slice(8, 14)}…${did.slice(-6)}`; }

async function http(url, options = {}, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      if (!res.ok) { const e = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`); e.fatal = true; throw e; }
      try { return JSON.parse(text); } catch { return text; }
    } catch (err) {
      lastErr = err;
      if (err.fatal) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function post(state, k, room, record) {
  const text = JSON.stringify(record);
  const nonce = nextNonce(state, k.did);
  const sig = sign(k.key, `${room}|${nonce}|${text}`);
  saveState(state);
  const res = await http(`${TC}/r/${room}?format=json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ did: k.did, sig, nonce, text }),
  });
  const seq = res?.seq ?? res?.message?.seq ?? res?.data?.seq ?? res?.messages?.at?.(-1)?.seq ?? null;
  state.responses = [...(state.responses || []), { at: new Date().toISOString(), room, t: record.t, seq, raw: JSON.stringify(res).slice(0, 400) }].slice(-40);
  saveState(state);
  return { ...(typeof res === "object" && res ? res : {}), seq };
}

async function refereeRecords(room) {
  const data = await http(`${TC}/r/${room}?format=json&limit=200`);
  return (data.messages || [])
    .filter((m) => m.from === REFEREE)
    .map((m) => { try { return { ...JSON.parse(m.text), _ts: toMs(m.ts) }; } catch { return null; } })
    .filter(Boolean);
}

function toMs(v) {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

// Referee büyük mint listelerini kısaltabiliyor (Ufuk'un aracı da bunu söylüyor). O yüzden:
// listede görünüyorsa ya da kayıttan sonra en az bir flow (sweep) mesajı geldiyse hazır sayılır.
function isReady(k, state, flow) {
  if (k.isMain || flow.minted.has(k.did)) return true;
  const at = state.registered[k.did] ? Date.parse(state.registered[k.did]) : 0;
  return Boolean(at && flow.latestTs > at + 30_000);
}

async function market() {
  const records = await refereeRecords(ROOMS.price);
  const price = [...records].reverse().find((r) => r.t === "price") || [...records].reverse().find((r) => r.t === "seed");
  if (!price) throw new Error("Referee fiyat mesajı okunamadı.");
  const ref = Number(price.ref?.px ?? price.price);
  const limits = (price.limits || []).map(Number);
  const sweep = Number(price.for || price.n || 0);
  return { ref, limits, sweep, global: price.global };
}

async function flowStatus() {
  const records = (await refereeRecords(ROOMS.flow)).filter((r) => r.t === "flow");
  const minted = new Set(); const settled = new Set(); const voided = new Map(); const rooms = new Set([TRADING_ROOM]);
  for (const r of records) {
    for (const d of r.mints || []) minted.add(String(d));
    for (const item of r.rooms || []) {
      const room = Array.isArray(item) ? item[0] : item && typeof item === "object" ? item.room || item.name : item;
      if (typeof room === "string") rooms.add(room);
    }
    for (const id of r.settled || []) settled.add(String(Array.isArray(id) ? id[0] : id));
    for (const v of r.void || []) {
      if (Array.isArray(v)) voided.set(String(v[0]), String(v[1] || "void"));
      else if (v && typeof v === "object") voided.set(String(v.id), String(v.reason || "void"));
      else voided.set(String(v), "void");
    }
  }
  const latestTs = Math.max(0, ...records.map((r) => r._ts || 0));
  const missed = records.slice(-12).map((r) => r.missed).filter((v) => v && (!Array.isArray(v) || v.length));
  try {
    const st = (await refereeRecords(ROOMS.state)).filter((r) => r.t === "state").at(-1);
    if (Array.isArray(st?.rooms)) for (const item of st.rooms) {
      const room = Array.isArray(item) ? item[0] : item && typeof item === "object" ? item.room || item.name : item;
      if (typeof room === "string") rooms.add(room);
    }
  } catch { /* state okunamazsa flow listesiyle devam */ }
  return { minted, settled, voided, rooms, latestTs, missed };
}

function args() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const k = rest[i].slice(2);
      const v = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
      opts[k] = v;
    } else opts._.push(rest[i]);
  }
  return { cmd, opts };
}

// ---------- komutlar ----------

function cmdKeys(opts) {
  const count = Number(opts._[0] || 5);
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error("Key sayısı 1-30 arası olmalı.");
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  let made = 0;
  for (let i = 1; made < count && i <= 99; i++) {
    const file = path.join(KEY_DIR, `key-${String(i).padStart(2, "0")}.json`);
    if (fs.existsSync(file)) continue;
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    const did = didFromX(jwk.x);
    fs.writeFileSync(file, JSON.stringify({ did, privateKeyJwk: jwk }, null, 2), { mode: 0o600 });
    console.log(`+ ${path.basename(file)}  ${did}`);
    made++;
  }
  console.log(`\n${made} yeni key üretildi (keys/ klasöründe). Bu dosyaları kimseyle paylaşma.`);
}

async function cmdStatus() {
  const keys = loadKeys();
  const state = loadState();
  const [m, flow] = await Promise.all([market(), flowStatus()]);
  console.log(`Sweep ${m.sweep}  referans ${m.ref}  izinli aralık ${m.limits.join(" – ")}  (kilit: sweep ${LOCK_SWEEP})\n`);
  for (const k of keys) {
    const posted = state.registered[k.did];
    const reg = k.isMain ? "main (daha önce kayıtlı sayılır)"
      : flow.minted.has(k.did) ? "kayıt ONAYLI"
      : isReady(k, state, flow) ? "kayıt ONAYLI (sweep geçti)"
      : posted ? "kayıt gönderildi, sweep bekleniyor" : "KAYITSIZ";
    console.log(`${k.file.padEnd(14)} ${short(k.did)}  ${reg}`);
  }
  if (state.trades.length) {
    console.log("\nİşlemler:");
    for (const t of state.trades) {
      const s = flow.settled.has(t.id) ? "SETTLED ✓"
        : flow.voided.has(t.id) ? `VOID (${flow.voided.get(t.id)})`
        : t.until && m.sweep > t.until ? "public listede görünmüyor (liste kısaltılıyor), açık sayılıyor"
        : "bekliyor";
      console.log(`  ${t.id}  ${t.qty} NVDA @ ${t.px}  LONG ${short(t.long)} / SHORT ${short(t.short)}  → ${s}`);
    }
  }
}

async function cmdRegister(opts) {
  const keys = loadKeys();
  const state = loadState();
  const flow = await flowStatus();
  for (const k of keys) {
    if (k.isMain && !opts["include-main"]) { console.log(`- ${k.file}: main key, atlandı (zaten kayıtlı)`); continue; }
    if (flow.minted.has(k.did) || state.registered[k.did]) { console.log(`- ${k.file}: zaten kayıtlı/gönderilmiş, atlandı`); continue; }
    const res = await post(state, k, TRADING_ROOM, { t: "owner", season: SEASON, key: k.did });
    state.registered[k.did] = new Date().toISOString();
    saveState(state);
    console.log(`+ ${k.file}: kayıt gönderildi (seq ${res?.seq ?? "?"})`);
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log("\nBir sonraki sweep'te (en fazla ~5 dk) 10.000 POLF gelir. Sonra: node close-call-bot.mjs status");
}

function resolveQty(opt, px) {
  if (!opt || opt === "max") {
    // bakiyenin %98'i: fiyat oynarsa veya fee clawback olursa "funds" void'i yemeyelim
    return (Math.floor((MINT * 0.98) / (Number(px) * (1 + FEE_RATE)) * 100) / 100).toFixed(2);
  }
  const qty = String(opt);
  if (!DECIMAL_RE.test(qty) || Number(qty) < 0.1) throw new Error("--qty en az 0.1, en fazla 2 ondalık olmalı (ya da max).");
  const cost = Number(qty) * Number(px) * (1 + FEE_RATE);
  if (cost > MINT) throw new Error(`${qty} NVDA × ${px} + fee = ${cost.toFixed(2)} POLF; 10.000 POLF'u aşıyor. --qty küçült.`);
  return qty;
}

function buildPairs(keys, flow, force, state) {
  const usable = keys.filter((k) => isReady(k, state, flow) || force);
  const pairs = [];
  for (let i = 0; i + 1 < usable.length; i += 2) pairs.push([usable[i], usable[i + 1]]);
  return { usable, pairs };
}

function tradeStatus(t, m, flow) {
  if (flow.settled.has(t.id)) return "settled";
  if (flow.voided.has(t.id)) return "void";
  // Referee public listeleri kısaltıyor: süresi geçip void görünmeyen işlem büyük ihtimalle
  // listeden çıkarılmıştır. Çift "dolu" sayılır, tekrar açılmaz (yoksa funds void'i ve sonsuz döngü).
  if (t.until && m.sweep > t.until) return "unconfirmed";
  return "pending";
}

// Bir çift "dolu" sayılır: en az bir işlemi settled ya da hâlâ pending ise
function pairBusy(state, pair, m, flow) {
  return state.trades.some((t) => t.long === pair[0].did && t.short === pair[1].did
    && ["settled", "pending", "unconfirmed"].includes(tradeStatus(t, m, flow)));
}

async function chooseRoom(state, flow, pairs, opts) {
  const room = opts.room || (flow.rooms.has(OFFER_ROOM) ? OFFER_ROOM : TRADING_ROOM);
  if (!opts.room && room === TRADING_ROOM && !opts.dry) {
    // close1-offers listede görünmüyorsa kaydını iste (Ufuk'un aracı da aynısını yapıyor); bu turda close1 kullanılır
    await post(state, pairs[0][0], TRADING_ROOM, { t: "room", season: SEASON, room: OFFER_ROOM }).catch(() => {});
  }
  return room;
}

async function openPair(state, m, pair, index, qty, room, dry) {
  const [longK, shortK] = pair;
  const px = m.ref.toFixed(2);
  if (!(Number(px) >= m.limits[0] && Number(px) <= m.limits[1])) throw new Error(`Fiyat ${px} izinli aralıkta değil.`);
  const terms = {
    id: `eb${Date.now().toString(36)}${index + 1}`,
    maker: longK.did,
    px,
    qty,
    side: "buy",
    taker: shortK.did,
    until: Math.min(m.sweep + 6, LOCK_SWEEP),
  };
  const termsText = JSON.stringify(terms);
  const record = {
    t: "trade",
    season: SEASON,
    terms,
    taker: shortK.did,
    maker_sig: sign(longK.key, `${SEASON}|terms|${termsText}`),
    taker_sig: sign(shortK.key, `${SEASON}|accept|${termsText}|${shortK.did}`),
  };
  if (dry) { console.log(JSON.stringify(record)); return; }
  const res = await post(state, shortK, room, record);
  state.trades.push({ id: terms.id, px, qty, long: longK.did, short: shortK.did, sweep: m.sweep, until: terms.until, room, seq: res?.seq ?? null, at: new Date().toISOString() });
  saveState(state);
  console.log(`${new Date().toISOString().slice(0, 16)}  Çift ${index + 1}: LONG ${longK.file} / SHORT ${shortK.file}  ${qty} NVDA @ ${px}  →  gönderildi (id ${terms.id})`);
}

async function cmdPair(opts) {
  const keys = loadKeys();
  const state = loadState();
  const [m, flow] = await Promise.all([market(), flowStatus()]);
  if (m.sweep >= LOCK_SWEEP) throw new Error("Yarışma kilitlendi, yeni işlem sayılmaz.");
  const px = m.ref.toFixed(2);
  const qty = resolveQty(opts.qty, px);
  const { usable, pairs } = buildPairs(keys, flow, opts.force, state);
  for (const k of keys.filter((k) => !usable.includes(k))) console.log(`- ${k.file}: kaydı henüz onaylanmadı, çiftlere alınmadı`);
  if (!pairs.length) throw new Error("En az 2 onaylı key lazım.");
  const only = opts.only ? String(opts.only).split(",").map(Number) : null;
  const room = await chooseRoom(state, flow, pairs, opts);
  console.log(`Sweep ${m.sweep}, fiyat ${px}, miktar ${qty}, çift sayısı ${pairs.length}, oda ${room}\n`);
  for (let p = 0; p < pairs.length; p++) {
    if (only && !only.includes(p + 1)) continue;
    if (!opts.dry && !opts.again && pairBusy(state, pairs[p], m, flow)) { console.log(`- Çift ${p + 1} zaten pozisyonda, atlandı (--again ile zorla)`); continue; }
    await openPair(state, m, pairs[p], p, qty, room, opts.dry);
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!opts.dry) console.log("\nSonuç bir sonraki sweep'te belli olur: node close-call-bot.mjs status");
}

// Otomatik mod: boştaki bir çifti, fiyat önceki girişlerin hepsinden --step kadar
// uzaklaştığında (yeni tepe/dip) ya da son girişten --hours saat geçtiğinde açar.
// Amaç: giriş fiyatlarını olabildiğince geniş bir aralığa yaymak; kapanış fiyatı nereye
// düşerse düşsün, ondan en uzak girişin kazanan tarafı en yüksek skoru alır.
// Tek adım: gerekirse bir çift açar. auto (döngü) ve tick (GitHub Actions) bunu kullanır.
async function autoStep(opts) {
  const step = Number(opts.step || 4);
  const hours = Number(opts.hours || 24);
  const keys = loadKeys();
  const state = loadState();
  const [m, flow] = await Promise.all([market(), flowStatus()]);
  if (m.sweep >= LOCK_SWEEP - 1) return { m, state, line: `sweep ${m.sweep}: kilit geldi`, locked: true };
  const { pairs } = buildPairs(keys, flow, false, state);
  const live = state.trades.filter((t) => ["settled", "pending", "unconfirmed"].includes(tradeStatus(t, m, flow)));
  const pending = live.some((t) => tradeStatus(t, m, flow) === "pending");
  const free = pairs.map((pair, i) => ({ pair, i })).filter(({ pair }) => !pairBusy(state, pair, m, flow));
  const entries = live.map((t) => Number(t.px));
  const hi = entries.length ? Math.max(...entries) : null;
  const lo = entries.length ? Math.min(...entries) : null;
  const lastAt = live.length ? Math.max(...live.map((t) => Date.parse(t.at))) : 0;
  const hoursSince = (Date.now() - lastAt) / 3.6e6;
  let reason = "";
  if (!entries.length) reason = "ilk giriş";
  else if (m.ref >= hi + step) reason = `yeni tepe (${hi} → ${m.ref})`;
  else if (m.ref <= lo - step) reason = `yeni dip (${lo} → ${m.ref})`;
  else if (hoursSince >= hours) reason = `${hours} saattir giriş yok`;
  const line = `sweep ${m.sweep}  fiyat ${m.ref}  girişler ${entries.length ? `${lo}–${hi}` : "-"}  boş çift ${free.length}/${pairs.length}`;
  let opened = null;
  // Sonuçlar public listede görünmediği için beklemek bir şey kazandırmaz; farklı çiftler çakışmaz.
  if (reason && free.length) {
    const px = m.ref.toFixed(2);
    const room = await chooseRoom(state, flow, pairs, opts);
    const qty = resolveQty(opts.qty, px);
    await openPair(state, m, free[0].pair, free[0].i, qty, room, false);
    opened = { pair: free[0].i + 1, px, qty, reason, left: free.length - 1, total: pairs.length };
  }
  return { m, state, line, opened, done: !free.length && !pending, pairs, flow };
}

async function cmdAuto(opts) {
  let lastSweep = -1;
  console.log(`Otomatik mod: yeni tepe/dip eşiği ${opts.step || 4}$, zaman eşiği ${opts.hours || 24} saat. Durdurmak için Ctrl+C.\n`);
  for (;;) {
    try {
      const m = await market();
      if (m.sweep !== lastSweep) {
        lastSweep = m.sweep;
        const r = await autoStep(opts);
        if (r.locked) { console.log("Kilide son sweep kaldı, otomatik mod bitti."); return; }
        console.log(r.opened ? `${r.line}  → AÇ: ${r.opened.reason}` : r.line);
        if (r.opened) await notify(openedText(r.opened));
        if (r.done) { console.log("Tüm çiftler pozisyonda. Otomatik mod bitti; takibi status ile yap."); return; }
      }
    } catch (err) {
      console.log(`uyarı: ${err.message} (tekrar denenecek)`);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

// ---------- Telegram ----------

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    await http(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    }, 3);
    return true;
  } catch (err) {
    console.log(`telegram gönderilemedi: ${err.message}`);
    return false;
  }
}

function openedText(o) {
  return `🟢 Close Call: çift ${o.pair} açıldı\n${o.qty} NVDA @ ${o.px} (LONG + SHORT)\nSebep: ${o.reason}\nBoşta kalan çift: ${o.left}/${o.total}`;
}

async function summaryText(r, title = "📊 Close Call günlük özet") {
  const keys = loadKeys();
  const mine = new Set(keys.map((k) => k.did));
  const board = (await refereeRecords(ROOMS.pnl)).filter((x) => x.t === "pnl").at(-1)?.top || [];
  const ours = board.map((row, i) => ({ i, row })).filter(({ row }) => mine.has(Array.isArray(row) ? row[0] : row?.key));
  const entries = r.state.trades.map((t) => `${t.px}`).join(", ") || "-";
  const kilit = Math.max(0, (Date.parse("2026-10-04T09:00:00Z") - Date.now()) / 3.6e6).toFixed(0);
  return [
    title,
    `Fiyat ${r.m.ref} (sweep ${r.m.sweep})`,
    `Girişlerimiz: ${entries}`,
    `Boşta çift: ${(r.pairs || []).filter((p) => !pairBusy(r.state, p, r.m, r.flow)).length}/${(r.pairs || []).length}`,
    `Sıralama: lider ${board[0]?.[1] ?? "?"}, 25. ${board.at(-1)?.[1] ?? "?"}` + (ours.length ? `, BİZ İLK 25'TE: ${ours.map(({ i, row }) => `${i + 1}. (${row[1]})`).join(" ")}` : ", bizden ilk 25'te yok"),
    `Kilide ~${kilit} saat`,
  ].join("\n");
}

function tradesText(state) {
  if (!state.trades.length) return "Henüz açılmış çift yok.";
  return ["📋 Açılan çiftler:", ...state.trades.map((t, i) =>
    `${i + 1}) ${t.qty} NVDA @ ${t.px}  (${t.at.slice(5, 16).replace("T", " ")} UTC)`)].join("\n");
}

// Telegram'dan gelen komutlar: sadece TELEGRAM_CHAT_ID'den gelenler dikkate alınır
async function handleCommands(r) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = String(process.env.TELEGRAM_CHAT_ID || "");
  if (!token || !chat) return;
  const state = loadState();
  const offset = state.tgOffset || 0;
  const data = await http(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=0`, {}, 2);
  const updates = data?.result || [];
  if (!updates.length) return;
  const cmds = [];
  for (const u of updates) {
    const msg = u.message;
    if (msg && String(msg.chat?.id) === chat && typeof msg.text === "string") cmds.push(msg.text.trim().toLowerCase().split(/[\s@]/)[0]);
  }
  state.tgOffset = updates.at(-1).update_id + 1;
  saveState(state);
  for (const c of new Set(cmds)) {
    if (c === "/durum" || c === "durum") await notify(await summaryText({ ...r, state: loadState() }, "📊 Close Call durum"));
    else if (c === "/islemler" || c === "islemler" || c === "/işlemler") await notify(tradesText(loadState()));
    else if (c === "/start" || c === "/yardim" || c === "/yardım" || c === "yardim") {
      await notify("Komutlar:\n/durum – güncel özet\n/islemler – açılan çiftler\nCevap en geç ~10 dakika içinde gelir (bot 10 dakikada bir uyanıyor).");
    }
  }
}

// GitHub Actions'ın her çalıştırmada çağırdığı tek adım
async function cmdTick(opts) {
  const state0 = loadState();
  try {
    const r = await autoStep(opts);
    console.log(r.opened ? `${r.line}  → AÇ: ${r.opened.reason}` : r.line);
    const state = loadState();
    if (r.opened) await notify(openedText(r.opened));
    const today = new Date().toISOString().slice(0, 10);
    if (new Date().getUTCHours() >= 6 && state.summaryDay !== today) {
      if (await notify(await summaryText({ ...r, state }))) { state.summaryDay = today; saveState(state); }
    }
    try { await handleCommands(r); } catch (err) { console.log(`komut okunamadı: ${err.message}`); }
    if (r.locked && !state.lockNotified) {
      if (await notify("🔒 Close Call işlemleri kilitlendi. Kapanış fiyatı 13:00 (TR) sonrası belli olacak.")) { state.lockNotified = true; saveState(state); }
    }
  } catch (err) {
    console.log(`hata: ${err.message}`);
    const last = Date.parse(state0.lastErrorAt || 0) || 0;
    if (Date.now() - last > 3 * 3.6e6) {
      await notify(`⚠️ Close Call bot hatası: ${err.message.slice(0, 300)}`);
      const st = loadState(); st.lastErrorAt = new Date().toISOString(); saveState(st);
    }
  }
}

// Telegram kurulumu: bota bir mesaj attıktan sonra chat id'yi bulur ve test mesajı yollar
async function cmdTgSetup() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Önce TELEGRAM_BOT_TOKEN ortam değişkenini ver.");
  const data = await http(`https://api.telegram.org/bot${token}/getUpdates`);
  const chats = new Map();
  for (const u of data.result || []) {
    const c = u.message?.chat || u.channel_post?.chat;
    if (c) chats.set(c.id, c.username || c.title || c.first_name || "");
  }
  if (!chats.size) { console.log("Hiç mesaj yok. Telegram'da botuna /start yaz, sonra bu komutu tekrar çalıştır."); return; }
  for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID = ${id}   (${name})`);
  const [firstId] = chats.keys();
  process.env.TELEGRAM_CHAT_ID = String(firstId);
  if (await notify("✅ Close Call bot Telegram bağlantısı çalışıyor.")) console.log("Test mesajı gönderildi, Telegram'ı kontrol et.");
}

async function cmdDiag() {
  const state = loadState();
  const keys = loadKeys();
  const mine = new Set(keys.map((k) => k.did));
  const [flow, st, pnl] = await Promise.all([
    refereeRecords(ROOMS.flow), refereeRecords(ROOMS.state), refereeRecords(ROOMS.pnl),
  ]);
  const lastState = st.filter((r) => r.t === "state").at(-1) || {};
  console.log("state.rooms:", JSON.stringify(lastState.rooms)?.slice(0, 300), "| owners:", JSON.stringify(lastState.owners)?.slice(0, 80));
  console.log("son flow 'missed' alanları:");
  for (const r of flow.filter((x) => x.t === "flow").slice(-6)) console.log(`  n ${r.n}:`, JSON.stringify(r.missed)?.slice(0, 300));
  const board = pnl.filter((r) => r.t === "pnl").at(-1)?.top || [];
  const ours = board.filter((row) => mine.has(Array.isArray(row) ? row[0] : row?.key));
  console.log(`pnl top ${board.length}: lider ${JSON.stringify(board[0])}, 25. ${JSON.stringify(board.at(-1))}, bizden: ${ours.length}`);
  console.log("son gönderim cevapları:");
  for (const r of (state.responses || []).slice(-5)) console.log(`  ${r.at.slice(11, 19)} ${r.room} ${r.t} seq=${r.seq} ${r.raw}`);
}

const HELP = `Kullanım:
  node close-call-bot.mjs keys 9          keys/ klasörüne 9 yeni DID üretir
  node close-call-bot.mjs register        kayıtsız DID'leri yarışmaya kaydeder (main*.json atlanır)
  node close-call-bot.mjs status          fiyat, kayıt ve işlem durumlarını gösterir
  node close-call-bot.mjs pair --only 1   bir çifti hemen açar (LONG/SHORT)
       --qty max|20 miktar (varsayılan max: bakiyenin %98'i)
       --only 1,3   sadece belirtilen çiftler
       --again      zaten pozisyonda olan çifte ekleme yap
       --dry        göndermeden imzalı kaydı ekrana yazar
       --room X     trade'i belirli bir odaya at
  node close-call-bot.mjs auto            boş çiftleri yeni tepe/dipte ya da belli aralıkla otomatik açar
       --step 4     yeni tepe/dip eşiği (dolar)
       --hours 24   bu kadar saat giriş olmazsa yine aç
  node close-call-bot.mjs tick            auto'nun tek adımı (GitHub Actions için), Telegram'a bildirir
  node close-call-bot.mjs tg-setup        Telegram chat id'sini bulur, test mesajı yollar
  node close-call-bot.mjs diag            teşhis bilgisi`;

const { cmd, opts } = args();
const run = { keys: cmdKeys, status: cmdStatus, register: cmdRegister, pair: cmdPair, auto: cmdAuto, diag: cmdDiag, tick: cmdTick, "tg-setup": cmdTgSetup }[cmd];
if (!run) { console.log(HELP); process.exit(cmd ? 1 : 0); }
Promise.resolve(run(opts)).catch((err) => { console.error(`Hata: ${err.message}`); process.exit(1); });
