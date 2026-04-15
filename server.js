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
    items = raw
      .split(",")
      .map((x) => x.toLowerCase().trim())
      .filter(Boolean);
  }

  return items.length ? items : ["walls"];
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
  const c = String(condition || "").toLowerCase();
  if (c.includes("minor")) return 1.12;
  if (c.includes("heavy")) return 1.3;
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

function calculateEstimate({
  projectType,
  squareFootage,
  rooms,
  paintItems,
  condition,
  paintChange,
}) {
  let base = 0;

  const includesWalls = paintItems.includes("walls");
  const includesTrim = paintItems.includes("trim");
  const includesDoors = paintItems.includes("doors");
  const includesCeiling =
    paintItems.includes("ceiling") || paintItems.includes("ceilings");

  if (includesWalls) {
    base += squareFootage * getWallsRate(projectType, rooms);
  }

  if (includesTrim) {
    const trimFeet = Math.max(40, Math.round(squareFootage * 0.12));
    base += trimFeet * 2;
  }

  if (includesDoors) {
    const estimatedDoors = Math.max(1, Math.min(rooms || 1, 6));
    base += estimatedDoors * 100;
  }

  if (includesCeiling) {
    base += squareFootage * 1.5;
  }

  base *= getRoomMultiplier(rooms);
  base *= getPaintMultiplier(paintChange);
  base *= getConditionMultiplier(condition);

  if (base < 500) base = 500;

  const low = Math.round((base * 0.9) / 50) * 50;
  const high = Math.round((base * 1.15) / 50) * 50;

  return { low, high };
}

app.get("/", (req, res) => {
  res.send("Ten Bell lead bot is running");
});

app.post("/lead", (req, res) => {
  try {
    console.log("RAW BODY:", JSON.stringify(req.body, null, 2));

    const payload = req.body?.data || req.body;

    const name = payload.name || payload.Name || "there";
    const email = payload.email || payload.Email || "";
    const phone = payload.phone || payload.Phone || "";
    const address = payload.address || payload["Project Address"] || "";
    const projectType = payload.projectType || payload["Project Type"] || "";
    const squareFootageRaw =
      payload.squareFootage ||
      payload["Square footage of space"] ||
      "";
    const roomsRaw =
      payload.rooms ||
      payload["Number of rooms/spaces"] ||
      "";
    const condition =
      payload.condition ||
      payload["Condition of walls"] ||
      "good (just repaint)";
    const paintChange =
      payload.paintChange ||
      payload["Will this be the same color or a color change?"] ||
      "";
    const details =
      payload.details ||
      payload["Additional details"] ||
      "";
    const photos =
      payload.photos ||
      payload["Upload photos"] ||
      "";

    const paintItems = normalizePaintItems(
      payload.paintItems ||
      payload["What are you looking to paint"]
    );

    const squareFootage = parseSquareFootage(squareFootageRaw);
    const rooms = parseRooms(roomsRaw);

    res.sendStatus(200);

    setImmediate(async () => {
      try {
        if (!squareFootage || !paintItems.length) {
          const fallbackMessage = `Hi ${name},

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
              subject: "Thanks for reaching out to Ten Bell Painting",
              text: fallbackMessage,
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

        const { low, high } = calculateEstimate({
          projectType,
          squareFootage,
          rooms,
          paintItems,
          condition,
          paintChange,
        });

        const customerMessage = `Hi ${name},

Thanks for reaching out to Ten Bell Painting. Based on the details you sent, your project likely falls in the $${low} to $${high} range.

Final pricing depends on prep, repairs, layout complexity, and confirming the scope.

If that range works for you, reply here and I’ll follow up with next steps.

Thanks,
Ten Bell Painting
905-536-6799
tenbellpainting@gmail.com`;

        if (email) {
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: email,
            subject: "Your Ten Bell Painting price range",
            text: customerMessage,
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

Suggested range: $${low} - $${high}
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
