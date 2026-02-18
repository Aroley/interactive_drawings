/**
 * Socket.IO relay server with server-side moderation
 *
 * OCR runs here in Node via tesseract.js (no browser worker cross-origin issues).
 * Shape detection still runs in scanner.html (needs canvas pixel access).
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
    // Dynamically require so server still starts even if tesseract isn't installed yet
    const { createWorker } = require("tesseract.js");
    ocrWorker = await createWorker("eng");
    ocrReady = true;
    console.log("[ocr] Tesseract worker ready");
  } catch (e) {
    console.warn("[ocr] tesseract.js not available — OCR disabled:", e.message);
    console.warn("[ocr] Run: npm install tesseract.js");
  }
}

initOCR();

const BLOCKED_WORDS = [
  "fuck",
  "shit",
  "cunt",
  "cock",
  "dick",
  "ass",
  "bitch",
  "piss",
  "porn",
  "sex",
  "nude",
  "kill",
  "die",
  "hate",
  "boob",
  "boobs",
  "tits",
  "tit",
  "penis",
  "vagina",
];

async function runOCR(imageDataUrl) {
  if (!ocrReady || !ocrWorker) return [];
  try {
    // Strip data-URL prefix so tesseract gets raw base64
    const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(base64, "base64");
    const {
      data: { text },
    } = await ocrWorker.recognize(buf);
    const words = (text || "")
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/);
    const flagged = words.filter(
      (w) => w.length > 1 && BLOCKED_WORDS.includes(w),
    );
    return flagged.map((w) => `blocked word: "${w}"`);
  } catch (e) {
    console.warn("[ocr] recognize error:", e.message);
    return [];
  }
}

// ── State ─────────────────────────────────────────────────────────────────
const liveDrawings = new Map(); // id → { id, imageData, throwSpeed, flagged, reason }
const pendingScans = new Map(); // scanId → { drawingId, resolve }
let scannerSocket = null;
let scanIdCounter = 0;

const AUTO_REMOVE_MS = 5000;
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
}

// ── Remove helper ─────────────────────────────────────────────────────────
function removeDrawing(drawingId, reason) {
  if (!liveDrawings.has(drawingId)) return;
  liveDrawings.delete(drawingId);
  clearTimeout(autoRemoveTimers.get(drawingId));
  autoRemoveTimers.delete(drawingId);
  io.to("projectors").emit("removeDrawing", drawingId);
  io.to("admins").emit("drawingRemoved", { drawingId, reason });
  console.log(`[mod] removed ${drawingId} — ${reason}`);
}

// ── Connections ───────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("register", (role) => {
    socket.data.role = role;

    if (role === "projector") {
      socket.join("projectors");
      liveDrawings.forEach((d) => {
        socket.emit("newDrawing", {
          id: d.id,
          imageData: d.imageData,
          throwSpeed: d.throwSpeed,
        });
        if (d.flagged) socket.emit("flagDrawing", { drawingId: d.id });
      });
    }

    if (role === "admin") {
      socket.join("admins");
      broadcastAdminState();
      notifyScannerStatus();
    }

    if (role === "scanner") {
      scannerSocket = socket;
      console.log("[mod] shape scanner connected");
      notifyScannerStatus();
      // Drain any queued shape-scan requests
      pendingScans.forEach((pending, scanId) => {
        socket.emit("scanThis", { scanId, imageData: pending.imageData });
      });
    }
  });

  // ── Drawing arrives from tablet ───────────────────────────────────────
  socket.on("drawing", async ({ imageData, throwSpeed }) => {
    const drawingId = `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // Optimistic: show on projector immediately
    const entry = {
      id: drawingId,
      imageData,
      throwSpeed,
      flagged: false,
      reason: null,
    };
    liveDrawings.set(drawingId, entry);
    io.to("projectors").emit("newDrawing", {
      id: drawingId,
      imageData,
      throwSpeed,
    });
    broadcastAdminState();

    // ── Step 1: OCR (server-side, fast) ──────────────────────────────
    const reasons = await runOCR(imageData);

    // ── Step 2: Shape detection (scanner.html via socket) ─────────────
    if (scannerSocket && scannerSocket.connected) {
      const scanId = `s_${scanIdCounter++}`;
      pendingScans.set(scanId, { drawingId, imageData });
      scannerSocket.emit("scanThis", { scanId, imageData });

      // Wait up to 8s for shape result, then proceed with OCR result only
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingScans.delete(scanId);
          resolve();
        }, 8000);
        pendingScans.get(scanId).resolve = (shapeReasons) => {
          clearTimeout(timer);
          reasons.push(...shapeReasons);
          pendingScans.delete(scanId);
          resolve();
        };
      });
    }

    if (reasons.length === 0) {
      console.log(`[mod] clean: ${drawingId}`);
      return;
    }

    // Flag it
    console.log(`[mod] FLAGGED: ${drawingId} — ${reasons.join(", ")}`);
    entry.flagged = true;
    entry.reason = reasons.join(", ");

    io.to("projectors").emit("flagDrawing", { drawingId });
    io.to("admins").emit("drawingFlagged", { drawingId, reasons });
    broadcastAdminState();

    const handle = setTimeout(() => {
      removeDrawing(drawingId, "auto-removed after flag");
      broadcastAdminState();
    }, AUTO_REMOVE_MS);
    autoRemoveTimers.set(drawingId, handle);
  });

  // ── Shape result from scanner.html ────────────────────────────────────
  socket.on("shapeResult", ({ scanId, reasons }) => {
    const pending = pendingScans.get(scanId);
    if (pending && pending.resolve) pending.resolve(reasons || []);
  });

  // ── Admin actions ─────────────────────────────────────────────────────
  socket.on("removeDrawing", (drawingId) => {
    removeDrawing(drawingId, "admin manual removal");
    broadcastAdminState();
  });

  socket.on("pardonDrawing", (drawingId) => {
    const entry = liveDrawings.get(drawingId);
    if (!entry) return;
    entry.flagged = false;
    entry.reason = null;
    clearTimeout(autoRemoveTimers.get(drawingId));
    autoRemoveTimers.delete(drawingId);
    io.to("projectors").emit("pardonDrawing", { drawingId });
    console.log(`[mod] pardoned ${drawingId}`);
    broadcastAdminState();
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    if (socket === scannerSocket) {
      scannerSocket = null;
      console.warn("[mod] shape scanner disconnected");
      notifyScannerStatus();
    }
    console.log("disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server:  http://localhost:3000");
  console.log("Draw:    http://localhost:3000/draw.html");
  console.log("Project: http://localhost:3000/project.html");
  console.log("Admin:   http://localhost:3000/admin.html");
  console.log(
    "Scanner: http://localhost:3000/scanner.html  (open once, keep in background)",
  );
  console.log("");
  console.log("First run: npm install tesseract.js");
});
