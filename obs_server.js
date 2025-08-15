#!/usr/bin/env node
/* eslint-disable */
const { execFileSync } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const cors = require("cors");
const io = require("@pm2/io");

const OBS_DIR = process.env.OBS_DIR || ".";
const PORT = Number(process.env.PORT || 8000);
const HOST = "0.0.0.0";
const FINGERPRINT_CMD = process.env.FINGERPRINT_CMD;

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

const templatePath = path.join(__dirname, "views", "table.html");

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

app.use(staticMount, hiddenGuard);

app.get(new RegExp(`^${esc(mount)}/?$`), async (_req, res) => {
    try {
        const files = await walkFiles(root);
        const rows = [];
        const exts = new Set();
        for (const rel of files) {
            const href = staticMount + rel.split("/").map(encodeURIComponent).join("/");
            const name = rel.substring(rel.lastIndexOf("/") + 1);
            const cat = categorize(rel);
            const ext = extOf(name);
            if (ext) exts.add(ext);
            rows.push({ href, name, cat, ext });
        }
        rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        const rowsHtml = rows.map(r => {
            const e = r.ext || "";
            return `<tr data-ext="${e}"><td><a href="${r.href}">${r.name}</a></td><td>${r.cat}</td></tr>`;
        }).join("");
        const extList = Array.from(exts).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        const filtersHtml = extList.map(x => {
            const id = `ext-${x.replace(/[^a-z0-9_-]/gi, "")}`;
            const checked = x === "mkv" ? "" : " checked";
            return `<label><input type="checkbox" class="ext-filter" id="${id}" value="${x}"${checked}> .${x}</label>`;
        }).join(" ");
        let template = await fsp.readFile(templatePath, "utf8");
        const html = template
            .replace("%%FILTERS%%", filtersHtml || "")
            .replace("%%ROWS%%", rowsHtml || "<tr><td colspan='2'>No files found.</td></tr>");
        res.type("html").send(html);
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

