// pages/api/realtime-handler.js
// WebSocket handler: Twilio <Stream> ↔ OpenAI Realtime ↔ ElevenLabs

import WebSocket from "ws";
import { ElevenLabsClient } from "elevenlabs";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const eleven = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

const VOICE_ID = "FOtIACPya7JrUALJeYnn";

// Realtime handler for Twilio audio stream
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
      const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12", {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });

      openaiWs.on("open", () => console.log("🤖 Connected to OpenAI Realtime"));

      // Receive audio from Twilio → forward to OpenAI
      twilioWs.on("message", (msg) => {
        const data = JSON.parse(msg.toString());
        if (data.event === "media" && data.media.payload) {
          // Base64 PCM from Twilio
          const audioB64 = data.media.payload;
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: audioB64 }));
        }
        if (data.event === "stop") {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
      });

      // Get GPT response → run through ElevenLabs → send to Twilio
      openaiWs.on("message", async (raw) => {
        const event = JSON.parse(raw.toString());

        if (event.type === "response.output_text.delta") {
          console.log("GPT text:", event.delta);
        }

        if (event.type === "response.output_audio.delta" && event.delta) {
          // If using GPT’s built-in audio output (not ElevenLabs)
          const pcmB64 = event.delta;
          twilioWs.send(
            JSON.stringify({ event: "media", streamSid: "realtime", media: { payload: pcmB64 } })
          );
        }

        if (event.type === "response.completed") {
          console.log("✅ GPT finished a turn");

          // OPTIONAL: If you want ElevenLabs voice instead of GPT audio
          // You’d take event.output_text, send to ElevenLabs, get MP3, convert to PCM, then send to Twilio
        }
      });

      // Handle cleanup
      twilioWs.on("close", () => {
        console.log("❌ Twilio stream closed");
        openaiWs.close();
      });
      openaiWs.on("close", () => console.log("❌ OpenAI stream closed"));
    });
  }

  res.end();
}
