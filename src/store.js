// Product catalog, search, and per-session carts with a spending limit (guardrail).
import { readFileSync } from "node:fs";

export const CATALOG = JSON.parse(
  readFileSync(new URL("./catalog.json", import.meta.url), "utf8")
);

const byId = new Map(CATALOG.map((p) => [p.id, p]));
export const getProduct = (id) => byId.get(id);
export const categories = () => [...new Set(CATALOG.map((p) => p.category))];

const round2 = (n) => Math.round(n * 100) / 100;

// ---- DummyJSON products ------------------------------------------------
// ~190 demo products with real photos from https://dummyjson.com, added on top of catalog.json.
// If DummyJSON is down, the app keeps working with the local catalog only.
const SKIP_CATEGORIES = new Set(["vehicle", "motorcycle"]);
const CATEGORY_EMOJI = {
  beauty: "💄", fragrances: "🌸", furniture: "🛋️", groceries: "🛒", "home-decoration": "🏺",
  "kitchen-accessories": "🍳", laptops: "💻", "mens-shirts": "👔", "mens-shoes": "👞", "mens-watches": "⌚",
  "mobile-accessories": "🎧", "skin-care": "🧴", smartphones: "📱", "sports-accessories": "🏀", sunglasses: "🕶️",
  tablets: "📱", tops: "👚", "womens-bags": "👜", "womens-dresses": "👗", "womens-jewellery": "💍",
  "womens-shoes": "👠", "womens-watches": "⌚",
};

function fromDummyJson(d) {
  const audience = d.category.startsWith("womens-") ? ["women", "her"] : d.category.startsWith("mens-") ? ["men", "him"] : [];
  return {
    id: `dj-${d.id}`,
    name: d.title,
    category: d.category,
    price: round2(d.price),
    tags: [...new Set([...(d.tags || []), ...d.category.split("-"), ...audience, d.brand].filter(Boolean).map((t) => String(t).toLowerCase()))],
    rating: Math.round(d.rating * 10) / 10,
    emoji: CATEGORY_EMOJI[d.category] || "🛍️",
    image: d.thumbnail,
  };
}

/** Fetches DummyJSON products into the catalog. Returns how many were added. */
export async function loadDummyJsonCatalog() {
  const res = await fetch("https://dummyjson.com/products?limit=0", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`DummyJSON returned ${res.status}`);
  const { products = [] } = await res.json();
  let added = 0;
  for (const d of products) {
    if (SKIP_CATEGORIES.has(d.category) || !(d.price > 0)) continue;
    const p = fromDummyJson(d);
    if (byId.has(p.id)) continue;
    CATALOG.push(p);
    byId.set(p.id, p);
    added++;
  }
  return added;
}

/** Simple relevance search: scores name/tag/category word overlap. */
export function searchProducts({ query = "", max_price, category, limit = 5 } = {}) {
  const words = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  let results = CATALOG.map((p) => {
    const hay = [p.name, p.category, ...p.tags].join(" ").toLowerCase();
    let score = 0;
    for (const w of words) {
      if (p.tags.includes(w)) score += 3;
      else if (hay.includes(w)) score += 1;
      else if (w.endsWith("s") && hay.includes(w.slice(0, -1))) score += 1;
    }
    return { p, score: score + p.rating / 10 };
  });
  if (words.length) results = results.filter((r) => r.score >= 1);
  if (category) results = results.filter((r) => r.p.category === String(category).toLowerCase());
  if (max_price != null && !Number.isNaN(Number(max_price)))
    results = results.filter((r) => r.p.price <= Number(max_price));
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Number(limit) || 5, 10))
    .map(({ p }) => ({ id: p.id, name: p.name, price: p.price, category: p.category, rating: p.rating }));
}

// ---- Sessions ----------------------------------------------------------
const sessions = new Map();

export function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { id, budget: 50, cart: [], saved: [], history: [], orders: [] });
  }
  return sessions.get(id);
}

export function cartTotal(session) {
  return round2(
    session.cart.reduce((sum, line) => sum + getProduct(line.id).price * line.qty, 0)
  );
}

export function cartView(session) {
  const items = session.cart.map((l) => {
    const p = getProduct(l.id);
    return { id: p.id, name: p.name, emoji: p.emoji, image: p.image, price: p.price, qty: l.qty, line_total: round2(p.price * l.qty) };
  });
  const total = cartTotal(session);
  const saved = session.saved.map(productCard).filter(Boolean);
  return { items, total, budget: session.budget, remaining: round2(session.budget - total), saved };
}

/** What the UI needs to show a product card. */
export function productCard(id) {
  const p = getProduct(id);
  return p && { id: p.id, name: p.name, price: p.price, rating: p.rating, emoji: p.emoji, image: p.image };
}

// ---- Saved for later (wishlist) ----------------------------------------
/** Moves an item out of the cart (if it's there) into the saved list. */
export function saveForLater(session, { product_id }) {
  if (!getProduct(product_id)) return { ok: false, error: `No product with id ${product_id}.`, cart: cartView(session) };
  session.cart = session.cart.filter((l) => l.id !== product_id);
  if (!session.saved.includes(product_id)) session.saved.push(product_id);
  return { ok: true, cart: cartView(session) };
}

export function removeSaved(session, { product_id }) {
  session.saved = session.saved.filter((id) => id !== product_id);
  return { ok: true, cart: cartView(session) };
}

/** Moves a saved item into the cart. The spending-limit guardrail still applies. */
export function moveSavedToCart(session, { product_id }) {
  const r = addToCart(session, { product_id, quantity: 1 });
  if (r.ok) session.saved = session.saved.filter((id) => id !== product_id);
  return { ...r, cart: cartView(session) };
}

export function setBudget(session, amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) {
    return { ok: false, error: "Budget must be a number between 0 and 10000." };
  }
  session.budget = round2(n);
  const total = cartTotal(session);
  const warning = total > session.budget
    ? `Your cart ($${total}) is now over this limit, so checkout is blocked until you remove something.`
    : undefined;
  return { ok: true, budget: session.budget, cart_total: total, warning };
}

/** Adds an item, refusing anything that would push the cart over the spending limit. */
export function addToCart(session, { product_id, quantity = 1 }) {
  const p = getProduct(product_id);
  if (!p) return { ok: false, error: `No product with id ${product_id}.` };
  const qty = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));
  const newTotal = round2(cartTotal(session) + p.price * qty);
  if (newTotal > session.budget) {
    return {
      ok: false,
      error: "GUARDRAIL: adding this would exceed the spending limit.",
      budget: session.budget,
      current_total: cartTotal(session),
      would_be_total: newTotal,
    };
  }
  const line = session.cart.find((l) => l.id === p.id);
  if (line) line.qty += qty;
  else session.cart.push({ id: p.id, qty });
  return { ok: true, added: { id: p.id, name: p.name, qty }, cart: cartView(session) };
}

export function removeFromCart(session, { product_id }) {
  const before = session.cart.length;
  session.cart = session.cart.filter((l) => l.id !== product_id);
  return { ok: before !== session.cart.length, cart: cartView(session) };
}

export function clearCart(session) {
  session.cart = [];
}
