import { describe, expect, test } from "bun:test";
import { QcVetoError, scaffoldWithAgent } from "./scaffold";
import { DEFAULT_ANSWERS } from "./wizard";

const baseFiles = new Map<string, string>([
  [
    "configuration.nix",
    '{ networking.hostName = "agent-os-demo"; }\n',
  ],
  [
    "README.md",
    "# agent-os\nbuild before switching\n",
  ],
]);
const answers = {
  ...DEFAULT_ANSWERS,
};
const builderJson = (files: Record<string, string>) =>
  JSON.stringify({
    files,
    summary: "covered special case",
  });

describe("scaffoldWithAgent (hybrid, generate-only, separate QC)", () => {
  test("no special cases: agent never invoked, returns null", async () => {
    const fail = async () => {
      throw new Error("must not be called");
    };
    expect(
      await scaffoldWithAgent({
        answers,
        baseFiles,
        specialCases: "  ",
        runBuilder: fail,
        runQc: fail,
      }),
    ).toBeNull();
  });

  test("builder delta merges over base and QC pass returns it", async () => {
    const prompts: string[] = [];
    const result = await scaffoldWithAgent({
      answers,
      baseFiles,
      specialCases: "add a tailscale service",
      runBuilder: async (p) => {
        prompts.push(p);
        return builderJson({
          "configuration.nix": "{ services.tailscale.enable = true; }\n",
        });
      },
      runQc: async (p) => {
        prompts.push(p);
        return "QC: PASS\ncovers tailscale, no secrets";
      },
    });
    expect(result?.files.get("configuration.nix")).toContain("tailscale");
    expect(result?.files.get("README.md")).toContain("build before switching");
    expect(result?.changed).toEqual([
      "configuration.nix",
    ]);
    expect(prompts[0]).toContain("tailscale service");
    expect(prompts[0]).toContain("Base files:");
    expect(prompts[1]).toContain("separate session from the builder");
    expect(prompts[1]).toContain("services.tailscale");
  });

  test("QC veto and non-PASS replies fail closed", async () => {
    const runBuilder = async () =>
      builderJson({
        "extra.nix": "{ }\n",
      });
    await expect(
      scaffoldWithAgent({
        answers,
        baseFiles,
        specialCases: "x",
        runBuilder,
        runQc: async () => "QC: VETO\nmisses the case",
      }),
    ).rejects.toBeInstanceOf(QcVetoError);
    await expect(
      scaffoldWithAgent({
        answers,
        baseFiles,
        specialCases: "x",
        runBuilder,
        runQc: async () => "looks fine to me",
      }),
    ).rejects.toBeInstanceOf(QcVetoError);
  });

  test("unsafe paths, secrets, and telegram in agent output are rejected", async () => {
    const qc = async () => "QC: PASS";
    await expect(
      scaffoldWithAgent({
        answers,
        baseFiles,
        specialCases: "x",
        runBuilder: async () =>
          builderJson({
            "../evil.nix": "{}",
          }),
        runQc: qc,
      }),
    ).rejects.toThrow("unsafe agent file path");
    await expect(
      scaffoldWithAgent({
        answers,
        baseFiles,
        specialCases: "x",
        runBuilder: async () =>
          builderJson({
            "a.nix": 'x = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";',
          }),
        runQc: qc,
      }),
    ).rejects.toThrow("secret-shaped");
    await expect(
      scaffoldWithAgent({
        answers,
        baseFiles,
        specialCases: "x",
        runBuilder: async () =>
          builderJson({
            "a.md": "add telegram bridge",
          }),
        runQc: qc,
      }),
    ).rejects.toThrow("telegram");
  });
});
