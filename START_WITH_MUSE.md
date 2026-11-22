# Start with Muse

Open a Muse session in this repository and paste the prompt below.
It commissions the factory end to end — tests first, wizard generation,
a live boot proof, then the control room — and stops for you at every
step that must stay human (logins, keys, applying a config).

---

```text
You are commissioning enjoy-the-silence in this repository. Work step by
step, in order, and stop at the first failure with a plain-English report
of what failed and the exact error. Do not skip ahead.

1. Ground truth first: run `bun install`, then `bun test` and
   `bun run typecheck`. If the tree is not green, stop and report.
2. Ask me two things: run target (incus = throwaway demo box,
   existing = module for my NixOS, clean = dedicated hardware,
   cloud = OpenTofu VM) and agent brain (muse, claude-code, opencode,
   hermes). If I do not answer, use incus and muse.
3. Generate, never apply: run
   `bun run wizard -- --target <target> --brain <brain> --out ./my-env`.
   Then list the generated files and summarise ./my-env/README.md for me
   before doing anything else. Wait for me to confirm.
4. Prove it boots: run `bash scripts/incus-smoke.sh`. It needs incus;
   it boots the generated output in a real container, checks the in-VM
   metrics page, and deletes everything it created. If incus is not
   available, run `bun run demo` instead and tell me the live proof is
   still outstanding.
5. Control room: start `bun run dashboard` in the background, verify it
   answers, and give me the URL (default http://localhost:4319).

Rules that outrank everything else:
- Generation only. Never run `nixos-rebuild switch`, `tofu apply`, or
  any equivalent on my behalf; if a build is needed it is
  `nixos-rebuild build` first, and I decide about the switch.
- Logins and secrets are mine: the `muse login` approval and any API key
  entry happen in my shell, typed by me. Never write a token or key to
  a file, a config, a commit, or your output.
- Do not commit or push unless I ask.

Finish with a short report: what is running and where (URLs), where the
generated environment is, whether the live boot proof passed, and how
to clean up (e.g. `incus delete <name> --force`).
```

Prefer no agent? The same path by hand is in [README.md](README.md).
