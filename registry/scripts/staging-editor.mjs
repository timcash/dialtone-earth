import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");

const ALLOWED_DIRS = [
  "registry/src",
  "registry/worker",
];
const ALLOWED_ROOT_FILES = new Set(["README.md"]);
const ALLOWED_EXTS = new Set([".ts", ".css", ".html", ".md"]);

function normalizeRel(raw) {
  const clean = String(raw || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("..") || clean.includes("\0")) {
    throw new Error("Invalid file path");
  }
  return clean;
}

function assertAllowedPath(rel) {
  const norm = normalizeRel(rel);
  if (ALLOWED_ROOT_FILES.has(norm)) {
    return { rel: norm, abs: resolve(ROOT, norm) };
  }
  const inAllowedDir = ALLOWED_DIRS.some((dir) => norm.startsWith(`${dir}/`));
  if (!inAllowedDir) {
    throw new Error(`Path not editable via staging editor: ${norm}`);
  }
  const dot = norm.lastIndexOf(".");
  const ext = dot >= 0 ? norm.slice(dot).toLowerCase() : "";
  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error(`File extension not editable: ${ext}`);
  }
  const abs = resolve(ROOT, norm);
  const checkRel = relative(ROOT, abs).replace(/\\/g, "/");
  if (checkRel !== norm || checkRel.startsWith("..")) {
    throw new Error("Path escapes project root");
  }
  return { rel: norm, abs };
}

function listEditableFiles() {
  const files = [];
  for (const dir of ALLOWED_DIRS) {
    const absDir = resolve(ROOT, dir);
    let entries = [];
    try {
      entries = readdirSync(absDir);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const rel = `${dir}/${name}`;
      const abs = join(absDir, name);
      try {
        const st = statSync(abs);
        if (!st.isFile()) continue;
        assertAllowedPath(rel);
        files.push({ path: rel, bytes: st.size, mtime: st.mtime.toISOString() });
      } catch {
        // skip non-editable files
      }
    }
  }
  for (const name of ALLOWED_ROOT_FILES) {
    const abs = resolve(ROOT, name);
    try {
      const st = statSync(abs);
      if (st.isFile()) {
        files.push({ path: name, bytes: st.size, mtime: st.mtime.toISOString() });
      }
    } catch {
      // ignore
    }
  }
  return files;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const cmd = process.argv[2] || "list";
const argPath = process.argv[3] || "";

(async () => {
  if (cmd === "list") {
    console.log(JSON.stringify({ files: listEditableFiles() }));
  } else if (cmd === "read") {
    const { rel, abs } = assertAllowedPath(argPath);
    const content = readFileSync(abs, "utf8");
    const st = statSync(abs);
    console.log(JSON.stringify({ path: rel, content, bytes: st.size, mtime: st.mtime.toISOString() }));
  } else if (cmd === "write") {
    const { rel, abs } = assertAllowedPath(argPath);
    const raw = await readStdin();
    if (Buffer.byteLength(raw, "utf8") > 512 * 1024) {
      throw new Error("File exceeds 512 KiB staging editor limit");
    }
    writeFileSync(abs, raw, "utf8");
    const st = statSync(abs);
    console.log(JSON.stringify({ ok: true, path: rel, bytes: st.size, mtime: st.mtime.toISOString() }));
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }
})().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
