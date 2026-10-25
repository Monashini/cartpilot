import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import {
  getSession, cartView, setBudget, addToCart, removeFromCart, clearCart, CATALOG, loadDummyJsonCatalog,
  saveForLater, removeSaved, moveSavedToCart,
} from "./src/store.js";
import { runAgent, AI_MODE, getUsage } from "./src/agent.js";
import { createOrder, captureOrder, PAYPAL_MOCK, PAYPAL_CLIENT_ID, CURRENCY } from "./src/paypal.js";

const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(express.static("public"));

const sid = (req) => {
  const id = String(req.get("x-session-id") || "");
  return /^[a-zA-Z0-9-]{8,64}$/.test(id) ? id : null;
};
const withSession = (handler) => async (req, res) => {
  const id = sid(req);
  if (!id) return res.status(400).json({ error: "Missing or invalid x-session-id header" });
  try {
    await handler(req, res, getSession(id));
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message, details: e.details });
  }
};

app.get("/api/config", (_req, res) =>
  res.json({ paypalClientId: PAYPAL_CLIENT_ID, paypalMock: PAYPAL_MOCK, currency: CURRENCY, aiMode: AI_MODE, products: CATALOG.length })
);

// Gemini calls and tokens per day, to keep an eye on the free-tier quota.
app.get("/api/usage", (_req, res) => res.json(getUsage()));

app.get("/api/cart", withSession((_req, res, s) => res.json(cartView(s))));

app.post("/api/budget", withSession((req, res, s) => {
  const r = setBudget(s, req.body.amount);
  res.status(r.ok ? 200 : 400).json({ ...r, cart: cartView(s) });
}));

app.post("/api/cart/remove", withSession((req, res, s) => res.json(removeFromCart(s, req.body))));

// The shopper's own clicks (product cards, saved list). Same guardrail as the agent: never past the limit.
app.post("/api/cart/add", withSession((req, res, s) => {
  const r = addToCart(s, { product_id: req.body.product_id, quantity: 1 });
  res.json({ ...r, cart: cartView(s) });
}));
app.post("/api/saved/add", withSession((req, res, s) => res.json(saveForLater(s, req.body))));
app.post("/api/saved/remove", withSession((req, res, s) => res.json(removeSaved(s, req.body))));
app.post("/api/saved/to-cart", withSession((req, res, s) => res.json(moveSavedToCart(s, req.body))));

app.post("/api/chat", withSession(async (req, res, s) => {
  const text = String(req.body.message || "").slice(0, 1000).trim();
  if (!text) return res.status(400).json({ error: "Empty message" });
  const result = await runAgent(s, text);
  res.json({ ...result, cart: cartView(s) });
}));

// Guardrail #2: the server re-prices the cart from the catalog and re-checks the limit before PayPal ever sees it.
app.post("/api/orders", withSession(async (_req, res, s) => {
  const cart = cartView(s);
  if (!cart.items.length) return res.status(400).json({ error: "Cart is empty" });
  if (cart.total > s.budget) return res.status(403).json({ error: "Cart exceeds spending limit" });
  const order = await createOrder(cart, `cp-${s.id.slice(0, 8)}-${Date.now()}`);
  s.pendingOrderId = order.id;
  res.json({ id: order.id, status: order.status, mock: !!order.mock });
}));

app.post("/api/orders/:id/capture", withSession(async (req, res, s) => {
  if (req.params.id !== s.pendingOrderId) return res.status(403).json({ error: "Order does not belong to this session" });
  const cart = cartView(s);
  const result = await captureOrder(req.params.id);
  const capture = result?.purchase_units?.[0]?.payments?.captures?.[0];
  const receipt = {
    orderId: result.id,
    status: result.status,
    captureId: capture?.id,
    amount: capture?.amount,
    payer: result.payer?.name ? `${result.payer.name.given_name} ${result.payer.name.surname}` : null,
    items: cart.items,
    mock: !!result.mock,
    at: new Date().toISOString(),
  };
  if (result.status === "COMPLETED") {
    s.orders.push(receipt);
    clearCart(s);
    s.pendingOrderId = null;
  }
  res.json(receipt);
}));

app.get("/api/orders", withSession((_req, res, s) => res.json(s.orders)));

app.get("/api/new-session", (_req, res) => res.json({ sessionId: randomUUID() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CartPilot running on http://localhost:${PORT}`);
  console.log(`AI: ${AI_MODE} | PayPal: ${PAYPAL_MOCK ? "MOCK (add sandbox keys to .env)" : "sandbox"}`);
  if (process.env.CATALOG_SOURCE !== "local") {
    loadDummyJsonCatalog()
      .then((n) => console.log(`Catalog: added ${n} DummyJSON products (${CATALOG.length} total)`))
      .catch((e) => console.log(`Catalog: DummyJSON unavailable (${e.message}), using ${CATALOG.length} local products`));
  }
});
