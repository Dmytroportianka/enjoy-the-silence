const STAGES = [
  {
    name: "Perceive",
    title: "The system watches itself",
    body: "agent-status (:8123) probes the fleet's systemd units and binaries, and the muse-code-update-check timer notices when a new Muse release ships. No human has to remember to check — the OS perceives its own staleness and files the task.",
  },
  {
    name: "Decide",
    title: "Rules before actions",
    body: "AGENTS.md codifies incident-derived law: worktree isolation, plan-first approval, Zod over type assertions, no hardcoded price fallbacks. Agents decide inside those constraints, not around them — governance is part of the system image, not a prompt you hope is remembered.",
  },
  {
    name: "Act",
    title: "Hands that can touch the real machine",
    body: "The crew dispatches an agent into a jailed worktree on hardware you own. It edits real code, runs real builds, and reports back to the dashboard. The live checkout is never the workspace.",
  },
  {
    name: "Verify",
    title: "Every self-modification is gated",
    body: "The pre-push gauntlet runs lint, typecheck, unit tests, a shuffled test order, and containerized E2E before any change lands. An agent that cannot pass its own gates cannot change the system — ambition without verification is just risk.",
  },
  {
    name: "Deploy & roll back",
    title: "Generations make self-change reversible",
    body: "NixOS generations turn deployment into a switch, and a bad switch into a rollback. That reversibility is the answer to the first objection every judge raises: what happens when the agent improves itself wrong?",
  },
];

let stageIndex = 0;
const stepsEl = document.getElementById("loop-steps");
const detailEl = document.getElementById("loop-detail");

function renderStage() {
  const stage = STAGES[stageIndex];
  detailEl.innerHTML = "";
  const h = document.createElement("h3");
  h.textContent = `${stageIndex + 1}. ${stage.name} — ${stage.title}`;
  const p = document.createElement("p");
  p.textContent = stage.body;
  detailEl.append(h, p);
  stepsEl.querySelectorAll("button").forEach((btn, i) => {
    btn.setAttribute("aria-current", i === stageIndex ? "true" : "false");
  });
}

STAGES.forEach((stage, i) => {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = stage.name;
  btn.addEventListener("click", () => {
    stageIndex = i;
    renderStage();
  });
  li.append(btn);
  stepsEl.append(li);
});
document.getElementById("loop-prev").addEventListener("click", () => {
  stageIndex = (stageIndex + STAGES.length - 1) % STAGES.length;
  renderStage();
});
document.getElementById("loop-next").addEventListener("click", () => {
  stageIndex = (stageIndex + 1) % STAGES.length;
  renderStage();
});
renderStage();

function el(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

async function loadConfig() {
  try {
    const cfg = await (await fetch("/api/config")).json();
    if (cfg.title) document.getElementById("pitch-title").textContent = cfg.title;
    if (cfg.tagline) document.getElementById("pitch-tagline").textContent = cfg.tagline;
    if (cfg.accent) document.documentElement.style.setProperty("--accent", cfg.accent);
  } catch {
    // Defaults in the HTML stay in place.
  }
}

async function loadData() {
  const badge = document.getElementById("source-badge");
  try {
    const data = await (await fetch("/api/showcase")).json();
    if (data.error) throw new Error(data.error);
    badge.textContent = data.source.startsWith("live") ? "live repo data" : "bundled snapshot";
    document.getElementById("generated-at").textContent = `data generated ${data.generatedAt}`;
    document.getElementById("stat-routes").textContent = String(data.routes.length);
    document.getElementById("stat-fleet").textContent = String(data.fleet.length);
    document.getElementById("stat-presets").textContent = String(data.presets.length);
    document.getElementById("stat-commits").textContent = String(data.commits.length);

    const routesBody = document.getElementById("routes-body");
    routesBody.innerHTML = "";
    for (const r of data.routes) {
      const tr = document.createElement("tr");
      tr.append(el("td", r.host), el("td", r.path), el("td", r.upstream));
      routesBody.append(tr);
    }
    if (!data.routes.length) routesBody.append(el("tr", "No routes parsed"));

    const fleet = document.getElementById("fleet-list");
    fleet.innerHTML = "";
    for (const name of data.fleet) fleet.append(el("li", name));

    const presets = document.getElementById("presets-list");
    presets.innerHTML = "";
    for (const p of data.presets) {
      const li = document.createElement("li");
      const code = el("code", p.command);
      li.append(
        el("strong", `${p.name}: `),
        code,
        el("span", ` (resume ${p.resume}, ${p.output})`),
      );
      presets.append(li);
    }

    const commits = document.getElementById("commits-list");
    commits.innerHTML = "";
    for (const c of data.commits) {
      const li = document.createElement("li");
      const hash = el("span", c.hash);
      hash.className = "hash";
      const date = el("span", ` ${c.date} `);
      date.className = "date";
      li.append(hash, date, el("span", c.subject));
      commits.append(li);
    }
  } catch (err) {
    badge.textContent = "data unavailable";
    document.getElementById("routes-body").innerHTML = "";
    document.getElementById("routes-body").append(el("tr", `Failed to load: ${err.message}`));
  }
}

loadConfig().then(loadData);
