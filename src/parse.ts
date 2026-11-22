// Parsers for the live repo data the showcase renders. Pure functions so
// they are unit-testable and work identically on the bundled snapshot.

export type Route = {
  host: string;
  path: string;
  upstream: string;
};
export type Preset = {
  name: string;
  command: string;
  resume: string;
  output: string;
};

export function parseCaddyRoutes(text: string): Route[] {
  const routes: Route[] = [];
  let host = "";
  let pendingPath = "/*";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const hostMatch = line.match(/^([a-z0-9.*_{}$-]+)\s*\{\s*$/i);
    if (hostMatch && !line.startsWith("handle") && !line.startsWith("@")) {
      host = (hostMatch[1] ?? "").replace("{$SITE_ADDRESS}", "example.com");
      pendingPath = "/*";
      continue;
    }
    const handleMatch = line.match(/^handle\s+(\S+)\s*\{/);
    if (handleMatch) {
      pendingPath = handleMatch[1] ?? "/*";
      continue;
    }
    if (line === "handle {") {
      pendingPath = "/*";
      continue;
    }
    const proxyMatch = line.match(/^reverse_proxy\s+(\S+)/);
    const upstream = proxyMatch?.[1];
    if (upstream && host) {
      routes.push({
        host,
        path: pendingPath,
        upstream,
      });
    }
  }
  return routes;
}

export function parseAgentPresets(text: string): Preset[] {
  const presets: Preset[] = [];
  const block = text.match(/PRESETS\s*=\s*\{([\s\S]*?)\n\} as const/);
  const body = block?.[1];
  if (!body) return presets;
  const entry =
    /"?([A-Za-z0-9_-]+)"?:\s*\{\s*command:\s*\[([^\]]+)\],\s*resumeFlag:\s*"([^"]+)",\s*output:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(body)) !== null) {
    const [, name, cmdBlock, resume, output] = m;
    if (!name || !cmdBlock || !resume || !output) continue;
    const cmd = [
      ...cmdBlock.matchAll(/"([^"]+)"/g),
    ]
      .map((x) => x[1] ?? "")
      .join(" ");
    presets.push({
      name,
      command: cmd,
      resume,
      output,
    });
  }
  return presets;
}

export function parseFleetBinaries(text: string): string[] {
  const names: string[] = [];
  const re = /\[\s*"([a-z-]+)",\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (name) names.push(name);
  }
  return names;
}

export function parseRoutesSummary(routes: Route[]): string {
  const hosts = [
    ...new Set(routes.map((r) => r.host)),
  ];
  return `${routes.length} public routes across ${hosts.length} hosts`;
}
