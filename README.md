# Cosmic Daily Planner — Railway Server

Version 7 — Streaming API

## Architecture

- **Backend**: Node.js + Express on Railway (Docker)
- **Frontend**: Static HTML/CSS/JS on Netlify
- **AI**: Anthropic Claude Sonnet via streaming API
- **Ephemeris**: Swiss Ephemeris data (ae_2026.pdf, Astrodienst AG)
- **Moon**: USNO-verified lunar cycle anchor

## Environment Variables

Copy `.env.example` to `.env` and fill in your keys.
Set all variables in Railway → your project → Variables.

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/reading` | POST | Full Oracle reading (streaming-safe) |
| `/api/cosmic` | POST | Raw cosmic data (no AI) |
| `/api/ask` | POST | Oracle follow-up question |
| `/api/calendar` | POST | Month calendar data |

## Deployment

Push to GitHub. Railway auto-deploys via Dockerfile.

## Scholarly Sources

- Swiss Ephemeris: Astrodienst AG (Koch & Treindl)
- Moon phases: USNO — https://aa.usno.navy.mil
- Planetary positions: JPL Horizons — https://ssd.jpl.nasa.gov/horizons
- Maya calendrics: Šprajc et al. (2023) Science Advances doi:10.1126/sciadv.abq7675
- Maya calendrics: Aldana (2022) doi:10.34758/qyyd-vx23
- Dreamspell: Argüelles (1987) The Mayan Factor — modern system
- Astrology: Tarnas (2006) Cosmos & Psyche; Greene (1976) Saturn
- Numerology: Drayer (2002); Kahn (2001) Pythagoras
