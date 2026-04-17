require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Allow requests from anywhere (needed for PWA on phone calling the API)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

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

app.get("/review", (_req, res) => {
  res.sendFile(path.join(__dirname, "review.html"));
});

// ─── Jobber OAuth Integration ─────────────────────────────────────────────────
const JOBBER_CLIENT_ID     = process.env.JOBBER_CLIENT_ID;
const JOBBER_CLIENT_SECRET = process.env.JOBBER_CLIENT_SECRET;
const JOBBER_CALLBACK_URL  = "https://tenbell-bot.onrender.com/jobber/callback";
const JOBBER_API_URL       = "https://api.getjobber.com/api/graphql";

// In-memory token store (persists as long as server is running)
let jobberTokens = {
  access_token:  process.env.JOBBER_ACCESS_TOKEN  || null,
  refresh_token: process.env.JOBBER_REFRESH_TOKEN || null,
  expires_at:    0,
};

// Step 1 — redirect to Jobber to authorize
app.get("/jobber/connect", (_req, res) => {
  const url = `https://api.getjobber.com/api/oauth/authorize?response_type=code&client_id=${JOBBER_CLIENT_ID}&redirect_uri=${encodeURIComponent(JOBBER_CALLBACK_URL)}`;
  res.redirect(url);
});

// Step 2 — Jobber redirects back here with a code
app.get("/jobber/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("No code received from Jobber.");

  try {
    const resp = await fetch("https://api.getjobber.com/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     JOBBER_CLIENT_ID,
        client_secret: JOBBER_CLIENT_SECRET,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  JOBBER_CALLBACK_URL,
      }),
    });

    const data = await resp.json();
    if (!data.access_token) {
      console.error("Jobber token error:", data);
      return res.send("Failed to get token from Jobber. Check server logs.");
    }

    jobberTokens.access_token  = data.access_token;
    jobberTokens.refresh_token = data.refresh_token;
    jobberTokens.expires_at    = Date.now() + (data.expires_in * 1000);

    console.log("Jobber connected successfully.");
    console.log("=== SAVE THESE TO RENDER ENV VARS ===");
    console.log("JOBBER_ACCESS_TOKEN=" + data.access_token);
    console.log("JOBBER_REFRESH_TOKEN=" + data.refresh_token);
    console.log("=====================================");

    res.send(`
      <html><body style="font-family:sans-serif;padding:2rem;max-width:480px;margin:0 auto">
        <h2 style="color:#73C7AA">Jobber connected!</h2>
        <p>Ten Bell Painting is now connected to Jobber.</p>
        <p style="color:#666;font-size:13px">Important: Go to Render → Environment and add these two variables to make the connection permanent:</p>
        <div style="background:#f4f4f4;padding:12px;border-radius:8px;font-family:monospace;font-size:12px;word-break:break-all;margin-top:12px">
          <p><strong>JOBBER_ACCESS_TOKEN</strong><br>${data.access_token}</p>
          <p style="margin-top:8px"><strong>JOBBER_REFRESH_TOKEN</strong><br>${data.refresh_token}</p>
        </div>
        <p style="color:#666;font-size:12px;margin-top:12px">Copy both values into Render → tenbell-bot → Environment → Add Variable, then redeploy. You only need to do this once.</p>
      </body></html>
    `);
  } catch (err) {
    console.error("Jobber callback error:", err.message);
    res.send("Error connecting to Jobber: " + err.message);
  }
});

// Refresh access token when expired
async function getValidToken() {
  if (jobberTokens.access_token && Date.now() < jobberTokens.expires_at - 60000) {
    return jobberTokens.access_token;
  }
  if (!jobberTokens.refresh_token) return null;

  const resp = await fetch("https://api.getjobber.com/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     JOBBER_CLIENT_ID,
      client_secret: JOBBER_CLIENT_SECRET,
      grant_type:    "refresh_token",
      refresh_token: jobberTokens.refresh_token,
    }),
  });

  const data = await resp.json();
  if (data.access_token) {
    jobberTokens.access_token  = data.access_token;
    jobberTokens.refresh_token = data.refresh_token || jobberTokens.refresh_token;
    jobberTokens.expires_at    = Date.now() + (data.expires_in * 1000);
    return jobberTokens.access_token;
  }
  return null;
}

// GraphQL helper
async function jobberQuery(query, variables = {}) {
  const token = await getValidToken();
  if (!token) throw new Error("Jobber not connected. Visit /jobber/connect first.");

  const resp = await fetch(JOBBER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
      "X-JOBBER-GRAPHQL-VERSION": "2026-04-13",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Jobber non-JSON response:", text.substring(0, 200));
    throw new Error("Jobber returned an unexpected response. Token may be expired — visit /jobber/connect to reconnect.");
  }
}

// Step 3 — Create quote in Jobber from on-site app
app.post("/jobber/quote", async (req, res) => {
  try {
    const q = req.body;
    console.log("Jobber quote request:", JSON.stringify(q, null, 2));

    // 1. Create client
    const nameParts = (q.client || "Client").trim().split(" ");
    const firstName = nameParts[0] || "Client";
    const lastName  = nameParts.slice(1).join(" ") || ".";

    const clientInput = { firstName, lastName };
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (q.email && emailRegex.test(q.email)) {
      clientInput.emails = [{ description: "MAIN", primary: true, address: q.email }];
    }
    if (q.phone) clientInput.phones = [{ number: String(q.phone), primary: true, description: "MAIN" }];

    const clientMutation = `
      mutation CreateClient($input: ClientCreateInput!) {
        clientCreate(input: $input) {
          client { id }
          userErrors { message path }
        }
      }
    `;

    const clientResult = await jobberQuery(clientMutation, { input: clientInput });
    console.log("Client result:", JSON.stringify(clientResult, null, 2));

    const clientErrors = clientResult?.data?.clientCreate?.userErrors || [];
    if (clientErrors.length) console.warn("Client warnings:", clientErrors);

    const clientId = clientResult?.data?.clientCreate?.client?.id;
    if (!clientId) throw new Error("Failed to create client: " + JSON.stringify(clientErrors));

    // 2. Create property for client
    const propertyMutation = `
      mutation CreateProperty($clientId: EncodedId!, $street1: String!) {
        propertyCreate(clientId: $clientId, input: {
          properties: [{
            address: {
              street1: $street1
              city: "Toronto"
              province: "ON"
              country: "CA"
            }
          }]
        }) {
          properties { id }
          userErrors { message path }
        }
      }
    `;
    const propertyResult = await jobberQuery(propertyMutation, {
      clientId,
      street1: q.addr || "Address not provided",
    });
    console.log("Property result:", JSON.stringify(propertyResult, null, 2));
    const propertyId = propertyResult?.data?.propertyCreate?.properties?.[0]?.id;
    if (!propertyId) throw new Error("Failed to create property: " + JSON.stringify(propertyResult?.data?.propertyCreate?.userErrors));

    // 3. Build line items
    const lineItems = [];
    lineItems.push({
      name: `Interior painting — ${q.projType || "condo"}`,
      description: `Scope: ${q.scope || "walls"} | ${q.coat === "major" ? "3 coats/major change" : q.coat === "change" ? "2 coats/color change" : "1 coat/same color"} | Condition: ${q.cond} | ${q.sqft} sqft | ${q.ceilH}ft ceilings`,
      quantity: 1,
      unitPrice: parseFloat(q.price) || 0,
      saveToProductsAndServices: false,
    });
    if (q.paintSummary) {
      lineItems.push({ name: "Paint selection", description: String(q.paintSummary), quantity: 1, unitPrice: 0, saveToProductsAndServices: false });
    }
    if (q.mats && q.mats !== "none") {
      lineItems.push({ name: "Materials & prep supplies", description: String(q.mats), quantity: 1, unitPrice: 0, saveToProductsAndServices: false });
    }

    // 4. Create quote with propertyId and lineItems (both required)
    const quoteMutation = `
      mutation CreateQuote(
        $clientId: EncodedId!
        $propertyId: EncodedId!
        $title: String!
        $message: String!
        $lineItems: [QuoteCreateLineItemAttributes!]!
      ) {
        quoteCreate(attributes: {
          clientId: $clientId
          propertyId: $propertyId
          title: $title
          message: $message
          lineItems: $lineItems
        }) {
          quote { id quoteNumber jobberWebUri }
          userErrors { message path }
        }
      }
    `;

    const quoteResult = await jobberQuery(quoteMutation, {
      clientId,
      propertyId,
      title: `Painting Quote — ${q.addr || q.projType || "Ten Bell"}`,
      message: `Ten Bell Painting — on-site quote\n\nClient: ${q.client}\nAddress: ${q.addr || "—"}\nPhone: ${q.phone || "—"}\nEmail: ${q.email || "—"}\n\nScope: ${q.scope}\nSqft: ${q.sqft} | Ceiling: ${q.ceilH}ft\nCoat: ${q.coat} | Condition: ${q.cond}\nOccupied: ${q.occ === "yes" ? "Yes" : "No"}\n\nPaint:\n${q.paintSummary || "—"}\n\nMaterials: ${q.mats || "none"}\n\nNotes: ${q.notes || "none"}`,
      lineItems,
    });
    console.log("Quote result:", JSON.stringify(quoteResult, null, 2));

    const quoteErrors = quoteResult?.data?.quoteCreate?.userErrors || [];
    if (quoteErrors.length) throw new Error(quoteErrors.map(e => e.message).join(", "));

    const quote = quoteResult?.data?.quoteCreate?.quote;
    if (!quote) throw new Error("Quote not returned from Jobber");

    res.json({
      success: true,
      quoteNumber: quote.quoteNumber,
      jobberUrl: quote.jobberWebUri,
    });

  } catch (err) {
    console.error("Jobber quote error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check if Jobber is connected
app.get("/jobber/status", (_req, res) => {
  res.json({ connected: !!jobberTokens.access_token });
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
