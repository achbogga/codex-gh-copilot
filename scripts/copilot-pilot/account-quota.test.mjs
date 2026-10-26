import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { accountQuota, quotaSummary } from "./account-quota.mjs";

const result = (value) => ({ quotaSnapshots: { premium_interactions: value } });

test("quota preserves real credit units and zero without fabricating missing amounts", () => {
  const quota = quotaSummary(result({ tokenBasedBilling: true, usedRequests: 0,
    entitlementRequests: 700000, remainingPercentage: 100, irrelevantSecret: "private" }));
  assert.equal(quota.unit, "AI credits");
  assert.equal(quota.used, 0);
  assert.equal(quota.entitlement, 700000);
  assert.equal(quota.unlimited, false);
  assert.equal(quota.remaining_percentage, 100);
  assert.ok(!JSON.stringify(quota).includes("private"));
  for (const missing of [undefined, null, -2, NaN, Infinity, true]) {
    const value = quotaSummary(result({ usedRequests: missing, entitlementRequests: missing }));
    assert.equal(value.used, null);
    assert.equal(value.entitlement, null);
    assert.equal(value.unlimited, false);
  }
});

test("legacy quota stays premium requests; unlimited needs an explicit provider flag", () => {
  assert.equal(quotaSummary(result({})).unit, "premium requests");
  assert.equal(quotaSummary(result({ entitlementRequests: -1 })).unlimited, true);
  assert.equal(quotaSummary(result({ isUnlimitedEntitlement: true })).unlimited, true);
  assert.deepEqual(quotaSummary({}), { state: "unavailable" });
  assert.deepEqual(quotaSummary(result({ hasQuota: false, entitlementRequests: 0 })), { state: "unavailable" });
});

test("quota uses only the official read-only account RPC, starts no model session, cleans up", async () => {
  const calls = [];
  let directory;
  class Client {
    constructor(options) {
      directory = options.cwd;
      assert.equal(options.autoRestart, false);
      this.rpc = { account: { getQuota: async (args) => {
        calls.push("getQuota");assert.deepEqual(args, {});
        return result({ tokenBasedBilling: true, usedRequests: 3 });
      } } };
    }
    async start() { calls.push("start"); }
    async stop() { calls.push("stop"); }
    async createSession() { assert.fail("No inference session may be created"); }
  }
  assert.equal((await accountQuota({ Client })).used, 3);
  assert.deepEqual(calls, ["start", "getQuota", "stop"]);
  await assert.rejects(access(directory));
});

test("account failures return no raw provider errors or credentials and still stop", async () => {
  let stopped = false;
  class Client {
    async start() { throw new Error("private credential or auth denial"); }
    async stop() { stopped = true; }
  }
  assert.deepEqual(await accountQuota({ Client }), { state: "unavailable" });
  assert.equal(stopped, true);
  class BrokenConstructor { constructor() { throw new Error("private"); } }
  assert.deepEqual(await accountQuota({ Client: BrokenConstructor }), { state: "unavailable" });
});
