// pages/api/process-recording.js
import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import fs from "fs";
import path from "path";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const eleven = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

const VOICE_ID = "FOtIACPya7JrUALJeYnn";

// Helper: retry fetching Twilio recording up to 3 times
async function fetchTwilioRecording(recordingUrl) {
  const authHeader =
    "Basic " +
    Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

  let lastErr;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${recordingUrl}.mp3`, {
      headers: { Authorization: authHeader },
    });

    if (res.ok) {
      console.log(`✅ Successfully fetched recording on attempt ${i + 1}`);
      return Buffer.from(await res.arrayBuffer());
    }

    lastErr = new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    console.warn(
      `⚠️ Recording not ready (attempt ${i + 1}), retrying in 2s...`
    );
    await new Promise((r) => setTimeout(r, 2000));
  }

  throw lastErr;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    console.log("📩 Incoming Twilio Recording Request body:", req.body);

    const recordingUrl = req.body.RecordingUrl;
    if (!recordingUrl) {
      throw new Error("No recording URL received from Twilio.");
    }

    console.log("🎧 Fetching recording from Twilio:", recordingUrl);
    const audioBuffer = await fetchTwilioRecording(recordingUrl);
    console.log("🎧 Recording fetched, size:", audioBuffer.length);

    // Transcribe with Whisper
    console.log("📝 Sending to Whisper...");
    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], "recording.mp3", { type: "audio/mpeg" }),
      model: "whisper-1",
    });
    console.log("📝 Transcription result:", transcription);

    // GPT response
    console.log("🤖 Sending transcription to GPT:", transcription.text);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful AI voice assistant." },
        { role: "user", content: transcription.text },
      ],
    });

    const gptResponse = completion.choices[0].message.content;
    console.log("🤖 GPT Response:", gptResponse);

    // ElevenLabs TTS
    console.log("🎤 Sending GPT response to ElevenLabs...");
    const audio = await eleven.textToSpeech.convert(VOICE_ID, {
      text: gptResponse,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
      },
    });
    console.log("🎤 ElevenLabs response received");

    // Save audio to /tmp (Vercel ephemeral storage)
    const fileName = `reply_${Date.now()}.mp3`;
    const filePath = path.join("/tmp", fileName);
    console.log("💾 Writing file to:", filePath);

    try {
      const buffer = Buffer.from(await audio.arrayBuffer());
      await fs.promises.writeFile(filePath, buffer);
      console.log("💾 File successfully written, size:", buffer.length);
    } catch (fsErr) {
      console.error("❌ Error writing file to /tmp:", fsErr);
      throw fsErr;
    }

    // Build URL for Twilio to fetch audio
    const host =
      req.headers["x-forwarded-host"] ||
      req.headers.host ||
      "finlumina-vox.vercel.app";
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const actionUrl = `${proto}://${host}/api/process-recording`;
    const fileUrl = `${proto}://${host}/api/tmp/${fileName}`;

    console.log("🔗 File URL for Twilio:", fileUrl);

    // TwiML: Play ElevenLabs audio, then record again
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${fileUrl}</Play>
  <Record action="${actionUrl}" method="POST" maxLength="120" playBeep="true" finishOnKey="*"/>
  <Say voice="alice">No input received. Goodbye.</Say>
</Response>`;

    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twiml);
  } catch (err) {
    console.error("❌ Error in process-recording:", err);

    // Echo more detail back in Twilio response for now
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(`
      <Response>
        <Say voice="alice">Sorry, there was an error: ${err.message}</Say>
      </Response>
    `);
  }
}
