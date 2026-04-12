const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");
 
const PORT        = process.env.PORT || 3000;
const HELIUS_KEY  = process.env.HELIUS_KEY || "e6c9c34f-ff5b-441d-9ad6-0b32d512239a";
const PUMP_PROG   = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM    = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const HELIUS_RPC  = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_WS   = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const SOL_USD     = 170;
const INIT_REAL   = 793100000000000n; // bigint for precision
 
const IPFS = ["https://cf-ipfs.com/ipfs/","https://ipfs.io/ipfs/"];
const ipfs = u => {
  if (!u) return null;
  if (u.startsWith("ipfs://")) return IPFS[0] + u.slice(7).split("?")[0];
  const m = u.match(/\/ipfs\/([a-zA-Z0-9]{30,})/);
  return m ? IPFS[0] + m[1] : u;
};
 
// Bond % from realTokenReserves (bigint or number)
const calcBond = r => {
  try {
    const big = BigInt(Math.floor(Number(r)));
    if (big <= 0n) return 0;
    if (big >= INIT_REAL) return 0;
    return Number((INIT_REAL - big) * 10000n / INIT_REAL) / 100;
  } catch(e) { return 0; }
};
 
// Parse pump.fun bonding curve account data (base64)
function parseBondingCurve(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 48) return null;
    return {
      virtualTokenReserves: buf.readBigUInt64LE(8),
      virtualSolReserves:   buf.readBigUInt64LE(16),
      realTokenReserves:    buf.readBigUInt64LE(24),
      realSolReserves:      buf.readBigUInt64LE(32),
      complete:             buf[40] === 1,
    };
  } catch(e) { return null; }
}
 
// ── Stores ────────────────────────────────────────────────────────────────────
const tokens   = new Map(); // mint → token
const curves   = new Map(); // bondingCurveAddress → mint
const subToCurve = new Map(); // helius subId → bondingCurveAddress
const clients  = new Set();
 
// ── HTTP + WS server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok:true, tokens:tokens.size, clients:clients.size, curves:curves.size, v:7 }));
    return;
  }
  res.end("HYPERLAUNCH v7");
});
 
const wss = new WebSocket.Server({ server });
wss.on("connection", ws => {
  clients.add(ws);
  // Send full snapshot to new client
  ws.send(JSON.stringify({
    type: "snapshot",
    tokens: [...tokens.values()].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,200)
  }));
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});
 
function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const ws of clients)
    if (ws.readyState === WebSocket.OPEN) try { ws.send(msg); } catch(e) {}
}
 
// ── Token helpers ─────────────────────────────────────────────────────────────
function upsert(mint, update) {
  const base = tokens.get(mint) || {
    id:mint, addr:mint, pairAddr:mint, name:"?", sym:"?", fullName:"",
    chain:"SOL", dex:"pump.fun", isPump:true, complete:false,
    img:null, twitter:null, telegram:null, website:null,
    price:0, c24:0, vol:0, mcap:0, bond:0,
    buys:0, sells:0, holders:0,
    url:"https://pump.fun/coin/"+mint, createdAt:Date.now(),
  };
  const merged = { ...base, ...update };
  tokens.set(mint, merged);
  return merged;
}
 
function applyBondingCurve(mint, state) {
  if (!state) return;
  const bond = state.complete ? 100 : calcBond(state.realTokenReserves);
  const vSol = Number(state.virtualSolReserves) / 1e9;
  const vTok = Number(state.virtualTokenReserves) / 1e6;
  const price = vTok > 0 ? (vSol / vTok) * SOL_USD : 0;
  const mcap  = price * 1e9;
  const prev  = tokens.get(mint);
 
  const t = upsert(mint, { bond, price, mcap, complete: state.complete });
 
  if (state.complete && (!prev || !prev.complete)) {
    broadcast("graduation", { token: t });
    console.log(`🎓 GRAD ${t.sym} | ${mint.slice(0,8)} | $${(mcap/1000).toFixed(1)}K`);
  } else if (!prev || Math.abs((prev.bond||0) - bond) > 0.3) {
    broadcast("bondUpdate", { mint, bond, mcap, price, complete: state.complete });
  }
}
 
// ── Helius accountSubscribe on a bonding curve ────────────────────────────────
// We use a SINGLE persistent WebSocket for all account subscriptions
let subWs = null;
let subIdCounter = 1;
const pendingSubs = new Map(); // subId → resolve
 
function ensureSubWs() {
  if (subWs && subWs.readyState === WebSocket.OPEN) return;
  console.log("🔌 Connecting Helius account subscription WS...");
  subWs = new WebSocket(HELIUS_WS);
 
  subWs.on("open", () => {
    console.log("✅ Account sub WS connected");
    // Re-subscribe to all known curves
    for (const [curveAddr] of curves) subscribeToCurve(curveAddr);
  });
 
  subWs.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
 
      // Subscription confirmation
      if (msg.result !== undefined && msg.id) {
        const curveAddr = pendingSubs.get(msg.id);
        if (curveAddr) {
          subToCurve.set(msg.result, curveAddr);
          pendingSubs.delete(msg.id);
        }
        return;
      }
 
      // Account update notification
      if (msg.method === "accountNotification") {
        const subId   = msg.params?.subscription;
        const b64     = msg.params?.result?.value?.data?.[0];
        const curveAddr = subToCurve.get(subId);
        if (!curveAddr || !b64) return;
        const mint = curves.get(curveAddr);
        if (!mint) return;
        const state = parseBondingCurve(b64);
        if (state) applyBondingCurve(mint, state);
      }
    } catch(e) {}
  });
 
  subWs.on("close", () => { console.log("🔌 Account sub WS closed — reconnect 3s"); setTimeout(ensureSubWs, 3000); });
  subWs.on("error", e => { console.error("❌ Account sub WS error:", e.message); setTimeout(ensureSubWs, 3000); });
}
 
function subscribeToCurve(curveAddr) {
  if (!subWs || subWs.readyState !== WebSocket.OPEN) return;
  const id = subIdCounter++;
  pendingSubs.set(id, curveAddr);
  subWs.send(JSON.stringify({
    jsonrpc: "2.0", id,
    method: "accountSubscribe",
    params: [curveAddr, { encoding: "base64", commitment: "confirmed" }]
  }));
}
 
// ── Derive bonding curve PDA from mint ───────────────────────────────────────
// pump.fun uses PDA: ["bonding-curve", mint] under PUMP_PROG
async function getBondingCurveAddr(mint) {
  try {
    // Use Helius RPC to get the bonding curve address
    // The bonding curve is at getProgramAccounts filtered by mint
    const r = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getProgramAccounts",
        params: [PUMP_PROG, {
          encoding: "base64",
          filters: [
            { dataSize: 49 },
            { memcmp: { offset: 8, bytes: mint } }
          ]
        }]
      }),
      timeout: 5000,
    });
    const d = await r.json();
    return d?.result?.[0]?.pubkey || null;
  } catch(e) { return null; }
}
 
// Fetch and subscribe to a token's bonding curve
async function watchBondingCurve(mint) {
  if (curves.values && [...curves.values()].includes(mint)) return; // already watching
  try {
    const curveAddr = await getBondingCurveAddr(mint);
    if (!curveAddr) return;
    curves.set(curveAddr, mint);
 
    // Fetch current state immediately
    const r = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getAccountInfo",
        params: [curveAddr, { encoding: "base64" }]
      }),
      timeout: 4000,
    });
    const d = await r.json();
    const b64 = d?.result?.value?.data?.[0];
    if (b64) applyBondingCurve(mint, parseBondingCurve(b64));
 
    // Subscribe for real-time updates
    subscribeToCurve(curveAddr);
  } catch(e) {}
}
 
// ── SOURCE 1: Helius transactionSubscribe (new tokens + trades) ───────────────
function connectHelius() {
  console.log("🔌 Connecting Helius transaction WS...");
  const ws = new WebSocket(HELIUS_WS);
  let ping;
 
  ws.on("open", () => {
    console.log("✅ Helius transaction WS connected");
    ws.send(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "transactionSubscribe",
      params: [
        { accountInclude: [PUMP_PROG], failed: false },
        { commitment: "confirmed", encoding: "jsonParsed", transactionDetails: "full", maxSupportedTransactionVersion: 0 }
      ]
    }));
    ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping" }));
    }, 15000);
  });
 
  ws.on("message", async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      const result = msg?.params?.result;
      if (!result) return;
 
      const logs = result?.transaction?.meta?.logMessages || [];
      const keys = result?.transaction?.transaction?.message?.accountKeys || [];
      const getKey = i => keys[i]?.pubkey || keys[i] || "";
 
      const isCreate = logs.some(l => l.includes("Instruction: Create") || l.includes("InitializeMint2"));
      const isBuy    = logs.some(l => l.includes("Instruction: Buy"));
      const isSell   = logs.some(l => l.includes("Instruction: Sell"));
      const isGrad   = logs.some(l => l.includes("InitializePool") || l.includes(PUMP_AMM));
 
      if (isCreate) {
        const mint      = getKey(1);
        const curveAddr = getKey(2);
        if (!mint || mint.length < 32) return;
 
        if (curveAddr) curves.set(curveAddr, mint);
 
        if (!tokens.has(mint)) {
          console.log(`⚡ NEW ${mint.slice(0,8)}`);
          try {
            const d = await Promise.any([
              `https://frontend-api-v3.pump.fun/coins/${mint}`,
              `https://frontend-api.pump.fun/coins/${mint}`,
            ].map(u => fetch(u, { timeout: 5000 }).then(r => { if(!r.ok) throw 0; return r.json(); })));
            const t = upsert(mint, {
              name: (d.symbol||"?").toUpperCase(), sym: (d.symbol||"?").toUpperCase().slice(0,6),
              fullName: d.name||d.symbol||"", img: d.image_uri?ipfs(d.image_uri):null,
              twitter:d.twitter||null, telegram:d.telegram||null, website:d.website||null,
              mcap: parseFloat(d.usd_market_cap||0)||0, complete: !!(d.complete),
            });
            broadcast("newToken", { token: t });
          } catch(e) {
            const t = upsert(mint, {});
            broadcast("newToken", { token: t });
          }
          // Start watching the bonding curve immediately
          if (curveAddr) {
            subscribeToCurve(curveAddr);
          } else {
            watchBondingCurve(mint);
          }
        }
        return;
      }
 
      if (isGrad) {
        const postTok = result?.transaction?.meta?.postTokenBalances || [];
        for (const b of postTok) {
          if (b.mint && b.mint.length > 30 && b.mint !== PUMP_PROG) {
            const t = upsert(b.mint, { bond: 100, complete: true });
            broadcast("graduation", { token: t });
            console.log(`🎓 GRAD ${b.mint.slice(0,8)}`);
            break;
          }
        }
        return;
      }
 
      if (isBuy || isSell) {
        const postTok = result?.transaction?.meta?.postTokenBalances || [];
        const mint = postTok[0]?.mint || postTok[1]?.mint;
        if (!mint || mint.length < 32) return;
 
        const preB  = result?.transaction?.meta?.preBalances?.[0] || 0;
        const postB = result?.transaction?.meta?.postBalances?.[0] || 0;
        const sol = Math.abs(postB - preB) / 1e9;
 
        const prev = tokens.get(mint) || {};
        upsert(mint, {
          vol:   (prev.vol||0) + sol * SOL_USD,
          buys:  (prev.buys||0)  + (isBuy ? 1 : 0),
          sells: (prev.sells||0) + (!isBuy ? 1 : 0),
        });
 
        broadcast("updateToken", {
          token: { mint, addr:mint, id:mint,
            vol: tokens.get(mint).vol,
            buys: tokens.get(mint).buys, sells: tokens.get(mint).sells,
            _trade: { type: isBuy?"buy":"sell", usd: sol*SOL_USD }
          }
        });
 
        // Bonding curve update comes via accountSubscribe — no polling needed
        // But if we haven't subscribed yet, start now
        const curveAddr = getKey(3);
        if (curveAddr && curveAddr.length > 30 && !curves.has(curveAddr)) {
          curves.set(curveAddr, mint);
          subscribeToCurve(curveAddr);
        }
      }
    } catch(e) {}
  });
 
  ws.on("close", () => { clearInterval(ping); console.log("🔌 Tx WS closed — reconnect 2s"); setTimeout(connectHelius, 2000); });
  ws.on("error", e  => { clearInterval(ping); console.error("❌ Tx WS error:", e.message); setTimeout(connectHelius, 3000); });
}
 
// ── SOURCE 2: pump.fun Socket.IO (backup for images/metadata) ────────────────
function connectPumpFun() {
  const ws = new WebSocket("wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket");
  ws.on("open", () => {
    ws.send("40");
    setTimeout(() => { try { ws.send('42["joinRoom","global"]'); } catch(e) {} }, 300);
    console.log("✅ pump.fun WS connected (image backup)");
  });
  ws.on("message", data => {
    try {
      const raw = data.toString();
      if (raw === "2") { ws.send("3"); return; }
      if (!raw.startsWith("42")) return;
      const arr = JSON.parse(raw.slice(2));
      const evt = arr?.[0], m = arr?.[1];
      if (!evt || !m?.mint) return;
 
      if (evt === "newCoinCreated" || evt === "tokenCreated") {
        const prev = tokens.get(m.mint);
        if (!prev) return;
        // Just fill in missing image/socials
        if (!prev.img && (m.image_uri||m.imageUri)) {
          upsert(m.mint, { img: ipfs(m.image_uri||m.imageUri), twitter:m.twitter||null, telegram:m.telegram||null, website:m.website||null });
          broadcast("updateToken", { token: { mint:m.mint, addr:m.mint, img: tokens.get(m.mint).img } });
        }
      }
 
      if (evt === "tradeCreated" || evt === "trade") {
        const prev = tokens.get(m.mint) || {};
        const sol = parseFloat(m.sol_amount||m.solAmount||0);
        const isBuy = m.is_buy===true||m.txType==="buy";
        upsert(m.mint, {
          vol: (prev.vol||0) + sol * SOL_USD,
          buys: (prev.buys||0) + (isBuy?1:0), sells: (prev.sells||0) + (!isBuy?1:0),
        });
      }
    } catch(e) {}
  });
  ws.on("close", () => setTimeout(connectPumpFun, 2000));
  ws.on("error", () => setTimeout(connectPumpFun, 3000));
}
 
// ── Initial load from pump.fun REST API ───────────────────────────────────────
async function loadInitial() {
  console.log("📥 Loading initial token data...");
  const endpoints = [
    "https://frontend-api-v3.pump.fun/coins?limit=50&sort=created_timestamp&order=DESC",
    "https://frontend-api-v3.pump.fun/coins?limit=50&sort=bonding_curve_progress&order=DESC",
    "https://frontend-api-v3.pump.fun/coins?limit=30&sort=last_trade_timestamp&order=DESC&complete=true",
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, { timeout: 8000 });
      if (!r.ok) continue;
      const arr = await r.json().then(d => Array.isArray(d)?d:(d.coins||[]));
      for (const c of arr) {
        if (!c.mint) continue;
        const realTok = parseFloat(c.real_token_reserves||0);
        const bond = realTok > 0 ? calcBond(realTok) : parseFloat(c.bonding_curve_progress||0)||0;
        const t = upsert(c.mint, {
          name: (c.symbol||"?").toUpperCase(), sym: (c.symbol||"?").toUpperCase().slice(0,6),
          fullName: c.name||c.symbol||"",
          img: c.image_uri?ipfs(c.image_uri):null,
          twitter:c.twitter||null, telegram:c.telegram||null, website:c.website||null,
          mcap: parseFloat(c.usd_market_cap||0)||0, vol: parseFloat(c.volume_24h||0)||0,
          buys: parseFloat(c.buy_count||c.buys||0)||0, sells: parseFloat(c.sell_count||c.sells||0)||0,
          bond, complete: !!(c.complete),
        });
        // Start watching bonding curve for non-graduated tokens
        if (!c.complete) watchBondingCurve(c.mint);
      }
      console.log(`  ✓ Loaded ${arr.length} from ${url.split("?")[1]}`);
    } catch(e) { console.log("  ✗ Failed:", url.split("coins")[1]); }
  }
  console.log(`📊 Initial load complete: ${tokens.size} tokens, watching ${curves.size} curves`);
}
 
// Cache cleanup
setInterval(() => {
  if (tokens.size > 1000) {
    const keep = [...tokens.entries()].sort((a,b)=>(b[1].createdAt||0)-(a[1].createdAt||0)).slice(0,700);
    tokens.clear(); keep.forEach(([k,v])=>tokens.set(k,v));
    console.log(`🧹 Cache trimmed → ${tokens.size}`);
  }
}, 120000);
 
// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🚀 HYPERLAUNCH SERVER v7`);
  console.log(`   Port:    ${PORT}`);
  console.log(`   Helius:  ${HELIUS_KEY.slice(0,8)}... (transactionSubscribe + accountSubscribe)`);
  console.log(`   No polling — 100% real-time via Helius\n`);
 
  ensureSubWs();       // Account subscription WebSocket
  connectHelius();     // Transaction subscription WebSocket  
  connectPumpFun();    // pump.fun WS for image backup
 
  await loadInitial(); // Load seed data once on startup
});
 
