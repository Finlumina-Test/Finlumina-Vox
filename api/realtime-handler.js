// pages/api/realtime-handler.js
// WebSocket handler: Twilio <Stream> ↔ OpenAI Realtime ↔ (optionally ElevenLabs)

import WebSocket from "ws";
import { ElevenLabsClient } from "elevenlabs";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const eleven = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

const VOICE_ID = "FOtIACPya7JrUALJeYnn";

/* ---------- μ-law <-> PCM16 conversion helpers ---------- */
function ulawToPCM16(ulawByte) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  ulawByte = ~ulawByte & 0xFF;

  const sign = ulawByte & 0x80;
  let exponent = (ulawByte >> 4) & 0x07;
  let mantissa = ulawByte & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << (exponent + 3);
  if (sign !== 0) sample = -sample;
  return Math.max(-32768, Math.min(32767, sample));
}

function pcm16ToUlaw(sample) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;

  let sign = (sample < 0) ? 0x80 : 0;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let ulawByte = ~(sign | (exponent << 4) | mantissa);
  return ulawByte & 0xFF;
}

function ulawBase64ToPCM16(base64) {
  const ulawBuf = Buffer.from(base64, "base64");
  const pcm16 = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) {
    pcm16[i] = ulawToPCM16(ulawBuf[i]);
  }
  return Buffer.from(pcm16.buffer);
}

function pcm16ToUlawBase64(pcmBuf) {
  const pcm16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2);
  const ulawBuf = Buffer.alloc(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    ulawBuf[i] = pcm16ToUlaw(pcm16[i]);
  }
  return ulawBuf.toString("base64");
}

/* -------------------------------------------------------- */

export default function handler(req, res) {
  if (!res.socket.server.wss) {
    console.log("🔌 Starting WebSocket server...");

    const wss = new WebSocket.Server({ noServer: true });
    res.socket.server.wss = wss;

    // Handle WS upgrade (Twilio connects here)
    res.socket.server.on("upgrade", (req, socket, head) => {
      if (req.url === "/api/realtime-handler") {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      }
    });

    wss.on("connection", async (twilioWs) => {
      console.log("📞 Twilio stream connected");

      // Connect to OpenAI Realtime API
      const openaiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12",
        { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
      );

      openaiWs.on("open", () => console.log("🤖 Connected to OpenAI Realtime"));

      // From Twilio → decode μ-law → send PCM16 to OpenAI
      twilioWs.on("message", (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.event === "media" && data.media.payload) {
          const pcm16buf = ulawBase64ToPCM16(data.media.payload);
          const pcm16b64 = pcm16buf.toString("base64");
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16b64 }));
        }
        if (data.event === "stop") {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
      });

      // From OpenAI → convert PCM16 → send μ-law back to Twilio
      openaiWs.on("message", async (raw) => {
        const event = JSON.parse(raw.toString());

        if (event.type === "response.output_text.delta") {
          console.log("GPT text:", event.delta);
        }

        if (event.type === "response.output_audio.delta" && event.delta) {
          const pcm16buf = Buffer.from(event.delta, "base64");
          const ulawB64 = pcm16ToUlawBase64(pcm16buf);
          twilioWs.send(
            JSON.stringify({ event: "media", streamSid: "realtime", media: { payload: ulawB64 } })
          );
        }

        if (event.type === "response.completed") {
          console.log("✅ GPT finished a turn");
        }
      });

      // Cleanup
      twilioWs.on("close", () => {
        console.log("❌ Twilio stream closed");
        openaiWs.close();
      });
      openaiWs.on("close", () => console.log("❌ OpenAI stream closed"));
    });
  }

  res.end();
}
