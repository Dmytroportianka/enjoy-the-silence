# Reproducible base (NixOS)

NixOS is only the concrete: it makes the factory reproducible. The wizard
generates `configuration.nix` (or `agent-os-module.nix` for an existing
host), `factory.nix` (local Gitea + dashboard units), and a placeholder
`hardware-configuration.nix` you replace on the target machine.

Rules: build before switch (`nixos-rebuild build && nixos-rebuild switch`),
rollback is one generation (`nixos-rebuild switch --rollback`), secrets
live in 0600 env files — never in `.nix` files or git. No Nix expertise is
needed to run the factory; the wizard pours the concrete.

## Project gates

The factory verifies projects with the same gate it uses on itself. A
Bun/TypeScript checkout that ships `biome.json` and a `verify` script is
verified with `bun run verify` automatically (see `defaultVerifyCommand`
in `src/crew/dispatch.ts`). To give that gate to an existing repo:

```bash
scripts/project-gates.sh /path/to/repo    # copies biome.json, bunfig.toml, PATTERNS.md
```

The conventions the gate enforces — formatting for additive diffs,
complexity ceilings, closed-set types, and the design patterns we lean on —
live in [../PATTERNS.md](../PATTERNS.md). The coder reviewer checks every
diff against that file.
