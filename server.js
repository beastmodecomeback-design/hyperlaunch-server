const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 3000;
const HELIUS_KEY = process.env.HELIUS_KEY || "e6c9c34f-ff5b-441d-9ad6-0b32d512239a";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const IPFS_GWS = [
  "https://cf-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://nftstorage.link/ipfs/",
];

function resolveIPFS(url) {
  if (!url) return null;
  if (url.startsWith("ipfs://")) return IPFS_GWS[0] + url.slice(7).split("?")[0];
  const m = url.match(/\/ipfs\/([a-zA-Z0-9]{30,})/);
  if (m) return IPFS_GWS[0] + m[1];
  return url;
}

const tokenCache = new Map();
const clients = new Set();

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tokens: tokenCache.size, clients: clients.size }));
    return;
  }
  res.writeHead(200);
  res.end("HYPERLAUNCH OK");
});

const wss = new WebSocket.Server({ server });
wss.on("connection", ws => {
  clients.add(ws);
  const snap = [...tokenCache.values()]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 50);
  ws.send(JSON.stringify({ type: "snapshot", tokens: snap }));
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (e) {}
    }
  }
}

function handleNewToken(mint, name, symbol, rawImg, twitter, telegram, website, mcap, bond) {
  if (tokenCache.has(mint)) return;
  const token = {
    id: mint, addr: mint, pairAddr: mint,
    name: (symbol || "?").toUpperCase(),
    sym: (symbol || "?").toUpperCase().slice(0, 6),
    fullName: name || symbol || "",
    chain: "SOL", dex: "pump.fun", isPump: true,
    img: rawImg ? resolveIPFS(rawImg) : null,
    twitter: twitter || null,
    telegram: telegram || null,
    website: website || null,
    price: 0, c24: 0, vol: 0,
    mcap: parseFloat(mcap || 0) || 0,
    fdv: parseFloat(mcap || 0) || 0,
    age: 0, bond: parseFloat(bond || 0) || 0,
    buys: 0, sells: 0, holders: 0,
    url: "https://pump.fun/coin/" + mint,
    createdAt: Date.now(),
  };
  tokenCache.set(mint, token);
  broadcast("newToken", { token });
  console.log(`⚡ ${token.sym} | ${mint.slice(0, 8)} | img=${!!rawImg}`);
}

function connectHelius() {
  console.log("Connecting Helius Enhanced WS...");
  const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`);
  let pingInterval;
  ws.on("open", () => {
    console.log("✅ Helius Enhanced WS connected");
    ws.send(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "transactionSubscribe",
      params: [
        { accountInclude: [PUMP_PROGRAM], failed: false },
        { commitment: "confirmed", encoding: "jsonParsed", transactionDetails: "full", maxSupportedTransactionVersion: 0 }
      ]
    }));
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping" }));
      }
    }, 15000);
  });
  ws.on("message", async data => {
    try {
      const msg = JSON.parse(data.toString());
      const result = msg?.params?.result;
      if (!result) return;
      const logs = result?.transaction?.meta?.logMessages || [];
      const isCreate = logs.some(l => l.includes("InitializeMint2") || l.includes("Instruction: Create"));
      if (!isCreate) {
        const mint = result?.transaction?.meta?.postTokenBalances?.[0]?.mint;
        if (mint && tokenCache.has(mint)) {
          const t = tokenCache.get(mint);
          const isBuy = logs.some(l => l.includes("Instruction: Buy"));
          const preB = result?.transaction?.meta?.preBalances?.[0] || 0;
          const postB = result?.transaction?.meta?.postBalances?.[0] || 0;
          const sol = Math.abs(postB - preB) / 1e9;
          t.vol = (t.vol || 0) + sol * 170;
          if (isBuy) t.buys = (t.buys || 0) + 1;
          else t.sells = (t.sells || 0) + 1;
          tokenCache.set(mint, t);
          broadcast("updateToken", { token: { mint, addr: mint, id: mint, _trade: { type: isBuy ? "buy" : "sell", usd: sol * 170, mcapSol: 0 } } });
        }
        return;
      }
      const keys = result?.transaction?.transaction?.message?.accountKeys || [];
      const mint = keys[1]?.pubkey || keys[1];
      if (!mint || tokenCache.has(mint)) return;
      console.log(`⚡ Helius: new token ${mint.slice(0,8)}`);
      try {
        const urls = [`https://frontend-api-v3.pump.fun/coins/${mint}`, `https://frontend-api.pump.fun/coins/${mint}`];
        const d = await Promise.any(urls.map(u =>
          fetch(u, { timeout: 4000, headers: { Accept: "application/json" } }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        ));
        handleNewToken(mint, d.name, d.symbol, d.image_uri, d.twitter, d.telegram, d.website, d.usd_market_cap, d.bonding_curve_progress);
      } catch(e) {
        handleNewToken(mint, "?", "?", null, null, null, null, 0, 0);
      }
    } catch (e) {}
  });
  ws.on("close", () => { clearInterval(pingInterval); setTimeout(connectHelius, 2000); });
  ws.on("error", e => { clearInterval(pingInterval); setTimeout(connectHelius, 3000); });
}

function connectPumpFun() {
  const ws = new WebSocket("wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket");
  ws.on("open", () => {
    ws.send("40");
    setTimeout(() => { try { ws.send('42["joinRoom","global"]'); } catch (e) {} }, 300);
    console.log("✅ pump.fun WS connected (backup)");
  });
  ws.on("message", async data => {
    try {
      const raw = data.toString();
      if (raw === "2") { ws.send("3"); return; }
      if (!raw.startsWith("42")) return;
      const arr = JSON.parse(raw.slice(2));
      if (!arr?.[0]) return;
      const evt = arr[0], msg = arr[1];
      if (evt === "newCoinCreated" || evt === "tokenCreated") {
        const mint = msg?.mint || "";
        if (!mint || tokenCache.has(mint)) return;
        handleNewToken(mint, msg.name, msg.symbol, msg.image_uri || msg.imageUri, msg.twitter, msg.telegram, msg.website, msg.usd_market_cap, msg.bonding_curve_progress);
      }
      if (evt === "tradeCreated" || evt === "trade") {
        const mint = msg?.mint || "";
        if (!mint || !tokenCache.has(mint)) return;
        const t = tokenCache.get(mint);
        const sol = parseFloat(msg.sol_amount || msg.solAmount || 0);
        const isBuy = msg.is_buy === true || msg.txType === "buy";
        t.vol = (t.vol || 0) + sol * 170;
        t.mcap = parseFloat(msg.market_cap_sol || 0) * 170 || t.mcap;
        if (isBuy) t.buys = (t.buys || 0) + 1;
        else t.sells = (t.sells || 0) + 1;
        tokenCache.set(mint, t);
        broadcast("updateToken", { token: { mint, addr: mint, id: mint, _trade: { type: isBuy ? "buy" : "sell", usd: sol * 170, mcapSol: parseFloat(msg.market_cap_sol || 0) } } });
      }
    } catch (e) {}
  });
  ws.on("close", () => setTimeout(connectPumpFun, 2000));
  ws.on("error", () => setTimeout(connectPumpFun, 3000));
}

setInterval(() => {
  if (tokenCache.size > 500) {
    const keep = [...tokenCache.entries()].sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0)).slice(0, 400);
    tokenCache.clear();
    keep.forEach(([k, v]) => tokenCache.set(k, v));
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`\n🚀 HYPERLAUNCH SERVER v5`);
  console.log(`   Port:   ${PORT}`);
  console.log(`   Helius: ${HELIUS_KEY.slice(0,8)}...`);
  connectHelius();
  connectPumpFun();
});
