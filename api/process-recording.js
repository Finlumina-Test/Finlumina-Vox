import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import fetch from "node-fetch";
import FormData from "form-data";

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

// Upload buffer to Cloudinary
async function uploadToCloudinary(buffer, fileName) {
  const form = new FormData();
  form.append("file", buffer, { filename: fileName });
  form.append("upload_preset", process.env.CLOUDINARY_UPLOAD_PRESET);
  form.append("folder", "finlumina-vox"); // optional

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/auto/upload`,
    { method: "POST", body: form }
  );

  if (!res.ok) {
    throw new Error(`Cloudinary upload failed: ${res.status}`);
  }
  const data = await res.json();
  return data.secure_url;
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

    // 6. TwiML: Play AI reply, then keep listening
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${fileUrl}</Play>
  <Gather input="speech" action="/api/process-recording" method="POST" timeout="5">
    <Say voice="alice">I'm listening...</Say>
  </Gather>
</Response>`;

    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twiml);
  } catch (err) {
    console.error("❌ Error in process-recording:", err);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(`
      <Response>
        <Say voice="alice">Sorry, there was an error processing your request.</Say>
        <Gather input="speech" action="/api/process-recording" method="POST" timeout="5">
          <Say voice="alice">Please try again.</Say>
        </Gather>
      </Response>
    `);
  }
}
