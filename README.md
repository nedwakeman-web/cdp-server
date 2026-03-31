# Cosmic Daily Planner — Production Backend

## What this is
A production Node.js API server that replaces the Netlify function timeout problem entirely.
No 26-second limit. Claude can run for 5+ minutes for bespoke readings.
Scales to millions of users. Stripe payments built in.

---

## Deploy to Railway (30 minutes, one-time setup)

### Step 1: Create GitHub repository
1. Go to github.com → New repository → name it `cdp-server`
2. Upload all files in this folder to it (or use git push)

### Step 2: Deploy on Railway
1. Go to railway.app → Login with GitHub
2. New Project → Deploy from GitHub repo → select `cdp-server`
3. Railway auto-detects Node.js and deploys

### Step 3: Add environment variables
In Railway dashboard → your project → Variables, add:

```
ANTHROPIC_API_KEY=sk-ant-your-key
JWT_SECRET=run: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
APP_URL=https://cosmicdailyplanner.com
ALLOWED_ORIGINS=https://cosmicdailyplanner.com
```

### Step 4: Get your Railway URL
Railway gives you a URL like: `https://cdp-server-production-xxxx.up.railway.app`

### Step 5: Update your frontend
In `index.html`, find this line:
```js
: 'https://your-app.railway.app'; // UPDATE THIS after Railway deploy
```
Change it to your actual Railway URL.

### Step 6: Deploy frontend to Netlify
Drag and drop your updated `index.html` to Netlify as before.
Netlify just serves the HTML — all API calls go to Railway.

---

## Adding Stripe payments (optional, 1 hour)

1. Create account at stripe.com
2. Get your API keys from stripe.com/dashboard/apikeys
3. Create products and prices for each tier
4. Add to Railway environment variables:
   ```
   STRIPE_SECRET_KEY=sk_live_xxx
   STRIPE_WEBHOOK_SECRET=whsec_xxx
   STRIPE_PRICE_SEEKER=price_xxx
   STRIPE_PRICE_INITIATE=price_xxx
   STRIPE_PRICE_MYSTIC=price_xxx
   STRIPE_PRICE_ORACLE=price_xxx
   STRIPE_PRICE_BESPOKE=price_xxx
   ```
5. In Stripe dashboard → Webhooks → Add endpoint:
   `https://your-app.railway.app/billing/webhook`
   Events: `checkout.session.completed`, `customer.subscription.deleted`

---

## What the server provides

### API Endpoints

**Auth**
- `POST /auth/register` — create account
- `POST /auth/login` — login, returns JWT token
- `GET /auth/me` — get current user + profile

**Profile**
- `PUT /profile` — save full profile (birth details, life chapter, people etc)

**Readings**
- `POST /reading/stream` — main reading (SSE streaming, no timeout)
- `POST /reading/part1` — parallel: convergence + frameworks
- `POST /reading/part2` — parallel: planets + priorities + shadow  
- `POST /reading/part3` — parallel: lookahead + daily gift
- `POST /reading/bespoke` — £1000 tier, 16,000 tokens, full depth, 5+ minutes
- `GET /readings` — reading history
- `GET /readings/:id` — specific reading + chat messages

**Chat**
- `POST /reading/:id/chat` — follow-up conversation (with full history saved)

**Insights**
- `GET /insights` — AI-generated patterns from reading history

**Billing**
- `POST /billing/checkout` — create Stripe checkout session
- `POST /billing/webhook` — Stripe webhook handler

**Health**
- `GET /health` — server status check

---

## Future capabilities (ready to add)

- **Scheduled readings**: cron job at 6am sends daily reading by email
- **Natal chart**: add birth time + place for full ascendant/house system
- **Year ahead**: 12-month arc reading using solar return
- **Relationship readings**: two profiles, composite chart
- **Search enrichment**: web_search tool for current transits, news context
- **Audio narration**: ElevenLabs integration for spoken readings
- **PDF generation**: puppeteer renders the dark-styled PDF server-side

---

## Costs

- Railway Hobby plan: $5/month (handles ~10,000 readings/month)
- Railway Pro: $20/month (autoscales, handles millions)
- SQLite is free and included
- Upgrade to PostgreSQL on Railway when you need it ($5-20/month extra)
