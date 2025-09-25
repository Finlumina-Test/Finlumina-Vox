import WebSocket from "ws";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Handle a single Twilio connection
export default function realtimeHandler(twilioWs) {
  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("🤖 Connected to OpenAI Realtime API");
  });

  // Twilio → GPT
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "media" && data.media.payload) {
        const audioB64 = data.media.payload; // Twilio PCM base64
        openaiWs.send(
          JSON.stringify({ type: "input_audio_buffer.append", audio: audioB64 })
        );
      }

      if (data.event === "stop") {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({ type: "response.create" }));
      }
    } catch (err) {
      console.error("❌ Error parsing Twilio WS msg:", err);
    }
  });

  // GPT → Twilio
  openaiWs.on("message", (raw) => {
    try {
      const event = JSON.parse(raw.toString());

      if (event.type === "response.output_text.delta") {
        console.log("GPT text:", event.delta);
      }

      if (event.type === "response.output_audio.delta" && event.delta) {
        // GPT generates playable audio (PCM base64) → forward to Twilio
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid: "realtime",
            media: { payload: event.delta },
          })
        );
      }

      if (event.type === "response.completed") {
        console.log("✅ GPT finished speaking");
      }
    } catch (err) {
      console.error("❌ Error parsing GPT WS msg:", err);
    }
  });

  // Cleanups
  twilioWs.on("close", () => {
    console.log("❌ Twilio WS closed");
    openaiWs.close();
  });

  openaiWs.on("close", () => {
    console.log("❌ OpenAI WS closed");
  });
}
