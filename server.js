require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ─── Case-insensitive field reader ───────────────────────────────────────────
function getField(obj, ...keys) {
  if (!obj || typeof obj !== "object") return "";
  const lower = Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase().trim(), v])
  );
  for (const key of keys) {
    const val = lower[key.toLowerCase().trim()];
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      return String(val).trim();
    }
  }
  return "";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
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

// ─── Details scanner ─────────────────────────────────────────────────────────
// Reads free-text "additional details" and returns pricing signals.
function scanDetails(text) {
  const t = String(text || "").toLowerCase();
  const signals = [];

  // High ceilings — adds wall area and reach difficulty
  const ceilingMatch = t.match(/\b(9|10|11|12)\s*('|ft|foot|feet)/);
  if (ceilingMatch || t.includes("high ceiling") || t.includes("high ceilings")) {
    const height = ceilingMatch ? parseInt(ceilingMatch[1], 10) : 10;
    const pct = height >= 12 ? 0.20 : height >= 10 ? 0.12 : 0.08;
    signals.push({ label: `${height}ft ceilings detected`, multiplier: 1 + pct });
  }

  // Stairwell / vaulted — awkward access, ladders required
  if (t.includes("stairwell") || t.includes("stair well") || t.includes("vaulted")) {
    signals.push({ label: "stairwell/vaulted area", multiplier: 1.15 });
  }

  // Occupied home / furniture present — slower work
  if (t.includes("occupied") || t.includes("furnished") || t.includes("furniture")) {
    signals.push({ label: "occupied/furnished space", multiplier: 1.10 });
  }

  // Closets — tight spaces, setup-heavy, charged as flat adds
  const closetMatch = t.match(/(\d+)\s*closet/);
  const closetCount = closetMatch ? parseInt(closetMatch[1], 10) :
    (t.includes("closet") ? 1 : 0);
  if (closetCount >= 3) {
    signals.push({ label: `${closetCount} closets`, flatAdd: 200 });
  } else if (closetCount === 2) {
    signals.push({ label: "2 closets", flatAdd: 125 });
  } else if (closetCount === 1) {
    signals.push({ label: "1 closet", flatAdd: 75 });
  }

  // Bathrooms — tight, cutting-heavy
  const bathMatch = t.match(/(\d+)\s*(bathroom|bath|ensuite)/);
  const bathCount = bathMatch ? parseInt(bathMatch[1], 10) :
    (t.includes("bathroom") || t.includes("bath") || t.includes("ensuite") ? 1 : 0);
  if (bathCount > 0) {
    signals.push({ label: `${bathCount} bathroom(s)`, flatAdd: bathCount * 150 });
  }

  // Kitchen — grease prep, more cutting
  if (t.includes("kitchen")) {
    signals.push({ label: "kitchen included", flatAdd: 150 });
  }

  // Water damage / mold — needs extra primer and prep
  if (t.includes("water damage") || t.includes("water stain") || t.includes("mold") || t.includes("mould")) {
    signals.push({ label: "water damage/mold — extra prep", multiplier: 1.20 });
  }

  // Wallpaper — completely different job, widen range
  if (t.includes("wallpaper")) {
    signals.push({ label: "wallpaper present — range widened", rangeWiden: true });
  }

  return signals;
}

// ─── Pricing engine ──────────────────────────────────────────────────────────
//
// Toronto GTA mid-market positioning (2025-2026):
//   - Studios:        ~$850–$1,400
//   - 1-bed condos:   ~$800–$1,800
//   - 2-bed condos:   ~$1,500–$3,500
//   - Houses 1,200sqft: ~$3,000–$5,000
//
// Base rates are per floor sqft, walls only (standard repaint = 1 primer + 2 coats).
// Smaller jobs cost more per sqft because setup/travel is a fixed cost.
//
// Subcontract model: painters 40%, materials ~10%, you net ~50%.
// These rates are calibrated so a $2,000 job gives painters $800,
// ~$200 materials, and you net ~$1,000.

function getWallsRate(sqft) {
  if (sqft <= 300)  return 4.50;  // studio / single room
  if (sqft <= 600)  return 3.50;  // 1-bedroom condo
  if (sqft <= 900)  return 3.00;  // 2-bedroom condo
  if (sqft <= 1300) return 2.75;  // 3-bed condo / small house
  if (sqft <= 2000) return 2.50;  // mid-size house
  return 2.25;                    // large house
}

function estimateRange({
  sqft,
  rooms,
  paintItems,
  condition,
  paintChange,
  details,
}) {
  let base = 0;
  const notes = [];

  const walls   = paintItems.includes("walls");
  const trim    = paintItems.includes("trim");
  const doors   = paintItems.includes("doors");
  const ceiling = paintItems.includes("ceiling") || paintItems.includes("ceilings");

  // ── Walls ──
  if (walls) {
    const rate = getWallsRate(sqft);
    const wallCost = sqft * rate;
    base += wallCost;
    notes.push(`walls: ${sqft} sqft × $${rate.toFixed(2)}/sqft = $${wallCost.toFixed(0)}`);
  }

  // ── Trim / baseboards ──
  if (trim) {
    const trimFt = Math.max(40, Math.round(sqft * 0.14));
    const trimCost = trimFt * 2;
    base += trimCost;
    notes.push(`trim: ~${trimFt}ft × $2/ft = $${trimCost}`);
  }

  // ── Doors ──
  if (doors) {
    const estimatedDoors = Math.max(1, Math.min(rooms || 2, 8));
    const doorCost = estimatedDoors * 100;
    base += doorCost;
    notes.push(`doors: ${estimatedDoors} × $100 = $${doorCost}`);
  }

  // ── Ceilings ──
  if (ceiling) {
    const ceilingCost = sqft * 1.75;
    base += ceilingCost;
    notes.push(`ceiling: ${sqft} sqft × $1.75/sqft = $${ceilingCost.toFixed(0)}`);
  }

  // ── Condition ──
  const cond = String(condition || "").toLowerCase();
  if (cond.includes("minor")) {
    base *= 1.12;
    notes.push("minor repairs +12%");
  } else if (cond.includes("heavy")) {
    base *= 1.30;
    notes.push("heavy repairs +30%");
  }

  // ── Paint change (coats) ──
  const pc = String(paintChange || "").toLowerCase();
  if (pc.includes("major") || pc.includes("3 coat") || pc.includes("primer")) {
    base *= 1.30;
    notes.push("major color change / primer needed +30%");
  } else if (pc.includes("color change") || pc.includes("colour change") || pc.includes("2 coat")) {
    base *= 1.15;
    notes.push("color change (2 coats) +15%");
  }
  // same color / 1 coat = no adjustment

  // ── Details signals ──
  const detailSignals = scanDetails(details);
  let rangeWiden = false;

  for (const signal of detailSignals) {
    if (signal.multiplier) {
      base *= signal.multiplier;
      notes.push(`${signal.label} +${Math.round((signal.multiplier - 1) * 100)}%`);
    }
    if (signal.flatAdd) {
      base += signal.flatAdd;
      notes.push(`${signal.label} +$${signal.flatAdd}`);
    }
    if (signal.rangeWiden) {
      rangeWiden = true;
      notes.push(signal.label);
    }
  }

  // ── Minimum job ──
  if (base < 500) {
    base = 500;
    notes.push("minimum job price ($500)");
  }

  // ── Output range ──
  // Standard: low = 90%, high = 115%
  // Widened (wallpaper etc): low = 85%, high = 130%
  const lowPct  = rangeWiden ? 0.85 : 0.90;
  const highPct = rangeWiden ? 1.30 : 1.15;

  const low  = Math.round((base * lowPct)  / 50) * 50;
  const high = Math.round((base * highPct) / 50) * 50;

  return { low, high, notes, rangeWiden };
}

// ─── Email builders ───────────────────────────────────────────────────────────
function buildCustomerEmail({ name, projectType, sqftRaw, paintItems, low, high, rangeWiden }) {
  const type  = String(projectType || "space").toLowerCase();
  const scope = paintItems.includes("walls") ? "painting the walls" : "the painting work";
  const size  = sqftRaw ? `${sqftRaw} ` : "";
  const widenNote = rangeWiden
    ? "\n\nNote: your project may include work that varies significantly in scope (e.g. wallpaper removal). The range above is wider than usual to reflect that."
    : "";

  return {
    subject: `${projectType || "Painting"} Estimate — Ten Bell Painting`,
    body:
`Hi ${name},

Thanks for reaching out to Ten Bell Painting.

Based on the information provided, a rough ballpark for ${scope} in your ${size}${type} would be in the range of $${low.toLocaleString()} to $${high.toLocaleString()}.

Final pricing depends on the amount of prep required, any repairs, layout complexity, and confirming the final scope of work. This range is non-binding and intended as a preliminary ballpark.${widenNote}

If that range works for you, reply here and I'll follow up to confirm details and get you booked in.

Thanks,
Ten Bell Painting
905-536-6799
tenbellpainting@gmail.com`,
  };
}

function buildInternalEmail({
  name, phone, email, address, projectType, sqftRaw, roomsRaw,
  paintItems, condition, paintChange, details, photos, low, high, notes,
}) {
  return {
    subject: `New Lead: ${name}`,
    body:
`New lead received

Name:         ${name}
Phone:        ${phone || "—"}
Email:        ${email || "—"}
Address:      ${address || "—"}

Project Type: ${projectType || "—"}
Square Ft:    ${sqftRaw || "—"}
Rooms:        ${roomsRaw || "—"}
Paint Items:  ${paintItems.join(", ")}
Condition:    ${condition || "—"}
Paint Change: ${paintChange || "—"}
Details:      ${details || "—"}
Photos:       ${photos || "none"}

Suggested range: $${low} – $${high}

Pricing breakdown:
${notes.map((n) => `  · ${n}`).join("\n")}`,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Ten Bell lead bot is running"));

app.post("/lead", (req, res) => {
  console.log("RAW:", JSON.stringify(req.body, null, 2));

  const p = req.body?.data || req.body;

  const name          = getField(p, "name")         || "there";
  const phone         = getField(p, "phone");
  const email         = getField(p, "email");
  const address       = getField(p, "address",       "project address");
  const projectType   = getField(p, "projectType",   "project type");
  const sqftRaw       = getField(p, "squareFootage", "square footage of space", "square footage");
  const roomsRaw      = getField(p, "rooms",         "number of rooms/spaces");
  const condition     = getField(p, "condition",     "condition of walls") || "good (just repaint)";
  const paintChange   = getField(p, "paintChange",   "paintchange",
                                  "will this be the same color or a color change?") || "color match";
  const details       = getField(p, "details",       "additional details");
  const photos        = getField(p, "photos",        "upload photos");
  const paintItemsRaw = getField(p, "paintItems",    "paintitems",
                                  "what are you looking to paint");

  console.log("EMAIL →", email);
  console.log("SQFT →", sqftRaw);
  console.log("PAINT →", paintItemsRaw);
  console.log("DETAILS →", details);

  const sqft       = parseSqFt(sqftRaw);
  const rooms      = parseRooms(roomsRaw);
  const paintItems = parsePaintItems(paintItemsRaw);

  // Respond to Wix immediately — never let the automation hang
  res.sendStatus(200);

  setImmediate(async () => {
    try {

      // ── Not enough info ──
      if (!sqft || !paintItems.length) {
        console.log("Insufficient info — sqft:", sqft, "paintItems:", paintItems);

        if (email) {
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: email,
            subject: "Thanks for reaching out to Ten Bell Painting",
            text:
`Hi ${name},

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

      // ── Calculate ──
      const { low, high, notes, rangeWiden } = estimateRange({
        sqft, rooms, paintItems, condition, paintChange, details,
      });

      // ── Customer email ──
      if (email) {
        const { subject, body } = buildCustomerEmail({
          name, projectType, sqftRaw, paintItems, low, high, rangeWiden,
        });
        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: email,
          subject,
          text: body,
        });
        console.log("QUOTE → customer:", email);
      }

      // ── Internal email ──
      const { subject: intSubject, body: intBody } = buildInternalEmail({
        name, phone, email, address, projectType, sqftRaw, roomsRaw,
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
