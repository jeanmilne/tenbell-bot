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
function parseRooms(rooms) {
  const r = String(rooms || "").trim().toLowerCase();
  if (r === "1") return 1;
  if (r === "2") return 2;
  if (r === "3") return 3;
  if (r === "4") return 4;
  if (r === "5+" || r === "5") return 5;

  const n = parseInt(r, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseFloorSqFt(sizeText) {
  const text = String(sizeText || "").toLowerCase();
  const match = text.match(/(\d{2,5})/);
  return match ? parseInt(match[1], 10) : 0;
}

function hasEnoughInfo(projectType, size, condition) {
  return !!projectType && !!size && !!condition;
}

function normalizePaintItems(paintItemsRaw) {
  let paintItems = [];

  if (Array.isArray(paintItemsRaw)) {
    paintItems = paintItemsRaw.map((item) => String(item).toLowerCase().trim());
  } else if (typeof paintItemsRaw === "string") {
    paintItems = paintItemsRaw
      .split(",")
      .map((item) => item.toLowerCase().trim())
      .filter(Boolean);
  }

  // Remove noise / weird values
  paintItems = paintItems.filter(
    (item) => !["other", "n/a", "na", "-"].includes(item)
  );

  return paintItems;
}

function getBaseRate(projectType, rooms) {
  const type = String(projectType || "").toLowerCase();

  if (type.includes("single room")) {
    return 0; // handled separately
  }

  if (type.includes("condo") || type.includes("apartment") || type.includes("rental")) {
    if (rooms <= 1) return 3.0;
    if (rooms === 2) return 3.25;
    if (rooms === 3) return 3.4;
    if (rooms === 4) return 3.6;
    return 3.9;
  }

  if (type.includes("house")) {
    if (rooms <= 2) return 3.6;
    if (rooms <= 4) return 3.75;
    return 4.1;
  }

  if (type.includes("commercial")) {
    return 3.5;
  }

  return 3.5;
}

function getConditionMultiplier(condition) {
  const c = String(condition || "").toLowerCase();

  if (c.includes("good")) return 1.0;
  if (c.includes("minor")) return 1.15;
  if (c.includes("medium")) return 1.25;
  if (c.includes("heavy")) return 1.38;

  return 1.1;
}

function roundTo50(n) {
  return Math.round(n / 50) * 50;
}

/**
 * Ten Bell pricing engine
 *
 * Philosophy:
 * - Fair Toronto / GTA mid-market pricing
 * - Protect margin for subcontracting
 * - Keep quotes wide enough to avoid underpricing
 */
function calculateEstimate({
  projectType,
  floorSqFt,
  rooms,
  paintItems,
  condition,
  details,
}) {
  const type = String(projectType || "").toLowerCase();
  const detailText = String(details || "").toLowerCase();

  const includesWalls = paintItems.length === 0 || paintItems.includes("walls");
  const includesDoors = paintItems.includes("doors");
  const includesTrim = paintItems.includes("trim");
  const includesCeilings =
    paintItems.includes("ceilings") || paintItems.includes("ceiling");

  const conditionMultiplier = getConditionMultiplier(condition);

  let base = 0;
  let notes = [];

  // Detect awkward areas / stairwells / high ceilings from details
  const hasAwkwardAreas =
    detailText.includes("stair") ||
    detailText.includes("stairwell") ||
    detailText.includes("awkward");
  const hasHighCeilings =
    detailText.includes("10'") ||
    detailText.includes("10 ft") ||
    detailText.includes("10ft") ||
    detailText.includes("12'") ||
    detailText.includes("12 ft") ||
    detailText.includes("12ft") ||
    detailText.includes("high ceiling");

  // Single room jobs are better handled separately
  if (type.includes("single room")) {
    if (includesWalls) {
      base += 400;
      notes.push("single-room walls baseline");
    }

    if (includesDoors) {
      base += 100;
      notes.push("single-room door add-on");
    }

    if (includesTrim) {
      base += 150;
      notes.push("single-room trim add-on");
    }

    if (includesCeilings) {
      base += 175;
      notes.push("single-room ceiling add-on");
    }

    base *= conditionMultiplier;
  } else {
    const baseRate = getBaseRate(projectType, rooms || 0);

    if (includesWalls && floorSqFt > 0) {
      base += floorSqFt * baseRate;
      notes.push(`walls at $${baseRate.toFixed(2)}/sqft floor area`);
    }

    // Ceilings: same ballpark as walls would overprice. Keep lower.
    if (includesCeilings && floorSqFt > 0) {
      const ceilingRate = 1.65;
      base += floorSqFt * ceilingRate;
      notes.push(`ceilings at $${ceilingRate.toFixed(2)}/sqft`);
    }

    // Doors: estimate from room count if user did not provide a count
    if (includesDoors) {
      const estimatedDoors = Math.max(1, rooms || 1);
      base += estimatedDoors * 100;
      notes.push(`${estimatedDoors} estimated doors at $100 each`);
    }

    // Trim: rough estimator from floor area if selected
    if (includesTrim) {
      const estimatedTrimFeet = floorSqFt > 0
        ? Math.max(40, Math.round(floorSqFt * 0.16))
        : Math.max(40, (rooms || 1) * 25);
      base += estimatedTrimFeet * 2;
      notes.push(`${estimatedTrimFeet} estimated trim ft at $2/ft`);
    }

    // Awkward areas
    if (hasAwkwardAreas && floorSqFt > 0) {
      base += floorSqFt * 0.3;
      notes.push("awkward area / stairwell add-on");
    }

    // High ceilings
    if (hasHighCeilings) {
      base *= 1.18;
      notes.push("high ceiling multiplier");
    }

    base *= conditionMultiplier;
  }

  // Minimum job
  if (base < 500) {
    base = 500;
    notes.push("minimum job price applied");
  }

  // Safer range
  let low = roundTo50(base * 0.92);
  let high = roundTo50(base * 1.18);

  // Guardrails for walls-only condo/apartment/rental so it does not overshoot
  const isWallsOnly =
    includesWalls && !includesDoors && !includesTrim && !includesCeilings;
  const isCondoLike =
    type.includes("condo") || type.includes("apartment") || type.includes("rental");

  if (isWallsOnly && isCondoLike && floorSqFt > 0 && String(condition).toLowerCase().includes("good")) {
    const marketLow = roundTo50(floorSqFt * 3.0);
    const marketHigh = roundTo50(floorSqFt * 4.0);

    low = Math.max(low, marketLow);
    high = Math.min(Math.max(high, marketLow + 200), marketHigh);

    if (high < low) {
      high = low + 300;
    }

    notes.push("walls-only condo market guardrail applied");
  }

  return {
    low,
    high,
    notes,
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
    const paintItemsRaw =
      payload.paintItems ||
      payload["What are you looking to paint"] ||
      payload["What are you looking to have painted?"] ||
      "";
    const size =
      payload.size ||
      payload.Size ||
      payload["Approximate size of project"] ||
      payload["Approximate size of the project"] ||
      "";
    const rooms = payload.rooms || payload["Number of rooms/spaces"] || "";
    const condition =
      payload.condition ||
      payload.Condition ||
      payload["Condition of walls"] ||
      "";
    const details =
      payload.details ||
      payload.Details ||
      payload["Additional details"] ||
      payload["Additional details (optional)"] ||
      payload["Anything else we should know?"] ||
      "";
    const photos = payload.photos || payload.Photos || payload["Upload photo"] || "";

    const paintItems = normalizePaintItems(paintItemsRaw);
    const floorSqFt = parseFloorSqFt(size);
    const roomCount = parseRooms(rooms);

    if (!hasEnoughInfo(projectType, size, condition)) {
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
Paint Items: ${paintItems.join(", ") || "walls"}
Size: ${size}
Rooms: ${rooms}
Condition: ${condition}
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

      return res.status(200).json({ success: true, fallback: true });
    }

    const { low, high, notes } = calculateEstimate({
      projectType,
      floorSqFt,
      rooms: roomCount,
      paintItems,
      condition,
      details,
    });

    const prompt = `
You are Ten Bell Painting's lead-response assistant.

Write a short professional email to a painting lead in Toronto.
The email must:
- thank them for reaching out
- give a non-binding price range of $${low} to $${high}
- mention that pricing depends on prep, repairs, layout complexity, and confirming the final scope
- invite them to reply if the range works for them
- keep the tone concise, confident, and professional

Lead details:
Name: ${name}
Project type: ${projectType}
Paint items: ${paintItems.join(", ") || "walls"}
Approximate size: ${size}
Rooms/spaces: ${rooms}
Condition: ${condition}
Address: ${address}
Additional details: ${details}
`;

    const response = await openai.responses.create({
      model: "gpt-5.4",
      input: prompt,
    });

    const customerMessage =
      response.output_text?.trim() ||
      `Hi ${name},

Thanks for reaching out to Ten Bell Painting. Based on the details you sent, your project likely falls in the $${low} to $${high} range.

Final pricing depends on prep, repairs, layout complexity, and confirming the final scope. If that range works for you, reply here and I’ll follow up with next steps.

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
Paint Items: ${paintItems.join(", ") || "walls"}
Size: ${size}
Rooms: ${rooms}
Condition: ${condition}
Details: ${details}
Photos: ${photos || "none"}

Suggested range: $${low} to $${high}

Pricing notes:
- ${notes.join("\n- ")}
`,
    });
    console.log("INTERNAL EMAIL SENT TO:", process.env.GMAIL_USER, internalResult.messageId);

    res.status(200).json({
      success: true,
      low,
      high,
      emailed: !!email,
    });
  } catch (error) {
    console.error("Lead bot error:", error);
    res.status(500).json({
      success: false,
      error: "Something went wrong",
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Lead bot running on port ${process.env.PORT || 3000}`);
});
