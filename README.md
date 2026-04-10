# HYPERLAUNCH SERVER

Real-time pump.fun token feed server. Connects to 3 sources simultaneously, pre-fetches metadata + images, and pushes to frontend via WebSocket.

## Deploy to Railway (free)

1. Go to railway.app and create an account
2. Click "New Project" → "Deploy from GitHub repo"
3. Upload this folder or connect your GitHub
4. Set environment variable: HELIUS_KEY=your_key
5. Deploy — Railway auto-detects Node.js

## Environment Variables

- `HELIUS_KEY` — Your Helius API key (from dashboard.helius.dev)
- `PORT` — Port to run on (Railway sets this automatically)

## WebSocket API

Connect to `wss://your-server.railway.app`

### Messages from server:

**snapshot** — sent on connect, last 50 tokens:
```json
{ "type": "snapshot", "tokens": [...] }
```

**newToken** — new token detected:
```json
{ "type": "newToken", "token": { "mint": "...", "name": "...", "img": "...", ... } }
```

**updateToken** — token enriched with metadata:
```json
{ "type": "updateToken", "token": { "mint": "...", "img": "https://...", "twitter": "...", ... } }
```

### Token shape:
```json
{
  "mint": "...",
  "name": "SYMBOL",
  "fullName": "Token Name",
  "img": "https://cf-ipfs.com/ipfs/...",
  "imgProxy": "/img/mint",
  "twitter": "@handle or null",
  "telegram": "https://t.me/... or null",
  "website": "https://... or null",
  "mcap": 12500,
  "bond": 4.2,
  "buys": 1,
  "sells": 0,
  "holders": 1,
  "createdAt": 1234567890000,
  "url": "https://pump.fun/coin/..."
}
```

## REST API

- `GET /health` — server status
- `GET /tokens` — last 100 tokens as JSON
- `GET /img/:mint` — proxied + cached token image

## How it works

1. Three simultaneous feeds: pumpportal.fun WS + pump.fun frontend WS + API polling
2. Token appears on frontend IMMEDIATELY when detected
3. Server fetches metadata JSON from IPFS in background (~200-500ms)
4. Image pre-fetched and cached server-side
5. Frontend receives enriched token update with real image/socials
6. Frontend serves images from `/img/:mint` — instant, no CORS, cached
