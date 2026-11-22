// Shared bootstrap for the providers demo recording and its no-video
// test twin: a second feature whose builder station starts on the agy
// runner, hits that subscription's quota (demo/provider-stub.ts), and
// fails over to the muse backup — the real failover path in
// orchestrator.runStation, driven with stub runners per provider.
import { join } from "node:path";
import { runPlanPipeline, runTaskPipeline } from "../src/crew/dispatch";
import {
  getActivePresetId,
  getPresets,
  getStationRoutes,
  setPresets,
} from "../src/crew/orchestrator";
import type { FactoryStore } from "../src/crew/store";
import { newTask, type Task } from "../src/crew/task";
import { PROJECT_ID, STUB_COMMAND } from "./feature-run";

export const FAILOVER_PROMPT = "add a goodbye service and expose it at /goodbye";
export const FAILOVER_TITLE = "goodbye service";
export const QUOTA_STUB_COMMAND = [
  "bun",
  join(import.meta.dir, "provider-stub.ts"),
];

export async function submitFailoverTask(store: FactoryStore, taskId: string): Promise<void> {
  const now = new Date().toISOString();
  await store.writeTask(
    newTask(
      {
        id: taskId,
        projectId: PROJECT_ID,
        title: FAILOVER_TITLE,
        prompt: FAILOVER_PROMPT,
      },
      now,
    ),
  );
  await store.appendPrompt(taskId, {
    at: now,
    kind: "user",
    text: FAILOVER_PROMPT,
  });
}

/**
 * Plan with the normal stub, then build with per-provider stubs: the
 * builder's primary runner is agy (quota-exhausted stub), its backup is
 * muse (the feature stub). Routes are restored afterwards — they are
 * process-global routing state.
 */
export async function runFailoverFeature(store: FactoryStore, taskId: string): Promise<Task> {
  await runPlanPipeline(taskId, {
    store,
    command: STUB_COMMAND,
    autoApprove: true,
  });
  const beforePresets = getPresets();
  const beforeActive = getActivePresetId();
  const museRoutes = getStationRoutes();
  const agyBuilder = {
    id: "demo-agy-builds",
    name: "Gemini (agy) builds, Muse checks",
    routes: {
      ...museRoutes,
      builder: {
        provider: "agy" as const,
        model: "gemini-3-flash",
        effort: "medium",
      },
    },
  };
  const museDefault = {
    id: "demo-claude-default",
    name: "Muse — judgment & build (Meta)",
    routes: museRoutes,
  };
  setPresets(
    [
      agyBuilder,
      museDefault,
    ],
    "demo-agy-builds",
  );
  try {
    await runTaskPipeline(taskId, {
      store,
      providerCommands: {
        agy: QUOTA_STUB_COMMAND,
        muse: STUB_COMMAND,
        gemini: STUB_COMMAND,
        claude: STUB_COMMAND,
        codex: STUB_COMMAND,
      },
    });
  } finally {
    setPresets(beforePresets, beforeActive);
  }
  const task = await store.readTask(taskId);
  if (!task) throw new Error(`providers run: task ${taskId} disappeared from the store`);
  return task;
}
