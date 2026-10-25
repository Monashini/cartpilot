// PayPal Orders v2 (sandbox) integration.
// If PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are missing, runs in MOCK mode so the UI can still be explored.
import { randomUUID } from "node:crypto";

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
export const PAYPAL_MOCK = !CLIENT_ID || !CLIENT_SECRET;
export const PAYPAL_CLIENT_ID = CLIENT_ID || "";
export const CURRENCY = process.env.CURRENCY || "USD";

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function paypalFetch(path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": randomUUID(), // idempotency
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.details?.[0]?.description || data?.message || `PayPal error ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

const money = (n) => n.toFixed(2);

/** Builds an itemized Orders v2 payload from server-side cart data (never from client prices). */
export function buildOrderPayload(cart, referenceId) {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: referenceId,
        description: "CartPilot AI-assisted purchase",
        amount: {
          currency_code: CURRENCY,
          value: money(cart.total),
          breakdown: { item_total: { currency_code: CURRENCY, value: money(cart.total) } },
        },
        items: cart.items.map((i) => ({
          name: i.name.slice(0, 127),
          sku: i.id,
          quantity: String(i.qty),
          unit_amount: { currency_code: CURRENCY, value: money(i.price) },
          category: "PHYSICAL_GOODS",
        })),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "CartPilot",
          shipping_preference: "GET_FROM_FILE",
          user_action: "PAY_NOW",
        },
      },
    },
  };
}

const mockOrders = new Map();

export async function createOrder(cart, referenceId) {
  const payload = buildOrderPayload(cart, referenceId);
  if (PAYPAL_MOCK) {
    const id = "MOCK-" + randomUUID().slice(0, 8).toUpperCase();
    mockOrders.set(id, payload);
    return { id, status: "CREATED", mock: true };
  }
  return paypalFetch("/v2/checkout/orders", payload);
}

export async function captureOrder(orderId) {
  if (PAYPAL_MOCK) {
    const payload = mockOrders.get(orderId);
    if (!payload) throw Object.assign(new Error("Unknown mock order"), { status: 404 });
    return {
      id: orderId,
      status: "COMPLETED",
      mock: true,
      purchase_units: [
        {
          payments: {
            captures: [{ id: "MOCKCAP-" + orderId.slice(5), status: "COMPLETED", amount: payload.purchase_units[0].amount }],
          },
        },
      ],
      payer: { name: { given_name: "Demo", surname: "Buyer" }, email_address: "buyer@example.com" },
    };
  }
  return paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`);
}
