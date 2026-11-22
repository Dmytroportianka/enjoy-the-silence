// Wizard generation logic. Pure: answers in, files out (path -> content).
// The CLI wrapper (scripts/wizard.ts) handles prompting and writing to disk.
// Nothing here applies a configuration: the wizard only generates, and the
// generated README always builds before any switch.

export const TARGETS = [
  "incus",
  "existing",
  "clean",
  "cloud",
] as const;
export const BRAINS = [
  "muse",
  "claude-code",
  "opencode",
  "hermes",
] as const;
export const ENTRIES = [
  "cli",
] as const;
export const CLOUD_PROVIDERS = [
  "hetzner",
  "digitalocean",
] as const;
export const MUSE_BILLING = [
  "api",
  "plan",
] as const;
export type MuseBilling = (typeof MUSE_BILLING)[number];

export type Target = (typeof TARGETS)[number];
export type Brain = (typeof BRAINS)[number];
export type Entry = (typeof ENTRIES)[number];
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export interface WizardAnswers {
  target: Target;
  hostname: string;
  username: string;
  brain: Brain;
  entry: Entry;
  statusPage: boolean;
  updateCheck: boolean;
  cloudProvider: CloudProvider;
  cloudRegion: string;
  cloudSize: string;
  museBilling: MuseBilling;
  backgroundTasks: boolean;
  gitea: boolean;
  dashboard: boolean;
  mirrorRemote: string;
}

export const DEFAULT_ANSWERS: WizardAnswers = {
  target: "incus",
  hostname: "agent-os-demo",
  username: "agent",
  brain: "muse",
  entry: "cli",
  statusPage: true,
  updateCheck: true,
  cloudProvider: "hetzner",
  cloudRegion: "",
  cloudSize: "",
  museBilling: "api",
  backgroundTasks: true,
  gitea: true,
  dashboard: true,
  mirrorRemote: "",
};

export const CLOUD_DEFAULTS: Record<
  CloudProvider,
  {
    region: string;
    size: string;
    image: string;
    tokenEnv: string;
  }
> = {
  hetzner: {
    region: "fsn1",
    size: "cpx22",
    image: "debian-12",
    tokenEnv: "HCLOUD_TOKEN",
  },
  digitalocean: {
    region: "fra1",
    size: "s-2vcpu-4gb",
    image: "debian-12-x64",
    tokenEnv: "DIGITALOCEAN_TOKEN",
  },
};

// Muse Code is not in nixpkgs channels yet; the reference deployment installs it as a pinned
// static binary verified against Meta's release channel
// (https://api.meta.ai/muse-code/channels/muse-stable). Same approach here:
// a real inline derivation, pinned and hash-checked — bump version+hashes
// together when upgrading.
export const MUSE_PIN = {
  version: "1.4.10",
  build: "R6427.1",
  assets: {
    "x86_64-linux": {
      url: "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.10-R6427.1&file=muse-x86-linux",
      hash: "sha256-3s78D7M8SO5DQZw+cqwtvHgXQ4aGEQdMcpKAf1lg388=",
    },
    "aarch64-linux": {
      url: "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.10-R6427.1&file=muse-aarch64-linux",
      hash: "sha256-Llr6XoVgwVZRhSSa8tJ7Ppeq81HT0yJ1uOQQvnAtzjU=",
    },
  },
} as const;

function museDerivation(): string {
  const x = MUSE_PIN.assets["x86_64-linux"];
  const arm = MUSE_PIN.assets["aarch64-linux"];
  return [
    "    # Muse (Meta) — pinned static binary, hash-verified (see install-muse.sh",
    "    # for the non-Nix path). Authenticate once after install: run `muse`.",
    "    (pkgs.stdenv.mkDerivation {",
    '      pname = "muse-code";',
    `      version = "${MUSE_PIN.version}";`,
    "      src = pkgs.fetchurl {",
    `        url = if pkgs.stdenv.hostPlatform.system == "aarch64-linux" then "${arm.url}" else "${x.url}";`,
    `        hash = if pkgs.stdenv.hostPlatform.system == "aarch64-linux" then "${arm.hash}" else "${x.hash}";`,
    "      };",
    "      dontUnpack = true;",
    '      installPhase = "install -Dm755 $src $out/bin/muse";',
    "    })",
  ].join("\n");
}

function museInstallScript(a: WizardAnswers): string {
  return [
    "#!/usr/bin/env bash",
    "# Install Muse (Meta) as the `muse` binary — the non-Nix path",
    "# (cloud bootstrap, Debian fallback, or a plain user install).",
    "# Resolves Meta's stable channel manifest, verifies the sha256 from",
    "# that manifest before installing, then smoke-tests `muse --version`.",
    "set -euo pipefail",
    "",
    'CHANNEL_URL="https://api.meta.ai/muse-code/channels/muse-stable"',
    'command -v jq >/dev/null || { echo "jq is required"; exit 1; }',
    'case "$(uname -m)" in',
    '  x86_64) KEY="x86_linux" ;;',
    '  aarch64|arm64) KEY="aarch64_linux" ;;',
    '  *) echo "unsupported architecture: $(uname -m)"; exit 1 ;;',
    "esac",
    'MANIFEST_URL=$(curl -fsSL "$CHANNEL_URL" | jq -r .manifest_url)',
    'ARTIFACT=$(curl -fsSL "$MANIFEST_URL" | jq -c ".artifacts.$KEY")',
    'URL=$(echo "$ARTIFACT" | jq -r .url)',
    'CHECKSUM=$(echo "$ARTIFACT" | jq -r .checksum)',
    "TMP=$(mktemp -d)",
    'curl -fsSL "$URL" -o "$TMP/muse"',
    'echo "$CHECKSUM  $TMP/muse" | sha256sum -c -',
    'install -Dm755 "$TMP/muse" "$HOME/.local/bin/muse"',
    'rm -rf "$TMP"',
    '"$HOME/.local/bin/muse" --version',
    ...(a.museBilling === "api"
      ? [
          'echo "Per-token billing (Meta Model API):"',
          'echo "  export META_API_KEY=...   # takes priority over account login"',
          'echo "  # or persist: printf %s \\"\\$META_API_KEY\\" | muse auth set --api-key-stdin"',
          'echo "No plan subscription needed; idle agents cost nothing."',
        ]
      : [
          "echo \"Plan billing: run 'muse login' and approve the code in your browser.\"",
        ]),
    "",
  ].join("\n");
}

function apiKeySetupScript(a: WizardAnswers): string {
  return [
    "#!/usr/bin/env bash",
    "# Bring your own key: unattended background tasks and self-improvement",
    "# run without you, so they must bill per token to YOUR Meta Model API",
    "# key — never to a plan login meant for interactive use.",
    "# This prompts once (hidden), stores the key via Muse's own credential",
    "# store, and writes a 0600 env file that background user units load via",
    "# EnvironmentFile. The key never appears in generated config or git.",
    "set -euo pipefail",
    "",
    'ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/enjoy-the-silence/muse.env"',
    'read -rsp "Enter your Meta Model API key (hidden, billed per token): " KEY',
    "echo",
    '[ -n "$KEY" ] || { echo "empty key, aborting"; exit 1; }',
    'printf %s "$KEY" | muse auth set --api-key-stdin',
    'mkdir -p "$(dirname "$ENV_FILE")"',
    "umask 077",
    'printf "META_API_KEY=%s\\n" "$KEY" > "$ENV_FILE"',
    'chmod 600 "$ENV_FILE"',
    "unset KEY",
    `echo "Stored. Background units for user ${a.username} load: $ENV_FILE"`,
    'echo "Verify billing path: META_API_KEY is set for the unit, then muse exec runs per-token."',
    "",
  ].join("\n");
}

const BRAIN_PACKAGES: Record<Brain, string> = {
  muse: museDerivation(),
  "claude-code": "    claude-code",
  opencode: "    opencode",
  hermes: "    # hermes: per-user installer into ~/.hermes (intentionally not declarative)",
};

function brainPackageLine(brain: Brain): string {
  return BRAIN_PACKAGES[brain];
}

function systemConfig(a: WizardAnswers): string {
  return [
    "# Generated by the enjoy-the-silence wizard. Review before use.",
    "# This is a template: complete hardware-configuration.nix for your machine,",
    "# keep secrets in env files (0600), never in this file.",
    "{ config, pkgs, ... }:",
    "",
    "{",
    "  imports = [ ./hardware-configuration.nix ];",
    "",
    `  networking.hostName = "${a.hostname}";`,
    "  networking.firewall.allowedTCPPorts = [ " + (a.statusPage ? "8123 " : "") + "];",
    "",
    `  users.users.${a.username} = {`,
    "    isNormalUser = true;",
    '    extraGroups = [ "wheel" "docker" ];',
    "    linger = true; # user units (agent gateway) survive logout/boot",
    "  };",
    "",
    "  # Only the deploy path is passwordless; everything else needs a human.",
    "  security.sudo.extraRules = [{",
    `    users = [ "${a.username}" ];`,
    "    commands = [{",
    '      command = "/run/current-system/sw/bin/nixos-rebuild";',
    '      options = [ "NOPASSWD" ];',
    "    }];",
    "  }];",
    "",
    "  environment.systemPackages = with pkgs; [",
    "    git bun ripgrep fd worktrunk",
    brainPackageLine(a.brain),
    "  ];",
    "",
    a.updateCheck
      ? "  # The perceive stage: a timer that notices when the agent runtime is\n  # stale and files a task. Wire it to your tracker (see README)."
      : "  # Update-check timer disabled by wizard choice.",
    "",
    "  # Entry: local CLI and dashboard only.",
    "",
    '  system.stateVersion = "25.11";',
    "}",
    "",
  ].join("\n");
}

function moduleConfig(a: WizardAnswers): string {
  return [
    "# Generated by the enjoy-the-silence wizard (existing-NixOS target).",
    "# Import this module from your configuration.nix or flake, then:",
    "#   nixos-rebuild build   # evaluate+build FIRST",
    "#   nixos-rebuild switch  # only after the build is green",
    "# Your previous generation stays available for rollback.",
    "{ config, pkgs, ... }:",
    "",
    "{",
    `  # Host: keep your existing networking.hostName; this module adds the agent layer.`,
    `  users.users.${a.username} = {`,
    "    isNormalUser = true;",
    '    extraGroups = [ "wheel" "docker" ];',
    "    linger = true;",
    "  };",
    "",
    "  environment.systemPackages = with pkgs; [",
    "    git bun ripgrep fd worktrunk",
    brainPackageLine(a.brain),
    "  ];",
    "",
    a.statusPage
      ? "  networking.firewall.allowedTCPPorts = [ 8123 ]; # agent-status page"
      : "  # Status page disabled by wizard choice.",
    "}",
    "",
  ].join("\n");
}

function factoryConfig(a: WizardAnswers): string {
  const lines = [
    "# Generated by the enjoy-the-silence wizard: the factory layer (self-storing + control room).",
    "# Import alongside configuration.nix / agent-os-module.nix. Build before switching.",
    "{ config, pkgs, ... }:",
    "",
    "{",
  ];
  if (a.gitea) {
    lines.push(
      "  # Self-storing loop: the factory files its own blueprints, branches and PRs here.",
      "  services.gitea = {",
      "    enable = true;",
      '    settings.server = { HTTP_PORT = 3000; DOMAIN = "localhost"; ROOT_URL = "http://localhost:3000/"; };',
      "    settings.service.DISABLE_REGISTRATION = true;",
      "  };",
      "  networking.firewall.allowedTCPPorts = [ 3000 ];",
      "",
    );
  }
  if (a.dashboard) {
    lines.push(
      "  # Control room: manages the crew; owns no state (reads/writes /data job cards).",
      "  systemd.services.agent-factory-dashboard = {",
      '    description = "agent factory dashboard";',
      '    after = [ "network.target" ];',
      '    wantedBy = [ "multi-user.target" ];',
      `    serviceConfig = { ExecStart = "${"${pkgs.bun}"}/bin/bun run dashboard"; WorkingDirectory = "/var/lib/agent-factory/enjoy-the-silence"; Restart = "on-failure"; Environment = [ "FACTORY_DATA=/data" "DASHBOARD_PORT=4319" ]; };`,
      "  };",
      "",
    );
  }
  if (a.statusPage) {
    lines.push(
      "  # Status/backdoor: factory metrics, Muse subsessions, web terminal (:8123).",
      "  # The terminal is root-equivalent: set STATUS_AUTH_PASS_HASH from a 0600 env",
      "  # file (EnvironmentFile), never in Nix config. Without it the terminal is off",
      "  # on this non-loopback bind; /state stays read-only.",
      "  systemd.services.agent-factory-status = {",
      '    description = "agent factory status";',
      '    after = [ "network.target" ];',
      '    wantedBy = [ "multi-user.target" ];',
      `    serviceConfig = { ExecStart = "${"${pkgs.bun}"}/bin/bun run status/server.ts"; WorkingDirectory = "/var/lib/agent-factory/enjoy-the-silence"; Restart = "on-failure"; Environment = [ "FACTORY_DATA=/data" "STATUS_PORT=8123" "STATUS_BIND=0.0.0.0" ]; };`,
      "  };",
      "",
    );
  }
  if (a.mirrorRemote) {
    lines.push(
      `  # Mirror-out (breaks the self-storing loop): scheduled push to ${a.mirrorRemote}`,
      "  # Configure credentials outside Nix (0600 env/token file); never commit them.",
      "",
    );
  }
  lines.push("}", "");
  return lines.join("\n");
}

function hardwareStub(a: WizardAnswers): string {
  return [
    "# Placeholder. On the target machine replace this with the real file from:",
    "#   nixos-generate-config --show-hardware-config",
    `# (Generated for target '${a.target}' by the enjoy-the-silence wizard; the wizard`,
    "#  cannot know your disks, bootloader, or filesystems.)",
    "{ ... }: { }",
    "",
  ].join("\n");
}

function incusScript(a: WizardAnswers): string {
  return [
    "#!/usr/bin/env bash",
    "# Generated by the enjoy-the-silence wizard (incus target). Throwaway demo box:",
    "# nothing on the host changes; delete the container when done.",
    "set -euo pipefail",
    "",
    `CONTAINER="${a.hostname}"`,
    'incus launch images:nixos/26.05 "$CONTAINER" || incus launch images:debian/12 "$CONTAINER"',
    'incus file push configuration.nix "$CONTAINER/root/configuration.nix"',
    'incus file push hardware-configuration.nix "$CONTAINER/root/hardware-configuration.nix"',
    'incus file push factory.nix "$CONTAINER/root/factory.nix" 2>/dev/null || true',
    'incus file push -r status "$CONTAINER/root/"',
    'echo "Inside the container: review configuration.nix, then nixos-rebuild switch (NixOS image)"',
    'echo "Status backdoor inside the container: STATUS_BIND=0.0.0.0 bun /root/status/server.ts -> http://localhost:8123 (forward with: incus proxy)"',
    'echo "or apply the equivalent packages/services (Debian fallback)."',
    `echo "Demo box ready: incus shell $CONTAINER"`,
    "",
  ].join("\n");
}

function agentInstructions(a: WizardAnswers): string {
  return [
    "# AGENTS.md — instructions for an agent setting up this environment",
    "",
    "You are configuring an agent-operated NixOS environment. Rules:",
    "",
    "1. Never edit the live system directly; edit the config files in this",
    "   directory, then build before you switch:",
    "   `nixos-rebuild build` must pass before `nixos-rebuild switch`.",
    "2. Work in a git worktree/branch, never on a live checkout another",
    "   session may be using. Commit generated changes for review.",
    "3. Secrets live in 0600 env files, never in .nix files or git.",
    `4. Brain configured by the wizard: ${a.brain}. Entry: ${a.entry}.`,
    "5. If a build fails, read the evaluation error first; do not switch",
    "   around it and do not disable gates to make it pass.",
    "6. Rollback is one generation: `nixos-rebuild switch --rollback`.",
    "",
  ].join("\n");
}

function cloudMainTf(a: WizardAnswers): string {
  const d = CLOUD_DEFAULTS[a.cloudProvider];
  const region = a.cloudRegion || d.region;
  const size = a.cloudSize || d.size;
  if (a.cloudProvider === "hetzner") {
    return [
      "# Generated by the enjoy-the-silence wizard (cloud/hetzner). Review before applying.",
      "# Token comes from the environment at deploy time — never from files:",
      `#   export ${d.tokenEnv}=...   tofu plan && tofu apply`,
      "terraform {",
      "  required_providers {",
      '    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.48" }',
      "  }",
      "}",
      'variable "hcloud_token" { sensitive = true } # set via TF_VAR_hcloud_token',
      'provider "hcloud" { token = var.hcloud_token }',
      "",
      'resource "hcloud_ssh_key" "operator" {',
      '  name       = "agent-os-operator"',
      "  public_key = file(var.ssh_public_key_path)",
      "}",
      'variable "ssh_public_key_path" { default = "~/.ssh/id_ed25519.pub" }',
      "",
      'resource "hcloud_server" "agent_os" {',
      `  name        = "${a.hostname}"`,
      `  server_type = "${size}"`,
      `  location    = "${region}"`,
      `  image       = "${d.image}" # bootstrap converts this host to NixOS; see bootstrap-cloud.sh`,
      "  ssh_keys    = [hcloud_ssh_key.operator.id]",
      '  user_data   = file("bootstrap-cloud.sh")',
      "}",
      "",
      'output "ipv4" { value = hcloud_server.agent_os.ipv4_address }',
      "",
    ].join("\n");
  }
  return [
    "# Generated by the enjoy-the-silence wizard (cloud/digitalocean). Review before applying.",
    "# Token comes from the environment at deploy time — never from files:",
    `#   export TF_VAR_do_token=$${d.tokenEnv}   tofu plan && tofu apply`,
    "terraform {",
    "  required_providers {",
    '    digitalocean = { source = "digitalocean/digitalocean", version = "~> 2.40" }',
    "  }",
    "}",
    'variable "do_token" { sensitive = true }',
    'provider "digitalocean" { token = var.do_token }',
    "",
    'variable "ssh_public_key_path" { default = "~/.ssh/id_ed25519.pub" }',
    'resource "digitalocean_ssh_key" "operator" {',
    '  name       = "agent-os-operator"',
    "  public_key = file(var.ssh_public_key_path)",
    "}",
    "",
    'resource "digitalocean_droplet" "agent_os" {',
    `  name   = "${a.hostname}"`,
    `  region = "${region}"`,
    `  size   = "${size}"`,
    `  image  = "${d.image}" # bootstrap converts this host to NixOS; see bootstrap-cloud.sh`,
    "  ssh_keys = [digitalocean_ssh_key.operator.fingerprint]",
    '  user_data = file("bootstrap-cloud.sh")',
    "}",
    "",
    'output "ipv4" { value = digitalocean_droplet.agent_os.ipv4_address }',
    "",
  ].join("\n");
}

function cloudBootstrap(a: WizardAnswers): string {
  return [
    "#!/usr/bin/env bash",
    "# Generated by the enjoy-the-silence wizard (cloud target). Runs as cloud-init",
    "# user_data on a fresh Debian host and converts it to NixOS with",
    "# nixos-infect (a community tool — review it before trusting it:",
    "# https://github.com/elitak/nixos-infect). The wizard never runs this;",
    "# your `tofu apply` does, on a machine you just created and can delete.",
    "set -euo pipefail",
    "",
    "# 1. Copy configuration.nix + hardware-configuration.nix next to this",
    "#    script before apply, or fetch them from your generated repo.",
    "# 2. Bootstrap (destructive to THIS new VM only):",
    "#    curl https://raw.githubusercontent.com/elitak/nixos-infect/master/nixos-infect | PROVIDER=" +
      (a.cloudProvider === "hetzner" ? "hetznercloud" : "digitalocean") +
      " NIX_CHANNEL=nixos-25.11 bash 2>&1 | tee /tmp/infect.log",
    "# 3. After reboot into NixOS: nixos-rebuild build && nixos-rebuild switch",
    `echo "bootstrap placeholder for ${a.hostname}: review and uncomment on the new VM"`,
    "",
  ].join("\n");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
function readme(a: WizardAnswers): string {
  const lines = [
    `# enjoy-the-silence instance: ${a.hostname}`,
    "",
    `Generated by the enjoy-the-silence wizard. Target: **${a.target}**, user: \`${a.username}\`, brain: \`${a.brain}\`, entry: \`${a.entry}\`.`,
    "",
    "## Apply safely (all targets)",
    "",
    "1. Review every generated file. Complete `hardware-configuration.nix`",
    "   with your machine's real output where present.",
    "2. Build first: `nixos-rebuild build` — the config either builds or it",
    "   does not switch. No exceptions, including for agents.",
    "3. Switch: `nixos-rebuild switch`. Rollback if wrong:",
    "   `nixos-rebuild switch --rollback`.",
    "",
  ];
  if (a.target === "incus") {
    lines.push(
      "## Incus demo",
      "",
      "Run `./run-incus.sh` on a host with Incus. It creates a throwaway",
      "container and pushes the config in; delete the container to undo",
      "everything.",
      "",
    );
  }
  if (a.target === "cloud") {
    const d = CLOUD_DEFAULTS[a.cloudProvider];
    lines.push(
      "## Cloud VM",
      "",
      `Provider: **${a.cloudProvider}** (region \`${a.cloudRegion || d.region}\`, size \`${a.cloudSize || d.size}\`).`,
      "The wizard generated OpenTofu files only — it created nothing.",
      "",
      "```bash",
      `export TF_VAR_${a.cloudProvider === "hetzner" ? "hcloud_token" : "do_token"}=$${d.tokenEnv}`,
      "tofu init && tofu plan   # read the plan; it creates a billable VM",
      "tofu apply               # bootstrap-cloud.sh converts the fresh VM to NixOS",
      "```",
      "",
      "Destroy with `tofu destroy`. The provider token lives only in your",
      "shell environment; it is never written to a generated file.",
      "",
    );
  }
  if (a.target === "existing") {
    lines.push(
      "## Existing NixOS",
      "",
      "Add `./agent-os-module.nix` to your configuration.nix `imports` (or",
      "your flake's modules), then build before switching as above. Your",
      "existing generations remain your rollback path.",
      "",
    );
  }
  if (a.brain === "muse") {
    lines.push(
      "## Muse (the brain)",
      "",
      `Muse Code is installed literally, pinned at ${MUSE_PIN.version}: on`,
      "NixOS via the hash-verified derivation in the generated config (the",
      "`muse` binary lands in the system profile); elsewhere via the",
      "generated `install-muse.sh`, which resolves Meta's stable channel",
      "manifest, verifies sha256, installs to `~/.local/bin/muse`, and",
      "runs `muse --version`. Authenticate once by running `muse`.",
      "",
      a.museBilling === "api"
        ? 'Billing: **per-token Meta Model API** (`META_API_KEY`, which Muse gives priority over account login; or `printf %s "$META_API_KEY" | muse auth set --api-key-stdin` to persist it). No plan subscription: at participant/contributor token pricing the loop\'s perceive-and-check cycles cost little, an idle agent costs nothing, and headless Incus/cloud boxes need no browser login. That is what justifies metering this environment by tokens instead of by seat. Per-run contributor mode is available as `muse --contributor-mode on`.'
        : "Billing: **plan login** (`muse login`, browser approval). Flat cost for heavy personal use; per-token API mode (`META_API_KEY`) is the better fit for headless or shared demo boxes.",
      "",
      a.backgroundTasks && a.museBilling === "api"
        ? "Background tasks and self-improvement run without you, so they bill per token to your own key. Run `./setup-api-key.sh` once: it prompts (hidden), stores the key via `muse auth set --api-key-stdin`, and writes `~/.config/enjoy-the-silence/muse.env` (0600) for background user units to load via `EnvironmentFile`. The wizard itself never sees or stores the key."
        : a.backgroundTasks
          ? "WARNING: background tasks and self-improvement will not be scheduled on a plan login — a subscription seat is for interactive use, and unattended calls must bill per token. Re-run the wizard with `--billing api` (it generates `setup-api-key.sh`) before enabling any timers."
          : "Interactive use only; no background tasks will be scheduled. Enable them later with `--billing api` so unattended work bills per token to your own key.",
      "",
      "Bump the pin deliberately: update version and both hashes together",
      "from https://api.meta.ai/muse-code/channels/muse-stable.",
      "",
    );
  }
  if (a.gitea || a.dashboard) {
    lines.push(
      "## The factory layer",
      "",
      a.gitea
        ? "Gitea runs on this machine (http://localhost:3000): the factory stores its own configs, branches and PRs there. After the first switch: create the owner account, create an `enjoy-the-silence` repo, and push this generated directory into it. The crew then works only against that local Gitea."
        : "Gitea disabled: the crew works against your existing git remote.",
      a.dashboard
        ? "Dashboard (control room): `bun run dashboard` serves http://localhost:4319 — submit work orders, watch stations, answer governance stop-points. It owns no state; it reads the same `/data` job cards the orchestrator reconciles from."
        : "Dashboard disabled: manage the crew with `bun run crew` and the files in `/data`.",
      a.mirrorRemote
        ? `Mirror-out is configured for ${a.mirrorRemote}: a scheduled mirror keeps a copy outside this machine, so the self-storing loop is never the sole copy.`
        : "Mirror-out not configured: add one external mirror remote before trusting the self-storing loop — Gitea must never be the sole copy of the factory's blueprints.",
      "",
    );
  }
  lines.push(
    "## Agent-driven setup",
    "",
    "No wizard needed next time: hand this directory and its `AGENTS.md`",
    "to your coding agent and ask it to apply the environment. The same",
    "build-before-switch rule binds the agent.",
    "",
  );
  return lines.join("\n");
}

/** Generate all files for a wizard run. Throws on invalid answers. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: baseline: pre-existing complexity, split when next edited (see REVIEW.md)
export function generateWizardFiles(answers: WizardAnswers): Map<string, string> {
  if (!TARGETS.includes(answers.target)) throw new Error(`invalid target: ${answers.target}`);
  if (!BRAINS.includes(answers.brain)) throw new Error(`invalid brain: ${answers.brain}`);
  if (!ENTRIES.includes(answers.entry)) throw new Error(`invalid entry: ${answers.entry}`);
  if (!CLOUD_PROVIDERS.includes(answers.cloudProvider)) {
    throw new Error(`invalid cloud provider: ${answers.cloudProvider}`);
  }
  if (!MUSE_BILLING.includes(answers.museBilling)) {
    throw new Error(`invalid muse billing: ${answers.museBilling}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(answers.hostname)) {
    throw new Error(`invalid hostname: ${answers.hostname}`);
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(answers.username)) {
    throw new Error(`invalid username: ${answers.username}`);
  }
  const files = new Map<string, string>();
  if (answers.target === "existing") {
    files.set("agent-os-module.nix", moduleConfig(answers));
  } else {
    files.set("configuration.nix", systemConfig(answers));
    files.set("hardware-configuration.nix", hardwareStub(answers));
  }
  if (answers.gitea || answers.dashboard || answers.statusPage)
    files.set("factory.nix", factoryConfig(answers));
  if (answers.target === "incus") files.set("run-incus.sh", incusScript(answers));
  if (answers.target === "cloud") {
    files.set("main.tf", cloudMainTf(answers));
    files.set("bootstrap-cloud.sh", cloudBootstrap(answers));
  }
  if (answers.brain === "muse") files.set("install-muse.sh", museInstallScript(answers));
  if (answers.brain === "muse" && answers.museBilling === "api") {
    files.set("setup-api-key.sh", apiKeySetupScript(answers));
  }
  files.set("AGENTS.md", agentInstructions(answers));
  files.set("README.md", readme(answers));
  return files;
}
