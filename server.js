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

// ─── Room count → assumed space premiums ─────────────────────────────────────
// When a customer selects room count on the Wix form, we infer typical spaces
// so the price reflects the actual complexity of the job.
function getSpacePremiumsFromRooms(rooms) {
  const r = parseInt(rooms, 10) || 0;
  // Returns: { beds, halls, bathSm, bathMd, bathLg, kitchen }
  if (r <= 0) return { beds:0, halls:0, bathSm:0, bathMd:0, bathLg:0, kitchen:0 };
  if (r === 1) return { beds:0, halls:0, bathSm:1, bathMd:0, bathLg:0, kitchen:0 };
  if (r === 2) return { beds:1, halls:0, bathSm:1, bathMd:0, bathLg:0, kitchen:0 };
  if (r === 3) return { beds:1, halls:1, bathSm:0, bathMd:1, bathLg:0, kitchen:0 };
  if (r === 4) return { beds:2, halls:1, bathSm:0, bathMd:1, bathLg:0, kitchen:1 };
  if (r === 5) return { beds:2, halls:1, bathSm:0, bathMd:1, bathLg:1, kitchen:1 };
  return       { beds:3, halls:2, bathSm:0, bathMd:1, bathLg:1, kitchen:1 };
}

// ─── FINAL LOCKED PRICING ENGINE ─────────────────────────────────────────────
function getWallsRate(sqft, projectType) {
  const type = String(projectType || "").toLowerCase();
  if (type.includes("house")) {
    if (sqft <= 1000) return 2.75;
    if (sqft <= 1500) return 2.55;
    if (sqft <= 2000) return 2.35;
    return 2.10;
  }
  if (type.includes("commercial")) return getWallsRate(sqft, "condo") * 1.20;
  if (sqft <= 300)  return 3.75;
  if (sqft <= 450)  return 2.90;
  if (sqft <= 700)  return 2.55;
  if (sqft <= 900)  return 2.50;
  if (sqft <= 1300) return 2.40;
  if (sqft <= 2000) return 2.15;
  return 1.85;
}

function getCeilingRate(sqft) {
  if (sqft <= 600)  return 1.50;
  if (sqft <= 800)  return 1.35;
  if (sqft <= 1100) return 1.20;
  if (sqft <= 1500) return 1.05;
  if (sqft <= 2000) return 0.90;
  return 0.75;
}

function roundTo50(n) { return Math.round(n / 50) * 50; }

function estimateRange({ projectType, sqft, paintItems, condition, paintChange, rooms }) {
  let base = 0;

  const walls   = paintItems.includes("walls");
  const trim    = paintItems.includes("trim");
  const doors   = paintItems.includes("doors");
  const ceiling = paintItems.includes("ceiling") || paintItems.includes("ceilings");

  let wallBase = 0;
  if (walls) {
    wallBase = sqft * getWallsRate(sqft, projectType);
    base += wallBase;
  }
  if (trim)    base += Math.max(40, Math.round(sqft * 0.15)) * 2;
  if (doors)   base += 2 * 100;
  if (ceiling) base += sqft * getCeilingRate(sqft);

  // Space premiums inferred from room count
  const sp = getSpacePremiumsFromRooms(rooms);
  let premiums = 0;
  premiums += sp.beds    * 25;
  premiums += sp.halls   * 50;
  premiums += sp.bathSm  * 75;
  premiums += sp.bathMd  * 125;
  premiums += sp.bathLg  * 150;
  premiums += sp.kitchen * 75;

  // Cap premiums at 15% of wall base to prevent inflation on small units
  if (wallBase > 0) premiums = Math.min(premiums, wallBase * 0.15);
  base += premiums;

  // Condition
  const cond = String(condition || "").toLowerCase();
  if (cond.includes("minor")) base *= 1.12;
  else if (cond.includes("heavy")) base *= 1.30;

  // Paint change
  const pc = String(paintChange || "").toLowerCase();
  if (pc.includes("major") || pc.includes("3 coat") || pc.includes("primer")) {
    base *= 1.30;
  } else if (pc.includes("color change") || pc.includes("colour change") || pc.includes("2 coat")) {
    base *= 1.15;
  }

  if (base < 500) base = 500;

  const low  = roundTo50(base * 0.90);
  const high = roundTo50(base * 1.20);

  return { low, high };
}

// ─── Email builders ───────────────────────────────────────────────────────────
function buildCustomerEmail({ name, projectType, sqftRaw, paintItems, low, high }) {
  const type  = String(projectType || "space").toLowerCase();
  const scope = paintItems.includes("walls") ? "painting the walls" : "the painting work";
  const size  = sqftRaw ? `${sqftRaw} ` : "";

  return {
    subject: `${projectType || "Painting"} Estimate — Ten Bell Painting`,
    body:
`Hi ${name},

Thanks for reaching out to Ten Bell Painting.

Based on the information provided, a rough ballpark for ${scope} in your ${size}${type} would be in the range of $${low.toLocaleString()} to $${high.toLocaleString()}.

Final pricing depends on the amount of prep required, any repairs, layout complexity, and confirming the final scope of work. This range is non-binding and intended as a preliminary ballpark.

If that range works for you, reply here and I'll follow up to confirm details and get you booked in.

Thanks,
Ten Bell Painting
905-536-6799
tenbellpainting@gmail.com`,
  };
}

function buildInternalEmail({
  name, phone, email, address, projectType, sqftRaw, roomsRaw,
  paintItems, condition, paintChange, details, photos, low, high, spaces,
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

Assumed spaces from room count:
  Bedrooms: ${spaces.beds} · Hallways: ${spaces.halls}
  Small bath: ${spaces.bathSm} · Std bath: ${spaces.bathMd} · Ensuite: ${spaces.bathLg}
  Kitchen: ${spaces.kitchen}

Suggested range: $${low} – $${high}`,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Ten Bell lead bot is running"));

app.post("/lead", (req, res) => {
  console.log("RAW:", JSON.stringify(req.body, null, 2));

  const p = req.body?.data || req.body;

  const name        = getField(p, "name")         || "there";
  const phone       = getField(p, "phone");
  const email       = getField(p, "email");
  const address     = getField(p, "address",       "project address");
  const projectType = getField(p, "projectType",   "project type");
  const sqftRaw     = getField(p, "squareFootage", "square footage of space",
                                   "Square Footage of Space", "square footage");
  const roomsRaw    = getField(p, "rooms",         "number of rooms/spaces");
  const condition   = getField(p, "condition",     "condition of walls") || "good (just repaint)";
  const paintChange = getField(p, "paintChange",   "paintchange",
                                   "will this be the same color or a color change?") || "color match";
  const details     = getField(p, "details",       "additional details");
  const photos      = getField(p, "photos",        "upload photos");
  const paintItemsRaw = getField(p, "paintItems",  "paintitems",
                                    "what are you looking to paint");

  console.log("EMAIL →", email);
  console.log("SQFT →", sqftRaw);
  console.log("ROOMS →", roomsRaw);
  console.log("TYPE →", projectType);

  const sqft       = parseSqFt(sqftRaw);
  const rooms      = parseRooms(roomsRaw);
  const paintItems = parsePaintItems(paintItemsRaw);
  const spaces     = getSpacePremiumsFromRooms(rooms);

  // Respond to Wix immediately
  res.sendStatus(200);

  setImmediate(async () => {
    try {
      if (!sqft || !paintItems.length) {
        console.log("Insufficient info — sending fallback");

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
          text: `New lead — not enough info\n\n${JSON.stringify(p, null, 2)}`,
        });
        console.log("FALLBACK → internal");
        return;
      }

      const { low, high } = estimateRange({
        projectType, sqft, paintItems, condition, paintChange, rooms,
      });

      if (email) {
        const { subject, body } = buildCustomerEmail({
          name, projectType, sqftRaw, paintItems, low, high,
        });
        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: email,
          subject,
          text: body,
        });
        console.log("QUOTE → customer:", email);
      }

      const { subject: intSubject, body: intBody } = buildInternalEmail({
        name, phone, email, address, projectType, sqftRaw, roomsRaw,
        paintItems, condition, paintChange, details, photos, low, high, spaces,
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

const path = require("path");
app.get("/quote", (_req, res) => {
  res.sendFile(path.join(__dirname, "quote.html"));
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
