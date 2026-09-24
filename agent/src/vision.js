import fs from "fs";
import path from "path";

// node-canvas is a native module; load it only when a viewer frame is requested so a
// missing/incompatible binary disables vision instead of preventing the bot from starting.
let renderBotPovPromise = null;
function loadRenderer() {
  renderBotPovPromise ??= import("./vision-render.js").then((mod) => mod.renderBotPov);
  return renderBotPovPromise;
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isJpeg(buffer) {
  return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/**
 * Vision provider.
 *
 * Sources:
 * - `viewer` — in-process first-person raycast of bot.world → JPEG (no desktop capture)
 * - `file`   — read a pre-written JPEG under project logs/ (manual / external capture)
 * - `none`   — always null
 *
 * Desktop/screen capture is intentionally unsupported: a Minecraft chat message
 * must never be able to turn the bot into a remote desktop screenshot uploader.
 */
export function createVisionProvider(cfg, log = console.log) {
  const capturePath = cfg.vision.capturePath;
  const captureRoot = cfg.vision.captureRoot;
  const maxFileBytes = cfg.vision.maxFileBytes ?? 5 * 1024 * 1024;
  const maxAgeMs = cfg.vision.maxAgeMs ?? 30000;
  let botRef = null;
  let lastRender = null;

  function writeDebugFrame(buffer) {
    try {
      fs.mkdirSync(path.dirname(capturePath), { recursive: true });
      const tmp = `${capturePath}.tmp`;
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, capturePath);
    } catch (err) {
      log(`[vision] failed to write debug frame: ${String(err?.message || err).slice(0, 160)}`);
    }
  }

  async function fromViewer() {
    if (!botRef?.entity || !botRef.world) return null;
    const renderBotPov = await loadRenderer();
    const rendered = renderBotPov(botRef, {
      width: cfg.vision.width,
      height: cfg.vision.height,
      maxDistance: cfg.vision.maxDistance,
      jpegQuality: cfg.vision.jpegQuality,
      fov: cfg.vision.fov,
    });
    if (!isJpeg(rendered.buffer)) throw new Error("viewer render did not produce JPEG");
    if (rendered.buffer.length > maxFileBytes) {
      throw new Error(`viewer frame too large: ${rendered.buffer.length} bytes`);
    }
    lastRender = {
      at: Date.now(),
      ms: rendered.ms,
      bytes: rendered.bytes,
      width: rendered.width,
      height: rendered.height,
      rays: rendered.rays,
    };
    if (cfg.vision.saveDebugFrame !== false) {
      writeDebugFrame(rendered.buffer);
    }
    log(
      `[vision] viewer frame ${rendered.width}x${rendered.height} ${rendered.bytes}B in ${rendered.ms}ms`
    );
    return rendered.buffer.toString("base64");
  }

  async function fromFile() {
    if (!fs.existsSync(capturePath)) return null;
    const stats = fs.lstatSync(capturePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("vision frame must be a regular file, not a link");
    }
    if (stats.size < 100 || stats.size > maxFileBytes) {
      throw new Error("vision frame size is outside the configured limit");
    }
    if (Date.now() - stats.mtimeMs > maxAgeMs) return null;

    const realFile = fs.realpathSync(capturePath);
    const realRoot = fs.realpathSync(captureRoot);
    if (!samePath(realRoot, captureRoot)) {
      throw new Error("vision logs directory must not be a symbolic link");
    }
    if (!isInside(realRoot, realFile)) {
      throw new Error("vision frame resolved outside the allowed logs directory");
    }
    const buffer = fs.readFileSync(realFile);
    if (!isJpeg(buffer)) throw new Error("vision frame is not a JPEG image");
    return buffer.toString("base64");
  }

  return {
    setBot(bot) {
      botRef = bot || null;
    },
    getLastRender() {
      return lastRender;
    },
    async getFrame() {
      if (!cfg.vision.enabled || cfg.vision.source === "none") return null;
      try {
        if (cfg.vision.source === "viewer") return await fromViewer();
        if (cfg.vision.source === "file") return await fromFile();
        log("[vision] unsupported source blocked");
        return null;
      } catch (err) {
        log(`[vision] ${String(err?.message || "capture failed").slice(0, 200)}`);
        return null;
      }
    },
  };
}
