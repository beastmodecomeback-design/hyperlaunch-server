/*  HYPERLAUNCH BACKEND SERVER v4
 *  ─────────────────────────────────────────────────────────────────
 *  Key feature: image proxy cache
 *  - Downloads IPFS images server-side the moment token is created
 *  - Serves them from /img/MINT — browser gets image from Railway CDN
 *  - No more waiting for IPFS from the browser side
 */

const http    = require("http");
const WebSocket = require("ws");
const fetch   = require("node-fetch");

const HELIUS_KEY = process.env.HELIUS_KEY || "e6c9c34f-ff5b-441d-9ad6-0b32d512239a";
const PORT       = process.env.PORT || 3000;
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const IPFS_GWS = [
  "https://cf-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

function resolveIPFS(url) {
  if (!url) return null;
  if (url.startsWith("ipfs://")) return IPFS_GWS[0] + url.slice(7).split("?")[0];
  const m = url.match(/\/ipfs\/([a-zA-Z0-9]{30,})/);
  if (m) return IPFS_GWS[0] + m[1];
  return url;
}

function ipfsCID(url) {
  if (!url) return null;
  if (url.startsWith("ipfs://")) return url.slice(7).split("?")[0];
  const m = url.match(/\/ipfs\/([a-zA-Z0-9]{30,})/);
  return m ? m[1] : null;
}

const tokenCache = new Map();
const imageCache = new Map();
const clients    = new Set();

async function downloadImage(url, mint) {
  if (imageCache.has(mint)) return;
  if (!url) return;
  const cid = ipfsCID(url);
  const urls = cid ? IPFS_GWS.map(gw => gw + cid) : [url];
  try {
    const res = await Promise.any(urls.map(u =>
      fetch(u, { timeout: 8000 }).then(r => { if (!r.ok) throw new Error(r.status); return r; })
    ));
    const type = res.headers.get("content-type") || "image/jpeg";
    const data = await res.buffer();
    if (data.length > 0) {
      imageCache.set(mint, { data, type });
      console.log(`🖼  ${mint.slice(0,8)} cached ${Math.round(data.length/1024)}KB`);
      if (tokenCache.has(mint)) {
        const t = tokenCache.get(mint);
        t.imgProxy = "/img/" + mint;
        tokenCache.set(mint, t);
        broadcast("updateToken", { token: t });
      }
    }
  } catch(e) {
    setTimeout(() => downloadImage(url, mint), 3000);
  }
}

const server = http.createServer((req, res) => {
  const url = req.url;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }
  if (url.startsWith("/img/")) {
    const mint = url.slice(5).split("?")[0];
    if (imageCache.has(mint)) {
      const { data, type } = imageCache.get(mint);
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=31536000", "Content-Length": data.length });
      res.end(data);
      return;
    }
    res.writeHead(404); res.end("not cached yet");
    return;
  }
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, tokens: tokenCache.size, images: imageCache.size, clients: clients.size }));
    return;
  }
  res.writeHead(200); res.end("HYPERLAUNCH v4");
});

const wss = new WebSocket.Server({ server });
wss.on("connection", ws => {
  clients.add(ws);
  const snap = [...tokenCache.values()].sort((a,b) => (b.createdAt||0)-(a.createdAt||0)).slice(0, 50);
  ws.send(JSON.stringify({ type: "snapshot", tokens: snap }));
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch(e) {} }
  }
}

async function fetchMeta(uri) {
  const cid = uri.startsWith("ipfs://") ? uri.slice(7) : null;
  const urls = cid ? IPFS_GWS.map(gw => gw + cid) : [uri];
  return Promise.any(urls.map(u =>
    fetch(u, { timeout: 5000 }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(m => { if (!m?.image) throw new Error("no image"); return m; })
  ));
}

async function handleNewToken(mint, name, symbol, uri, rawImg, twitter, telegram, website) {
  if (tokenCache.has(mint)) return;
  const token = {
    id: mint, addr: mint, pairAddr: mint,
    name: symbol.toUpperCase(), sym: symbol.toUpperCase().slice(0, 6), fullName: name,
    chain: "SOL", dex: "pump.fun", isPump: true,
    img: rawImg ? resolveIPFS(rawImg) : null, imgProxy: null,
    twitter: twitter || null, telegram: telegram || null, website: website || null,
    price: 0, c24: 0, vol: 0, mcap: 0, age: 0, bond: 0, buys: 0, sells: 0, holders: 0,
    url: "https://pump.fun/coin/" + mint, createdAt: Date.now(),
  };
  tokenCache.set(mint, token);
  broadcast("newToken", { token });
  console.log(`⚡ ${symbol} | ${mint.slice(0,8)} | img=${!!rawImg}`);
  const imgUrl = rawImg ? resolveIPFS(rawImg) : null;
  if (imgUrl) downloadImage(imgUrl, mint);
  const needsMeta = !rawImg || (!twitter && !telegram && !website);
  if (uri && needsMeta) {
    try {
      const meta = await fetchMeta(uri);
      if (meta.image && !token.img) { token.img = resolveIPFS(meta.image); downloadImage(token.img, mint); }
      if (meta.twitter  && !token.twitter)  token.twitter  = meta.twitter;
      if (meta.telegram && !token.telegram) token.telegram = meta.telegram;
      if (meta.website  && !token.website)  token.website  = meta.website;
      tokenCache.set(mint, token);
      broadcast("updateToken", { token });
    } catch(e) {
      setTimeout(async () => {
        try {
          const urls = [`https://frontend-api-v3.pump.fun/coins/${mint}`, `https://frontend-api.pump.fun/coins/${mint}`];
          const d = await Promise.any(urls.map(u =>
            fetch(u, { timeout: 4000, headers: { Accept: "application/json" }}).then(r => { if(!r.ok) throw new Error(r.status); return r.json(); }).then(d => { if(!d.image_uri) throw new Error("no img"); return d; })
          ));
          if (d.image_uri && !token.img) { token.img = resolveIPFS(d.image_uri); downloadImage(token.img, mint); }
          if (d.twitter  && !token.twitter)  token.twitter  = d.twitter;
          if (d.telegram && !token.telegram) token.telegram = d.telegram;
          if (d.website  && !token.website)  token.website  = d.website;
          tokenCache.set(mint, token);
          broadcast("updateToken", { token });
        } catch(e2) {}
      }, 2000);
    }
  }
}

function connectPumpFun() {
  const ws = new WebSocket("wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket");
  ws.on("open", () => {
    ws.send("40");
    setTimeout(() => { try { ws.send('42["joinRoom","global"]'); } catch(e) {} }, 300);
    console.log("✅ pump.fun WS connected");
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
        if (!mint) return;
        await handleNewToken(mint, msg.name || msg.symbol || "?", msg.symbol || "?", msg.metadata_uri || msg.uri || "", msg.image_uri || msg.imageUri || null, msg.twitter || null, msg.telegram || null, msg.website || null);
      }
      if (evt === "tradeCreated" || evt === "trade") {
        const mint = msg?.mint || "";
        if (!mint || !tokenCache.has(mint)) return;
        const t = tokenCache.get(mint);
        const sol = parseFloat(msg.sol_amount || msg.solAmount || 0);
        const isBuy = msg.is_buy === true || msg.txType === "buy";
        t.vol  = (t.vol  || 0) + sol * 170;
        t.mcap = parseFloat(msg.market_cap_sol || 0) * 170 || t.mcap;
        if (isBuy) t.buys = (t.buys || 0) + 1;
        else       t.sells = (t.sells || 0) + 1;
        tokenCache.set(mint, t);
        broadcast("updateToken", { token: { mint, addr: mint, id: mint, _trade: { type: isBuy?"buy":"sell", usd: sol*170, mcapSol: parseFloat(msg.market_cap_sol||0) } } });
      }
    } catch(e) {}
  });
  ws.on("close", () => setTimeout(connectPumpFun, 2000));
  ws.on("error", () => setTimeout(connectPumpFun, 3000));
}

setInterval(() => {
  if (tokenCache.size > 500) {
    const keep = [...tokenCache.entries()].sort((a,b) => (b[1].createdAt||0)-(a[1].createdAt||0)).slice(0, 400);
    tokenCache.clear();
    keep.forEach(([k,v]) => tokenCache.set(k,v));
  }
  if (imageCache.size > 600) {
    const keys = [...imageCache.keys()].slice(0, 200);
    keys.forEach(k => imageCache.delete(k));
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`\n🚀 HYPERLAUNCH SERVER v4`);
  console.log(`   Port:   ${PORT}`);
  console.log(`   Images: cached at /img/MINT — instant for browser`);
  connectPumpFun();
});
