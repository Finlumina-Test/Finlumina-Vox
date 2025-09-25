// pages/api/voice.js
// Twilio webhook for incoming calls → responds with TwiML to start a <Stream>

export default function handler(req, res) {
  // Allow both GET and POST from Twilio
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }

  // Ensure host + protocol are set (for Vercel/Twilio forwarding)
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "finlumina-vox.vercel.app";
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];

  // WebSocket endpoint where Twilio will send audio
  const streamUrl = `${proto}://${host}/api/realtime-handler`;

  // TwiML response to start live stream
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">By Finlumina Vox. Starting realtime conversation.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  // Return XML
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(twiml);
}
