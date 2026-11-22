# Run the showcase in an Incus container (demo box)

```bash
incus launch images:debian/12 enjoy-the-silence-demo
incus file push -r ../enjoy-the-silence enjoy-the-silence-demo/root/enjoy-the-silence
incus exec enjoy-the-silence-demo -- bash -c '
  apt-get update && apt-get install -y curl unzip git &&
  curl -fsSL https://bun.sh/install | bash &&
  export PATH=$HOME/.bun/bin:$PATH &&
  cd /root/enjoy-the-silence && bun install && PORT=4317 HOST=0.0.0.0 bun run start'
```

Then open `http://<container-ip>:4317` from the host network. Mount a reference
repo and set `REPO_ROOT` inside the container for live data; without it the
bundled snapshot renders. Packaging only — no public exposure is configured.
