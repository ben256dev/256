// Background media worker: probing, MKV→MP4 remuxing, posters, hover-preview sprites, audio waveforms.
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const ART_VERSION = "v2";
const SPRITE_FRAMES = 12;
const SPRITE_W = 320;
const SPRITE_H = 180;
const POSTER_W = 960;
const POSTER_H = 540;

const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "mov", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
// Preferred playable container first; mkv is the OBS original and only used until remuxed.
const VIDEO_PRIORITY = ["mp4", "m4v", "webm", "mov", "mkv"];

const extOf = (name) => {
    const base = name.slice(name.lastIndexOf("/") + 1);
    const i = base.lastIndexOf(".");
    if (i <= 0 || i === base.length - 1) return "";
    return base.slice(i + 1).toLowerCase();
};
const stemOf = (rel) => {
    const e = extOf(rel);
    return e ? rel.slice(0, -(e.length + 1)) : rel;
};
const kindOf = (ext) =>
    VIDEO_EXTS.has(ext) ? "video" : AUDIO_EXTS.has(ext) ? "audio" : IMAGE_EXTS.has(ext) ? "image" : "file";

const run = (cmd, args, opts = {}) =>
    new Promise((resolve) => {
        execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
            resolve({ ok: !err, stdout: stdout || "", stderr: stderr || "", err })
        );
    });

// Small counting semaphore so request-time and background jobs share a CPU budget.
const semaphore = (limit) => {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= limit || !queue.length) return;
        active++;
        const { fn, resolve } = queue.shift();
        Promise.resolve()
            .then(fn)
            .then(resolve, () => resolve(null))
            .finally(() => {
                active--;
                next();
            });
    };
    return (fn, priority = false) =>
        new Promise((resolve) => {
            (priority ? queue.unshift.bind(queue) : queue.push.bind(queue))({ fn, resolve });
            next();
        });
};

const parseFps = (s) => {
    const [a, b] = String(s || "").split("/").map(Number);
    if (a > 0 && b > 0) return Math.round((a / b) * 100) / 100;
    return a > 0 ? a : 0;
};

function createMedia({ root, artDir, log = console.log, ffmpegJobs = 3, remuxMinAgeSec = 90, scanIntervalSec = 60, autoRemux = true, skipRemux = null }) {
    const limit = semaphore(ffmpegJobs);
    const inflight = new Map();
    const probeCache = new Map();
    const remuxing = new Set(); // stem rels currently being remuxed
    const remuxQueued = new Set();
    const remuxFailed = new Set();
    const lastSeen = new Map(); // mkv rel -> "size:mtime" from previous scan (still-writing detection)
    let remuxChain = Promise.resolve();

    const once = (key, fn) => {
        if (inflight.has(key)) return inflight.get(key);
        const p = fn().finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    };

    const artBase = (stemRel) => crypto.createHash("sha1").update(`${stemRel}|${ART_VERSION}`).digest("hex");
    const posterPath = (stemRel) => path.join(artDir, `${artBase(stemRel)}-poster.jpg`);
    const spritePath = (stemRel) => path.join(artDir, `${artBase(stemRel)}-sprite.jpg`);
    const wavePath = (stemRel) => path.join(artDir, `${artBase(stemRel)}-wave2.png`);

    const exists = (p) => fsp.access(p, fs.constants.R_OK).then(() => true, () => false);

    const probe = async (abs, mtimeMs) => {
        const key = `${abs}:${mtimeMs}`;
        if (probeCache.has(key)) return probeCache.get(key);
        return once(`probe:${key}`, async () => {
            const r = await run("ffprobe", [
                "-v", "error", "-print_format", "json",
                "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate:stream_disposition=attached_pic",
                abs
            ]);
            const out = { duration: 0, width: 0, height: 0, fps: 0, vcodec: "", acodec: "", coverArt: false };
            if (r.ok) {
                try {
                    const j = JSON.parse(r.stdout);
                    out.duration = Number(j.format && j.format.duration) || 0;
                    for (const s of j.streams || []) {
                        const pic = s.disposition && s.disposition.attached_pic;
                        if (s.codec_type === "video" && pic) out.coverArt = true;
                        else if (s.codec_type === "video" && !out.vcodec) {
                            out.vcodec = s.codec_name || "";
                            out.width = s.width || 0;
                            out.height = s.height || 0;
                            out.fps = parseFps(s.avg_frame_rate);
                        } else if (s.codec_type === "audio" && !out.acodec) out.acodec = s.codec_name || "";
                    }
                } catch {}
            }
            probeCache.set(key, out);
            return out;
        });
    };

    // Write to a temp file in artDir then rename, so a half-written image is never served.
    const ffmpegTo = async (dest, args) => {
        await fsp.mkdir(artDir, { recursive: true });
        const tmp = `${dest}.${process.pid}.tmp${path.extname(dest)}`;
        const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args, "-y", tmp], { timeout: 120000 });
        if (r.ok && (await exists(tmp))) {
            await fsp.rename(tmp, dest);
            return true;
        }
        await fsp.rm(tmp, { force: true });
        if (r.stderr) log(`ffmpeg failed for ${path.basename(dest)}: ${r.stderr.trim().split("\n").pop()}`);
        return false;
    };

    const fit = (w, h) =>
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

    // Poster: seek ~20% in (past intros/loading screens), let the thumbnail filter pick the most
    // representative of the next ~90 frames, which avoids black frames and fades.
    const ensurePoster = (abs, stemRel, duration, priority = false) => {
        const out = posterPath(stemRel);
        return once(out, async () => {
            if (await exists(out)) return out;
            return limit(async () => {
                const seek = duration > 4 ? Math.min(duration * 0.2, Math.max(duration - 2, 0)) : 0;
                const vf = `thumbnail=90,${fit(POSTER_W, POSTER_H)}`;
                let ok = await ffmpegTo(out, ["-ss", seek.toFixed(2), "-i", abs, "-vf", vf, "-frames:v", "1", "-q:v", "4"]);
                if (!ok) ok = await ffmpegTo(out, ["-i", abs, "-vf", fit(POSTER_W, POSTER_H), "-frames:v", "1", "-q:v", "4"]);
                return ok ? out : "";
            }, priority);
        });
    };

    // Storyboard sprite: SPRITE_FRAMES evenly spaced frames in one horizontal strip, used for hover previews.
    const ensureSprite = (abs, stemRel, duration, priority = false) => {
        const out = spritePath(stemRel);
        return once(out, async () => {
            if (await exists(out)) return out;
            if (!(duration > 1)) return "";
            return limit(async () => {
                const inputs = [];
                const chains = [];
                for (let i = 0; i < SPRITE_FRAMES; i++) {
                    const t = (duration * (i + 0.5)) / SPRITE_FRAMES;
                    inputs.push("-ss", t.toFixed(2), "-i", abs);
                    chains.push(`[${i}:v]${fit(SPRITE_W, SPRITE_H)}[f${i}]`);
                }
                const stack = chains.map((_, i) => `[f${i}]`).join("") + `hstack=inputs=${SPRITE_FRAMES}`;
                const ok = await ffmpegTo(out, [...inputs, "-filter_complex", `${chains.join(";")};${stack}`, "-frames:v", "1", "-q:v", "5"]);
                return ok ? out : "";
            }, priority);
        });
    };

    // Audio art: embedded cover if present, otherwise a waveform (transparent PNG, tinted client-side).
    const ensureWave = (abs, stemRel, coverArt, priority = false) => {
        const out = wavePath(stemRel);
        return once(out, async () => {
            if (await exists(out)) return out;
            return limit(async () => {
                let ok = false;
                if (coverArt) ok = await ffmpegTo(out, ["-i", abs, "-an", "-map", "0:v:0", "-vf", fit(POSTER_W, POSTER_H), "-frames:v", "1"]);
                if (!ok) {
                    ok = await ffmpegTo(out, [
                        "-i", abs, "-filter_complex",
                        `aformat=channel_layouts=mono,showwavespic=s=${POSTER_W}x${POSTER_H / 2}:colors=0xffffff:scale=sqrt:filter=average`,
                        "-frames:v", "1"
                    ]);
                }
                return ok ? out : "";
            }, priority);
        });
    };

    // ---- Remuxing -------------------------------------------------------------------------------

    const remux = async (mkvAbs, mkvRel) => {
        const stem = stemOf(mkvRel);
        const dir = path.dirname(mkvAbs);
        const name = path.basename(stemOf(mkvAbs));
        const mp4 = path.join(dir, `${name}.mp4`);
        const part = path.join(dir, `.${name}.mp4.part`);
        remuxing.add(stem);
        log(`remux start: ${mkvRel}`);
        const started = Date.now();
        try {
            if (await exists(mp4)) return;
            const st = await fsp.stat(mkvAbs);
            const r = await run("ffmpeg", [
                "-hide_banner", "-loglevel", "error", "-nostdin",
                "-i", mkvAbs, "-map", "0:v?", "-map", "0:a?", "-c", "copy",
                "-movflags", "+faststart", "-f", "mp4", "-y", part
            ]);
            if (!r.ok) {
                remuxFailed.add(mkvRel);
                await fsp.rm(part, { force: true });
                log(`remux FAILED: ${mkvRel}: ${r.stderr.trim().split("\n").pop()}`);
                return;
            }
            // Keep the original recording time so "newest first" ordering is unaffected.
            await fsp.utimes(part, st.atime, st.mtime);
            await fsp.rename(part, mp4);
            log(`remux done: ${mkvRel} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
        } finally {
            remuxing.delete(stem);
            remuxQueued.delete(mkvRel);
        }
    };

    const queueRemux = (abs, rel) => {
        if (remuxQueued.has(rel) || remuxFailed.has(rel)) return;
        remuxQueued.add(rel);
        // Remuxes are disk-bound; run them strictly one at a time.
        remuxChain = remuxChain.then(() => remux(abs, rel)).catch((e) => log(`remux error: ${rel}: ${e.message}`));
    };

    // Called with the full file list after every directory walk.
    const scan = async (files) => {
        if (!autoRemux) return;
        const relSet = new Set(files);
        const now = Date.now();
        for (const rel of files) {
            if (extOf(rel) !== "mkv" || (skipRemux && skipRemux(rel))) continue;
            const stem = stemOf(rel);
            if (relSet.has(`${stem}.mp4`)) continue;
            const abs = path.join(root, rel);
            let st;
            try {
                st = await fsp.stat(abs);
            } catch {
                continue;
            }
            const sig = `${st.size}:${st.mtimeMs}`;
            const prev = lastSeen.get(rel);
            lastSeen.set(rel, sig);
            const ageSec = (now - st.mtimeMs) / 1000;
            // OBS may still be writing: require the file to be old enough, and (if recent) unchanged since last scan.
            if (ageSec < remuxMinAgeSec) continue;
            if (ageSec < 600 && prev !== sig) continue;
            queueRemux(abs, rel);
        }
    };

    // Pre-generate art in the background so cards are ready before anyone hovers.
    const warm = async (items) => {
        for (const it of items) {
            const abs = path.join(root, it.rel);
            if (it.kind === "video") {
                ensurePoster(abs, it.stem, it.durationSec).catch(() => {});
                ensureSprite(abs, it.stem, it.durationSec).catch(() => {});
            } else if (it.kind === "audio") {
                ensureWave(abs, it.stem, it.coverArt).catch(() => {});
            }
        }
    };

    const status = (stemRel) => (remuxing.has(stemRel) ? "converting" : "");
    const isQueued = (mkvRel) => remuxQueued.has(mkvRel);

    const start = (walk, toItems) => {
        const tick = async () => {
            try {
                const files = await walk();
                await scan(files);
                await warm(await toItems(files));
            } catch (e) {
                log(`media scan error: ${e.message}`);
            }
        };
        tick();
        const t = setInterval(tick, scanIntervalSec * 1000);
        t.unref();
    };

    return {
        probe, ensurePoster, ensureSprite, ensureWave, status, isQueued, start,
        posterPath, spritePath, wavePath
    };
}

module.exports = { createMedia, extOf, stemOf, kindOf, VIDEO_EXTS, AUDIO_EXTS, VIDEO_PRIORITY, SPRITE_FRAMES };
