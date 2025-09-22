// pages/api/voice.js
// Twilio webhook for incoming calls → responds with TwiML to record the caller

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

  // When Twilio first hits this endpoint, send instructions
  const actionUrl = `${proto}://${host}/api/process-recording`;

  // Generate TwiML response
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">
    Assalamualaikum. This is a test call by the courtesy of Finlumina call agent.
    It may be recorded for order processing. Please speak after the beep. Press star when you are finished.
  </Say>
  <Record action="${actionUrl}" method="POST" maxLength="120" playBeep="true" finishOnKey="*" />
  <Say voice="alice">We did not receive a recording. Goodbye.</Say>
</Response>`;

  // Return XML
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(twiml);
}
