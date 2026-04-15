require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json({ limit: "10mb" }));

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// -------------------------
// SIMPLE ESTIMATE
// -------------------------
function estimate(squareFootage) {
  const sqft = parseInt(String(squareFootage).match(/\d+/)?.[0] || 0);

  if (!sqft) return { low: 0, high: 0 };

  const base = sqft * 3;

  return {
    low: Math.round(base * 0.9),
    high: Math.round(base * 1.1),
  };
}

// -------------------------
// ROUTE
// -------------------------
app.post("/lead", async (req, res) => {
  console.log("========== NEW REQUEST ==========");
  console.log("FULL BODY:", JSON.stringify(req.body, null, 2));

  const data = req.body.data || req.body;

  // 🔥 FORCE EMAIL EXTRACTION
  const email =
    data.email ||
    data.Email ||
    "";

  console.log("EXTRACTED EMAIL:", email);

  const name = data.name || data.Name || "there";
  const sqft = data.squareFootage || data["Square footage of space"] || "";

  // respond instantly to Wix
  res.sendStatus(200);

  try {
    if (!email) {
      console.log("NO EMAIL FOUND — STOPPING");
      return;
    }

    const { low, high } = estimate(sqft);

    const message = `Subject: Condo Painting Estimate

Hi ${name},

Thanks for reaching out to Ten Bell Painting.

Based on the information provided, a rough ballpark would be in the range of $${low} to $${high}.

Final pricing depends on prep, repairs, and confirming the scope.

Thanks,
Ten Bell Painting
905-536-6799`;

    // CUSTOMER EMAIL
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: email,
      subject: "Painting Estimate",
      text: message,
    });

    console.log("CUSTOMER EMAIL SENT TO:", email);

    // INTERNAL EMAIL
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: "New Lead",
      text: JSON.stringify(data, null, 2),
    });

    console.log("INTERNAL EMAIL SENT");

  } catch (err) {
    console.error("ERROR:", err);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER RUNNING");
});
