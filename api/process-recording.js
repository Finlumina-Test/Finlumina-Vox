// pages/api/process-recording.js
import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { v2 as cloudinary } from "cloudinary";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const eleven = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// Configure Cloudinary SDK (required)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Your custom Urdu/English voice
const VOICE_ID = "FOtIACPya7JrUALJeYnn";

// In-memory conversation store keyed by CallSid (warm-instance only)
if (!global.__CALL_CONV__) global.__CALL_CONV__ = new Map();
const callConversations = global.__CALL_CONV__;

// Helper: sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch Twilio recording with retries.
 * Tries .mp3 then .wav; configurable attempts/delay.
 * Returns a Buffer.
 */
async function fetchTwilioRecording(recordingUrl, attempts = 8, delayMs = 1500) {
  const authHeader =
    "Basic " +
    Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    try {
      // try mp3 first
      let res = await fetch(`${recordingUrl}.mp3`, {
        headers: { Authorization: authHeader },
      });

      // fall back to wav if mp3 not found
      if (!res.ok) {
        res = await fetch(`${recordingUrl}.wav`, {
          headers: { Authorization: authHeader },
        });
      }

      // final fallback: try without extension
      if (!res.ok) {
        res = await fetch(recordingUrl, {
          headers: { Authorization: authHeader },
        });
      }

      if (res.ok) {
        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      lastErr = new Error(`Twilio fetch failed: ${res.status} ${res.statusText}`);
      console.warn(
        `⚠️ Recording not ready (attempt ${i + 1}/${attempts}): ${res.status} ${res.statusText}`
      );
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️ Fetch attempt ${i + 1}/${attempts} error:`, err.message);
    }

    // wait before next attempt (but don't wait after final attempt)
    if (i < attempts - 1) await sleep(delayMs);
  }

  throw lastErr || new Error("Failed to fetch Twilio recording");
}

/**
 * Upload a Buffer to Cloudinary via upload_stream (SDK).
 * Returns secure_url.
 */
function uploadBufferToCloudinary(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: "auto",
        public_id: publicId,
        overwrite: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );

    uploadStream.end(buffer);
  });
}

export default async function handler(req, res) {
  try {
    // accept GET too for simple health checks if you want (but Twilio POSTs)
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    console.log("📩 Incoming Twilio Recording Request:", req.body);

    const recordingUrl = req.body.RecordingUrl;
    const callSid = req.body.CallSid || `no-callsid-${Date.now()}`;

    if (!recordingUrl) {
      throw new Error("No recording URL received from Twilio.");
    }

    // 1) Fetch audio from Twilio with retries (retries because Twilio may need time)
    const audioBuffer = await fetchTwilioRecording(recordingUrl, /*attempts*/ 8, /*delayMs*/ 1500);

    // write transient file for Whisper (Whisper accepts a file/stream)
    const tmpFile = path.join("/tmp", `twilio_rec_${Date.now()}.mp3`);
    fs.writeFileSync(tmpFile, audioBuffer);

    // 2) Transcribe with Whisper (keep same API flow you used before)
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: "whisper-1",
    });

    // cleanup temp file
    try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }

    console.log("📝 Transcription:", transcription.text);

    // 3) Maintain per-call conversation context
    let convo = callConversations.get(callSid);
    if (!convo) {
      convo = [
        { role: "system", content: "You are a helpful AI voice assistant." }
      ];
    }

    // push this new user message (use the real transcript)
    convo.push({ role: "user", content: transcription.text });

    // 4) GPT response (conversation continues)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: convo,
    });

    const gptResponse = completion.choices[0].message.content;
    console.log("🤖 GPT Response:", gptResponse);

    // save assistant reply into convo for future turns
    convo.push({ role: "assistant", content: gptResponse });
    callConversations.set(callSid, convo);

    // 5) ElevenLabs TTS → Buffer
    const ttsStream = await eleven.textToSpeech.convert(VOICE_ID, {
      text: gptResponse,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    });

    // collect stream chunks into buffer
    const chunks = [];
    for await (const chunk of ttsStream) {
      // chunk may be Buffer or UInt8Array
      chunks.push(Buffer.from(chunk));
    }
    const ttsBuffer = Buffer.concat(chunks);

    // 6) Upload TTS buffer to Cloudinary
    const publicId = `finlumina-vox/reply_${callSid}_${Date.now()}`;
    const fileUrl = await uploadBufferToCloudinary(ttsBuffer, publicId);
    console.log("☁️ Uploaded reply to Cloudinary:", fileUrl);

    // 7) Return TwiML that plays the reply and then records again (loop until hangup)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${fileUrl}</Play>
  <Record action="/api/process-recording" method="POST" maxLength="60" playBeep="true" trim="trim-silence" />
</Response>`;

    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twiml);
  } catch (err) {
    console.error("❌ Error in process-recording:", err);
    // Return TwiML which informs caller and ends the call (or you could attempt a Record again)
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(`
      <Response>
        <Say voice="alice">Sorry, there was an error processing your request.</Say>
        <Hangup/>
      </Response>
    `);
  }
}
