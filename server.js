/**
 * HyperLaunch Token Sync Service
 * Syncs ALL pump.fun tokens into Supabase
 */

const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET;
const SOL_USD = parseFloat(process.env.SOL_USD || "170");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeCoin(c) {
  const vSol = parseFloat(c.virtual_sol_reserves || 0) / 1e9;
  const vTok = parseFloat(c.virtual_token_reserves || 1);
  const bond = Math.min(100, parseFloat(c.bonding_curve_progress || 0));
  const mcap = parseFloat(c.usd_market_cap || 0) || (vSol > 0 ? vSol * 2 * SOL_USD : 0);
  const price = vTok > 0 ? (vSol / vTok) * SOL_USD : 0;
  const createdTs = c.created_timestamp ? Math.floor(c.created_timestamp / (c.created_timestamp > 1e12 ? 1000 : 1)) : 0;
  const lastTradeTs = c.last_trade_unix_time || c.last_trade_timestamp || createdTs;
  return {
    mint: c.mint, name: (c.name || "").slice(0, 80), symbol: (c.symbol || "").slice(0, 20),
    img: c.image_uri || null, twitter: c.twitter || null, telegram: c.telegram || null,
    website: c.website || null, creator: c.creator || null, created_at: createdTs,
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

async function fetchPage(sort, order, offset, limit = 200) {
  const url = `https://frontend-api-v3.pump.fun/coins?limit=${limit}&offset=${offset}&sort=${sort}&order=${order}&includeNsfw=false`;
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "Accept": "application/json", "Origin": "https://pump.fun", "Referer": "https://pump.fun/", "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok) { console.log(`HTTP ${r.status} for ${sort} offset ${offset}`); return []; }
    const d = await r.json();
    return Array.isArray(d) ? d : (d.coins || []);
  } catch(e) { console.log(`Fetch error: ${e.message}`); return []; }
}

async function upsertBatch(coins) {
  if (!coins.length) return 0;
  const rows = coins.map(normalizeCoin).filter(t => t.mint && t.mint.length > 10);
  if (!rows.length) return 0;
  const { error } = await supabase.from("tokens").upsert(rows, { onConflict: "mint", ignoreDuplicates: false });
  if (error) { console.error("Upsert error:", error.message); return 0; }
  return rows.length;
}

async function deepSync() {
  console.log("🔄 Running deep sync...");
  let total = 0;

  const sorts = [
    { sort: "last_trade_timestamp", order: "DESC", pages: 50 },
    { sort: "created_timestamp",    order: "DESC", pages: 50 },
    { sort: "volume_24h",           order: "DESC", pages: 25 },
    { sort: "usd_market_cap",       order: "DESC", pages: 25 },
  ];

  for (const { sort, order, pages } of sorts) {
    let fetched = 0;
    let emptyStreak = 0;
    for (let p = 0; p < pages; p++) {
      const coins = await fetchPage(sort, order, p * 200);
      if (!coins.length) {
        emptyStreak++;
        if (emptyStreak >= 2) break;
        await sleep(3000);
        continue;
      }
      emptyStreak = 0;
      const n = await upsertBatch(coins);
      fetched += n;
      console.log(`  ${sort} p${p+1}: +${n} (running: ${fetched})`);
      await sleep(1000);
    }
    console.log(`✅ ${sort}: ${fetched} tokens`);
    total += fetched;
    await sleep(3000);
  }

  const { count } = await supabase.from("tokens").select("*", { count: "exact", head: true });
  console.log(`✅ Deep sync done. DB total: ${count}`);
  return total;
}

async function syncRecent() {
  console.log("🔄 Syncing recent tokens...");
  let total = 0;
  for (const sort of ["last_trade_timestamp", "volume_24h", "created_timestamp"]) {
    for (let offset = 0; offset < 1000; offset += 200) {
      const coins = await fetchPage(sort, "DESC", offset);
      if (!coins.length) break;
      total += await upsertBatch(coins);
      await sleep(600);
    }
    await sleep(1000);
  }
  console.log(`✅ Recent sync done: ${total} tokens`);
  return total;
}

async function main() {
  const mode = process.argv[2] || "recent";
  console.log(`🚀 Mode: ${mode}`);
  const { count } = await supabase.from("tokens").select("*", { count: "exact", head: true });
  console.log(`📊 DB count: ${count || 0}`);
  if (mode === "deep" || (count || 0) < 500) { await deepSync(); } else { await syncRecent(); }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
