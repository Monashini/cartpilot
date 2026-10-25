// The CartPilot shopping agent: an LLM with tools that can search, build a cart and prepare a PayPal checkout.
// It can never pay on its own — the human approves every payment in the PayPal window.
import { readFileSync, writeFileSync } from "node:fs";
import {
  searchProducts, addToCart, removeFromCart, cartView, setBudget, clearCart, categories, productCard,
} from "./store.js";

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
// Each free-tier model has its own daily quota (gemini-3.5-flash: 20 requests/day), so when one runs out
// the agent moves on to the next. Don't list aliases that share a quota (gemini-3.6-flash = gemini-3.5-flash).
const GEMINI_MODELS = [...new Set([
  GEMINI_MODEL,
  ...(process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite").split(","),
].map((m) => m.trim()).filter(Boolean))];
const GEMINI_TIMEOUT_MS = 20000; // a stuck call moves to the next model / offline planner instead of hanging the chat
export const AI_MODE = GEMINI_KEY
  ? `gemini:${GEMINI_MODEL}${GEMINI_MODELS.length > 1 ? ` +${GEMINI_MODELS.length - 1} backups` : ""}`
  : "offline-planner";

const SYSTEM_PROMPT = `You are CartPilot, a friendly AI shopping agent. You shop on the user's behalf from a fixed catalog and check out with PayPal.
Rules:
- Always use search_products to find items; never invent products, ids or prices.
- Respect the user's spending limit. add_to_cart enforces it; if it refuses, pick a cheaper option or explain.
- Only change the spending limit with set_budget when the user asks or states a budget for this request ("under $60"); then call it in your first step, together with your searches.
- Prefer well-rated items and explain picks in one short line each.
- When the cart matches the request, call ready_for_checkout. You cannot pay yourself: the user approves payment in PayPal.
- Keep replies short (max ~80 words), warm and clear. Prices are in USD.
- Be efficient, every step uses limited quota. Usually: one step with search_products (several calls at once if the user wants different things), then ONE step that calls add_to_cart for every pick AND ready_for_checkout together. The current cart is in the user's message, so don't call view_cart.
- Don't keep searching for a perfect fit. If not everything fits the limit, add the best subset that does and say what was left out.`;

const TOOL_DECLS = [
  {
    name: "search_products",
    description: "Search the store catalog. Returns up to `limit` products with id, name, price, category, rating.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'book reading gift'" },
        max_price: { type: "number", description: "Maximum unit price in USD" },
        category: { type: "string", description: "Optional category (filled in from the live catalog)" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "add_to_cart",
    description: "Add a product to the cart. Fails if it would exceed the spending limit.",
    parameters: {
      type: "object",
      properties: { product_id: { type: "string" }, quantity: { type: "integer" } },
      required: ["product_id"],
    },
  },
  {
    name: "remove_from_cart",
    description: "Remove a product from the cart.",
    parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
  },
  { name: "view_cart", description: "See current cart, total, spending limit and remaining budget.", parameters: { type: "object", properties: {} } },
  {
    name: "set_budget",
    description: "Change the spending limit. ONLY when the user explicitly asks.",
    parameters: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
  },
  {
    name: "ready_for_checkout",
    description: "Signal that the cart is ready and show the PayPal checkout to the user. Call it in the same step as your add_to_cart calls.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "One short, warm sentence on why these picks fit, shown above the item list" } },
    },
  },
];

// The catalog grows once DummyJSON loads, so the category list is read at call time.
function toolDecls() {
  TOOL_DECLS[0].parameters.properties.category.description = `Optional, one of: ${categories().join(", ")}`;
  return TOOL_DECLS;
}

function runTool(session, name, args, state) {
  switch (name) {
    case "search_products": {
      const results = searchProducts(args);
      for (const p of results) state.seen.add(p.id);
      return { results, remaining_budget: cartView(session).remaining };
    }
    case "add_to_cart": return addToCart(session, args);
    case "remove_from_cart": return removeFromCart(session, args);
    case "view_cart": return cartView(session);
    case "set_budget": return setBudget(session, args.amount);
    case "ready_for_checkout": {
      const cart = cartView(session);
      if (!cart.items.length) return { ok: false, error: "Cart is empty." };
      state.checkout = true;
      return { ok: true, cart };
    }
    default: return { ok: false, error: `Unknown tool ${name}` };
  }
}

// ---------------- Gemini usage tracking ----------------
// Counts every Gemini call per day so you can watch the free-tier quota (it resets at midnight Pacific time).
// Saved to gemini-usage.json so the numbers survive restarts. See GET /api/usage.
const USAGE_FILE = new URL("../gemini-usage.json", import.meta.url);
let usageLog = {};
try { usageLog = JSON.parse(readFileSync(USAGE_FILE, "utf8")); } catch {}

const quotaDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const usageToday = () => (usageLog[quotaDay()] ||= { requests: 0, errors: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0 });

function recordUsage(model, meta, failed) {
  const day = usageToday();
  day.models ||= {}; // days saved before per-model tracking don't have it
  const m = (day.models[model] ||= { requests: 0, errors: 0, totalTokens: 0 });
  for (const u of [day, m]) {
    u.requests++;
    if (failed) u.errors++;
    u.totalTokens += meta?.totalTokenCount || 0;
  }
  day.promptTokens += meta?.promptTokenCount || 0;
  day.outputTokens += (meta?.candidatesTokenCount || 0) + (meta?.thoughtsTokenCount || 0);
  try { writeFileSync(USAGE_FILE, JSON.stringify(usageLog, null, 2)); } catch {}
  console.log(`[gemini] ${model} ${failed ? "FAILED" : `${meta?.totalTokenCount || 0} tokens`} | today (PT ${quotaDay()}): ${model} ${m.requests} requests, all models ${day.requests} requests, ${day.errors} errors`);
}

// Models whose daily free quota ran out (or that Google retired), keyed by the quota day it happened.
const outOfQuota = new Map();
const availableModels = () => GEMINI_MODELS.filter((m) => outOfQuota.get(m) !== quotaDay());

export const getUsage = () => ({
  models: GEMINI_MODELS,
  outOfQuotaToday: GEMINI_MODELS.filter((m) => !availableModels().includes(m)),
  quotaDay: quotaDay(),
  today: usageToday(),
  days: usageLog,
});

// ---------------- Gemini (function calling) ----------------
const MAX_RETRY_WAIT_MS = 15000; // longer rate-limit waits go straight to the offline planner

const isDailyLimit = (err) => err.status === 429 && /PerDay/.test(err.body || "");

// Per-minute rate limits (429) clear quickly, so one short wait usually gets through.
function retryWaitMs(err) {
  if (err.status !== 429 || isDailyLimit(err)) return null;
  const s = Number(err.body?.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/)?.[1] ?? 5);
  const ms = Math.ceil(s * 1000) + 500;
  return ms <= MAX_RETRY_WAIT_MS ? ms : null;
}

// Tries each model that still has quota today. Daily limit or retired model: skip it until tomorrow.
// Per-minute limit: wait once, then move on. Timeout or server error: move on to the next model.
async function callGemini(contents, opts) {
  let lastErr = new Error("All Gemini models are out of free quota for today");
  for (const model of availableModels()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await requestGemini(model, contents, opts);
      } catch (e) {
        recordUsage(model, null, true);
        lastErr = e;
        if (isDailyLimit(e) || e.status === 404) {
          outOfQuota.set(model, quotaDay());
          console.log(`[gemini] ${model} is out of free quota for today, switching model`);
          break;
        }
        const wait = attempt === 0 ? retryWaitMs(e) : null;
        if (wait != null) {
          console.log(`[gemini] ${model} rate limited, retrying once in ${(wait / 1000).toFixed(1)}s`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (e.status === 429 || e.status >= 500 || e.name === "TimeoutError") break;
        throw e;
      }
    }
  }
  throw lastErr;
}

async function requestGemini(model, contents, { noTools = false, onlyTools = null, nudge = "" } = {}) {
  const functionCallingConfig = noTools ? { mode: "NONE" } : onlyTools ? { mode: "ANY", allowedFunctionNames: onlyTools } : null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: nudge ? `${SYSTEM_PROMPT}\n\n${nudge}` : SYSTEM_PROMPT }] },
      contents,
      tools: [{ functionDeclarations: toolDecls() }],
      ...(functionCallingConfig && { toolConfig: { functionCallingConfig } }),
      generationConfig: { temperature: 0.4 },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`Gemini error ${res.status}: ${body.slice(0, 300)}`), { status: res.status, body });
  }
  const data = await res.json();
  recordUsage(model, data.usageMetadata, false);
  return data.candidates?.[0]?.content || { role: "model", parts: [{ text: "Sorry, I didn't catch that." }] };
}

async function runGemini(session, userText) {
  const state = { checkout: false, trace: [], seen: new Set() };
  const context = `[Spending limit: $${session.budget}. Cart: ${JSON.stringify(cartView(session).items.map((i) => `${i.qty}x ${i.name}`))}]`;
  session.history.push({ role: "user", parts: [{ text: `${context}\n${userText}` }] });
  let reply = "";
  const MAX_STEPS = 4; // a normal chat needs 2 (search, then add + checkout); the last step must answer in text
  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1;
    // Stop the model from searching forever for a combo that can't fit the limit.
    const nudge = last ? "Reply to the user now in text: say what you found and what didn't fit the spending limit."
      : step >= 2 ? "You have searched enough. In this step call add_to_cart for the best items that fit the remaining budget (if not everything fits, the single best one), then ready_for_checkout."
      : "";
    const onlyTools = !last && step >= 2 ? ["add_to_cart", "ready_for_checkout"] : null;
    const content = await callGemini(session.history.slice(-30), { noTools: last, onlyTools, nudge });
    session.history.push(content);
    const calls = (content.parts || []).filter((p) => p.functionCall);
    const text = (content.parts || []).filter((p) => p.text).map((p) => p.text).join("").trim();
    if (!calls.length) { reply = text; break; }
    let summary = "";
    const responses = calls.map(({ functionCall: { name, args = {} } }) => {
      const result = runTool(session, name, args, state);
      state.trace.push({ tool: name, args, ok: result.ok !== false, note: result.error || null });
      if (name === "ready_for_checkout" && result.ok) summary = String(args.summary || "");
      return { functionResponse: { name, response: result } };
    });
    session.history.push({ role: "user", parts: responses });
    // Cart is ready: write the reply here instead of spending another Gemini call on it.
    if (state.checkout) {
      reply = checkoutReply(session, summary || text);
      session.history.push({ role: "model", parts: [{ text: reply }] });
      break;
    }
  }
  if (!reply) {
    reply = cartView(session).items.length
      ? "Done — take a look at your cart."
      : `I couldn't fit that within your $${session.budget} limit. Want me to raise the limit or pick fewer items?`;
  }
  return { reply, ...state };
}

function checkoutReply(session, summary) {
  const cart = cartView(session);
  const lines = cart.items.map((i) => `• ${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""} — $${i.line_total.toFixed(2)}`).join("\n");
  return `${summary || "Here's what I picked:"}\n${lines}\nTotal $${cart.total.toFixed(2)} of your $${cart.budget} limit. Approve with PayPal when you're happy, or ask me to swap anything.`;
}

// ---------------- Offline planner (no API key) ----------------
const STOP = new Set(["want", "need", "buy", "get", "for", "the", "and", "with", "under", "below", "less", "than", "some", "something", "who", "loves", "likes", "love", "like", "please", "find", "me", "my", "his", "them", "budget", "dollars", "usd", "gift", "present"]);

function runOffline(session, userText) {
  const t = userText.toLowerCase();
  const state = { checkout: false, trace: [], seen: new Set() };
  const log = (tool, args, result) => state.trace.push({ tool, args, ok: result.ok !== false, note: result.error || null });

  const budgetMatch = t.match(/(?:limit|budget|spend|under|below|max|within)\D{0,12}\$?\s?(\d+(?:\.\d+)?)/) || t.match(/\$(\d+(?:\.\d+)?)/);
  if (/\b(clear|empty)\b.*\bcart\b/.test(t)) { clearCart(session); log("clear_cart", {}, {}); return { reply: "Cart cleared. What should I look for?", ...state }; }
  if (/\b(checkout|check out|pay|buy it|place order)\b/.test(t)) {
    const r = runTool(session, "ready_for_checkout", {}, state); log("ready_for_checkout", {}, r);
    return { reply: r.ok ? `Your cart is $${cartView(session).total.toFixed(2)}. Approve the payment in PayPal below.` : "Your cart is empty — tell me what you need first.", ...state };
  }
  if (budgetMatch && /(limit|budget|spend|set)/.test(t) && !/\b(find|gift|need|want|buy|get|for)\b/.test(t)) {
    const r = setBudget(session, budgetMatch[1]); log("set_budget", { amount: Number(budgetMatch[1]) }, r);
    return { reply: r.ok ? `Spending limit set to $${r.budget}.${r.warning ? " " + r.warning : ""}` : r.error, ...state };
  }
  if (budgetMatch) { const r = setBudget(session, budgetMatch[1]); log("set_budget", { amount: Number(budgetMatch[1]) }, r); }

  const words = t.split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const query = words.join(" ");
  let results = searchProducts({ query, max_price: cartView(session).remaining, limit: 6 });
  log("search_products", { query, max_price: cartView(session).remaining }, { ok: true });
  // No usable keywords or no match: suggest the top-rated gifts that fit the budget instead of giving up.
  const fallbackPicks = !words.length || !results.length;
  if (fallbackPicks) {
    results = searchProducts({ query: "gift", max_price: cartView(session).remaining, limit: 6 });
    log("search_products", { query: "gift", max_price: cartView(session).remaining }, { ok: true });
  }
  for (const p of results) state.seen.add(p.id);
  if (!results.length) return { reply: "I couldn't find anything within your limit. Try raising the limit.", ...state };

  const picks = [];
  for (const p of results) {
    if (picks.length >= 3) break;
    if (picks.filter((x) => x.category === p.category).length >= 2) continue;
    if (p.price > cartView(session).remaining) continue; // would break the limit; don't even try
    const r = addToCart(session, { product_id: p.id, quantity: 1 });
    log("add_to_cart", { product_id: p.id }, r);
    if (r.ok) picks.push(p);
  }
  const cart = cartView(session);
  if (picks.length) { runTool(session, "ready_for_checkout", {}, state); log("ready_for_checkout", {}, { ok: true }); }
  const lines = picks.map((p) => `• ${p.name} — $${p.price.toFixed(2)} (★${p.rating})`).join("\n");
  return {
    reply: picks.length
      ? `${fallbackPicks ? "I didn't find an exact match, so here are top-rated gifts within your budget" : "Here's what I picked"}:\n${lines}\nTotal $${cart.total.toFixed(2)} of your $${cart.budget} limit. Approve with PayPal when you're happy, or ask me to swap anything.`
      : "Everything I found would go over your spending limit. Want to raise it?",
    ...state,
  };
}

export async function runAgent(session, userText) {
  if (!GEMINI_KEY) return withCards(session, runOffline(session, userText));
  try {
    return withCards(session, await runGemini(session, userText));
  } catch (e) {
    console.error(e.message);
    session.history = [];
    const r = runOffline(session, userText);
    const note = availableModels().length ? "AI service unavailable, used offline planner" : "Free AI quota used up for today, used offline planner";
    r.trace.unshift({ tool: "fallback", args: {}, ok: false, note });
    return withCards(session, r);
  }
}

// Product cards for the chat: what the agent added this turn, plus other options it found while searching,
// so the shopper can swap with a click instead of another AI request.
function withCards(session, { seen, ...r }) {
  const inCart = new Set(session.cart.map((l) => l.id));
  const added = r.trace.filter((t) => t.tool === "add_to_cart" && t.ok).map((t) => t.args.product_id);
  r.picks = [...new Set(added)].filter((id) => inCart.has(id)).map(productCard).filter(Boolean);
  r.alternatives = [...seen].filter((id) => !inCart.has(id)).slice(0, 4).map(productCard).filter(Boolean);
  return r;
}
