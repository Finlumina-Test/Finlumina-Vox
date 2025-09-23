import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import fetch from "node-fetch";
import { v2 as cloudinary } from "cloudinary";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const eleven = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

// Configure Cloudinary SDK
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
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

// Upload buffer to Cloudinary with SDK
async function uploadToCloudinary(buffer, fileName) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "auto",
        public_id: `finlumina-vox/${fileName}`,
        overwrite: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );

    stream.end(buffer); // send buffer to Cloudinary
  });
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

    // 1. Fetch audio with retry logic
    const audioBuffer = await fetchTwilioRecording(recordingUrl);

    // 2. Transcribe with Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], "recording.mp3", { type: "audio/mpeg" }),
      model: "whisper-1",
    });

    console.log("📝 Transcription:", transcription.text);

    // 3. GPT response
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful AI voice assistant." },
        { role: "user", content: transcription.text },
      ],
    });

    const gptResponse = completion.choices[0].message.content;
    console.log("🤖 GPT Response:", gptResponse);

    // 4. ElevenLabs TTS → Buffer
    const audioStream = await eleven.textToSpeech.convert(VOICE_ID, {
      text: gptResponse,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
      },
    });

    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const finalBuffer = Buffer.concat(chunks);

    // 5. Upload to Cloudinary
    const fileUrl = await uploadToCloudinary(
      finalBuffer,
      `reply_${Date.now()}.mp3`
    );
    console.log("☁️ Uploaded reply to Cloudinary:", fileUrl);

    // 6. TwiML: Play Cloudinary audio, then hang up
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
