/**
 * HYPERLAUNCH BACKEND SERVER
 * - Connects to Solana RPC via Helius
 * - Listens to pump.fun program for new token creation events
 * - Fetches metadata JSON from IPFS instantly on token creation
 * - Caches token data + images in memory
 * - Pushes to all connected frontend clients via WebSocket
 * - Serves cached images as a proxy (no CORS issues)
 */

const express = require("express");
const cors    = require("cors");
const WebSocket = require("ws");
const http    = require("http");
const fetch   = require("node-fetch");
const { Connection, PublicKey } = require("@solana/web3.js");

// ── Config ────────────────────────────────────────────────
const PORT         = process.env.PORT || 3001;
const HELIUS_KEY   = process.env.HELIUS_KEY || "e6c9c34f-ff5b-441d-9ad6-0b32d51223a9";
const HELIUS_RPC   = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_WS    = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"; // pump.fun program ID

// IPFS gateways to race
const IPFS_GATEWAYS = [
  "https://cf-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

// ── In-memory cache ───────────────────────────────────────
const tokenCache   = new Map(); // mint -> token data
const imageCache   = new Map(); // url -> buffer
const MAX_TOKENS   = 500;       // keep last 500 tokens

// ── Express app ───────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
app.use(cors({ origin: "*" }));
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    tokens: tokenCache.size,
    clients: wss.clients.size,
    uptime: Math.floor(process.uptime()),
  });
});

// Get recent tokens
app.get("/tokens", (req, res) => {
  const tokens = [...tokenCache.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
  res.json(tokens);
});

// Image proxy — serves cached images to avoid CORS/IPFS slowness on frontend
app.get("/img/:mint", async (req, res) => {
  const { mint } = req.params;
  const token = tokenCache.get(mint);
  if (!token || !token.img) {
    return res.status(404).send("Not found");
  }
  // Serve from cache if available
  if (imageCache.has(mint)) {
    const buf = imageCache.get(mint);
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  }
  // Proxy the image
  try {
    const r = await fetchWithTimeout(token.img, 5000);
    if (!r.ok) return res.status(404).send("Image fetch failed");
    const buf = await r.buffer();
    imageCache.set(mint, buf);
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (e) {
    res.status(500).send("Error");
  }
});

// ── WebSocket server (for frontend clients) ───────────────
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log(`Client connected. Total: ${wss.clients.size}`);

  // Send last 50 tokens immediately on connect
  const recent = [...tokenCache.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
  ws.send(JSON.stringify({ type: "snapshot", tokens: recent }));

  ws.on("close", () => {
    console.log(`Client disconnected. Total: ${wss.clients.size}`);
  });
  ws.on("error", () => {});
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ── Fetch helpers ─────────────────────────────────────────
async function fetchWithTimeout(url, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function fetchJSON(url, ms = 5000) {
  try {
    const r = await fetchWithTimeout(url, ms);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// Race multiple IPFS gateways — return first success
async function fetchIPFS(hash, ms = 4000) {
  const urls = IPFS_GATEWAYS.map((g) => g + hash);
  try {
    return await Promise.any(
      urls.map((url) =>
        fetchJSON(url, ms).then((d) => {
          if (!d) throw new Error("null");
          return d;
        })
      )
    );
  } catch (e) {
    return null;
  }
}

// ── Metadata fetcher ──────────────────────────────────────
async function fetchTokenMetadata(mint, metaUri) {
  try {
    let meta = null;

    // Try metadata URI first (fastest path — direct IPFS JSON)
    if (metaUri) {
      const hash = metaUri.startsWith("ipfs://")
        ? metaUri.slice(7)
        : metaUri.split("/ipfs/")[1] || null;

      if (hash) {
        meta = await fetchIPFS(hash.split("?")[0]);
      } else if (metaUri.startsWith("http")) {
        meta = await fetchJSON(metaUri, 4000);
      }
    }

    // Fallback: pump.fun API
    if (!meta) {
      meta = await fetchJSON(`https://frontend-api.pump.fun/coins/${mint}`, 4000);
      if (meta) {
        // Normalize pump.fun API response to metadata shape
        return {
          image:    meta.image_uri || meta.imageUri || null,
          twitter:  meta.twitter   || null,
          telegram: meta.telegram  || null,
          website:  meta.website   || null,
          name:     meta.name      || null,
          mcap:     meta.usd_market_cap ? parseFloat(meta.usd_market_cap) : null,
          holders:  meta.holder_count   ? parseInt(meta.holder_count)     : null,
        };
      }
      return null;
    }

    // Resolve IPFS image URI to HTTP
    let imgUrl = meta.image || null;
    if (imgUrl && imgUrl.startsWith("ipfs://")) {
      imgUrl = "https://cf-ipfs.com/ipfs/" + imgUrl.slice(7);
    }

    return {
      image:    imgUrl,
      twitter:  meta.twitter  || null,
      telegram: meta.telegram || null,
      website:  meta.website  || null,
      name:     meta.name     || null,
      mcap:     null,
      holders:  null,
    };
  } catch (e) {
    return null;
  }
}

// ── Prefetch and cache image in background ─────────────────
async function prefetchImage(mint, imgUrl) {
  if (!imgUrl || imageCache.has(mint)) return;
  try {
    const r = await fetchWithTimeout(imgUrl, 5000);
    if (r.ok) {
      const buf = await r.buffer();
      imageCache.set(mint, buf);
      console.log(`  📸 Image cached: ${mint.slice(0, 8)}...`);
    }
  } catch (e) {}
}

// ── Token creation handler ────────────────────────────────
async function handleNewToken(rawData) {
  try {
    const mint     = rawData.mint || rawData.tokenAddress || rawData.address || "";
    const metaUri  = rawData.uri  || rawData.metadataUri  || rawData.metadata_uri || null;
    const symbol   = (rawData.symbol || "?").toUpperCase();
    const name     = rawData.name || symbol;

    if (!mint || tokenCache.has(mint)) return;

    console.log(`🆕 New token: ${symbol} (${mint.slice(0, 8)}...)`);

    // Build initial token — emit immediately
    const token = {
      id:        mint,
      mint,
      name:      symbol,
      fullName:  name,
      addr:      mint,
      chain:     "SOL",
      dex:       "pump.fun",
      isPump:    true,
      price:     parseFloat(rawData.solAmount || 0) / parseFloat(rawData.tokenAmount || 1e9) || 0,
      mcap:      parseFloat(rawData.marketCapSol || 0) * 170 || 0,
      vol:       0,
      liq:       0,
      bond:      parseFloat(rawData.bondingCurveProgress || 0) || 0,
      buys:      1,
      sells:     0,
      holders:   1,
      age:       0,
      img:       null,
      twitter:   rawData.twitter  || null,
      telegram:  rawData.telegram || null,
      website:   rawData.website  || null,
      url:       `https://pump.fun/coin/${mint}`,
      createdAt: Date.now(),
      enriched:  false,
    };

    // Store + broadcast immediately
    tokenCache.set(mint, token);
    broadcast({ type: "newToken", token });

    // Trim cache if too large
    if (tokenCache.size > MAX_TOKENS) {
      const oldest = [...tokenCache.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      tokenCache.delete(oldest[0]);
    }

    // Fetch metadata in background — update + re-broadcast when ready
    const meta = await fetchTokenMetadata(mint, metaUri);
    if (meta) {
      if (meta.image)    token.img      = meta.image;
      if (meta.twitter)  token.twitter  = meta.twitter;
      if (meta.telegram) token.telegram = meta.telegram;
      if (meta.website)  token.website  = meta.website;
      if (meta.name)     token.fullName = meta.name;
      if (meta.mcap)     token.mcap     = meta.mcap;
      if (meta.holders)  token.holders  = meta.holders;
      token.enriched = true;

      // Use our own image proxy URL for the frontend
      if (token.img) {
        token.imgProxy = `/img/${mint}`;
        // Prefetch image in background
        prefetchImage(mint, token.img);
      }

      tokenCache.set(mint, token);
      broadcast({ type: "updateToken", token });
      console.log(`  ✅ Enriched: ${symbol} img=${!!token.img} tw=${!!token.twitter}`);
    }
  } catch (e) {
    console.error("handleNewToken error:", e.message);
  }
}

// ── Helius WebSocket — Solana RPC subscription ────────────
let heliusWs = null;
let heliusReconnectTimer = null;

function connectHelius() {
  console.log("🔌 Connecting to Helius RPC WebSocket...");
  try {
    heliusWs = new WebSocket(HELIUS_WS);

    heliusWs.on("open", () => {
      console.log("✅ Helius WS connected");

      // Subscribe to pump.fun program logs — catches every new token creation
      heliusWs.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          { mentions: [PUMP_PROGRAM] },
          { commitment: "processed" }
        ]
      }));
    });

    heliusWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);

        // Subscription confirmed
        if (msg.result !== undefined && msg.id === 1) {
          console.log(`✅ Subscribed to pump.fun program logs (sub ${msg.result})`);
          return;
        }

        // Log notification
        if (msg.method === "logsNotification") {
          const logs = msg.params?.result?.value?.logs || [];
          const sig  = msg.params?.result?.value?.signature || "";

          // Check if this is a token creation event
          const isCreate = logs.some(l =>
            l.includes("InitializeMint") ||
            l.includes("Create") ||
            l.includes("create")
          );

          if (isCreate && sig) {
            // Fetch transaction details to get token info
            fetchTokenFromSig(sig);
          }
        }
      } catch (e) {}
    });

    heliusWs.on("close", () => {
      console.log("❌ Helius WS closed, reconnecting in 3s...");
      heliusReconnectTimer = setTimeout(connectHelius, 3000);
    });

    heliusWs.on("error", (e) => {
      console.log("❌ Helius WS error:", e.message);
    });

    // Ping every 30s to keep connection alive
    setInterval(() => {
      if (heliusWs.readyState === WebSocket.OPEN) {
        heliusWs.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }));
      }
    }, 30000);

  } catch (e) {
    console.error("Helius connect error:", e.message);
    heliusReconnectTimer = setTimeout(connectHelius, 5000);
  }
}

// Fetch transaction to extract token creation data
async function fetchTokenFromSig(sig) {
  try {
    const data = await fetchJSON(
      `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_KEY}`,
      // POST request
      null
    );
    // Use Helius enhanced transaction API
    const r = await fetchWithTimeout(
      `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY}`,
      8000
    );
  } catch (e) {}
}

// ── pumpportal WebSocket (secondary feed) ─────────────────
let ppWs = null;
let ppReconnect = null;

function connectPumpPortal() {
  console.log("🔌 Connecting to pumpportal.fun WebSocket...");
  try {
    ppWs = new WebSocket("wss://pumpportal.fun/api/data");

    ppWs.on("open", () => {
      console.log("✅ pumpportal.fun connected");
      ppWs.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    ppWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.txType === "create" || msg.event === "NewToken") {
          await handleNewToken(msg);
        }
      } catch (e) {}
    });

    ppWs.on("close", () => {
      console.log("❌ pumpportal WS closed, reconnecting in 3s...");
      ppReconnect = setTimeout(connectPumpPortal, 3000);
    });

    ppWs.on("error", () => {});
  } catch (e) {
    ppReconnect = setTimeout(connectPumpPortal, 5000);
  }
}

// ── pump.fun frontend WebSocket (tertiary feed) ───────────
let pfWs = null;
let pfReconnect = null;

function connectPumpFun() {
  console.log("🔌 Connecting to pump.fun frontend WebSocket...");
  try {
    pfWs = new WebSocket("wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket");

    pfWs.on("open", () => {
      pfWs.send("40");
      setTimeout(() => {
        try { pfWs.send('42["joinRoom","global"]'); } catch (e) {}
      }, 500);
    });

    pfWs.on("message", async (data) => {
      try {
        const raw = data.toString();
        if (raw === "2") return pfWs.send("3"); // pong
        if (!raw.startsWith("42")) return;
        const arr = JSON.parse(raw.slice(2));
        if (!arr || !arr[0]) return;
        const evt = arr[0], msg = arr[1] || {};
        if (evt === "newCoinCreated" || evt === "create" || evt === "tokenCreated") {
          await handleNewToken(msg);
        }
      } catch (e) {}
    });

    pfWs.on("close", () => {
      pfReconnect = setTimeout(connectPumpFun, 3000);
    });

    pfWs.on("error", () => {});
  } catch (e) {
    pfReconnect = setTimeout(connectPumpFun, 5000);
  }
}

// ── Periodic pump.fun API poll (catch any missed tokens) ──
async function pollPumpFun() {
  try {
    const url = "https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=created_timestamp&order=DESC&includeNsfw=false";
    const data = await fetchJSON(url, 5000);
    const coins = Array.isArray(data) ? data : (data?.coins || []);
    for (const c of coins) {
      if (!tokenCache.has(c.mint)) {
        await handleNewToken({
          mint:        c.mint,
          symbol:      c.symbol,
          name:        c.name,
          uri:         c.metadata_uri || null,
          image_uri:   c.image_uri    || null,
          twitter:     c.twitter      || null,
          telegram:    c.telegram     || null,
          website:     c.website      || null,
          marketCapSol: c.market_cap  || 0,
          bondingCurveProgress: c.bonding_curve_progress || 0,
        });
      }
    }
  } catch (e) {}
}

// ── Start everything ──────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   HYPERLAUNCH SERVER                 ║
║   Port: ${PORT}                          ║
║   Starting feeds...                  ║
╚══════════════════════════════════════╝
  `);

  // Connect all three feeds
  connectPumpPortal();
  connectPumpFun();

  // Poll pump.fun API every 10s as safety net
  setInterval(pollPumpFun, 10000);
  pollPumpFun(); // immediate first poll

  console.log("🚀 Server ready!");
});
