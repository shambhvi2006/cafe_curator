// backend/server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from 'dotenv';
dotenv.config();
const apiKey = process.env.GOOGLE_API_KEY;

const app = express();

// Read key from either GOOGLE_API_KEY or API_KEY
const GOOGLE_KEY = process.env.GOOGLE_API_KEY || process.env.API_KEY || "";
if (!GOOGLE_KEY) {
  console.warn("[WARN] No GOOGLE_API_KEY or API_KEY found in backend/.env");
}

// CORS: allow your dev origins
app.use(cors({
  origin: [
    "http://localhost:8080",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://localhost:5173",
    "http://localhost:3000"
  ],
}));

/* ---------- API ROUTES ---------- */

// Nearby places proxy (hides key)
app.get("/api/nearby", async (req, res) => {
  const { type = "cafe", lat, lng, radius = 1500 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat,lng required" });
  if (!GOOGLE_KEY) return res.status(500).json({ error: "Server is missing GOOGLE_API_KEY" });

  try {
    const r = await axios.get("https://maps.googleapis.com/maps/api/place/nearbysearch/json", {
      params: { key: GOOGLE_KEY, location: `${lat},${lng}`, radius, type }
    });

    // Make Google’s error visible
    if (r.data?.status && r.data.status !== "OK") {
      console.error("[Places Nearby]", r.data.status, r.data.error_message);
      return res.status(502).json({
        error: "Google Places error",
        status: r.data.status,
        message: r.data.error_message || "Unknown error from Google"
      });
    }

    const items = (r.data.results || []).map(p => ({
      place_id: p.place_id,
      name: p.name,
      rating: p.rating ?? null,
      vicinity: p.vicinity ?? "",
      photoRef: p.photos?.[0]?.photo_reference || null,
      photo: p.photos?.[0]?.photo_reference
        ? `/api/photo?ref=${encodeURIComponent(p.photos[0].photo_reference)}&max=520`
        : null
    }));

    res.json({ ok: true, results: items });
  } catch (e) {
    console.error("[Nearby ERROR]", e?.response?.data || e.message);
    res.status(e?.response?.status || 500).json({ error: "Upstream failed" });
  }
});

// Photo proxy
app.get("/api/photo", async (req, res) => {
  const { ref, max = 520 } = req.query;
  if (!ref) return res.status(400).send("Missing ref");
  if (!GOOGLE_KEY) return res.status(500).send("Server is missing GOOGLE_API_KEY");

  try {
    const r = await axios.get("https://maps.googleapis.com/maps/api/place/photo", {
      params: { key: GOOGLE_KEY, maxwidth: max, photo_reference: ref },
      responseType: "stream"
    });
    res.setHeader("Content-Type", r.headers["content-type"] || "image/jpeg");
    r.data.pipe(res);
  } catch (e) {
    console.error("[Photo ERROR]", e?.response?.data || e.message);
    res.status(500).send("Photo fetch failed");
  }
});

// Health check
app.get("/health", (_, res) => res.json({ ok: true }));

/* ---------- STATIC FRONTEND (optional) ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const FRONTEND_DIR = path.join(__dirname, "..");
app.use(express.static(FRONTEND_DIR));
app.get("/", (req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));

/* ---------- START ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
