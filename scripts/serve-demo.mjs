// Dependency-free static server for the synthetic demo (browsers block fetch() of the 3D assets from file://).
//   node scripts/serve-demo.mjs [dir=dist-demo] [port=4173]      binds 127.0.0.1 only
// Inside the demo zip this file sits next to index.html, and `node serve.mjs` serves that folder.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || (fs.existsSync(path.join(here, "index.html")) ? here : "dist-demo")), port = Number(process.argv[3] || process.env.PORT || 4173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".bin": "application/octet-stream", ".png": "image/png", ".md": "text/plain; charset=utf-8" };
if (!fs.existsSync(path.join(root, "index.html"))) { console.error(`no index.html in ${root} (run \`npm run build\` first)`); process.exit(1); }
http.createServer((req, res) => {
  let rel; try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400); return res.end(); }
  const f = path.join(root, rel.endsWith("/") ? rel + "index.html" : rel);
  if (f !== root && !f.startsWith(root + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(f).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`Palace Atlas demo (synthetic data): http://127.0.0.1:${port}/?asset=assets   (Ctrl+C to stop)`));
