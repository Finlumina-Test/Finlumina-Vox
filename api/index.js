import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import realtimeHandler from "./realtime-handler.js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const server = http.createServer(app);

// Attach WebSocket server
const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  console.log("📞 Twilio WebSocket connected");
  realtimeHandler(ws);
});

app.get("/", (req, res) => {
  res.send("✅ Twilio GPT Realtime Server is running!");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
