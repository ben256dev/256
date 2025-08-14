#!/usr/bin/env node
/* eslint-disable */
const { execFileSync } = require("child_process");
const fs = require("fs").promises;
const path = require("path");
const express = require("express");
const cors = require("cors");
const io = require("@pm2/io");

// -------- Config --------
const OBS_DIR = process.env.OBS_DIR || ".";
const PORT = Number(process.env.PORT || 8000);
// Empty string/undefined => all interfaces. Set HOST=127.0.0.1 to bind localhost only.
const HOST = process.env.HOST ?? "";
const FINGERPRINT_CMD = process.env.FINGERPRINT_CMD;

if (!FINGERPRINT_CMD) {
    console.error("FINGERPRINT_CMD not set in environment");
    process.exit(1);
}

// -------- Secret key --------
// Allow commands with args by using shell, since the caller controls the env.
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

// -------- App --------
const app = express();
app.disable("x-powered-by");

const root = path.resolve(OBS_DIR);
const mount = `/${key}`;
const staticMount = `${mount}/`;

// CORS only under the secret path
app.use(staticMount, cors());

// Escape helper for safe regex construction
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Custom index for exact /<key> or /<key>/
app.get(new RegExp(`^${esc(mount)}/?$`), async (_req, res) => {
    try {
        const items = await fs.readdir(root, { withFileTypes: true });
        const files = items.filter((d) => d.isFile()).map((d) => d.name).sort();
        const list = files
            .map((f) => `<li><a href="${encodeURIComponent(f)}">${f}</a></li>`)
            .join("");

        res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OBS Files</title>
  <link rel="stylesheet" href="https://ben256.com/darkmode.css">
  <style>
    body{font:14px system-ui,sans-serif;margin:24px}
    h1{margin-bottom:12px}
    ul{list-style:none;padding:0}
    li{margin:6px 0}
    a{text-decoration:none}
    .wrap{max-width:900px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>OBS Files</h1>
    <ul>${list}</ul>
  </div>
</body>
</html>`);
    } catch (err) {
        console.error("Failed to generate index page:", err);
        res.status(500).send("Internal Server Error");
    }
});

// Static files under the secret mount
app.use(
    staticMount,
    express.static(root, {
        fallthrough: true,      // allow our index route above to handle /<key>/
        etag: true,
        immutable: true,        // only effective with maxAge > 0
        maxAge: "1h",
        index: false
    })
);

// Catch-all 404 (kept last)
app.all(/.*/, (_req, res) => res.status(404).end());

// -------- Server --------
const DISPLAY_HOST = HOST || "0.0.0.0";
const url = `http://${DISPLAY_HOST}:${PORT}${staticMount}`;

const server = app.listen(PORT, HOST || undefined, () => {
    console.log(`obs_server listening on ${url}`);
});

server.on("error", (err) => {
    console.error("listen error:", err.code || err);
    process.exit(1);
});

// Crash guards
process.on("unhandledRejection", (e) => {
    console.error("unhandledRejection", e);
    process.exit(1);
});
process.on("uncaughtException", (e) => {
    console.error("uncaughtException", e);
    process.exit(1);
});

// PM2 action to retrieve the URL
io.action("url", (reply) => {
    reply({ url });
});

