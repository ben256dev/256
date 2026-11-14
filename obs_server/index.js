#!/usr/bin/env node
const { execFileSync } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const https = require("https");
const express = require("express");
const cors = require("cors");
const io = require("@pm2/io");
const { createMedia, extOf, stemOf, kindOf, VIDEO_PRIORITY, SPRITE_FRAMES } = require("./media");
const { createIcons } = require("./icons");

const OBS_DIR = process.env.OBS_DIR || ".";
const PORT = Number(process.env.PORT || 8000);
const HOST = "0.0.0.0";
const FINGERPRINT_CMD = process.env.FINGERPRINT_CMD;
const BODY_FILE = path.join(__dirname, "views", "body_table.html");
const CATEGORIES_FILE = process.env.CATEGORIES_FILE || path.join(__dirname, "categories.json");
const CSS_URL = process.env.DARKMODE_CSS || "https://ben256.com/darkmode.css";
const OWNER_EMAILS = (process.env.OWNER_EMAILS || process.env.OWNER_EMAIL || "benjamin@ben256.com")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
const SSO_SESSION_URL = process.env.SSO_SESSION_URL || "https://www.ben256.com/api/session";
const SSO_LOGIN_URL = process.env.SSO_LOGIN_URL || "https://www.ben256.com/auth/google/start";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
// Recordings marked for cleanup are moved under this top-level folder, keeping their original
// relative path, so backups can exclude one directory and restoring is exact.
const CLEANUP_DIR = (process.env.CLEANUP_DIR || "_cleanup").replace(/[\\/.]/g, "") || "_cleanup";
const AUTO_REMUX = process.env.AUTO_REMUX !== "0";

if (!FINGERPRINT_CMD) {
    console.error("FINGERPRINT_CMD not set in environment");
    process.exit(1);
}

let key;
try {
    key = execFileSync(FINGERPRINT_CMD, { encoding: "utf8", shell: true }).trim();
} catch (err) {
    console.error("Failed to execute FINGERPRINT_CMD:", err);
    process.exit(1);
}
key = key.replace(/[^A-Za-z0-9._-]/g, "");
if (!key) {
    console.error("FINGERPRINT_CMD produced an empty or invalid key");
    process.exit(1);
}

const app = express();
app.disable("x-powered-by");

const root = path.resolve(OBS_DIR);
const ART_DIR = path.join(root, ".thumbs");
const ICON_DIR = path.join(root, ".icons");
const META_FILE = path.join(root, ".obs_meta.json");
const mount = `/${key}`;
const staticMount = `${mount}/`;

const media = createMedia({
    root,
    artDir: ART_DIR,
    log: (msg) => console.log(`[media] ${msg}`),
    ffmpegJobs: Number(process.env.FFMPEG_JOBS || 3),
    remuxMinAgeSec: Number(process.env.REMUX_MIN_AGE_SEC || 90),
    autoRemux: AUTO_REMUX,
    // Don't spend disk on converting footage that is already marked for cleanup.
    skipRemux: (rel) => inCleanup(rel)
});

const icons = createIcons({ iconDir: ICON_DIR, log: (msg) => console.log(`[icons] ${msg}`) });

// Owner-set display names, keyed by the recording's path without extension so a name survives
// MKV→MP4 remuxing. Stored beside the media (hidden file, never served statically).
let meta = { titles: {}, cleanup: {} };
try {
    meta = { titles: {}, cleanup: {}, ...JSON.parse(fs.readFileSync(META_FILE, "utf8")) };
} catch (err) {
    if (err.code !== "ENOENT") console.warn("could not read", META_FILE, err.message);
}
const saveMeta = async () => {
    const tmp = `${META_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fsp.rename(tmp, META_FILE);
};

app.use(staticMount, cors());

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const htmlEsc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hidden = (name) => name.startsWith(".");
const hiddenGuard = (req, res, next) => {
    if (req.path.split("/").some((p) => p && p.startsWith("."))) return res.status(404).end();
    next();
};

const walkFiles = async (base = root) => {
    const out = [];
    const stack = [{ abs: base, rel: "" }];
    while (stack.length) {
        const { abs, rel } = stack.pop();
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        for (const d of entries) {
            if (hidden(d.name)) continue;
            const absChild = path.join(abs, d.name);
            const relChild = rel ? `${rel}/${d.name}` : d.name;
            if (d.isDirectory()) {
                stack.push({ abs: absChild, rel: relChild });
            } else if (d.isFile()) {
                out.push(relChild);
            }
        }
    }
    return out;
};

const categorize = (relPath) => {
    const parts = relPath.split("/").filter(Boolean);
    if (parts.length === 1) return "Uncategorized";
    return parts[0];
};

const inCleanup = (rel) => rel.startsWith(`${CLEANUP_DIR}/`);
const originalRel = (rel) => (inCleanup(rel) ? rel.slice(CLEANUP_DIR.length + 1) : rel);

const hasFile = async (absPath) => {
    try {
        await fsp.access(absPath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
};

const encodeRel = (rel) => Buffer.from(rel, "utf8").toString("base64url");

const decodeRel = (encoded) => {
    try {
        return Buffer.from(encoded, "base64url").toString("utf8");
    } catch {
        return "";
    }
};

const safeRelPath = (rel) => {
    if (!rel || rel.includes("\0") || rel.startsWith("/") || rel.split("/").some((part) => part === ".." || part.startsWith("."))) {
        return null;
    }
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) return null;
    return abs;
};

// OBS default filenames ("2025-08-19_20-45-59" / "2026-11-12 23-36-51") carry the recording start time.
const recordedAt = (name, fallbackMs) => {
    const m = /(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})-(\d{2})-(\d{2})/.exec(name);
    if (!m) return fallbackMs;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d) ? fallbackMs : d.getTime();
};

const loadCategories = () => {
    try {
        return JSON.parse(fs.readFileSync(CATEGORIES_FILE, "utf8"));
    } catch (err) {
        if (err.code !== "ENOENT") console.warn("categories.json unreadable:", err.message);
        return {};
    }
};

// Collapse recordings that exist in several containers (OBS .mkv + remuxed .mp4, plus legacy
// sidecar .jpg thumbnails) into one item that plays the most browser-friendly file.
const buildItems = async (files) => {
    const videoGroups = new Map();
    for (const rel of files) {
        if (kindOf(extOf(rel)) !== "video") continue;
        const stem = stemOf(rel);
        if (!videoGroups.has(stem)) videoGroups.set(stem, []);
        videoGroups.get(stem).push(rel);
    }
    const seen = new Set();
    const tasks = [];
    for (const rel of files) {
        const ext = extOf(rel);
        const kind = kindOf(ext);
        const stem = stemOf(rel);
        if (kind === "image" && videoGroups.has(stem)) continue;
        let primary = rel;
        let alts = [];
        if (kind === "video") {
            if (seen.has(stem)) continue;
            seen.add(stem);
            const group = videoGroups.get(stem);
            group.sort((a, b) => VIDEO_PRIORITY.indexOf(extOf(a)) - VIDEO_PRIORITY.indexOf(extOf(b)));
            [primary, ...alts] = group;
        }
        tasks.push(
            (async () => {
                const abs = path.join(root, primary);
                let st;
                try {
                    st = await fsp.stat(abs);
                } catch {
                    return null;
                }
                const pext = extOf(primary);
                const meta = kind === "video" || kind === "audio" ? await media.probe(abs, st.mtimeMs) : {};
                const name = primary.slice(primary.lastIndexOf("/") + 1);
                return {
                    rel: primary,
                    stem,
                    kind,
                    ext: pext,
                    name,
                    cat: categorize(primary),
                    cleanup: inCleanup(primary),
                    origCat: categorize(originalRel(primary)),
                    alts,
                    size: st.size,
                    mtime: st.mtimeMs,
                    t: recordedAt(name, st.mtimeMs),
                    durationSec: meta.duration || 0,
                    width: meta.width || 0,
                    height: meta.height || 0,
                    fps: meta.fps || 0,
                    coverArt: Boolean(meta.coverArt)
                };
            })()
        );
    }
    return (await Promise.all(tasks)).filter(Boolean);
};

const hrefFor = (basePath, rel) => {
    const href = `${basePath}${rel.split("/").map(encodeURIComponent).join("/")}`;
    return href.startsWith("/") ? href : `/${href}`;
};
const artHref = (basePath, kind, rel, ext) => `${basePath}__art/${kind}/${encodeRel(rel)}.${ext}?v=2`;

const clientItem = (it, basePath) => {
    const out = {
        stem: it.stem,
        name: it.name,
        cat: it.cat,
        kind: it.kind,
        ext: it.ext,
        href: hrefFor(basePath, it.rel),
        alts: it.alts.map((rel) => ({ ext: extOf(rel), href: hrefFor(basePath, rel) })),
        size: it.size,
        t: it.t,
        dur: Math.round(it.durationSec),
        w: it.width,
        h: it.height,
        fps: it.fps
    };
    if (meta.titles[it.stem]) out.custom = meta.titles[it.stem];
    if (it.cleanup) {
        out.cleanup = true;
        out.origCat = it.origCat;
        if (meta.cleanup[it.stem]) out.markedAt = meta.cleanup[it.stem].at;
    }
    if (it.kind === "video") {
        out.art = artHref(basePath, "poster", it.rel, "jpg");
        if (it.durationSec > 1) out.sprite = artHref(basePath, "sprite", it.rel, "jpg");
        if (it.ext === "mkv") {
            out.status = media.status(it.stem) || (media.isQueued(it.rel) ? "queued" : "");
        }
    } else if (it.kind === "audio") {
        out.art = artHref(basePath, "wave", it.rel, "png").replace("?v=2", "?v=3");
        out.cover = it.coverArt;
    } else if (it.kind === "image") {
        out.art = out.href;
    }
    return out;
};

const fetchTemplate = (url) =>
    new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to fetch template: ${res.statusCode}`));
                res.resume();
                return;
            }
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
        }).on("error", reject);
    });

const fetchJSON = (url, headers = {}) =>
    new Promise((resolve, reject) => {
        https.get(url, { headers }, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`Failed to fetch JSON: ${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(err);
                }
            });
        }).on("error", reject);
    });

const requestOrigin = (req) => {
    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString().split(",")[0];
    const host = (req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).toString().split(",")[0];
    return `${proto}://${host}`;
};

const urlPath = (raw) => {
    try {
        return new URL(raw, "http://localhost").pathname;
    } catch {
        return raw.split("?")[0] || "/";
    }
};

const isOwnerRequest = async (req) => {
    if (!OWNER_EMAILS.length) return false;
    const cookie = req.headers.cookie;
    if (!cookie) return false;
    try {
        const session = await fetchJSON(SSO_SESSION_URL, { Cookie: cookie });
        const email = session && session.user && session.user.email;
        return Boolean(session.authenticated && email && OWNER_EMAILS.includes(String(email).trim().toLowerCase()));
    } catch (err) {
        console.warn("sso session check failed:", err.message);
        return false;
    }
};

const loginURL = (req) => `${SSO_LOGIN_URL}?next=${encodeURIComponent(requestOrigin(req) + req.originalUrl)}`;

const ownerGuard = async (req, res, next) => {
    if (await isOwnerRequest(req)) return next();
    res.status(401).type("html").send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title></head>
<body>
<main>
<h1>OBS Files</h1>
<p>Sign in as the site owner to use the private OBS browser.</p>
<p><a href="${htmlEsc(loginURL(req))}">Sign in with Google</a></p>
<p>Shared links still use the private URL key.</p>
</main>
</body>
</html>`);
};

const fallbackTemplate = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$title$</title>
<style>
:root { color-scheme: dark; --bg: #0f0f0f; --text: #f1f1f1; --muted: #aaa; --link: #8ab4f8; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
body { font: 15px/1.45 Arial, Helvetica, sans-serif; }
main { width: min(1500px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
a { color: var(--link); }
button, input { font: inherit; }
footer { color: var(--muted); }
</style>
$if(css)$
<link rel="stylesheet" href="$css$">
$endif$
</head>
<body>
<main>
$body$
</main>
<footer>$footer-content$</footer>
</body>
</html>`;

// Function replacers so "$&", "$'" etc. in file names or page content are inserted literally.
const lit = (s) => () => s || "";

const renderWithTemplate = async (bodyHtml, title, cssUrl, footerHtml, baseHref) => {
    let tpl;
    try {
        tpl = await fetchTemplate("https://www.ben256.com/template.html");
    } catch (err) {
        console.warn("template fetch failed; using fallback:", err.message);
        tpl = fallbackTemplate;
    }
    const ifCssRe = /\$if\(css\)\$[\s\S]*?\$endif\$/g;
    let out = tpl.replace(ifCssRe, lit(`<link rel="stylesheet" href="${cssUrl}">`))
        .replace(/\$title\$/g, lit(title))
        .replace(/\$css\$/g, lit(cssUrl))
        .replace(/\$body\$/g, lit(bodyHtml))
        .replace(/\$footer-content\$/g, lit(footerHtml));
    out = out.replace(/<head>/i, lit(`<head><base href="${baseHref || "/"}">`));
    return out;
};

const renderIndex = async (req, res, basePath, isOwner) => {
    try {
        const [files, bodyTpl] = await Promise.all([walkFiles(root), fsp.readFile(BODY_FILE, "utf8")]);
        const [items, iconFiles] = await Promise.all([buildItems(files), icons.existing()]);
        const iconHrefs = {};
        for (const [cat, { file, v }] of iconFiles) iconHrefs[cat] = `${basePath}__icon/${encodeURIComponent(file)}?v=${v}`;
        const data = {
            // Cleanup is an owner-only concern; shared links never list those recordings.
            items: items.filter((it) => isOwner || !it.cleanup).map((it) => clientItem(it, basePath)),
            cleanupCat: CLEANUP_DIR,
            categories: loadCategories(),
            icons: iconHrefs,
            spriteFrames: SPRITE_FRAMES,
            isOwner
        };
        const shareUrl = `${PUBLIC_BASE_URL || requestOrigin(req)}${staticMount}`;
        // Per-item "copy link" always hands out the shareable (keyed) URL, never the owner-only path.
        data.shareBase = shareUrl;
        data.basePath = basePath;
        // JSON inside <script>: escape "<" so a file name can never close the tag.
        const json = JSON.stringify(data).replace(/</g, "\\u003c");
        const bodyHtml = bodyTpl
            .replace("%%DATA%%", lit(json))
            .replace(/%%SHARE_URL%%/g, lit(htmlEsc(shareUrl)))
            .replace(/%%OWNER_CLASS%%/g, lit(isOwner ? "is-owner" : "is-public"));
        const page = await renderWithTemplate(bodyHtml, "OBS Files", CSS_URL, "", basePath);
        res.type("html").send(page);
    } catch (err) {
        console.error("index error:", err);
        res.status(500).send("Internal Server Error");
    }
};

app.use(staticMount, hiddenGuard);

// Rename (display title only; files on disk are untouched). Empty title restores the automatic one.
app.post("/__api/title", ownerGuard, express.json({ limit: "4kb" }), async (req, res) => {
    const stem = String((req.body && req.body.stem) || "");
    const title = String((req.body && req.body.title) || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!safeRelPath(stem)) return res.status(400).json({ error: "bad path" });
    const files = await walkFiles(root);
    if (!files.some((rel) => stemOf(rel) === stem)) return res.status(404).json({ error: "not found" });
    if (title) meta.titles[stem] = title;
    else delete meta.titles[stem];
    try {
        await saveMeta();
    } catch (err) {
        console.error("saving titles failed:", err);
        return res.status(500).json({ error: "save failed" });
    }
    res.json({ stem, title });
});

// Mark recordings for cleanup (move every file of the recording under CLEANUP_DIR/) or restore them.
// Nothing is deleted here; deletion/backup policy is left to whatever reads the cleanup folder.
const moveGroup = async (files, stem, toCleanup) => {
    if (toCleanup === inCleanup(stem)) return { stem, skipped: true };
    if (media.status(stem)) throw Object.assign(new Error("still converting"), { code: 409 });
    const group = files.filter((rel) => stemOf(rel) === stem);
    if (!group.length) throw Object.assign(new Error("not found"), { code: 404 });
    const dest = (rel) => (toCleanup ? `${CLEANUP_DIR}/${rel}` : originalRel(rel));
    for (const rel of group) {
        const target = safeRelPath(dest(rel));
        if (!target) throw Object.assign(new Error("bad path"), { code: 400 });
        if (await hasFile(target)) throw Object.assign(new Error(`${dest(rel)} already exists`), { code: 409 });
    }
    const moved = [];
    try {
        for (const rel of group) {
            const from = path.join(root, rel);
            const to = path.join(root, dest(rel));
            await fsp.mkdir(path.dirname(to), { recursive: true });
            await fsp.rename(from, to);
            moved.push([from, to]);
        }
    } catch (err) {
        for (const [from, to] of moved.reverse()) await fsp.rename(to, from).catch(() => {});
        throw err;
    }
    const newStem = dest(stem);
    if (meta.titles[stem]) {
        meta.titles[newStem] = meta.titles[stem];
        delete meta.titles[stem];
    }
    if (toCleanup) meta.cleanup[newStem] = { at: Date.now(), from: stem };
    else delete meta.cleanup[stem];
    // Drop now-empty folders left behind under the cleanup dir after a restore.
    if (!toCleanup) {
        let dir = path.dirname(path.join(root, stem));
        const top = path.join(root, CLEANUP_DIR);
        while (dir.startsWith(top + path.sep)) {
            if (!(await fsp.rmdir(dir).then(() => true, () => false))) break;
            dir = path.dirname(dir);
        }
    }
    console.log(`[cleanup] ${toCleanup ? "marked" : "restored"}: ${stem} -> ${newStem} (${group.length} file${group.length === 1 ? "" : "s"})`);
    return { stem: newStem };
};

app.post("/__api/cleanup", ownerGuard, express.json({ limit: "64kb" }), async (req, res) => {
    const body = req.body || {};
    const action = body.action;
    const stems = Array.isArray(body.stems) ? body.stems.map(String).slice(0, 500) : [];
    if (!["mark", "restore"].includes(action) || !stems.length) return res.status(400).json({ error: "bad request" });
    const files = await walkFiles(root);
    const results = [];
    for (const stem of stems) {
        if (!safeRelPath(stem)) {
            results.push({ stem, error: "bad path" });
            continue;
        }
        try {
            results.push({ from: stem, ...(await moveGroup(files, stem, action === "mark")) });
        } catch (err) {
            results.push({ stem, error: err.message });
        }
    }
    try {
        await saveMeta();
    } catch (err) {
        console.error("saving meta failed:", err);
    }
    const failed = results.filter((r) => r.error);
    res.status(failed.length === results.length ? 409 : 200).json({ results });
});

app.get("/", ownerGuard, async (req, res) => {
    await renderIndex(req, res, "/", true);
});

app.get(new RegExp(`^${esc(mount)}/?$`), async (req, res) => {
    await renderIndex(req, res, staticMount, false);
});

const ART_KINDS = { poster: "video", sprite: "video", wave: "audio" };

const sendArt = async (res, artKind, encoded) => {
    const rel = decodeRel(encoded);
    const abs = safeRelPath(rel);
    const kind = kindOf(extOf(rel));
    if (!abs || ART_KINDS[artKind] !== kind || !(await hasFile(abs))) {
        res.status(404).end();
        return;
    }
    const st = await fsp.stat(abs);
    const meta = await media.probe(abs, st.mtimeMs);
    const stem = stemOf(rel);
    let out = "";
    if (artKind === "poster") out = await media.ensurePoster(abs, stem, meta.duration, true);
    else if (artKind === "sprite") out = await media.ensureSprite(abs, stem, meta.duration, true);
    else if (artKind === "wave") out = await media.ensureWave(abs, stem, meta.coverArt, true);
    if (!out) {
        res.status(404).end();
        return;
    }
    res.sendFile(out, { dotfiles: "allow", headers: { "Cache-Control": "public, max-age=604800" } });
};

const ART_RE = /__art\/(poster|sprite|wave)\/([A-Za-z0-9_-]+)\.(?:jpg|png)$/;
const ICON_RE = /__icon\/([^/]+)$/;

const sendIcon = async (res, encodedName) => {
    let name;
    try {
        name = decodeURIComponent(encodedName);
    } catch {
        return res.status(404).end();
    }
    const abs = icons.resolve(name);
    if (!abs || !(await hasFile(abs))) return res.status(404).end();
    res.sendFile(abs, { dotfiles: "allow", headers: { "Cache-Control": "public, max-age=604800" } });
};

app.use(async (req, res, next) => {
    const originalPath = urlPath(req.originalUrl || req.url || "");
    const ic = ICON_RE.exec(originalPath);
    if (ic && originalPath.startsWith(`${staticMount}__icon/`)) return sendIcon(res, ic[1]);
    if (ic && originalPath.startsWith("/__icon/")) return ownerGuard(req, res, () => sendIcon(res, ic[1]));
    const m = ART_RE.exec(originalPath);
    if (m && originalPath.startsWith(`${staticMount}__art/`)) {
        await sendArt(res, m[1], m[2]);
        return;
    }
    if (m && originalPath.startsWith("/__art/")) {
        ownerGuard(req, res, () => sendArt(res, m[1], m[2]));
        return;
    }
    next();
});

const MIME_MAP = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".css": "text/css",
    ".js": "application/javascript",
    ".html": "text/html"
};

const staticOpts = {
    fallthrough: true,
    etag: true,
    immutable: true,
    maxAge: "1h",
    index: false,
    setHeaders: (res, filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        const t = MIME_MAP[ext];
        if (t) res.setHeader("Content-Type", t);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Disposition", "inline");
    }
};

app.use(staticMount, express.static(root, staticOpts));

app.use("/", ownerGuard, hiddenGuard);

app.use("/", express.static(root, staticOpts));

app.all(/.*/, (_req, res) => res.status(404).end());

const DISPLAY_HOST = process.env.HOST;
const url = `http://${DISPLAY_HOST}:${PORT}${staticMount}`;

const server = app.listen(PORT, HOST || undefined, () => {
    console.log(`obs_server listening on ${url}`);
    media.start(() => walkFiles(root), buildItems);
    icons.sync(loadCategories()).catch((e) => console.warn("icon sync failed:", e.message));
});

server.on("error", (err) => {
    console.error("listen error:", err.code || err);
    process.exit(1);
});

process.on("unhandledRejection", (e) => {
    console.error("unhandledRejection", e);
    process.exit(1);
});
process.on("uncaughtException", (e) => {
    console.error("uncaughtException", e);
    process.exit(1);
});

io.action("url", (reply) => {
    reply({ url });
});
