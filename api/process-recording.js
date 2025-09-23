import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v2 as cloudinary } from "cloudinary";
import OpenAI from "openai";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Cloudinary config ✅
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Conversation store (naive in-memory for demo)
let conversationHistory = [];

// Helper: sleep
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Download recording with retries ✅
async function downloadRecording(recordingUrl, retries = 5, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${recordingUrl}.wav`);
      if (!res.ok) throw new Error(`Twilio fetch failed: ${res.status}`);
      const buffer = await res.arrayBuffer();
      const filePath = path.join("/tmp", `recording_${Date.now()}.wav`);
      fs.writeFileSync(filePath, Buffer.from(buffer));
      return filePath;
    } catch (err) {
      console.warn(`Retry ${i + 1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) await sleep(delay);
    }
  }
  throw new Error("Failed to download Twilio recording after retries");
}

// Upload to Cloudinary ✅
async function uploadToCloudinary(filePath) {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: "video", // audio/wav counts as video
    });
    return result.secure_url;
  } catch (err) {
    console.error("Cloudinary upload failed:", err.message);
    throw new Error("Cloudinary upload failed");
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // cleanup tmp ✅
  }
}

app.post("/process-recording", async (req, res) => {
  try {
    const recordingUrl = req.body.RecordingUrl;
    if (!recordingUrl) {
      return res.status(400).send("Missing RecordingUrl");
    }

    // Download with retry
    const filePath = await downloadRecording(recordingUrl);

    // Upload to Cloudinary
    const cloudinaryUrl = await uploadToCloudinary(filePath);

    // Add user turn to conversation
    conversationHistory.push({
      role: "user",
      content: `User spoke, audio file at: ${cloudinaryUrl}`,
    });

    // GPT reply (conversation continues)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: conversationHistory,
    });

    const reply = completion.choices[0].message.content;

    // Add assistant turn to history
    conversationHistory.push({ role: "assistant", content: reply });

    console.log("✅ GPT Reply:", reply);

    // Send back GPT’s reply (Twilio <Say> or TTS will speak this)
    res.type("text/xml");
    res.send(`
      <Response>
        <Say voice="alice">${reply}</Say>
        <Record 
          action="/process-recording" 
          method="POST" 
          maxLength="30" 
          playBeep="true" />
      </Response>
    `);
  } catch (err) {
    console.error("❌ Error in process-recording:", err);
    res.status(500).send("Internal Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
