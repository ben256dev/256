#!/usr/bin/env node
const { execFileSync, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const https = require("https");
const express = require("express");
const cors = require("cors");
const io = require("@pm2/io");

const OBS_DIR = process.env.OBS_DIR || ".";
const PORT = Number(process.env.PORT || 8000);
const HOST = "0.0.0.0";
const FINGERPRINT_CMD = process.env.FINGERPRINT_CMD;
const THUMB_TIME = process.env.THUMB_TIME || "00:00:03";
const BODY_FILE = path.join(__dirname, "views", "body_table.html");
const CSS_URL = process.env.DARKMODE_CSS || "https://ben256.com/darkmode.css";
const OWNER_EMAILS = (process.env.OWNER_EMAILS || process.env.OWNER_EMAIL || "benjamin@ben256.com")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
const SSO_SESSION_URL = process.env.SSO_SESSION_URL || "https://www.ben256.com/api/session";
const SSO_LOGIN_URL = process.env.SSO_LOGIN_URL || "https://www.ben256.com/auth/google/start";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

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
const THUMB_DIR = path.join(root, ".thumbs");
const mount = `/${key}`;
const staticMount = `${mount}/`;

app.use(staticMount, cors());

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const htmlEsc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hidden = (name) => name.startsWith(".");
const hiddenGuard = (req, res, next) => {
    if (req.path.split("/").some((p) => p && p.startsWith("."))) return res.status(404).end();
    next();
};

const walkFiles = async (base) => {
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

const extOf = (filename) => {
    const i = filename.lastIndexOf(".");
    if (i <= 0 || i === filename.length - 1) return "";
    return filename.slice(i + 1).toLowerCase();
};

const hasFile = async (absPath) => {
    try {
        await fsp.access(absPath, fs.constants.ROK);
        return true;
    } catch {
        return false;
    }
};

const videoExts = new Set(["mp4", "mkv", "mov", "webm", "m4v"]);

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

const generatedThumbPath = (rel) => {
    const hash = crypto.createHash("sha1").update(rel).digest("hex");
    return path.join(THUMB_DIR, `${hash}-480x270.jpg`);
};

const ensureGeneratedThumb = (abs, rel) =>
    new Promise((resolve) => {
        const out = generatedThumbPath(rel);
        fsp.access(out, fs.constants.ROK)
            .then(() => resolve(out))
            .catch(async () => {
                try {
                    await fsp.mkdir(THUMB_DIR, { recursive: true });
                } catch {
                    resolve("");
                    return;
                }
                execFile(
                    "ffmpeg",
                    [
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-ss",
                        THUMB_TIME,
                        "-i",
                        abs,
                        "-frames:v",
                        "1",
                        "-vf",
                        "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2",
                        "-y",
                        out
                    ],
                    { timeout: 30000 },
                    (err) => resolve(err ? "" : out)
                );
            });
    });

const fmtDuration = (seconds) => {
    if (!isFinite(seconds) || seconds < 0) return "";
    const s = Math.floor(seconds);
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
};

const fmtBytes = (n) => {
    if (!Number.isFinite(n) || n < 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let x = n;
    while (x >= 1024 && i < units.length - 1) {
        x /= 1024;
        i++;
    }
    return `${x.toFixed(x < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

const fmtDate = (d) => {
    try {
        return new Date(d).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
    } catch {
        return "";
    }
};

const parseFps = (s) => {
    if (!s) return "";
    const parts = String(s).split("/");
    if (parts.length === 2) {
        const a = Number(parts[0]);
        const b = Number(parts[1]);
        if (a > 0 && b > 0) return (a / b).toFixed(2);
    }
    const v = Number(s);
    if (isFinite(v) && v > 0) return v.toFixed(2);
    return "";
};

const videoMetaCache = new Map();

const ffprobeMeta = (abs, cacheKey) =>
    new Promise((resolve) => {
        if (videoMetaCache.has(cacheKey)) return resolve(videoMetaCache.get(cacheKey));
        execFile(
            "ffprobe",
            [
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_entries",
                "format=duration:stream=codec_type,width,height,avg_frame_rate",
                abs
            ],
            { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
            (err, stdout) => {
                if (err) {
                    const empty = { duration: "", width: "", height: "", fps: "" };
                    videoMetaCache.set(cacheKey, empty);
                    return resolve(empty);
                }
                let j;
                try {
                    j = JSON.parse(stdout);
                } catch {
                    const empty = { duration: "", width: "", height: "", fps: "" };
                    videoMetaCache.set(cacheKey, empty);
                    return resolve(empty);
                }
                let duration = "";
                let width = "";
                let height = "";
                let fps = "";
                if (j && j.format && j.format.duration) duration = fmtDuration(Number(j.format.duration));
                if (Array.isArray(j.streams)) {
                    const v = j.streams.find((s) => s.codec_type === "video") || {};
                    if (v.width) width = String(v.width);
                    if (v.height) height = String(v.height);
                    if (v.avg_frame_rate) fps = parseFps(v.avg_frame_rate);
                }
                const out = { duration, width, height, fps };
                videoMetaCache.set(cacheKey, out);
                resolve(out);
            }
        );
    });

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

const renderWithTemplate = async (bodyHtml, title, cssUrl, footerHtml, baseHref) => {
    let tpl;
    try {
        tpl = await fetchTemplate("https://www.ben256.com/template.html");
    } catch (err) {
        console.warn("template fetch failed; using fallback:", err.message);
        tpl = fallbackTemplate;
    }
    const ifCssRe = /\$if\(css\)\$[\s\S]*?\$endif\$/g;
    let out = tpl.replace(ifCssRe, `<link rel="stylesheet" href="${cssUrl}">`)
        .replace(/\$title\$/g, title || "")
        .replace(/\$css\$/g, cssUrl || "")
        .replace(/\$body\$/g, bodyHtml || "")
        .replace(/\$footer-content\$/g, footerHtml || "");
    out = out.replace(/<head>/i, `<head><base href="${baseHref || "/"}">`);
    return out;
};

const renderIndex = async (req, res, basePath, isOwner) => {
    try {
        const [files, bodyTpl] = await Promise.all([walkFiles(root), fsp.readFile(BODY_FILE, "utf8")]);
        const exts = new Set();
        const rows = [];
        const tasks = files.map(async (rel) => {
            const name = rel.substring(rel.lastIndexOf("/") + 1);
            const hrefPath = rel.split("/").map(encodeURIComponent).join("/");
            let href = `${basePath}${hrefPath}`;
            if (!href.startsWith("/")) href = `/${href}`;
            const cat = categorize(rel);
            const ext = extOf(name);
            if (ext) exts.add(ext);
            const abs = path.join(root, rel);
            let stat;
            try {
                stat = await fsp.stat(abs);
            } catch {
                return;
            }
            let thumbHref = "";
            if (videoExts.has(ext)) {
                const thumbRel = rel.replace(/\.[^/.]+$/, ".jpg");
                const absThumb = path.join(root, thumbRel);
                if (await hasFile(absThumb)) {
                    const thumbPath = thumbRel.split("/").map(encodeURIComponent).join("/");
                    thumbHref = `${basePath}${thumbPath}`;
                    if (!thumbHref.startsWith("/")) thumbHref = `/${thumbHref}`;
                } else {
                    thumbHref = `${basePath}__thumb/${encodeRel(rel)}.jpg`;
                    if (!thumbHref.startsWith("/")) thumbHref = `/${thumbHref}`;
                }
            }
            let duration = "";
            let width = "";
            let height = "";
            let fps = "";
            if (videoExts.has(ext)) {
                const cacheKey = `${abs}:${stat.mtimeMs}`;
                const m = await ffprobeMeta(abs, cacheKey);
                duration = m.duration || "";
                width = m.width || "";
                height = m.height || "";
                fps = m.fps || "";
            }
            const size = fmtBytes(stat.size);
            const mtime = fmtDate(stat.mtime);
            rows.push({
                href,
                name,
                cat,
                ext,
                thumb: thumbHref,
                duration,
                resolution: width && height ? `${width}×${height}` : "",
                fps,
                size,
                mtime
            });
        });
        await Promise.all(tasks);
        rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        const rowsHtml = rows.map((r) => {
            const e = r.ext || "";
            const thumbCell = r.thumb ? `<a href="${r.href}"><img class="thumb" src="${r.thumb}" alt=""></a>` : "";
            const fpsCell = r.fps ? `${r.fps} fps` : "";
            const tt = THUMB_TIME ? ` data-thumbts="${THUMB_TIME}"` : "";
            return `<tr data-ext="${e}" data-cat="${r.cat}" data-name="${r.name}"${tt}><td class="thumb-cell">${thumbCell}</td><td><a class="file-link" href="${r.href}">${r.name}</a></td><td>${r.cat}</td><td>${r.duration}</td><td>${r.resolution}</td><td>${fpsCell}</td><td>${r.size}</td><td>${r.mtime}</td><td><a class="download-link" href="${r.href}" download>Download</a></td></tr>`;
        }).join("");
        const extList = Array.from(exts).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        const filtersHtml = extList.map((x) => {
            const id = `ext-${x.replace(/[^a-z0-9_-]/gi, "")}`;
            const checked = (x === "mkv" || x === "jpg") ? "" : " checked";
            return `<label><input type="checkbox" class="ext-filter" id="${id}" value="${x}"${checked}> .${x}</label>`;
        }).join(" ");
        const shareUrl = `${PUBLIC_BASE_URL || requestOrigin(req)}${staticMount}`;
        const bodyHtml = bodyTpl
            .replace("%%FILTERS%%", filtersHtml || "")
            .replace("%%ROWS%%", rowsHtml || "<tr><td colspan='9'>No files found.</td></tr>")
            .replace(/%%SHARE_URL%%/g, htmlEsc(shareUrl))
            .replace(/%%OWNER_CLASS%%/g, isOwner ? "is-owner" : "is-public");
        const page = await renderWithTemplate(bodyHtml, "OBS Files", CSS_URL, "", basePath);
        res.type("html").send(page);
    } catch (err) {
        console.error("table index error:", err);
        res.status(500).send("Internal Server Error");
    }
};

app.use(staticMount, hiddenGuard);

app.get("/", ownerGuard, async (req, res) => {
    await renderIndex(req, res, "/", true);
});

app.get(new RegExp(`^${esc(mount)}/?$`), async (req, res) => {
    await renderIndex(req, res, staticMount, false);
});

const sendGeneratedThumb = async (req, res, encoded) => {
    const rel = decodeRel(encoded);
    const abs = safeRelPath(rel);
    const ext = extOf(rel);
    if (!abs || !videoExts.has(ext) || !(await hasFile(abs))) {
        res.status(404).end();
        return;
    }
    const thumb = await ensureGeneratedThumb(abs, rel);
    if (!thumb) {
        res.status(404).end();
        return;
    }
    res.sendFile(thumb, {
        dotfiles: "allow",
        headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=86400"
        }
    });
};

app.use(async (req, res, next) => {
    const originalPath = urlPath(req.originalUrl || req.url || "");
    if (originalPath.startsWith(`${staticMount}__thumb/`)) {
        const file = path.basename(originalPath);
        await sendGeneratedThumb(req, res, file.replace(/\.jpg$/i, ""));
        return;
    }
    if (originalPath.startsWith("/__thumb/")) {
        ownerGuard(req, res, async () => {
            const file = path.basename(originalPath);
            await sendGeneratedThumb(req, res, file.replace(/\.jpg$/i, ""));
        });
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

app.use(
    staticMount,
    express.static(root, {
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
    })
);

app.use("/", ownerGuard, hiddenGuard);

app.use(
    "/",
    express.static(root, {
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
    })
);

app.all(/.*/, (_req, res) => res.status(404).end());

const DISPLAY_HOST = process.env.HOST;
const url = `http://${DISPLAY_HOST}:${PORT}${staticMount}`;

const server = app.listen(PORT, HOST || undefined, () => {
    console.log(`obs_server listening on ${url}`);
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
