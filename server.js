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

function getBaseRange(projectType, sizeText) {
  const type = (projectType || "").toLowerCase();
  const size = (sizeText || "").toLowerCase();

  if (type.includes("single room")) return [800, 1400];
  if (type.includes("condo") && size.includes("1-bedroom")) return [1400, 2400];
  if (type.includes("condo") && size.includes("2-bedroom")) return [2400, 4200];
  if (type.includes("apartment")) return [1800, 3500];
  if (type.includes("house")) return [4500, 9000];
  if (type.includes("rental")) return [1200, 3000];
  if (type.includes("commercial")) return [1800, 5000];

  return [1200, 3500];
}

function adjustRange(low, high, condition) {
  const c = (condition || "").toLowerCase();

  if (c.includes("minor")) {
    low *= 1.1;
    high *= 1.15;
  } else if (c.includes("heavy")) {
    low *= 1.2;
    high *= 1.35;
  }

  low = Math.round(low / 50) * 50;
  high = Math.round(high / 50) * 50;

  if (low < 800) low = 800;
  if (high < 1200) high = 1200;

  return [low, high];
}

app.get("/", (req, res) => {
  res.send("Ten Bell lead bot is running");
});

app.post("/lead", async (req, res) => {
  try {
   const lead = req.body;
console.log("RAW BODY:", JSON.stringify(req.body, null, 2));

const payload = req.body?.data || req.body?.body || req.body;

const name = payload.name || payload.Name || "there";
const email = payload.email || payload.Email || "";
const phone = payload.phone || payload.Phone || "";
const projectType = payload.projectType || payload["Project Type"] || "";
const size = payload.size || payload.Size || payload["Approximate size of the project"] || "";
const condition = payload.condition || payload.Condition || payload["Condition of walls"] || "";
const details =
  payload.details ||
  payload.Details ||
  payload["Additional details (optional)"] ||
  payload["Anything else we should know?"] ||
  "";

// Photo is received but ignored for pricing
const photos = payload.photos || payload.Photos || "";
    const [baseLow, baseHigh] = getBaseRange(projectType, size);
   const [low, high] = adjustRange(baseLow, baseHigh, condition);

    const prompt = `
You are Ten Bell Painting's lead-response assistant.

Write a short professional email to a painting lead in Toronto.
The email must:
- thank them for reaching out
- give a non-binding price range of $${low} to $${high}
- say final pricing depends on prep, repairs, and confirming the scope
- invite them to reply if the range works for them
- keep the tone clean, professional, and concise

Lead details:
Name: ${name}
Project type: ${projectType}
Size: ${size}
Condition: ${condition}
Additional details: ${details}
Photos uploaded: ${photos ? "yes" : "no"}
`;

    const response = await openai.responses.create({
      model: "gpt-5.4",
      input: prompt,
    });

    const customerMessage =
      response.output_text?.trim() ||
      `Hi ${name},

Thanks for reaching out to Ten Bell Painting. Based on the details you sent, your project likely falls in the $${low} to $${high} range.

Final pricing depends on prep, repairs, and confirming the scope from photos or a quick walkthrough. If that range works for you, reply here and I’ll follow up with next steps.

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
Project Type: ${projectType}
Size: ${size}
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
