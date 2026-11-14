// Category icons: real artwork only. Each category's icon is <ICON_DIR>/<category>.<png|jpg|webp|ico>.
// Drop a file there by hand, or set "steam": <appid> / "iconUrl": "<url>" in categories.json and the
// server downloads the official icon once on startup. Categories without one simply show no icon.
const { execFile } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const https = require("https");
const path = require("path");

const ICON_EXTS = ["png", "jpg", "jpeg", "webp", "ico", "svg"];
const STEAM_CDN = "https://cdn.fastly.steamstatic.com/steamcommunity/public/images/apps";

const run = (cmd, args) =>
    new Promise((resolve) => execFile(cmd, args, { timeout: 30000 }, (err, stdout) => resolve({ ok: !err, stdout: stdout || "" })));

const download = (url, redirects = 3) =>
    new Promise((resolve, reject) => {
        https
            .get(url, { headers: { "User-Agent": "obs-server-icons/1.0" } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                    res.resume();
                    resolve(download(new URL(res.headers.location, url).toString(), redirects - 1));
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                    return;
                }
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve(Buffer.concat(chunks)));
            })
            .on("error", reject);
    });

// Steam's appinfo carries a multi-resolution "clienticon" (.ico, often up to 256px); the official
// Web API only exposes the 32px community icon, used as a fallback.
const steamIconUrls = async (appid) => {
    const urls = [];
    try {
        const j = JSON.parse((await download(`https://api.steamcmd.net/v1/info/${appid}`)).toString("utf8"));
        const common = j.data && j.data[appid] && j.data[appid].common;
        if (common && common.clienticon) urls.push(`${STEAM_CDN}/${appid}/${common.clienticon}.ico`);
        if (common && common.icon) urls.push(`${STEAM_CDN}/${appid}/${common.icon}.jpg`);
    } catch {}
    if (!urls.length) {
        try {
            const j = JSON.parse(
                (await download(`https://api.steampowered.com/ICommunityService/GetApps/v1/?appids%5B0%5D=${appid}`)).toString("utf8")
            );
            const app = j.response && j.response.apps && j.response.apps[0];
            if (app && app.icon) urls.push(`${STEAM_CDN}/${appid}/${app.icon}.jpg`);
        } catch {}
    }
    return urls;
};

// Convert whatever we downloaded to a PNG of at most 256px, picking the largest frame of an .ico.
const toPng = async (src, dest) => {
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "stream=index,width,height", "-of", "csv=p=0", src]);
    let best = 0;
    let bestW = -1;
    for (const line of probe.stdout.trim().split("\n")) {
        const [i, w] = line.split(",").map(Number);
        if (w > bestW) {
            best = i;
            bestW = w;
        }
    }
    const tmp = `${dest}.tmp.png`;
    const r = await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-i", src, "-map", `0:${best}`,
        "-vf", "scale='min(256,iw)':-1:flags=lanczos", "-frames:v", "1", "-y", tmp
    ]);
    if (!r.ok) {
        await fsp.rm(tmp, { force: true });
        return false;
    }
    await fsp.rename(tmp, dest);
    return true;
};

function createIcons({ iconDir, log = console.log }) {
    const existing = async () => {
        const map = new Map();
        let names = [];
        try {
            names = await fsp.readdir(iconDir);
        } catch {
            return map;
        }
        for (const name of names) {
            const ext = path.extname(name).slice(1).toLowerCase();
            if (!ICON_EXTS.includes(ext) || name.startsWith(".")) continue;
            const cat = name.slice(0, -(ext.length + 1));
            const st = await fsp.stat(path.join(iconDir, name)).catch(() => null);
            if (st && st.isFile()) map.set(cat, { file: name, v: Math.round(st.mtimeMs) });
        }
        return map;
    };

    const fetchOne = async (cat, cfg) => {
        const urls = [];
        if (cfg.iconUrl) urls.push(cfg.iconUrl);
        if (cfg.steam) urls.push(...(await steamIconUrls(cfg.steam)));
        for (const url of urls) {
            const ext = (path.extname(new URL(url).pathname).slice(1) || "img").toLowerCase();
            const raw = path.join(iconDir, `.${cat}.download.${ext}`);
            try {
                await fsp.writeFile(raw, await download(url));
                if (await toPng(raw, path.join(iconDir, `${cat}.png`))) {
                    log(`icon: ${cat} <- ${url}`);
                    return true;
                }
            } catch (e) {
                log(`icon fetch failed for ${cat}: ${e.message}`);
            } finally {
                await fsp.rm(raw, { force: true });
            }
        }
        return false;
    };

    // Download configured icons that are not on disk yet. Safe to call repeatedly.
    const sync = async (categories) => {
        await fsp.mkdir(iconDir, { recursive: true });
        const have = await existing();
        for (const [cat, cfg] of Object.entries(categories || {})) {
            if (have.has(cat) || !cfg || !(cfg.steam || cfg.iconUrl)) continue;
            if (cat.includes("/") || cat.startsWith(".")) continue;
            await fetchOne(cat, cfg);
        }
    };

    // Resolve a request for "<file>" to an absolute path inside iconDir, or null.
    const resolve = (file) => {
        if (!file || file.includes("/") || file.includes("\\") || file.startsWith(".")) return null;
        if (!ICON_EXTS.includes(path.extname(file).slice(1).toLowerCase())) return null;
        return path.join(iconDir, file);
    };

    return { existing, sync, resolve };
}

module.exports = { createIcons };
