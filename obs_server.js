#!/usr/bin/env node
/* eslint-disable */
const { execFileSync, execFile } = require("child_process");
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
const mount = `/${key}`;
const staticMount = `${mount}/`;

app.use(staticMount, cors());

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        await fsp.access(absPath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
};

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

const renderWithTemplate = async (bodyHtml, title, cssUrl, footerHtml) => {
    const tpl = await fetchTemplate("https://ben256.com/template.html");
    const ifCssRe = /\$if\(css\)\$[\s\S]*?\$endif\$/g;
    return tpl
        .replace(ifCssRe, `<link rel="stylesheet" href="${cssUrl}">`)
        .replace(/\$title\$/g, title || "")
        .replace(/\$css\$/g, cssUrl || "")
        .replace(/\$body\$/g, bodyHtml || "")
        .replace(/\$footer-content\$/g, footerHtml || "");
};

app.use(staticMount, hiddenGuard);

app.get(new RegExp(`^${esc(mount)}/?$`), async (_req, res) => {
    try {
        const [files, bodyTpl] = await Promise.all([walkFiles(root), fsp.readFile(BODY_FILE, "utf8")]);
        const exts = new Set();
        const rows = [];
        const tasks = files.map(async (rel) => {
            const name = rel.substring(rel.lastIndexOf("/") + 1);
            const href = staticMount + rel.split("/").map(encodeURIComponent).join("/");
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
            if (ext === "mp4" || ext === "mkv") {
                const thumbRel = rel.replace(/\.[^/.]+$/, ".jpg");
                const absThumb = path.join(root, thumbRel);
                if (await hasFile(absThumb)) {
                    thumbHref = staticMount + thumbRel.split("/").map(encodeURIComponent).join("/");
                }
            }
            let duration = "";
            let width = "";
            let height = "";
            let fps = "";
            if (ext === "mp4" || ext === "mkv") {
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
            return `<tr data-ext="${e}"${tt}><td class="thumb-cell">${thumbCell}</td><td><a href="${r.href}">${r.name}</a></td><td>${r.cat}</td><td>${r.duration}</td><td>${r.resolution}</td><td>${fpsCell}</td><td>${r.size}</td><td>${r.mtime}</td></tr>`;
        }).join("");
        const extList = Array.from(exts).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        const filtersHtml = extList.map((x) => {
            const id = `ext-${x.replace(/[^a-z0-9_-]/gi, "")}`;
            const checked = (x === "mkv" || x === "jpg") ? "" : " checked";
            return `<label><input type="checkbox" class="ext-filter" id="${id}" value="${x}"${checked}> .${x}</label>`;
        }).join(" ");
        const bodyHtml = bodyTpl.replace("%%FILTERS%%", filtersHtml || "").replace("%%ROWS%%", rowsHtml || "<tr><td colspan='8'>No files found.</td></tr>");
        const page = await renderWithTemplate(bodyHtml, "OBS Files", CSS_URL, "");
        res.type("html").send(page);
    } catch (err) {
        console.error("table index error:", err);
        res.status(500).send("Internal Server Error");
    }
});

app.use(
    staticMount,
    express.static(root, {
        fallthrough: true,
        etag: true,
        immutable: true,
        maxAge: "1h",
        index: false
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

