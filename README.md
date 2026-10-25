# CartPilot 🛒✈︎

**An AI shopping agent that shops for you and pays with PayPal, inside a spending limit you set.**

You tell CartPilot what you need in plain English ("a birthday gift for my sister who loves reading, under $40"). The agent searches the store, compares items, builds the cart and prepares a PayPal checkout. You stay in control the whole time: the agent **cannot** spend past your limit, and **nothing is paid until you approve it in PayPal**.

![CartPilot screenshot](screenshot.png)

## Try it (for judges)

**Hosted demo:** `<DEMO_URL>`
Or run it locally in about 2 minutes, see [Run it locally](#run-it-locally).

**PayPal sandbox buyer** (test money only, nothing real is charged):

| | |
|---|---|
| Email | `cartpilot.us.buyer@personal.example.com` |
| Password | `Cartpilot2026!` |

A 3-minute tour:

1. **Ask for something.** Click a suggestion chip, or type *"Coffee lover gift under $50"*. The agent searches, fills the cart, and every tool call shows up live in **Agent activity**.
2. **Swap with a click.** Under the reply you get product cards: what was added, plus *Other options* it found. Click **Add** or **♡ Wishlist**. No extra AI call needed.
3. **Pay with PayPal.** Click the PayPal button, log in with the sandbox buyer above and approve. The receipt shows the PayPal order and capture IDs, and the order appears in **Your orders**.
4. **Try to break the limit.** Type *"set my budget to 10"*. The PayPal button disappears and the server refuses any order over the limit. Moving a wishlist item into a full cart is refused too.

## Why this matters

AI agents that buy things raise an obvious question: *how do I trust them with my money?* CartPilot answers with layered guardrails, so even a model mistake can never reach the payment:

1. **Tool guardrail.** The agent's `add_to_cart` tool rejects anything that would break the spending limit, so the model can't talk its way past it. The same check applies to the shopper's own clicks (cards, wishlist).
2. **Server-side re-pricing.** When a PayPal order is created, the server re-prices every item from its own catalog and re-checks the limit. Prices from the browser or the AI are never trusted.
3. **Human approval through PayPal.** The agent only gets as far as `ready_for_checkout`. Only the shopper can approve a payment, in PayPal's own window. The PayPal button is hidden while the cart is over the limit.

## Features

- **Conversational shopping agent** with six tools: `search_products`, `add_to_cart`, `remove_from_cart`, `view_cart`, `set_budget`, `ready_for_checkout`.
- **Live agent activity log**, so every action the AI takes is visible.
- **Product cards in chat** with photos, price and rating, plus one-click swaps from the options the agent found.
- **Wishlist** (move items out of the cart and back, within the limit).
- **Order history** of PayPal payments with order IDs.
- **217 products**: a local catalog plus ~180 products with photos from [DummyJSON](https://dummyjson.com). If DummyJSON is down, the local catalog keeps working.
- **Resilient AI on the free tier**: when one Gemini model's daily quota runs out it switches to the next free model, retries once on per-minute rate limits, times out stuck calls, and falls back to a built-in offline planner if no model is available.
- **Efficient agent loop**: a typical request takes 2 Gemini calls (search, then add + checkout). It is capped at 4 steps, and the last steps can only add to the cart or reply.

## AI and tools used

| Tool | How it's used |
|---|---|
| **Google Gemini API** (`gemini-3.5-flash`, with `gemini-3-flash-preview`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` as free-tier backups) | Function calling drives the shopping agent: understanding the request, choosing search queries and categories, picking well-rated items that fit the budget, and writing the reply. |
| **PayPal JavaScript SDK** | Smart Payment Buttons in the browser; the shopper approves the payment in PayPal's window. |
| **PayPal REST Orders v2** | Server-side OAuth2 (client credentials), itemized `purchase_units` with `intent: CAPTURE`, idempotent `PayPal-Request-Id`, and capture after approval. |
| **DummyJSON** | Extra product catalog with photos. |
| **Render** | Hosting (`render.yaml` blueprint included). |

## How it works

```
Browser (chat, product cards, cart, wishlist, orders, PayPal Buttons)
   │  /api/chat
   ▼
Express server ── Agent loop (Gemini function calling, model fallback chain)
   │                 tools: search_products, add_to_cart, remove_from_cart,
   │                        view_cart, set_budget, ready_for_checkout
   │                 └─ offline planner if the AI is unavailable
   │  /api/cart/*, /api/saved/*   shopper's own clicks (same spending-limit guardrail)
   │  /api/orders                → PayPal Orders v2: create (re-priced, limit re-checked)
   │  /api/orders/:id/capture    → PayPal Orders v2: capture
   ▼
PayPal Sandbox
```

## Run it locally

Requirements: **Node.js 18 or newer**.

```bash
git clone https://github.com/Monashini/cartpilot.git
cd cartpilot
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start                 # open http://localhost:3000
```

The app runs with **no keys at all**: PayPal falls back to a simulated checkout and the offline planner stands in for the AI. Add keys to `.env` for the full experience:

| Variable | What it is |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/sandbox) → Apps & Credentials → Sandbox → Create App |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) (free tier works) |
| `GEMINI_MODEL` | Main model, default `gemini-3.5-flash` |
| `GEMINI_FALLBACK_MODELS` | Comma-separated backups, each with its own free daily quota |
| `CATALOG_SOURCE` | `dummyjson` (default) or `local` |
| `PORT` | Default `3000` |

Tips:

- To test PayPal checkout with your own sandbox app, create a **Personal** sandbox account with country **United States** (Testing Tools → Sandbox Accounts). Your app's own Business account can't pay itself, and India-based sandbox buyers can fail because PayPal India doesn't support domestic payments.
- Gemini's free tier allows about 20 requests per model per day. Check today's usage per model at `http://localhost:3000/api/usage`.

Run tests: `npm test`

## Project structure

```
server.js          Express API (chat, cart, wishlist, budget, PayPal orders, usage)
src/agent.js       Agent loop, tools, Gemini model fallback, usage tracking, offline planner
src/paypal.js      PayPal OAuth + Orders v2 create/capture (with demo mode)
src/store.js       Catalog (local + DummyJSON), search, carts, wishlist, spending-limit guardrail
src/catalog.json   Local product catalog
public/            Frontend (vanilla JS, PayPal JS SDK)
test/              Unit tests (node:test)
```

## Limitations and what's next

- Carts, wishlists and orders live in server memory, so they reset when the server restarts. A database is the next step.
- The catalog is demo data. Next: real merchant catalogs (Shopify, Channel3).
- PayPal Vault so a trusted agent can make small recurring purchases within rules you set, and spending limits per category.

## License

MIT. See [LICENSE](LICENSE).
