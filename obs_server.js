#!/usr/bin/env node
/* eslint-disable */
const { execFileSync } = require("child_process");
const path = require("path");
const express = require("express");
const cors = require("cors");
const serveIndex = require("serve-index");
const io = require("@pm2/io");

const OBS_DIR = process.env.OBS_DIR || ".";
const PORT = Number(process.env.PORT || 8000);
const FINGERPRINT_CMD = process.env.FINGERPRINT_CMD;


if (!FINGERPRINT_CMD) {
    console.error("FINGERPRINT_CMD not set");
    process.exit(1);
}

let key = execFileSync(FINGERPRINT_CMD, { encoding: "utf8" }).trim();
// keep it URL-safe
key = key.replace(/[^A-Za-z0-9._-]/g, "");
if (!key) {
    console.error("Empty key from FINGERPRINT_CMD");
    process.exit(1);
}

const app = express();
app.use(cors());

const mount = `/${key}/`;
app.use(mount, express.static(path.resolve(OBS_DIR)));
app.use(mount, serveIndex(path.resolve(OBS_DIR), { icons: true }));

app.use((req, res) => {
    res.status(401);
});

const url = `http://home.ben256.com:${PORT}${mount}`;
app.listen(PORT, () => {
    console.log(`Serving ${OBS_DIR} at ${url}`);
});

io.action("url", (reply) => {
    reply({ url });
});
