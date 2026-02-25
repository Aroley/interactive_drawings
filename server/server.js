/**
 * Socket.IO relay server with server-side moderation
 *
 * OCR runs here in Node via tesseract.js (no browser worker cross-origin issues).
 * Shape detection runs in scanner.html (needs canvas pixel access).
 *
 * Flow:
 *   tablet   → "drawing"         → server
 *   server   → OCR check         (inline, Node)
 *   server   → "scanThis"        → scanner.html (shape detection only)
 *   scanner  → "shapeResult"     → server
 *   server   → "newDrawing"      → projector  (optimistic, shown immediately)
 *   server   → flags / removes   → projector + admin if dirty
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// ── Tesseract OCR (Node) ──────────────────────────────────────────────────
let ocrWorker = null;
let ocrReady = false;

async function initOCR() {
  try {
    const { createWorker } = require("tesseract.js");
    console.log("[ocr] Initializing Tesseract worker...");
    ocrWorker = await createWorker("eng");
    ocrReady = true;
    console.log("[ocr] ✓ Tesseract worker ready");
  } catch (e) {
    console.warn(
      "[ocr] ✗ tesseract.js not available — OCR disabled:",
      e.message,
    );
    console.warn("[ocr] Run: npm install tesseract.js");
  }
}

initOCR();

// Comprehensive blocked words list - focused on explicit/inappropriate content
const BLOCKED_WORDS = [
  // Profanity (common)
  "fuck",
  "fucking",
  "fucker",
  "fucked",
  "fuk",
  "fck",
  "shit",
  "shit",
  "crap",
  "damn",
  "hell",
  "bitch",
  "bastard",
  "asshole",

  // Sexual/explicit anatomy
  "penis",
  "cock",
  "dick",
  "dick",
  "pecker",
  "schlong",
  "balls",
  "testicle",
  "nut",
  "nuts",
  "vagina",
  "pussy",
  "cunt",
  "twat",
  "cooch",
  "boob",
  "boobs",
  "tit",
  "tits",
  "titty",
  "titties",
  "nipple",
  "butt",
  "ass",
  "arse",
  "butthole",
  "anus",
  "rectum",

  // Sexual acts/content
  "porn",
  "porno",
  "sex",
  "sexy",
  "fuck",
  "rape",
  "molest",
  "nude",
  "naked",
  "strip",
  "horny",
  "orgasm",
  "cum",
  "blowjob",
  "handjob",
  "masturbate",
  "jerk",
  "wank",

  // Bodily functions (often used inappropriately)
  "piss",
  "pee",
  "poop",
  "fart",
  "diarrhea",

  // Violence/threats
  "kill",
  "murder",
  "die",
  "death",
  "dead",
  "stab",
  "shoot",
  "gun",
  "knife",
  "weapon",
  "blood",
  "hurt",
  "pain",

  // Hate speech/slurs (racial, ethnic, religious)
  "nigger",
  "nigga",
  "nig",
  "negro",
  "chink",
  "gook",
  "jap",
  "zipperhead",
  "spic",
  "beaner",
  "wetback",
  "greaser",
  "kike",
  "heeb",
  "hymie",
  "raghead",
  "towelhead",
  "sandnigger",
  "terrorist",
  "cracker",
  "honky",
  "whitey",
  "redneck",
  "faggot",
  "fag",
  "dyke",
  "tranny",
  "queer",
  "retard",
  "retarded",
  "autist",
  "autistic",
  "sperg",

  // Hate groups and symbols (text-based)
  "kkk",
  "klan",
  "nazi",
  "hitler",
  "heil",
  "white power",
  "aryan",
  "supremacy",

  // Hate symbol codes
  "88",
  "1488",
  "14",
  "18", // Nazi codes (88=HH=Heil Hitler, 14=14 words, 18=AH=Adolf Hitler)
  "ss", // SS bolts

  // Common misspellings/leetspeak
  "fuk",
  "fck",
  "sht",
  "btch",
  "cnt",
  "dck",
  "pnis",
  "b00b",
  "t1t",
  "a55",
  "p3nis",
  "c0ck",
  "n1gger",
  "n1gga",
  "f4g",
  "f4ggot",

  // Drug references
  "weed",
  "drug",
  "cocaine",
  "heroin",
  "meth",

  // ═══════════════════════════════════════════════════════════════════════
  // GERMAN / DEUTSCH
  // ═══════════════════════════════════════════════════════════════════════

  // Profanity (German)
  "scheiße",
  "scheisse",
  "scheiss",
  "kacke",
  "mist",
  "verdammt",
  "verflucht",
  "arsch",
  "arschloch",
  "fotze",
  "votze",
  "hurensohn",
  "wichser",
  "pisser",

  // Sexual/explicit (German)
  "schwanz",
  "pimmel",
  "eier",
  "hoden",
  "muschi",
  "möse",
  "fotze",
  "titten",
  "brüste",
  "busen",
  "nippel",
  "hintern",
  "po",
  "popo",

  // Sexual acts (German)
  "ficken",
  "fick",
  "gefickt",
  "bumsen",
  "vögeln",
  "vergewaltigung",
  "nackt",
  "geil",
  "wichsen",
  "blasen",

  // Bodily functions (German)
  "pissen",
  "pinkeln",
  "scheißen",
  "furzen",
  "kotzen",

  // Violence (German)
  "töten",
  "mord",
  "sterben",
  "tot",
  "blut",
  "schmerz",
  "waffe",
  "messer",

  // Hate speech/slurs (German)
  "neger",
  "kanake",
  "türke",
  "ausländer",
  "schwuchtel",
  "schwuler",
  "tunte",
  "lesbe",
  "mongo",
  "spast",
  "spasti",
  "behindert",
  "behinderter",
  "idiot",
  "vollidiot",
  "trottel",
  "depp",

  // Hate groups/symbols (German)
  "nsdap",
  "hakenkreuz",
  "sieg heil",

  // German leetspeak/misspellings
  "sch3isse",
  "f1cken",
  "f0tze",
  "arsch1och",
  "h1tler",
];

async function runOCR(imageDataUrl) {
  if (!ocrReady || !ocrWorker) {
    console.log("[ocr] OCR not ready - skipping text check");
    return [];
  }

  try {
    // Strip data-URL prefix to get raw base64
    const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(base64, "base64");

    const {
      data: { text },
    } = await ocrWorker.recognize(buf);

    if (!text || text.trim().length === 0) {
      return [];
    }

    console.log("[ocr] Detected text:", text.substring(0, 100));

    // Normalize: lowercase, keep German characters (äöüß), remove other punctuation
    const words = text
      .toLowerCase()
      .replace(/[^a-zäöüß\s]/g, " ") // Keep German special characters
      .split(/\s+/)
      .filter((w) => w.length > 1); // Ignore single letters

    const flagged = [];
    for (const word of words) {
      if (BLOCKED_WORDS.includes(word)) {
        flagged.push(`blocked word: "${word}"`);
      }
    }

    return flagged;
  } catch (e) {
    console.warn("[ocr] Recognition error:", e.message);
    return [];
  }
}

// ── State ─────────────────────────────────────────────────────────────────
const liveDrawings = new Map(); // id → { id, imageData, throwSpeed, flagged, reason }
const pendingScans = new Map(); // scanId → { drawingId, imageData, resolve }
let scannerSocket = null;
let scanIdCounter = 0;

const AUTO_REMOVE_MS = 1000; // 1 second - fast removal
const autoRemoveTimers = new Map();

// ── Admin broadcast ───────────────────────────────────────────────────────
function broadcastAdminState() {
  const state = [...liveDrawings.values()].map((d) => ({
    id: d.id,
    thumb: d.imageData,
    flagged: d.flagged,
    reason: d.reason || null,
  }));
  io.to("admins").emit("adminState", state);
}

function notifyScannerStatus() {
  const online = !!(scannerSocket && scannerSocket.connected);
  io.to("admins").emit(online ? "scannerOnline" : "scannerOffline");
  console.log(`[scanner] Status: ${online ? "online" : "offline"}`);
}

// ── Remove helper ─────────────────────────────────────────────────────────
function removeDrawing(drawingId, reason) {
  if (!liveDrawings.has(drawingId)) return;
  liveDrawings.delete(drawingId);
  clearTimeout(autoRemoveTimers.get(drawingId));
  autoRemoveTimers.delete(drawingId);
  io.to("projectors").emit("removeDrawing", drawingId);
  io.to("admins").emit("drawingRemoved", { drawingId, reason });
  console.log(`[mod] Removed ${drawingId} — ${reason}`);
}

// ── Connections ───────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on("register", (role) => {
    socket.data.role = role;

    if (role === "projector") {
      socket.join("projectors");
      console.log(`[projector] Registered: ${socket.id}`);

      // Send current live drawings to new projector
      liveDrawings.forEach((d) => {
        socket.emit("newDrawing", {
          id: d.id,
          imageData: d.imageData,
          throwSpeed: d.throwSpeed,
        });
        if (d.flagged) {
          socket.emit("flagDrawing", { drawingId: d.id });
        }
      });
    }

    if (role === "admin") {
      socket.join("admins");
      console.log(`[admin] Registered: ${socket.id}`);
      broadcastAdminState();
      notifyScannerStatus();
    }

    if (role === "scanner") {
      scannerSocket = socket;
      console.log(`[scanner] Registered: ${socket.id}`);
      notifyScannerStatus();

      // Send any queued scans
      pendingScans.forEach((pending, scanId) => {
        socket.emit("scanThis", { scanId, imageData: pending.imageData });
      });
    }
  });

  // ── Drawing arrives from tablet ───────────────────────────────────────
  socket.on("drawing", async ({ imageData, throwSpeed }) => {
    const drawingId = `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    console.log(`[drawing] Received: ${drawingId}`);

    // Create an entry object but DO NOT publish to projectors yet.
    // We must run OCR + shape scanning first and only emit if clean.
    const entry = {
      id: drawingId,
      imageData,
      throwSpeed,
      flagged: false,
      reason: null,
    };

    const reasons = [];

    // ── Step 1: OCR (server-side) ─────────────────────────────────────
    try {
      const ocrReasons = await runOCR(imageData);
      reasons.push(...ocrReasons);
    } catch (err) {
      console.warn(`[ocr] Error scanning ${drawingId}:`, err.message);
    }

    // ── Step 2: Shape detection (scanner.html) ────────────────────────
    if (scannerSocket && scannerSocket.connected) {
      const scanId = `s_${scanIdCounter++}`;

      const shapeCheckPromise = new Promise((resolve) => {
        const timeoutHandle = setTimeout(() => {
          console.warn(`[scanner] Timeout waiting for ${scanId}`);
          pendingScans.delete(scanId);
          resolve([]); // Continue without shape check
        }, 8000); // 8 second timeout

        pendingScans.set(scanId, {
          drawingId,
          imageData,
          resolve: (shapeReasons) => {
            clearTimeout(timeoutHandle);
            pendingScans.delete(scanId);
            resolve(shapeReasons || []);
          },
        });
      });

      scannerSocket.emit("scanThis", { scanId, imageData });
      const shapeReasons = await shapeCheckPromise;
      reasons.push(...shapeReasons);
    } else {
      console.warn(
        `[scanner] Not connected - skipping shape check for ${drawingId}`,
      );
    }

    // ── Step 3: Take action based on results ──────────────────────────
    if (reasons.length === 0) {
      // Clean: now publish to projectors and include in live state
      console.log(`[mod] ✓ Clean: ${drawingId}`);
      entry.flagged = false;
      entry.reason = null;
      liveDrawings.set(drawingId, entry);
      io.to("projectors").emit("newDrawing", {
        id: drawingId,
        imageData,
        throwSpeed,
      });
      broadcastAdminState();
      return;
    }

    // Flagged: do not publish to projectors. Notify admins and log.
    console.log(
      `[mod] ✗ FLAGGED (blocked before publish): ${drawingId} — ${reasons.join(", ")}`,
    );
    entry.flagged = true;
    entry.reason = reasons.join(", ");

    // Inform admins with extra context (include imageData so they can review)
    io.to("admins").emit("drawingFlagged", { drawingId, reasons, imageData });
    // Also emit a short event for any connected admin UI that expects it
    io.emit("drawingBlocked", { drawingId, reasons });

    // Do not add to liveDrawings and do not auto-remove since it was never published.
  });

  // ── Admin upload / publish (from admin UI) ───────────────────────────
  socket.on("adminUpload", ({ imageData, throwSpeed }) => {
    // Only allow admin sockets to publish via this channel
    if (socket.data.role !== "admin") {
      console.warn(
        `[adminUpload] Rejected publish from non-admin socket: ${socket.id}`,
      );
      return;
    }

    const drawingId = `adm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    console.log(`[adminUpload] Admin published: ${drawingId}`);

    const entry = {
      id: drawingId,
      imageData,
      throwSpeed: typeof throwSpeed === "number" ? throwSpeed : 0.9,
      flagged: false,
      reason: null,
    };

    // Add to live drawings and immediately emit to projectors
    liveDrawings.set(drawingId, entry);
    io.to("projectors").emit("newDrawing", {
      id: drawingId,
      imageData,
      throwSpeed: entry.throwSpeed,
    });
    broadcastAdminState();
  });

  // ── Shape result from scanner.html ────────────────────────────────────
  socket.on("shapeResult", ({ scanId, reasons }) => {
    const pending = pendingScans.get(scanId);
    if (pending && pending.resolve) {
      console.log(
        `[scanner] Shape result for ${scanId}:`,
        reasons.length > 0 ? reasons : "clean",
      );
      pending.resolve(reasons || []);
    }
  });

  // ── Admin actions ─────────────────────────────────────────────────────
  socket.on("removeDrawing", (drawingId) => {
    console.log(`[admin] Manual removal: ${drawingId}`);
    removeDrawing(drawingId, "admin manual removal");
    broadcastAdminState();
  });

  socket.on("pardonDrawing", (drawingId) => {
    console.log(`[admin] Pardoned: ${drawingId}`);
    const entry = liveDrawings.get(drawingId);
    if (!entry) return;

    entry.flagged = false;
    entry.reason = null;
    clearTimeout(autoRemoveTimers.get(drawingId));
    autoRemoveTimers.delete(drawingId);
    io.to("projectors").emit("pardonDrawing", { drawingId });
    broadcastAdminState();
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    if (socket === scannerSocket) {
      scannerSocket = null;
      console.warn(`[scanner] Disconnected`);
      notifyScannerStatus();
    }
    console.log(`[disconnect] ${socket.id}`);
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\n[shutdown] Closing server...");
  if (ocrWorker) {
    await ocrWorker.terminate();
    console.log("[ocr] Worker terminated");
  }
  server.close(() => {
    console.log("[shutdown] Server closed");
    process.exit(0);
  });
});

// ── Start server ──────────────────────────────────────────────────────────
server.listen(3000, () => {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  🎨 Kids Drawing Projection Server");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Server:   http://localhost:3000");
  console.log("  Draw:     http://localhost:3000/draw.html");
  console.log("  Project:  http://localhost:3000/project.html");
  console.log("  Admin:    http://localhost:3000/admin.html");
  console.log("  Scanner:  http://localhost:3000/scanner.html");
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("  📋 Setup Instructions:");
  console.log("  1. Run: npm install");
  console.log("  2. Open scanner.html in a background tab");
  console.log("  3. Open project.html on projector/main screen");
  console.log("  4. Open draw.html on iPad(s)");
  console.log("  5. Open admin.html for moderation control");
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
});
