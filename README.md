# Bloxfolio Builder

TypeScript SaaS app for Roblox developers that:
- Generates unique portfolio copy with OpenRouter
- Persists generated portfolios in Convex
- Ships with a polished landing page plus builder studio UI
- Includes username/password auth and Convex-backed sessions

## Stack
- React + TypeScript + Vite
- Convex (queries, mutations, actions)
- OpenRouter

## Local Setup
1. Install deps:
```bash
npm install
```

2. Copy env file:
```bash
cp .env.example .env.local
```

3. Set frontend env:
- `VITE_CONVEX_URL` = your Convex deployment URL (`https://...convex.cloud`)
- `VITE_OPENROUTER_MODEL` optional override (default `minimax/minimax-m2.5`)

4. Set backend provider env values in `.env.local` (no `convex env set` required):
```bash
OPENROUTER_API_KEY="<your_openrouter_api_key>"      # for OpenRouter
OPENROUTER_MODEL="minimax/minimax-m2.5"             # optional override
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"  # optional override
```
  - If using OpenRouter, `OPENROUTER_MODEL` is the primary model override.
  - If you see `429` quota errors with any provider, switch model/plan as needed and check billing/usage.

Optional override if your provider uses a different completions path:
```bash
OPENROUTER_COMPLETIONS_PATH="/chat/completions"
```

5. Run app:
```bash
npm run convex:dev
npm run dev
```

## Scripts
- `npm run dev` -> Vite dev server
- `npm run convex:dev` -> Convex dev server with `.env.local` loaded into process env
- `npm run build` -> TypeScript build + Vite build
- `npm run typecheck` -> TypeScript project references check without emitting output
- `npm run audit` -> npm dependency audit (including dev tooling)
- `npm run audit:prod` -> npm audit scoped to production dependencies only
- `npm run convex:deploy` -> Deploy Convex functions with `.env.local` loaded into process env

## Notes
- Auth uses `username + password` and server-side session tokens in Convex.
- OpenRouter key is used only on the Convex server action, not in the browser.
- `.env*` files are gitignored by default except `.env.example`.
