import { describe, expect, test } from "bun:test";
import { prepareFeatureRepo, runFeaturePipeline, submitFeatureTask } from "./feature-run";
import { runFailoverFeature, submitFailoverTask } from "./providers-run";

// The no-video twin of demo/record-providers.ts: same runs, asserted
// instead of filmed. Feature one lands normally; feature two's builder
// exhausts its agy quota and fails over to the muse backup.
describe("providers demo run (mocked model calls, real pipeline)", () => {
  test("feature creation lands, then a quota failover lands the second feature", async () => {
    const { store } = await prepareFeatureRepo();
    await submitFeatureTask(store, "feature-1");
    const first = await runFeaturePipeline(store, "feature-1");
    expect(first.state).toBe("done");

    await submitFailoverTask(store, "feature-2");
    const second = await runFailoverFeature(store, "feature-2");
    expect(second.state).toBe("done");
    const deliveries = await store.listDeliveries("feature-2");
    const builder = deliveries.find((d) => d.stationId === "builder");
    expect(builder?.status).toBe("done");
    expect(builder?.provider).toBe("muse");
    expect(builder?.detail).toContain("quota exhausted on agy");
    expect(await store.providerQuotaUntil("agy")).not.toBe("");
  }, 300_000);
});
