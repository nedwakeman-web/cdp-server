# Cosmic Daily Planner — Railway Server

## Deploy to Railway

1. Push this folder to a GitHub repository
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Set environment variable: `ANTHROPIC_API_KEY` = your Anthropic API key
4. Railway auto-detects Node.js and runs `npm start`
5. Once live, copy your Railway URL (e.g. `https://cdp.up.railway.app`)
6. In `public/index.html`, set: `const RAILWAY_BASE = 'https://your-railway-url.up.railway.app';`

## Architecture

- `/api/reading/stream` — SSE streaming endpoint (token-by-token, no timeout)  
- `/api/reading` — Standard JSON endpoint (oracle chat)
- `public/` — Static frontend served by Express

## Model routing (no limits on Railway)

| Tier | Model | Max tokens |
|------|-------|-----------|
| FREE | Haiku | 512 |
| SEEKER | Haiku | 2048 |
| INITIATE | Haiku | 3000 |
| MYSTIC | Haiku | 4096 |
| ORACLE | Sonnet | **8192** |

## Local development

```bash
npm install
ANTHROPIC_API_KEY=your_key node server.js
```
