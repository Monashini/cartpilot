const $ = (id) => document.getElementById(id);
const fmt = (n) => `$${Number(n).toFixed(2)}`;

let sessionId;
let checkoutReady = false; // set once the agent calls ready_for_checkout
try { sessionId = localStorage.getItem("cp-session"); } catch {}
if (!sessionId) {
  sessionId = crypto.randomUUID();
  try { localStorage.setItem("cp-session", sessionId); } catch {}
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Renders **bold** from the model as <b>, using text nodes only (no innerHTML).
function appendRich(node, text) {
  String(text).split(/\*\*(.+?)\*\*/g).forEach((part, i) => node.append(i % 2 ? el("b", null, part) : part));
}

function addMsg(role, text) {
  const m = el("div", `msg ${role}`);
  appendRich(m, text);
  $("messages").appendChild(m);
  $("messages").scrollTop = $("messages").scrollHeight;
  return m;
}

// Product photo, falling back to the emoji if there's no image or it fails to load.
function picture(item, imgClass, emojiClass) {
  if (!item.image) return el("span", emojiClass, item.emoji);
  const img = el("img", imgClass);
  img.src = item.image;
  img.alt = "";
  img.loading = "lazy";
  img.onerror = () => img.replaceWith(el("span", emojiClass, item.emoji));
  return img;
}

function iconButton(cls, text, title, onclick) {
  const b = el("button", cls, text);
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = onclick;
  return b;
}

// Cart / saved-list changes the shopper makes by clicking. The server applies the same spending limit.
async function cartAction(path, productId) {
  const r = await api(path, { product_id: productId });
  if (r.ok && (path === "/api/cart/add" || path === "/api/saved/to-cart")) checkoutReady = true;
  renderCart(r.cart);
  if (!r.ok && r.error) addMsg("bot", r.error.replace(/^GUARDRAIL: /, "Can't add that: "));
  return r;
}

function renderCart(cart) {
  const list = $("cartList");
  list.replaceChildren();
  if (!cart.items.length) list.appendChild(el("li", "empty", "Empty — ask the agent to find something."));
  for (const i of cart.items) {
    const li = el("li");
    li.append(picture(i, "thumb", "emoji"), el("span", "name", `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ""}`), el("b", null, fmt(i.line_total)));
    li.append(
      iconButton("save", "♡", "Move to wishlist", () => cartAction("/api/saved/add", i.id)),
      iconButton("rm", "×", "Remove", () => cartAction("/api/cart/remove", i.id)),
    );
    list.appendChild(li);
  }
  renderSaved(cart.saved || []);
  $("cartTotal").textContent = fmt(cart.total);
  $("budgetInput").value = cart.budget;
  const pct = Math.min(100, (cart.total / cart.budget) * 100);
  $("meterFill").style.width = `${pct}%`;
  $("meterFill").style.background = pct > 90 ? "var(--warn)" : "var(--ok)";
  $("spentLabel").textContent = `${fmt(cart.total)} used`;
  $("remainLabel").textContent = `${fmt(cart.remaining)} left`;
  // Guardrail in the UI too: no PayPal button while the cart is over the limit.
  if (!cart.items.length) checkoutReady = false;
  const over = cart.items.length > 0 && cart.total > cart.budget;
  $("overBudget").classList.toggle("hidden", !over);
  $("checkout").classList.toggle("hidden", !checkoutReady || over);
}

function renderSaved(saved) {
  $("savedWrap").classList.toggle("hidden", !saved.length);
  $("savedList").replaceChildren(...saved.map((p) => {
    const li = el("li");
    li.append(
      picture(p, "thumb", "emoji"),
      el("span", "name", p.name),
      el("b", null, fmt(p.price)),
      iconButton("move", "Move to cart", "Move to cart", () => cartAction("/api/saved/to-cart", p.id)),
      iconButton("rm", "×", "Remove from wishlist", () => cartAction("/api/saved/remove", p.id)),
    );
    return li;
  }));
}

function productCardEl(p, actions) {
  const card = el("div", "pcard");
  const meta = el("div", "pmeta");
  meta.append(el("b", null, fmt(p.price)), el("span", null, `★${p.rating}`));
  const acts = el("div", "acts");
  for (const [label, path, doneLabel, primary] of actions) {
    const b = el("button", primary ? "primary" : null, label);
    b.onclick = async () => {
      b.disabled = true;
      const r = await cartAction(path, p.id).catch(() => ({ ok: false }));
      if (r.ok) {
        b.textContent = doneLabel;
        for (const other of acts.querySelectorAll("button")) other.disabled = true;
      } else b.disabled = false;
    };
    acts.appendChild(b);
  }
  card.append(picture(p, "pic", "pic emoji"), el("div", "pname", p.name), meta, acts);
  return card;
}

// Cards under the agent's reply: what it added, and other options it found (one click to swap, no AI call).
function renderCards(picks = [], alternatives = []) {
  if (!picks.length && !alternatives.length) return;
  const wrap = el("div", "cards");
  const section = (title, items, actions) => {
    if (!items.length) return;
    const row = el("div", "card-row");
    row.append(...items.map((p) => productCardEl(p, actions)));
    wrap.append(el("h4", null, title), row);
  };
  section("Added to your cart", picks, [["Remove", "/api/cart/remove", "Removed"], ["♡ Wishlist", "/api/saved/add", "In wishlist ♡"]]);
  section("Other options", alternatives, [["Add", "/api/cart/add", "In cart ✓", true], ["♡ Wishlist", "/api/saved/add", "In wishlist ♡"]]);
  $("messages").appendChild(wrap);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function renderOrders(orders) {
  const list = $("orderList");
  if (!orders.length) return;
  list.replaceChildren(...[...orders].reverse().map((o) => {
    const li = el("li");
    const row = el("div", "row");
    row.append(el("span", null, new Date(o.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })), el("span", null, `${o.amount?.currency_code || "USD"} ${o.amount?.value}`));
    li.append(
      row,
      el("small", null, o.items.map((i) => `${i.qty > 1 ? `${i.qty}× ` : ""}${i.name}`).join(", ")),
      el("small", null, `PayPal order ${o.orderId}${o.mock ? " · demo mode" : ""}`),
    );
    return li;
  }));
}

function renderTrace(trace) {
  const ol = $("trace");
  if (!trace?.length) return;
  if (ol.querySelector(".muted")) ol.replaceChildren();
  for (const t of trace) {
    const li = el("li", t.ok ? "" : "bad");
    li.appendChild(el("code", null, t.tool));
    const args = Object.entries(t.args || {}).map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : v}`).join(", ");
    if (args) li.append(" ", args);
    if (t.note) li.append(` → ${t.note}`);
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

function showReceipt(r) {
  const box = $("receipt");
  box.replaceChildren(
    el("h3", null, "✓ Payment captured"),
    el("div", null, `${r.amount?.currency_code || "USD"} ${r.amount?.value} · ${r.items.length} item(s)`),
    el("small", null, `PayPal order ${r.orderId}${r.captureId ? ` · capture ${r.captureId}` : ""}${r.payer ? ` · payer ${r.payer}` : ""}${r.mock ? " · demo mode" : ""}`)
  );
  box.classList.remove("hidden");
  addMsg("bot", `Done! Your PayPal payment of ${fmt(r.amount?.value || 0)} went through. Order ${r.orderId}. Anything else?`);
}

async function send(text) {
  $("chips").classList.add("used");
  addMsg("user", text);
  $("sendBtn").disabled = true;
  const typing = addMsg("bot typing", "CartPilot is shopping…");
  try {
    const r = await api("/api/chat", { message: text });
    typing.remove();
    addMsg("bot", r.reply);
    if (r.checkout && r.cart.items.length) {
      checkoutReady = true;
      $("receipt").classList.add("hidden");
    }
    renderCart(r.cart);
    renderCards(r.picks, r.alternatives);
    renderTrace(r.trace);
  } catch (e) {
    typing.remove();
    addMsg("bot", `Something went wrong: ${e.message}`);
  } finally {
    $("sendBtn").disabled = false;
    $("chatInput").focus();
  }
}

async function capture(orderId) {
  const r = await api(`/api/orders/${encodeURIComponent(orderId)}/capture`, {});
  if (r.status === "COMPLETED") {
    showReceipt(r);
    renderCart(await api("/api/cart"));
    renderOrders(await api("/api/orders"));
  } else addMsg("bot", `Payment status: ${r.status}`);
}

function loadPayPal(cfg) {
  if (cfg.paypalMock) {
    $("mockPay").classList.remove("hidden");
    $("mockPay").onclick = async () => {
      try { const o = await api("/api/orders", {}); await capture(o.id); }
      catch (e) { addMsg("bot", `Checkout blocked: ${e.message}`); }
    };
    return;
  }
  const s = document.createElement("script");
  s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(cfg.paypalClientId)}&currency=${cfg.currency}&components=buttons`;
  s.onload = () => {
    window.paypal.Buttons({
      style: { layout: "vertical", shape: "pill", label: "pay" },
      createOrder: async () => (await api("/api/orders", {})).id,
      onApprove: async (data) => capture(data.orderID),
      onCancel: () => addMsg("bot", "No problem — payment cancelled. Want me to change anything?"),
      onError: (err) => addMsg("bot", `PayPal error: ${err?.message || err}`),
    }).render("#paypal-buttons");
  };
  document.head.appendChild(s);
}

$("chatForm").onsubmit = (e) => {
  e.preventDefault();
  const t = $("chatInput").value.trim();
  if (!t) return;
  $("chatInput").value = "";
  send(t);
};
$("chips").onclick = (e) => { if (e.target.tagName === "BUTTON") send(e.target.textContent); };
$("budgetBtn").onclick = async () => {
  try { renderCart((await api("/api/budget", { amount: Number($("budgetInput").value) })).cart); }
  catch (e) { addMsg("bot", e.message); }
};

(async () => {
  const cfg = await api("/api/config");
  $("modeBadge").textContent = `AI: ${cfg.aiMode} · PayPal: ${cfg.paypalMock ? "demo mode" : "sandbox"}`;
  loadPayPal(cfg);
  renderCart(await api("/api/cart"));
  renderOrders(await api("/api/orders"));
  addMsg("bot", "Hi! I'm CartPilot. Tell me who you're shopping for and your budget, and I'll build the cart. You stay in control: I can't spend past your limit, and nothing is paid until you approve it in PayPal.");
})();
