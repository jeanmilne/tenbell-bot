require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const OpenAI = require("openai");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

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

  return paintItems;
}

function calculateBase(projectType, floorSqFt, rooms, paintItems, condition) {
  let base = 0;

  const type = String(projectType || "").toLowerCase();
  const cond = String(condition || "").toLowerCase();

  const includesWalls = paintItems.length === 0 || paintItems.includes("walls");
  const includesDoors = paintItems.includes("doors");
  const includesTrim = paintItems.includes("trim");
  const includesCeilings = paintItems.includes("ceilings") || paintItems.includes("ceiling");

  let wallFactor = 2.8;

  if (type.includes("house")) wallFactor = 3.1;
  if (type.includes("condo")) wallFactor = 2.7;
  if (type.includes("apartment")) wallFactor = 2.8;
  if (type.includes("rental")) wallFactor = 2.9;
  if (type.includes("single room")) wallFactor = 2.6;
  if (type.includes("commercial")) wallFactor = 2.9;

  let roomMultiplier = 1.0;
  if (rooms === 1) roomMultiplier = 0.9;
  if (rooms === 2) roomMultiplier = 1.0;
  if (rooms === 3) roomMultiplier = 1.08;
  if (rooms === 4) roomMultiplier = 1.15;
  if (rooms >= 5) roomMultiplier = 1.22;

  // Special handling for single-room jobs with little detail
  if (type.includes("single room") && floorSqFt === 0) {
    base = includesWalls ? 400 : 0;
    if (includesDoors) base += 100;
    if (includesTrim) base += 150;
    if (includesCeilings) base += 150;
  } else {
    if (includesWalls && floorSqFt > 0) {
      base += floorSqFt * wallFactor * 2.1 * roomMultiplier;
    }

    if (includesCeilings && floorSqFt > 0) {
      base += floorSqFt * 2.1;
    }

    if (includesDoors) {
      const estimatedDoors = Math.max(1, rooms || 1);
      base += estimatedDoors * 100;
    }

    if (includesTrim && floorSqFt > 0) {
      const estimatedTrimFeet = Math.max(40, floorSqFt * 0.18);
      base += estimatedTrimFeet * 2;
    } else if (includesTrim) {
      base += 150;
    }
  }

  if (cond.includes("minor")) {
    base *= 1.15;
  } else if (cond.includes("heavy")) {
    base *= 1.35;
  }

  if (base < 500) base = 500;

  const low = Math.round((base * 0.9) / 50) * 50;
  const high = Math.round((base * 1.25) / 50) * 50;

  return { low, high, base };
}

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
        await transporter.sendMail({
          from: process.env.GMAIL_USER,
          to: email,
          subject: "Thanks for reaching out to Ten Bell Painting",
          text: fallbackMessage,
        });
      }

      await transporter.sendMail({
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

      return res.status(200).json({ success: true, fallback: true });
    }

    const { low, high } = calculateBase(
      projectType,
      floorSqFt,
      roomCount,
      paintItems,
      condition
    );

    const prompt = `
You are Ten Bell Painting's lead-response assistant.

Write a short professional email to a painting lead in Toronto.
The email must:
- thank them for reaching out
- give a non-binding price range of $${low} to $${high}
- mention that pricing depends on prep, repairs, and confirming the final scope
- invite them to reply if the range works for them
- keep the tone concise and professional

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

Final pricing depends on prep, repairs, and confirming the final scope. If that range works for you, reply here and I’ll follow up with next steps.

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
    }

    await transporter.sendMail({
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
`,
    });

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
