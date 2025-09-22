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

// Your custom Urdu/English voice
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

    console.log("📩 Incoming Twilio Recording Request:", req.body);

    const recordingUrl = req.body.RecordingUrl;
    if (!recordingUrl) {
      throw new Error("No recording URL received from Twilio.");
    }

    // Fetch audio with retry logic
    const audioBuffer = await fetchTwilioRecording(recordingUrl);

    // Transcribe with Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], "recording.mp3", { type: "audio/mpeg" }),
      model: "whisper-1",
    });

    console.log("📝 Transcription:", transcription.text);

    // GPT response
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
    const audioStream = await eleven.textToSpeech.convert(VOICE_ID, {
      text: gptResponse,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
      },
    });

    // Save audio to /tmp
    const fileName = `reply_${Date.now()}.mp3`;
    const filePath = path.join("/tmp", fileName);

    const writeStream = fs.createWriteStream(filePath);
    await new Promise((resolve, reject) => {
      audioStream.pipe(writeStream);
      audioStream.on("end", resolve);
      audioStream.on("error", reject);
    });
    console.log("✅ Saved ElevenLabs audio to", filePath);

    // Build URL for Twilio to fetch audio
    const host =
      req.headers["x-forwarded-host"] ||
      req.headers.host ||
      "finlumina-vox.vercel.app";
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    const fileUrl = `${proto}://${host}/api/tmp/${fileName}`;

    // TwiML: Play ElevenLabs audio, then end call
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${fileUrl}</Play>
  <Hangup/>
</Response>`;

    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twiml);
  } catch (err) {
    console.error("❌ Error in process-recording:", err);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(`
      <Response>
        <Say voice="alice">Sorry, there was an error processing your request.</Say>
        <Hangup/>
      </Response>
    `);
  }
}
