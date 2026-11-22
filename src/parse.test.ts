import { describe, expect, test } from "bun:test";
import { parseAgentPresets, parseCaddyRoutes, parseFleetBinaries } from "./parse";

const CADDY = `
api.{$SITE_ADDRESS} {
	handle /v1/* {
		reverse_proxy app:3002
	}
	handle {
		reverse_proxy app:3001
	}
}
portal.{$SITE_ADDRESS} {
	reverse_proxy app:3005
}
`;

describe("parseCaddyRoutes", () => {
  test("extracts host/path/upstream incl. handle splits", () => {
    const routes = parseCaddyRoutes(CADDY);
    expect(routes).toEqual([
      {
        host: "api.example.com",
        path: "/v1/*",
        upstream: "app:3002",
      },
      {
        host: "api.example.com",
        path: "/*",
        upstream: "app:3001",
      },
      {
        host: "portal.example.com",
        path: "/*",
        upstream: "app:3005",
      },
    ]);
  });
  test("empty input yields no routes", () => {
    expect(parseCaddyRoutes("")).toEqual([]);
  });
});

describe("parseAgentPresets", () => {
  test("extracts preset commands", () => {
    const src = `export const PRESETS = {
  "claude-code": {
    command: ["claude", "-p", "--output-format", "json"],
    resumeFlag: "--resume",
    output: "claude-json",
  },
} as const satisfies Record<string, unknown>;`;
    expect(parseAgentPresets(src)).toEqual([
      {
        name: "claude-code",
        command: "claude -p --output-format json",
        resume: "--resume",
        output: "claude-json",
      },
    ]);
  });
  test("extracts unquoted keys too (real presets-file shape)", () => {
    const src = `export const PRESETS = {
  "claude-code": {
    command: ["claude", "-p", "--output-format", "json"],
    resumeFlag: "--resume",
    output: "claude-json",
  },
  opencode: {
    command: ["opencode", "run", "--format", "json"],
    resumeFlag: "--session",
    output: "opencode-ndjson",
  },
} as const satisfies Record<string, unknown>;`;
    expect(parseAgentPresets(src).map((p) => p.name)).toEqual([
      "claude-code",
      "opencode",
    ]);
  });
  test("malformed input yields no presets", () => {
    expect(parseAgentPresets("not typescript at all")).toEqual([]);
    expect(parseAgentPresets("")).toEqual([]);
  });
});

describe("parseFleetBinaries", () => {
  test("extracts binary names", () => {
    const src = `const BINARIES = [["hermes", ["/x"]], ["muse", ["/y"]]];`;
    expect(parseFleetBinaries(src)).toEqual([
      "hermes",
      "muse",
    ]);
  });
});
