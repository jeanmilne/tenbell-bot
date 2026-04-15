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

// -------------------------
// Helpers
// -------------------------
function pick(obj, keys, fallback = "") {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== "") {
      return obj[key];
    }
  }
  return fallback;
}

function parseSquareFootage(value) {
  const text = String(value || "").toLowerCase();
  const match = text.match(/(\d{2,5})/);
  return match ? parseInt(match[1], 10) : 0;
}

function parseRooms(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "0") return 0;
  if (text === "more than 10") return 10;
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : 0;
}

function normalizePaintItems(raw) {
  if (!raw) return ["walls"];

  let items = [];

  if (Array.isArray(raw)) {
    items = raw.map((x) => String(x).toLowerCase().trim());
  } else {
    items = String(raw)
      .split(",")
      .map((x) => x.toLowerCase().trim())
      .filter(Boolean);
  }

  const cleaned = items.filter(
    (item) => !["n/a", "na", "-", "none"].includes(item)
  );

  return cleaned.length ? cleaned : ["walls"];
}

function getRoomMultiplier(rooms) {
  if (!rooms || rooms <= 0) return 1.0;
  if (rooms === 1) return 1.2;
  if (rooms === 2) return 1.1;
  if (rooms <= 4) return 1.0;
  if (rooms <= 6) return 0.95;
  return 0.9;
}

function getPaintMultiplier(paintChange) {
  const text = String(paintChange || "").toLowerCase();
  if (text.includes("major")) return 1.3;
  if (text.includes("color change")) return 1.15;
  return 1.0;
}

function getConditionMultiplier(condition) {
  const text = String(condition || "").toLowerCase();
  if (text.includes("minor")) return 1.12;
  if (text.includes("heavy")) return 1.3;
  return 1.0;
}

function getWallsRate(projectType, rooms) {
  const type = String(projectType || "").toLowerCase();

  if (type.includes("condo") || type.includes("apartment") || type.includes("rental")) {
    if (rooms <= 2) return 3.0;
    if (rooms <= 4) return 3.2;
    return 3.4;
  }

  if (type.includes("house")) return 3.6;
  if (type.includes("small commercial")) return 3.4;

  return 3.3;
}

function roundTo50(n) {
  return Math.round(n / 50) * 50;
}

function calculateEstimate({
  projectType,
  squareFootage,
  rooms,
  paintItems,
  condition,
  paintChange,
  details,
}) {
  let base = 0;
  const notes = [];

  const includesWalls = paintItems.includes("walls");
  const includesTrim = paintItems.includes("trim");
  const includesDoors = paintItems.includes("doors");
  const includesCeiling =
    paintItems.includes("ceiling") || paintItems.includes("ceilings");
  const includesOther = paintItems.includes("other");

  if (includesWalls) {
    const rate = getWallsRate(projectType, rooms);
    base += squareFootage * rate;
    notes.push(`walls at $${rate.toFixed(2)}/sq ft`);
  }

  if (includesTrim) {
    const trimFeet = Math.max(40, Math.round(squareFootage * 0.12));
    base += trimFeet * 2;
    notes.push(`${trimFeet} estimated trim ft at $2/ft`);
  }

  if (includesDoors) {
    const estimatedDoors = Math.max(1, Math.min(rooms || 1, 6));
    base += estimatedDoors * 100;
    notes.push(`${estimatedDoors} estimated doors at $100 each`);
  }

  if (includesCeiling) {
    base += squareFootage * 1.5;
    notes.push("ceiling included");
  }

  if (includesOther) {
    base += 150;
    notes.push("other scope allowance");
  }

  const roomMult = getRoomMultiplier(rooms);
  base *= roomMult;
  notes.push(`room multiplier x${roomMult.toFixed(2)}`);

  const paintMult = getPaintMultiplier(paintChange);
  base *= paintMult;
  notes.push(`paint multiplier x${paintMult.toFixed(2)}`);

  const conditionMult = getConditionMultiplier(condition);
  base *= conditionMult;
  notes.push(`condition multiplier x${conditionMult.toFixed(2)}`);

  const detailText = String(details || "").toLowerCase();
  if (
    detailText.includes("high ceiling") ||
    detailText.includes("9 ft") ||
    detailText.includes("9'") ||
    detailText.includes("10 ft") ||
    detailText.includes("10'")
  ) {
    base *= 1.1;
    notes.push("high ceiling multiplier");
  }

  if (base < 500) {
    base = 500;
    notes.push("minimum job price applied");
  }

  let low = roundTo50(base * 0.9);
  let high = roundTo50(base * 1.07);

  return { low, high, notes };
}

function buildCustomerEmail({ name, projectType, squareFootageRaw, low, high, paintItems }) {
  const projectLabel = String(projectType || "Painting").trim();
  const scope = paintItems.includes("walls") ? "painting the walls" : "painting";
  const sizeText = String(squareFootageRaw || "").trim();

  const subject = `${projectLabel} Painting Estimate`;

  const body = `Hi ${name},

Thanks for reaching out to Ten Bell Painting.

Based on the information provided, a rough ballpark for ${scope.toLowerCase()} in your ${sizeText ? sizeText + " " : ""}${projectLabel.toLowerCase()} would be in the range of **$${low.toLocaleString()} to $${high.toLocaleString()}**.

Final pricing depends on the amount of prep required, any repairs, layout complexity, and confirming the final scope of work. Since some details were estimated, this range is non-binding and intended as a preliminary ballpark.

Thanks,
Ten Bell Painting
905-536-6799
tenbellpainting@gmail.com`;

  return { subject, body };
}

// -------------------------
// Routes
// -------------------------
app.get("/", (req, res) => {
  res.send("Ten Bell lead bot is running");
});

app.post("/lead", (req, res) => {
  try {
    console.log("RAW BODY:", JSON.stringify(req.body, null, 2));

    const payload = req.body?.data || req.body;

    const name = pick(payload, ["name", "Name"], "there");
    const phone = pick(payload, ["phone", "Phone"]);
    const email = pick(payload, ["email", "Email"]);
    const address = pick(payload, ["address", "Address", "Project Address"]);
    const projectType = pick(payload, ["projectType", "Project Type"]);
    const squareFootageRaw = pick(payload, ["squareFootage", "Square footage of space"]);
    const paintItemsRaw = pick(payload, ["paintItems", "What are you looking to paint"]);
    const roomsRaw = pick(payload, ["rooms", "Number of rooms/spaces"]);
    const condition = pick(payload, ["condition", "Condition of walls"], "good (just repaint)");
    const paintChange = pick(
      payload,
      ["paintChange", "Will this be the same color or a color change?"],
      "Color match (1 coat of paint)"
    );
    const details = pick(payload, ["details", "Additional details"]);
    const photos = pick(payload, ["photos", "Upload photos"]);

    console.log("EMAIL FIELD FROM WIX:", payload.email, payload.Email, email);

    const squareFootage = parseSquareFootage(squareFootageRaw);
    const rooms = parseRooms(roomsRaw);
    const paintItems = normalizePaintItems(paintItemsRaw);

    // reply to Wix immediately
    res.sendStatus(200);

    // background work
    setImmediate(async () => {
      try {
        if (!squareFootage || !paintItems.length) {
          const fallbackSubject = "Thanks for reaching out to Ten Bell Painting";
          const fallbackBody = `Hi ${name},

Thanks for reaching out to Ten Bell Painting.

We need a bit more information before providing a price range. A representative from Ten Bell Painting will be in contact with you shortly.

Thanks,
Ten Bell Painting
905-536-6799
tenbellpainting@gmail.com`;

          if (email) {
            await transporter.sendMail({
              from: process.env.GMAIL_USER,
              to: email,
              subject: fallbackSubject,
              text: fallbackBody,
            });
            console.log("FALLBACK EMAIL SENT TO:", email);
          }

          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: process.env.GMAIL_USER,
            subject: `New Lead: ${name}`,
            text: `New lead received

Name: ${name}
Email: ${email}
Phone: ${phone}
Address: ${address}
Project Type: ${projectType}
Square Footage: ${squareFootageRaw}
Rooms: ${roomsRaw}
Paint Items: ${paintItems.join(", ")}
Condition: ${condition}
Paint Change: ${paintChange}
Details: ${details}
Photos: ${photos || "none"}

Not enough information for price range.
`,
          });

          console.log("INTERNAL FALLBACK EMAIL SENT");
          return;
        }

        const { low, high, notes } = calculateEstimate({
          projectType,
          squareFootage,
          rooms,
          paintItems,
          condition,
          paintChange,
          details,
        });

        const { subject, body } = buildCustomerEmail({
          name,
          projectType,
          squareFootageRaw,
          low,
          high,
          paintItems,
        });

        if (email) {
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: email,
            subject,
            text: body,
          });
          console.log("CUSTOMER EMAIL SENT TO:", email);
        }

        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: process.env.GMAIL_USER,
          subject: `New Lead: ${name}`,
          text: `New lead received

Name: ${name}
Email: ${email}
Phone: ${phone}
Address: ${address}
Project Type: ${projectType}
Square Footage: ${squareFootageRaw}
Rooms: ${roomsRaw}
Paint Items: ${paintItems.join(", ")}
Condition: ${condition}
Paint Change: ${paintChange}
Details: ${details}
Photos: ${photos || "none"}

Suggested range: $${low} to $${high}

Pricing notes:
- ${notes.join("\n- ")}
`,
        });

        console.log("INTERNAL EMAIL SENT");
      } catch (err) {
        console.error("BACKGROUND ERROR:", err);
      }
    });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
