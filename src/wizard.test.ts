import { describe, expect, test } from "bun:test";
import { DEFAULT_ANSWERS, generateWizardFiles, MUSE_PIN, type WizardAnswers } from "./wizard";

const base: WizardAnswers = {
  ...DEFAULT_ANSWERS,
};

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
describe("generateWizardFiles", () => {
  test("incus target generates config, hardware stub, runner, instructions", () => {
    const files = generateWizardFiles({
      ...base,
      target: "incus",
    });
    expect(
      [
        ...files.keys(),
      ].sort(),
    ).toEqual([
      "AGENTS.md",
      "README.md",
      "configuration.nix",
      "factory.nix", // gitea + dashboard on by default
      "hardware-configuration.nix",
      "install-muse.sh", // default brain is muse
      "run-incus.sh",
      "setup-api-key.sh", // default billing is per-token api
    ]);
    expect(files.get("configuration.nix")).toContain('networking.hostName = "agent-os-demo"');
    expect(files.get("run-incus.sh")).toContain("incus launch");
    // Status app must land at /root/status/server.ts (the documented path):
    // pushing the dir onto root/ puts it there; onto root/status nests it.
    expect(files.get("run-incus.sh")).toContain('incus file push -r status "$CONTAINER/root/"');
    expect(files.get("run-incus.sh")).not.toContain(
      'incus file push -r status "$CONTAINER/root/status"',
    );
    // Primary image must be one the images: remote still publishes.
    expect(files.get("run-incus.sh")).toContain("images:nixos/26.05");
    expect(files.get("run-incus.sh")).not.toContain("images:nixos/25.11");
  });

  test("existing target generates an importable module, no hardware stub", () => {
    const files = generateWizardFiles({
      ...base,
      target: "existing",
    });
    expect(files.has("agent-os-module.nix")).toBe(true);
    expect(files.has("hardware-configuration.nix")).toBe(false);
    expect(files.get("README.md")).toContain("build before switching");
  });

  test("clean target generates full config but no incus runner", () => {
    const files = generateWizardFiles({
      ...base,
      target: "clean",
    });
    expect(files.has("configuration.nix")).toBe(true);
    expect(files.has("run-incus.sh")).toBe(false);
  });

  test("generated config never contains a secret-shaped value", () => {
    for (const target of [
      "incus",
      "existing",
      "clean",
    ] as const) {
      const files = generateWizardFiles({
        ...base,
        target,
      });
      for (const content of files.values()) {
        expect(content).not.toMatch(/[0-9]{8,10}:[A-Za-z0-9_-]{35}/);
        expect(content).not.toContain("BOT_TOKEN=");
      }
    }
  });

  test("telegram entry is removed: rejected and never generated", () => {
    expect(() =>
      generateWizardFiles({
        ...base,
        // @ts-expect-error telegram is no longer a valid entry
        entry: "telegram",
      }),
    ).toThrow("invalid entry");
    for (const target of [
      "incus",
      "existing",
      "clean",
      "cloud",
    ] as const) {
      for (const content of generateWizardFiles({
        ...base,
        target,
      }).values()) {
        expect(content).not.toMatch(/telegram/i);
      }
    }
  });

  test("cloud target generates OpenTofu + bootstrap for both providers, token-free", () => {
    for (const cloudProvider of [
      "hetzner",
      "digitalocean",
    ] as const) {
      const files = generateWizardFiles({
        ...base,
        target: "cloud",
        cloudProvider,
      });
      expect(files.has("main.tf")).toBe(true);
      expect(files.has("bootstrap-cloud.sh")).toBe(true);
      expect(files.has("configuration.nix")).toBe(true);
      const tf = files.get("main.tf") ?? "";
      expect(tf).toContain(cloudProvider === "hetzner" ? "hcloud_server" : "digitalocean_droplet");
      // Tokens are referenced as env/sensitive vars, never embedded values.
      for (const content of files.values()) {
        expect(content).not.toMatch(/HCLOUD_TOKEN=[A-Za-z0-9]|DIGITALOCEAN_TOKEN=[A-Za-z0-9]/);
      }
      expect(files.get("README.md")).toContain("tofu plan");
    }
  });

  test("cloud region/size overrides reach the generated tf", () => {
    const files = generateWizardFiles({
      ...base,
      target: "cloud",
      cloudProvider: "digitalocean",
      cloudRegion: "ams3",
      cloudSize: "s-4vcpu-8gb",
    });
    expect(files.get("main.tf")).toContain('region = "ams3"');
    expect(files.get("main.tf")).toContain('size   = "s-4vcpu-8gb"');
  });

  test("muse brain installs Muse literally: pinned derivation + verified script", () => {
    const files = generateWizardFiles({
      ...base,
      target: "clean",
      brain: "muse",
    });
    const nix = files.get("configuration.nix") ?? "";
    expect(nix).toContain('pname = "muse-code"');
    expect(nix).toContain(`version = "${MUSE_PIN.version}"`);
    expect(nix).toContain(MUSE_PIN.assets["x86_64-linux"].hash);
    expect(nix).toContain("install -Dm755 $src $out/bin/muse");
    const script = files.get("install-muse.sh") ?? "";
    expect(script).toContain("api.meta.ai/muse-code/channels/muse-stable");
    expect(script).toContain("sha256sum -c");
    expect(script).toContain('muse" --version');
    expect(files.get("README.md")).toContain("Muse (the brain)");
  });

  test("muse billing: api mode is per-token, plan mode is login, neither embeds a key", () => {
    const api = generateWizardFiles({
      ...base,
      target: "clean",
      brain: "muse",
      museBilling: "api",
    });
    expect(api.get("install-muse.sh")).toContain("META_API_KEY");
    expect(api.get("install-muse.sh")).toContain("muse auth set --api-key-stdin");
    expect(api.get("README.md")).toContain("per-token Meta Model API");
    const plan = generateWizardFiles({
      ...base,
      target: "clean",
      brain: "muse",
      museBilling: "plan",
    });
    expect(plan.get("install-muse.sh")).toContain("muse login");
    expect(plan.get("install-muse.sh")).not.toContain("auth set --api-key-stdin");
    for (const files of [
      api,
      plan,
    ]) {
      for (const content of files.values()) {
        expect(content).not.toMatch(/META_API_KEY=[A-Za-z0-9]{8,}/);
      }
    }
  });

  test("bring-your-own-key: api+background generates hidden-prompt setup, plan+background warns instead", () => {
    const api = generateWizardFiles({
      ...base,
      brain: "muse",
      museBilling: "api",
      backgroundTasks: true,
    });
    const setup = api.get("setup-api-key.sh") ?? "";
    expect(setup).toContain("read -rsp");
    expect(setup).toContain("muse auth set --api-key-stdin");
    expect(setup).toContain("chmod 600");
    expect(api.get("README.md")).toContain("setup-api-key.sh");
    const plan = generateWizardFiles({
      ...base,
      brain: "muse",
      museBilling: "plan",
      backgroundTasks: true,
    });
    expect(plan.has("setup-api-key.sh")).toBe(false);
    expect(plan.get("README.md")).toContain("will not be scheduled on a plan login");
    const attended = generateWizardFiles({
      ...base,
      brain: "muse",
      museBilling: "api",
      backgroundTasks: false,
    });
    expect(attended.get("README.md")).toContain("Interactive use only");
  });

  test("factory layer: gitea self-storing + dashboard, mirror-out named, both off omits factory.nix", () => {
    const files = generateWizardFiles({
      ...base,
      gitea: true,
      dashboard: true,
      mirrorRemote: "git@mirror.example:owner/agent-os.git",
    });
    const nix = files.get("factory.nix") ?? "";
    expect(nix).toContain("services.gitea");
    expect(nix).toContain("agent-factory-dashboard");
    expect(nix).toContain("Mirror-out");
    expect(files.get("README.md")).toContain("self-storing loop is never the sole copy");
    const withStatus = generateWizardFiles({
      ...base,
      gitea: false,
      dashboard: false,
      statusPage: true,
    });
    expect(withStatus.get("factory.nix")).toContain("agent-factory-status");
    expect(withStatus.get("run-incus.sh") ?? "").toContain("/root/status/server.ts");
    const off = generateWizardFiles({
      ...base,
      gitea: false,
      dashboard: false,
      statusPage: false,
    });
    expect(off.has("factory.nix")).toBe(false);
  });

  test("non-muse brains generate no muse installer", () => {
    const files = generateWizardFiles({
      ...base,
      target: "clean",
      brain: "opencode",
    });
    expect(files.has("install-muse.sh")).toBe(false);
    expect(files.get("configuration.nix")).not.toContain("muse-code");
  });

  test("invalid answers are rejected", () => {
    expect(() =>
      generateWizardFiles({
        ...base,
        hostname: "bad host!",
      }),
    ).toThrow("invalid hostname");
    expect(() =>
      generateWizardFiles({
        ...base,
        username: "0root",
      }),
    ).toThrow("invalid username");
    expect(() =>
      generateWizardFiles({
        ...base,
        // @ts-expect-error deliberately invalid enum value
        brain: "gpt",
      }),
    ).toThrow("invalid brain");
    expect(() =>
      generateWizardFiles({
        ...base,
        // @ts-expect-error deliberately invalid enum value
        cloudProvider: "aws",
      }),
    ).toThrow("invalid cloud provider");
  });
});
