import { CopilotClient } from "@github/copilot-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const quantity = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function quotaSummary(result) {
  const quota = result?.quotaSnapshots?.premium_interactions;
  if (!quota || typeof quota !== "object" || (quota.hasQuota === false
    && quota.isUnlimitedEntitlement !== true && quota.entitlementRequests !== -1)) {
    return { state: "unavailable" };
  }
  return {
    state: "available",
    source: "copilot-sdk.account.getQuota",
    unit: quota.tokenBasedBilling === true ? "AI credits" : "premium requests",
    used: quantity(quota.usedRequests),
    entitlement: quantity(quota.entitlementRequests),
    unlimited: quota.isUnlimitedEntitlement === true || quota.entitlementRequests === -1,
    remaining_percentage: quantity(quota.remainingPercentage),
    usage_allowed_after_exhaustion: quota.usageAllowedWithExhaustedQuota === true,
  };
}

export async function accountQuota({ cliPath = "copilot", Client = CopilotClient } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cxf-quota-"));
  let client, timer;
  try {
    client = new Client({ cliPath, cwd: directory, autoRestart: false, logLevel: "none" });
    return await Promise.race([
      (async () => {
        await client.start();
        return quotaSummary(await client.rpc.account.getQuota({}));
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ state: "unavailable" }), 20000);
      }),
    ]);
  } catch {
    return { state: "unavailable" };
  } finally {
    clearTimeout(timer);
    // Python also bounds the entire process group, including a stuck CLI child.
    await client?.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { "copilot-bin": { type: "string" } } });
  console.log(JSON.stringify(await accountQuota({ cliPath: values["copilot-bin"] })));
}
