require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

console.log("ENV CHECK:", {
  hasOpenAIKey: !!process.env.OPENAI_API_KEY,
  hasGmailUser: !!process.env.GMAIL_USER,
  hasGmailAppPassword: !!process.env.GMAIL_APP_PASSWORD,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
  let items = [];

  if (Array.isArray(raw)) {
    items = raw.map((x) => String(x).toLowerCase().trim());
  } else if (typeof raw === "string") {
    items = raw
      .split(",")
      .map((x) => x.toLowerCase().trim())
      .filter(Boolean);
  }

  return items.filter(
    (item) => !["n/a", "na", "-", "none"].includes(item)
  );
}

function hasEnoughInfo({ paintItems, squareFootage }) {
  const hasPaintScope = Array.isArray(paintItems) && paintItems.length > 0;
  const hasSqFt = !!String(squareFootage || "").trim();
  return hasPaintScope && hasSqFt;
}

function inferDetailsSignals(detailsText, currentCondition) {
  const text = String(detailsText || "").toLowerCase();
  const existingCondition = String(currentCondition || "").toLowerCase();

  const highCeilings =
    text.includes("high ceiling") ||
    text.includes("high ceilings") ||
    text.includes("9 ft") ||
    text.includes("9ft") ||
    text.includes("10 ft") ||
    text.includes("10ft") ||
    text.includes("11 ft") ||
    text.includes("11ft") ||
    text.includes("12 ft") ||
    text.includes("12ft") ||
    text.includes("9'") ||
    text.includes("10'") ||
    text.includes("11'") ||
    text.includes("12'");

  const awkwardAreas =
    text.includes("stair") ||
    text.includes("stairwell") ||
    text.includes("awkward") ||
    text.includes("vaulted") ||
    text.includes("foyer") ||
    text.includes("entryway") ||
    text.includes("hard to reach");

  let inferredCondition = existingCondition || "good (just repaint)";

  if (!existingCondition || existingCondition.includes("good")) {
    const heavySignals =
      text.includes("replace drywall") ||
      text.includes("replace panel") ||
      text.includes("water damage") ||
      text.includes("major damage") ||
      text.includes("large hole") ||
      text.includes("big hole") ||
      text.includes("panel size");

    const minorSignals =
      text.includes("nail holes") ||
      text.includes("scratches") ||
      text.includes("scuffs") ||
      text.includes("minor repair") ||
      text.includes("touch up") ||
      text.includes("patch");

    if (heavySignals) inferredCondition = "heavy repairs needed";
    else if (minorSignals) inferredCondition = "minor repairs needed";
  }

  return {
    highCeilings,
    awkwardAreas,
    inferredCondition,
  };
}

function getConditionMultiplier(condition) {
  const c = String(condition || "").toLowerCase();

  if (c.includes("good")) return 1.0;
  if (c.includes("minor")) return 1.12;
  if (c.includes("heavy")) return 1.3;

  return 1.0;
}

function getPaintChangeMultiplier(paintChange) {
  const text = String(paintChange || "").toLowerCase();

  if (text.includes("major color change")) return 1.3;
  if (text.includes("color change")) return 1.15;
  if (text.includes("color match")) return 1.0;

  return 1.0;
}

function getBaseWallsRate(projectType, rooms) {
  const type = String(projectType || "").toLowerCase();

  if (type.includes("condo") || type.includes("apartment") || type.includes("rental")) {
    if (rooms <= 2) return 3.0;
    if (rooms <= 4) return 3.25;
    if (rooms <= 6) return 3.5;
    return 3.75;
  }

  if (type.includes("house")) {
    if (rooms <= 3) return 3.5;
    if (rooms <= 6) return 3.75;
    return 4.0;
  }

  if (type.includes("commercial")) {
    return 3.5;
  }

  return 3.4;
}

function getRoomComplexityMultiplier(rooms) {
  if (rooms <= 0) return 1.0;
  if (rooms <= 2) return 1.0;
  if (rooms <= 4) return 1.08;
  if (rooms <= 6) return 1.15;
  if (rooms <= 8) return 1.22;
  return 1.28;
}

function estimateDoorsFromRooms(rooms, projectType) {
  const type = String(projectType || "").toLowerCase();

  if (type.includes("condo") || type.includes("apartment") || type.includes("rental")) {
    return Math.max(1, Math.round((rooms || 1) * 0.8));
  }

  if (type.includes("house")) {
    return Math.max(2, Math.round((rooms || 1) * 1.1));
  }

  return Math.max(1, rooms || 1);
}

function estimateTrimFeet(squareFootage, rooms) {
  const sqFtBased = squareFootage > 0 ? Math.round(squareFootage * 0.14) : 0;
  const roomBased = rooms > 0 ? rooms * 28 : 0;
  return Math.max(40, sqFtBased, roomBased);
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

  const type = String(projectType || "").toLowerCase();
  const signals = inferDetailsSignals(details, condition);
  const finalCondition = signals.inferredCondition;

  const conditionMultiplier = getConditionMultiplier(finalCondition);
  const paintChangeMultiplier = getPaintChangeMultiplier(paintChange);
  const roomComplexityMultiplier = getRoomComplexityMultiplier(rooms);

  const includesWalls = paintItems.includes("walls");
  const includesDoors = paintItems.includes("doors");
  const includesTrim = paintItems.includes("trim");
  const includesCeiling =
    paintItems.includes("ceiling") || paintItems.includes("ceilings");
  const includesOther = paintItems.includes("other");

  if (includesWalls) {
    const wallsRate = getBaseWallsRate(projectType, rooms);
    base += squareFootage * wallsRate;
    notes.push(`walls at $${wallsRate.toFixed(2)}/sq ft`);
  }

  if (includesCeiling) {
    const ceilingRate = 1.6;
    base += squareFootage * ceilingRate;
    notes.push(`ceiling at $${ceilingRate.toFixed(2)}/sq ft`);
  }

  if (includesDoors) {
    const estimatedDoors = estimateDoorsFromRooms(rooms, projectType);
    base += estimatedDoors * 100;
    notes.push(`${estimatedDoors} estimated doors at $100 each`);
  }

  if (includesTrim) {
    const trimFeet = estimateTrimFeet(squareFootage, rooms);
    base += trimFeet * 2;
    notes.push(`${trimFeet} estimated trim ft at $2/ft`);
  }

  if (includesOther) {
    base += 150;
    notes.push("other scope allowance");
  }

  base *= roomComplexityMultiplier;
  notes.push(`room complexity multiplier x${roomComplexityMultiplier.toFixed(2)}`);

  if (signals.highCeilings) {
    base *= 1.1;
    notes.push("high ceiling multiplier");
  }

  if (signals.awkwardAreas) {
    base += squareFootage * 0.3;
    notes.push("awkward area / stairwell add-on");
  }

  base *= paintChangeMultiplier;
  notes.push(`paint change multiplier x${paintChangeMultiplier.toFixed(2)}`);

  base *= conditionMultiplier;
  notes.push(`condition multiplier x${conditionMultiplier.toFixed(2)}`);

  if (base < 500) {
    base = 500;
    notes.push("minimum job price applied");
  }

  let low = roundTo50(base * 0.9);
  let high = roundTo50(base * 1.18);

  // Guardrail for condo/apartment/rental walls-only jobs so they stay market reasonable
  const isCondoLike =
    type.includes("condo") || type.includes("apartment") || type.includes("rental");
  const isWallsOnly =
    includesWalls && !includesDoors && !includesTrim && !includesCeiling && !includesOther;

  if (
    isCondoLike &&
    isWallsOnly &&
    String(finalCondition).toLowerCase().includes("good")
  ) {
    const marketLow = roundTo50(squareFootage * 2.9);
    const marketHigh = roundTo50(squareFootage * 3.8);

    low = Math.max(low, marketLow);
    high = Math.min(Math.max(high, marketLow + 200), marketHigh);

    if (high < low) high = low + 300;

    notes.push("walls-only condo market guardrail applied");
  }

  return {
    low,
    high,
    notes,
    finalCondition,
    signals,
  };
}

// -------------------------
// Routes
// -------------------------
app.get("/", (req, res) => {
  res.send("Ten Bell lead bot is running");
});

app.post("/lead", async (req, res) => {
  try {
    console.log("RAW BODY:", JSON.stringify(req.body, null, 2));

    const payload = req.body?.data || req.body?.body || req.body;

    const name = payload.name || payload.Name || "there";
    const phone = payload.phone || payload.Phone || "";
    const email = payload.email || payload.Email || "";
    const address = payload.address || payload["Project Address"] || "";
    const projectType = payload.projectType || payload["Project Type"] || "";
    const squareFootageRaw =
      payload.squareFootage ||
      payload["Square footage of space"] ||
      "";
    const paintItemsRaw =
      payload.paintItems ||
      payload["What are you looking to paint"] ||
      "";
    const roomsRaw =
      payload.rooms ||
      payload["Number of rooms/spaces"] ||
      "";
    const condition =
      payload.condition ||
      payload["Condition of walls"] ||
      "";
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

    const squareFootage = parseSquareFootage(squareFootageRaw);
    const rooms = parseRooms(roomsRaw);
    let paintItems = normalizePaintItems(paintItemsRaw);

    if (!paintItems.length) {
      paintItems = ["walls"];
    }

    // Respond to Wix immediately
    res.sendStatus(200);

    // Process in background
    setImmediate(async () => {
      try {
        if (!hasEnoughInfo({ paintItems, squareFootage: squareFootageRaw })) {
          const fallbackMessage = `Hi ${name},

Thanks for reaching out to Ten Bell Painting.

We need a bit more information before providing a price range. A representative from Ten Bell Painting will be in contact with you shortly.

Thanks,
Ten Bell Painting
905-536-6799
tenbellpainting@gmail.com`;

          if (email) {
            const fallbackCustomerResult = await transporter.sendMail({
              from: process.env.GMAIL_USER,
              to: email,
              subject: "Thanks for reaching out to Ten Bell Painting",
              text: fallbackMessage,
            });
            console.log("FALLBACK EMAIL SENT TO:", email, fallbackCustomerResult.messageId);
          }

          const fallbackInternalResult = await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: process.env.GMAIL_USER,
            subject: `New Lead: ${name}`,
            text: `New lead received

Name: ${name}
Phone: ${phone}
Email: ${email}
Address: ${address}
Project Type: ${projectType}
Square Footage: ${squareFootageRaw}
Paint Items: ${paintItems.join(", ") || "walls"}
Rooms: ${roomsRaw}
Condition: ${condition || "not provided"}
Paint Change: ${paintChange || "not provided"}
Details: ${details}
Photos: ${photos || "none"}

Not enough information for price range.
`,
          });
          console.log(
            "FALLBACK INTERNAL EMAIL SENT TO:",
            process.env.GMAIL_USER,
            fallbackInternalResult.messageId
          );
          return;
        }

        const { low, high, notes, finalCondition, signals } = calculateEstimate({
          projectType,
          squareFootage,
          rooms,
          paintItems,
          condition: condition || "good (just repaint)",
          paintChange,
          details,
        });

        const response = await openai.responses.create({
          model: "gpt-5.4",
          input: `
You are Ten Bell Painting's lead-response assistant.

Write a short professional email to a painting lead in Toronto.
The email must:
- thank them for reaching out
- give a non-binding price range of $${low} to $${high}
- mention that pricing depends on prep, repairs, layout complexity, number of coats, and confirming the final scope
- invite them to reply if the range works for them
- keep the tone concise, confident, and professional

Lead details:
Name: ${name}
Project type: ${projectType}
Square footage: ${squareFootageRaw}
Paint items: ${paintItems.join(", ") || "walls"}
Rooms/spaces: ${roomsRaw}
Condition used for estimate: ${finalCondition}
Paint change: ${paintChange}
Address: ${address}
Additional details: ${details}
Detected high ceilings: ${signals.highCeilings ? "yes" : "no"}
Detected awkward areas: ${signals.awkwardAreas ? "yes" : "no"}
`,
        });

        const customerMessage =
          response.output_text?.trim() ||
          `Hi ${name},

Thanks for reaching out to Ten Bell Painting. Based on the details you sent, your project likely falls in the $${low} to $${high} range.

Final pricing depends on prep, repairs, layout complexity, number of coats, and confirming the final scope. If that range works for you, reply here and I’ll follow up with next steps.

Thanks,
Ten Bell Painting
905-536-6799
tenbellpainting@gmail.com`;

        if (email) {
          const customerResult = await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: email,
            subject: "Your Ten Bell Painting price range",
            text: customerMessage,
          });
          console.log("CUSTOMER EMAIL SENT TO:", email, customerResult.messageId);
        }

        const internalResult = await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: process.env.GMAIL_USER,
          subject: `New Lead: ${name}`,
          text: `New lead received

Name: ${name}
Phone: ${phone}
Email: ${email}
Address: ${address}
Project Type: ${projectType}
Square Footage: ${squareFootageRaw}
Paint Items: ${paintItems.join(", ") || "walls"}
Rooms: ${roomsRaw}
Condition Used: ${finalCondition}
Paint Change: ${paintChange || "not provided"}
Details: ${details}
Photos: ${photos || "none"}

Detected high ceilings: ${signals.highCeilings ? "yes" : "no"}
Detected awkward areas: ${signals.awkwardAreas ? "yes" : "no"}

Suggested range: $${low} to $${high}

Pricing notes:
- ${notes.join("\n- ")}
`,
        });
        console.log("INTERNAL EMAIL SENT TO:", process.env.GMAIL_USER, internalResult.messageId);
      } catch (backgroundError) {
        console.error("BACKGROUND ERROR:", backgroundError);
      }
    });
  } catch (error) {
    console.error("Lead bot error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Something went wrong",
      });
    }
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Lead bot running on port ${process.env.PORT || 3000}`);
});
