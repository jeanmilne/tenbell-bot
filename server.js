require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Gmail transporter ────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function grab(payload, keys, fallback = "") {
  for (const k of keys) {
    const v = payload?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return fallback;
}

function parseSqFt(raw) {
  const match = String(raw || "").match(/\d{2,5}/);
  return match ? parseInt(match[0], 10) : 0;
}

function parseRooms(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text || text === "0") return 0;
  if (text.includes("more than 10")) return 10;
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : 0;
}

function parsePaintItems(raw) {
  if (!raw) return ["walls"];
  const items = Array.isArray(raw)
    ? raw.map((x) => String(x).toLowerCase().trim())
    : String(raw).split(",").map((x) => x.toLowerCase().trim()).filter(Boolean);
  const cleaned = items.filter((x) => !["other", "n/a", "na", "-", "none"].includes(x));
  return cleaned.length ? cleaned : ["walls"];
}

// ─── Pricing engine ───────────────────────────────────────────────────────────

function wallsRate(projectType, rooms) {
  const t = projectType.toLowerCase();
  if (t.includes("condo") || t.includes("apartment") || t.includes("rental")) {
    if (rooms <= 2) return 3.0;
    if (rooms <= 4) return 3.2;
    return 3.4;
  }
  if (t.includes("house")) return 3.6;
  if (t.includes("commercial")) return 3.4;
  return 3.3;
}

// Small jobs cost more per sq ft (heavy setup relative to work).
// Larger jobs get slight efficiency pricing.
function roomMultiplier(rooms) {
  if (!rooms || rooms <= 0) return 1.0;
  if (rooms === 1) return 1.2;
  if (rooms === 2) return 1.1;
  if (rooms <= 4) return 1.0;
  if (rooms <= 6) return 0.95;
  return 0.9;
}

function paintMultiplier(paintChange) {
  const t = paintChange.toLowerCase();
  if (t.includes("major")) return 1.3;
  if (t.includes("color change")) return 1.15;
  return 1.0; // color match / same color
}

function conditionMultiplier(condition) {
  const t = condition.toLowerCase();
  if (t.includes("minor")) return 1.12;
  if (t.includes("heavy")) return 1.3;
  return 1.0;
}

function estimateRange({ projectType, sqft, rooms, paintItems, condition, paintChange, details }) {
  let base = 0;
  const notes = [];

  const walls   = paintItems.includes("walls");
  const trim    = paintItems.includes("trim");
  const doors   = paintItems.includes("doors");
  const ceiling = paintItems.includes("ceiling") || paintItems.includes("ceilings");

  if (walls) {
    const rate = wallsRate(projectType, rooms);
    base += sqft * rate;
    notes.push(`walls $${rate.toFixed(2)}/sqft`);
  }

  if (trim) {
    const trimFt = Math.max(40, Math.round(sqft * 0.12));
    base += trimFt * 2;
    notes.push(`${trimFt}ft trim @ $2/ft`);
  }

  if (doors) {
    const d = Math.max(1, Math.min(rooms || 1, 6));
    base += d * 100;
    notes.push(`${d} doors @ $100`);
  }

  if (ceiling) {
    base += sqft * 1.5;
    notes.push("ceiling included");
  }

  const rm = roomMultiplier(rooms);
  base *= rm;
  notes.push(`room adj x${rm.toFixed(2)}`);

  const pm = paintMultiplier(paintChange);
  base *= pm;
  notes.push(`paint adj x${pm.toFixed(2)}`);

  const cm = conditionMultiplier(condition);
  base *= cm;
  notes.push(`condition adj x${cm.toFixed(2)}`);

  // High-ceiling detection from details
  const d = details.toLowerCase();
  if (d.includes("high ceiling") || /1[012]\s*('|ft)/.test(d) || /9\s*('|ft)/.test(d)) {
    base *= 1.1;
    notes.push("high ceiling adj x1.10");
  }

  if (base < 500) { base = 500; notes.push("minimum applied"); }

  const low  = Math.round((base * 0.90) / 50) * 50;
  const high = Math.round((base * 1.10) / 50) * 50;

  return { low, high, notes };
}

// ─── Email builders ───────────────────────────────────────────────────────────

function customerEmail({ name, projectType, sqftRaw, paintItems, low, high }) {
  const type  = projectType || "space";
  const scope = paintItems.includes("walls") ? "painting the walls" : "the painting work";
  const size  = sqftRaw ? `${sqftRaw} ` : "";

  return {
    subject: `${projectType || "Painting"} Estimate — Ten Bell Painting`,
    body: `Hi ${name},

Thanks for reaching out to Ten Bell Painting.

Based on the information provided, a rough ballpark for ${scope} in your ${size}${type.toLowerCase()} would be in the range of $${low.toLocaleString()} to $${high.toLocaleString()}.

Final pricing depends on the amount of prep required, any repairs, layout complexity, and confirming the final scope of work. This range is non-binding and intended as a preliminary ballpark.

If that range works for you, reply here and I'll follow up to confirm details and get you booked in.

Thanks,
Ten Bell Painting
905-536-6799
tenbellpainting@gmail.com`,
  };
}

function internalEmail({ name, phone, email, address, projectType, sqftRaw, rooms, paintItems, condition, paintChange, details, photos, low, high, notes }) {
  return {
    subject: `New Lead: ${name}`,
    body: `New lead received

Name:         ${name}
Phone:        ${phone || "—"}
Email:        ${email || "—"}
Address:      ${address || "—"}

Project Type: ${projectType || "—"}
Square Ft:    ${sqftRaw || "—"}
Rooms:        ${rooms || "—"}
Paint Items:  ${paintItems.join(", ")}
Condition:    ${condition || "—"}
Paint Change: ${paintChange || "—"}
Details:      ${details || "—"}
Photos:       ${photos || "none"}

Suggested range: $${low} – $${high}

Pricing notes:
${notes.map((n) => `  - ${n}`).join("\n")}`,
  };
}

// ─── Route ────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.send("Ten Bell lead bot is running"));

app.post("/lead", (req, res) => {
  // Log raw payload for debugging
  console.log("RAW:", JSON.stringify(req.body, null, 2));

  // Wix wraps the form data inside a "data" key
  const p = req.body?.data || req.body;

  // ── Field extraction ──
  const name        = grab(p, ["name",         "Name"],                              "there");
  const phone       = grab(p, ["phone",         "Phone"]);
  const email       = grab(p, ["email",         "Email"]);
  const address     = grab(p, ["address",       "Project Address"]);
  const projectType = grab(p, ["projectType",   "Project Type"]);
  const sqftRaw     = grab(p, ["squareFootage", "Square footage of space"]);
  const roomsRaw    = grab(p, ["rooms",         "Number of rooms/spaces"]);
  const condition   = grab(p, ["condition",     "Condition of walls"],                "good (just repaint)");
  const paintChange = grab(p, ["paintChange",   "Will this be the same color or a color change?"], "Color match (1 coat of paint)");
  const details     = grab(p, ["details",       "Additional details"]);
  const photos      = grab(p, ["photos",        "Upload photos"]);
  const paintItemsRaw = grab(p, ["paintItems",  "What are you looking to paint"]);

  console.log("EMAIL →", email);

  const sqft      = parseSqFt(sqftRaw);
  const rooms     = parseRooms(roomsRaw);
  const paintItems = parsePaintItems(paintItemsRaw);

  // Respond to Wix immediately so the automation never hangs
  res.sendStatus(200);

  // Do the heavy work in the background
  setImmediate(async () => {
    try {
      // ── Not enough info ──
      if (!sqft || !paintItems.length) {
        console.log("Insufficient info — sending fallback");

        if (email) {
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: email,
            subject: "Thanks for reaching out to Ten Bell Painting",
            text: `Hi ${name},

Thanks for reaching out to Ten Bell Painting.

We need a bit more detail before we can provide a price range — a representative will be in touch with you shortly.

Thanks,
Ten Bell Painting
905-536-6799
tenbellpainting@gmail.com`,
          });
          console.log("FALLBACK → customer:", email);
        }

        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: process.env.GMAIL_USER,
          subject: `New Lead (no range): ${name}`,
          text: `New lead — not enough info for range\n\n${JSON.stringify(p, null, 2)}`,
        });
        console.log("FALLBACK → internal");
        return;
      }

      // ── Calculate range ──
      const { low, high, notes } = estimateRange({
        projectType, sqft, rooms, paintItems, condition, paintChange, details,
      });

      // ── Customer email ──
      if (email) {
        const { subject, body } = customerEmail({ name, projectType, sqftRaw, paintItems, low, high });
        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: email,
          subject,
          text: body,
        });
        console.log("QUOTE → customer:", email);
      }

      // ── Internal email ──
      const { subject: intSubject, body: intBody } = internalEmail({
        name, phone, email, address, projectType, sqftRaw, rooms: roomsRaw,
        paintItems, condition, paintChange, details, photos, low, high, notes,
      });
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: process.env.GMAIL_USER,
        subject: intSubject,
        text: intBody,
      });
      console.log("QUOTE → internal");

    } catch (err) {
      console.error("BACKGROUND ERROR:", err.message);
    }
  });
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
