/**
 * HyperLaunch Railway Backend
 * Real-time pump.fun token streaming via Helius WebSocket
 * Stores everything in Supabase instantly as it happens on-chain
 */

const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");
const WebSocket = require("ws");
const express = require("express");

const app = express();
app.use(require("cors")());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://gptxwczyboghrctkqggo.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET;
const HELIUS_KEY  = process.env.HELIUS_KEY || "e6c9c34f-ff5b-441d-9ad6-0b32d512239a";
const SOL_USD     = parseFloat(process.env.SOL_USD || "170");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PUMP_PROGRAM  = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymtHPu";
const PUMP_MIGRATION = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";

function normalizeCoin(c) {
  const vSol = parseFloat(c.virtual_sol_reserves || 0) / 1e9;
  const vTok = parseFloat(c.virtual_token_reserves || 1);
  const bond = Math.min(100, parseFloat(c.bonding_curve_progress || 0));
  const mcap = parseFloat(c.usd_market_cap || 0) || (vSol > 0 ? vSol * 2 * SOL_USD : 0);
  const price = vTok > 0 ? (vSol / vTok) * SOL_USD : 0;
  const createdTs = c.created_timestamp
    ? Math.floor(c.created_timestamp / (c.created_timestamp > 1e12 ? 1000 : 1)) : 0;
  const lastTradeTs = c.last_trade_unix_time || c.last_trade_timestamp || createdTs;
  return {
    mint: c.mint, name: (c.name || "").slice(0, 80), symbol: (c.symbol || "").slice(0, 20),
    img: c.image_uri || null, twitter: c.twitter || null,
    telegram: c.telegram || null, website: c.website || null, creator: c.creator || null,
    created_at: createdTs,
    last_trade_at: Math.floor(lastTradeTs > 1e12 ? lastTradeTs / 1000 : lastTradeTs),
    complete: c.complete === true, bond, mcap, price,
    vol_24h: parseFloat(c.volume_24h || c.usd_volume_24h || 0),
    buys: parseInt(c.buy_count || c.buys || 0),
    sells: parseInt(c.sell_count || c.sells || 0),
    holders: parseInt(c.holder_count || c.holders || 0),
    liq: vSol > 0 ? vSol * 2 * SOL_USD : mcap * 0.1,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

async function upsert(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from("tokens").upsert(rows, {
    onConflict: "mint", ignoreDuplicates: false
  });
  if (error) console.error("Upsert error:", error.message);
}

let heliusWS = null;
let heliusReconnects = 0;

function connectHelius() {
  const url = `wss://atlas-mainnet.helius-rpc.com?api-key=${HELIUS_KEY}`;
  console.log("🔌 Connecting to Helius WebSocket...");
  heliusWS = new WebSocket(url);

  heliusWS.on("open", () => {
    heliusReconnects = 0;
    console.log("✅ Helius WS connected");
    heliusWS.send(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "transactionSubscribe",
      params: [
        { accountInclude: [PUMP_PROGRAM], type: "any", commitment: "confirmed",
          encoding: "jsonParsed", transactionDetails: "full", showRewards: false,
          maxSupportedTransactionVersion: 0 },
        { commitment: "confirmed" }
      ]
    }));
    console.log("📡 Subscribed to pump.fun transactions");
  });

  heliusWS.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.params?.result) return;
      const tx = msg.params.result;
      const meta = tx.transaction?.meta;
      const message = tx.transaction?.transaction?.message;
      if (!meta || !message) return;

      const logs = meta.logMessages || [];
      let isBuy = false, isSell = false, isMigration = false, isCreate = false;
      let mint = null;

      for (const log of logs) {
        if (log.includes("Instruction: Buy")) isBuy = true;
        if (log.includes("Instruction: Sell")) isSell = true;
        if (log.includes("Instruction: Create")) isCreate = true;
        if (log.includes("Instruction: Migrate") || log.includes(PUMP_MIGRATION)) isMigration = true;
      }

      if (meta.postTokenBalances?.length > 0) {
        mint = meta.postTokenBalances[0]?.mint || null;
      }
      if (!mint) return;

      const preBalances = meta.preBalances || [];
      const postBalances = meta.postBalances || [];
      let maxChange = 0;
      for (let i = 0; i < preBalances.length; i++) {
        const change = Math.abs((postBalances[i] || 0) - (preBalances[i] || 0));
        if (change > maxChange) maxChange = change;
      }
      const usd = (maxChange / 1e9) * SOL_USD;

      if (isBuy || isSell) {
        await supabase.rpc("increment_trade", {
          p_mint: mint, p_usd: usd, p_is_buy: isBuy,
        }).catch(() => null);
      }
      if (isMigration) {
        console.log(`🎓 Graduated: ${mint}`);
        await supabase.from("tokens").update({
          complete: true, bond: 100, updated_at: Math.floor(Date.now() / 1000),
        }).eq("mint", mint);
      }
      if (isCreate) {
        setTimeout(async () => {
          try {
            const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
              headers: { "Accept": "application/json", "Origin": "https://pump.fun" },
              signal: AbortSignal.timeout(8000),
            });
            if (r.ok) {
              const coin = await r.json();
              await upsert([normalizeCoin({ ...coin, mint })]);
              console.log(`✅ New token saved: ${coin.symbol || mint}`);
            }
          } catch(e) {}
        }, 2000);
      }
    } catch(e) {}
  });

  heliusWS.on("close", () => {
    heliusReconnects++;
    const delay = Math.min(1000 * heliusReconnects, 30000);
    console.log(`🔌 Reconnecting Helius in ${delay}ms...`);
    setTimeout(connectHelius, delay);
  });
  heliusWS.on("error", (e) => console.error("Helius error:", e.message));
}

let pumpWS = null;

function connectPumpFun() {
  console.log("🔌 Connecting to pump.fun WebSocket...");
  pumpWS = new WebSocket("wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket");
  let pingInterval;

  pumpWS.on("open", () => {
    console.log("✅ pump.fun WS connected");
    pumpWS.send("40");
    setTimeout(() => { try { pumpWS.send('42["joinRoom","global"]'); } catch(e) {} }, 500);
    pingInterval = setInterval(() => { try { if (pumpWS.readyState === 1) pumpWS.send("3"); } catch(e) {} }, 20000);
  });

  pumpWS.on("message", async (raw) => {
    try {
      const str = raw.toString();
      if (str === "2") { pumpWS.send("3"); return; }
      if (!str.startsWith("42")) return;
      const [evt, msg] = JSON.parse(str.slice(2));
      if (!msg?.mint) return;

      if (evt === "newCoinCreated" || evt === "tokenCreated") {
        console.log(`🆕 ${msg.symbol || msg.mint}`);
        await upsert([normalizeCoin(msg)]);
      }

      if (evt === "tradeCreated" || evt === "trade") {
        const rawSol = parseFloat(msg.sol_amount || 0);
        const sol = rawSol > 1000 ? rawSol / 1e9 : rawSol;
        const usd = sol * SOL_USD;
        const mcap = parseFloat(msg.market_cap_sol || 0) * SOL_USD;
        const bond = parseFloat(msg.bonding_curve_progress || 0);
        const now = Math.floor(Date.now() / 1000);
        await supabase.from("tokens").update({
          last_trade_at: now, updated_at: now,
          ...(mcap > 0 ? { mcap } : {}),
          ...(bond > 0 ? { bond } : {}),
        }).eq("mint", msg.mint);
        await supabase.rpc("increment_trade", {
          p_mint: msg.mint, p_usd: usd, p_is_buy: msg.is_buy === true,
        }).catch(() => null);
      }

      if (evt === "tokenMigrated" || (msg.complete === true && msg.migration_tx)) {
        console.log(`🎓 Migrated: ${msg.symbol || msg.mint}`);
        await supabase.from("tokens").update({
          complete: true, bond: 100, updated_at: Math.floor(Date.now() / 1000),
        }).eq("mint", msg.mint);
      }
    } catch(e) {}
  });

  pumpWS.on("close", () => {
    clearInterval(pingInterval);
    setTimeout(connectPumpFun, 3000);
  });
  pumpWS.on("error", () => {});
}

async function backfill() {
  console.log("🔄 Backfilling...");
  const sorts = [
    { sort: "last_trade_timestamp", order: "DESC", pages: 10 },
    { sort: "created_timestamp",    order: "DESC", pages: 5  },
    { sort: "volume_24h",           order: "DESC", pages: 10 },
  ];
  for (const { sort, order, pages } of sorts) {
    for (let p = 0; p < pages; p++) {
      try {
        const r = await fetch(
          `https://frontend-api-v3.pump.fun/coins?limit=200&offset=${p*200}&sort=${sort}&order=${order}&includeNsfw=false`,
          { headers: { "Accept": "application/json", "Origin": "https://pump.fun" }, signal: AbortSignal.timeout(10000) }
        );
        if (!r.ok) break;
        const d = await r.json();
        const coins = Array.isArray(d) ? d : (d.coins || []);
        if (!coins.length) break;
        await upsert(coins.map(normalizeCoin).filter(t => t.mint));
        console.log(`  ${sort} p${p+1}: +${coins.length}`);
        await sleep(600);
      } catch(e) { break; }
    }
    await sleep(1000);
  }
  const { count } = await supabase.from("tokens").select("*", { count: "exact", head: true });
  console.log(`✅ Backfill done. Total: ${count}`);
}

app.get("/health", async (req, res) => {
  const { count } = await supabase.from("tokens").select("*", { count: "exact", head: true });
  res.json({ ok: true, tokens: count,
    helius: heliusWS?.readyState === 1 ? "connected" : "disconnected",
    pumpfun: pumpWS?.readyState === 1 ? "connected" : "disconnected",
    uptime: process.uptime() });
});

app.get("/stats", async (req, res) => {
  const { data } = await supabase.from("tokens").select("complete, bond");
  res.json({
    total: data?.length || 0,
    newPairs: data?.filter(t => !t.complete && t.bond < 33).length || 0,
    finalStretch: data?.filter(t => !t.complete && t.bond >= 33).length || 0,
    migrated: data?.filter(t => t.complete).length || 0,
  });
});

async function boot() {
  console.log("🚀 HyperLaunch starting...");
  backfill().catch(console.error);
  connectPumpFun();
  connectHelius();
  app.listen(PORT, () => console.log(`🌐 Port ${PORT}`));
}

boot().catch(console.error);
