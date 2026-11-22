import { join } from "node:path";
import { loadShowcaseData } from "./src/data";

const baseDir = import.meta.dir;
const publicDir = join(baseDir, "public");
const port = Number(process.env.PORT ?? 4317);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES[path.slice(dot)] ?? "application/octet-stream";
}

const config = {
  title: process.env.SHOWCASE_TITLE ?? "",
  tagline: process.env.SHOWCASE_TAGLINE ?? "",
  accent: process.env.SHOWCASE_ACCENT ?? "",
};

const server = Bun.serve({
  port,
  hostname: process.env.HOST ?? "localhost",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/config") {
      return Response.json(config);
    }
    if (url.pathname === "/healthz") {
      return new Response("ok", {
        headers: {
          "content-type": "text/plain",
        },
      });
    }
    if (url.pathname === "/api/showcase") {
      try {
        const data = await loadShowcaseData(baseDir);
        return Response.json(data);
      } catch (err) {
        return Response.json(
          {
            error: err instanceof Error ? err.message : "failed to load showcase data",
          },
          {
            status: 500,
          },
        );
      }
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    if (rel.includes(".."))
      return new Response("not found", {
        status: 404,
      });
    const file = Bun.file(join(publicDir, rel));
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "content-type": contentType(rel),
        },
      });
    }
    return new Response("not found", {
      status: 404,
    });
  },
});

console.log(`enjoy-the-silence showcase listening on http://localhost:${server.port}`);
