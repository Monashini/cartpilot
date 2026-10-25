import test from "node:test";
import assert from "node:assert/strict";
import { getSession, addToCart, setBudget, searchProducts, cartView, saveForLater, moveSavedToCart } from "../src/store.js";
import { buildOrderPayload } from "../src/paypal.js";

test("search finds reading items under a price", () => {
  const r = searchProducts({ query: "book reading", max_price: 20 });
  assert.ok(r.length > 0);
  assert.ok(r.every((p) => p.price <= 20));
});

test("guardrail blocks going over the spending limit", () => {
  const s = getSession("test-session-1");
  setBudget(s, 30);
  assert.equal(addToCart(s, { product_id: "bk-02" }).ok, true); // 18.50
  const r = addToCart(s, { product_id: "ft-03" }); // 19.99 -> 38.49 > 30
  assert.equal(r.ok, false);
  assert.match(r.error, /GUARDRAIL/);
  assert.equal(cartView(s).total, 18.5);
});

test("save for later moves items out of the cart, and back only within the limit", () => {
  const s = getSession("test-session-3");
  setBudget(s, 30);
  addToCart(s, { product_id: "bk-02" }); // 18.50
  saveForLater(s, { product_id: "bk-02" });
  assert.equal(cartView(s).items.length, 0);
  assert.deepEqual(cartView(s).saved.map((p) => p.id), ["bk-02"]);
  addToCart(s, { product_id: "ft-03" }); // 19.99
  const blocked = moveSavedToCart(s, { product_id: "bk-02" }); // 38.49 > 30
  assert.equal(blocked.ok, false);
  assert.equal(cartView(s).saved.length, 1);
  setBudget(s, 50);
  assert.equal(moveSavedToCart(s, { product_id: "bk-02" }).ok, true);
  assert.equal(cartView(s).saved.length, 0);
  assert.equal(cartView(s).total, 38.49);
});

test("order payload is itemized and totals match", () => {
  const s = getSession("test-session-2");
  setBudget(s, 100);
  addToCart(s, { product_id: "bk-01", quantity: 2 });
  addToCart(s, { product_id: "st-02" });
  const p = buildOrderPayload(cartView(s), "ref");
  const pu = p.purchase_units[0];
  const sum = pu.items.reduce((a, i) => a + Number(i.unit_amount.value) * Number(i.quantity), 0);
  assert.equal(pu.amount.value, sum.toFixed(2));
  assert.equal(pu.amount.breakdown.item_total.value, pu.amount.value);
});
