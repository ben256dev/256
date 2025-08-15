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
const template = fs.readFileSync(path.join(__dirname, "views", "index.html"), "utf8");

app.use(staticMount, cors());

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hiddenGuard = (req, res, next) => {
    if (req.path.split("/").some((p) => p && p.startsWith("."))) return res.status(404).end();
    next();
};
const safeJoin = (base, sub) => {
    const p = path.normalize("/" + (sub || ""));
    const abs = path.join(base, p);
    if (!abs.startsWith(base)) return null;
    return abs;
};
const makeBreadcrumbs = (subpath) => {
    const parts = subpath ? subpath.split("/").filter(Boolean) : [];
    const crumbs = [];
    let acc = "";
    crumbs.push(`<a href="${staticMount}">/</a>`);
    for (let i = 0; i < parts.length; i++) {
        acc += parts[i] + "/";
        const href = staticMount + encodeURI(acc);
        crumbs.push(`<a href="${href}">${parts[i]}/</a>`);
    }
    return crumbs.join(" ");
};

app.use(staticMount, hiddenGuard);

app.get(new RegExp(`^${esc(mount)}(?:/(.*))?$`), async (req, res, next) => {
    try {
        const sub = req.params[0] || "";
        if (sub.split("/").some((p) => p && p.startsWith("."))) return res.status(404).end();
        const target = safeJoin(root, sub);
        if (!target) return res.status(400).send("Bad path");
        const st = await fsp.stat(target).catch(() => null);
        if (!st) return res.status(404).send("Not Found");
        if (!st.isDirectory()) return next();

        const items = (await fsp.readdir(target, { withFileTypes: true })).filter((d) => !d.name.startsWith("."));
        const dirs = items.filter((d) => d.isDirectory()).map((d) => d.name).sort();
        const files = items.filter((d) => d.isFile()).map((d) => d.name).sort();
        const prefix = sub ? encodeURI(sub.replace(/\/?$/, "/")) : "";
        const listDirs = dirs.map((d) => {
            const href = staticMount + prefix + encodeURIComponent(d) + "/";
            return `<li class="dir"><a href="${href}">${d}/</a></li>`;
        });
        const listFiles = files.map((f) => {
            const href = staticMount + prefix + encodeURIComponent(f);
            return `<li class="file"><a href="${href}">${f}</a></li>`;
        });
        const list = listDirs.concat(listFiles).join("");
        const html = template
            .replace("%%TITLE%%", "OBS Files")
            .replace("%%BREADCRUMBS%%", makeBreadcrumbs(sub))
            .replace("%%LIST%%", list);
        res.type("html").send(html);
    } catch (err) {
        console.error("index error:", err);
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

