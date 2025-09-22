// pages/api/tmp/[file].js
import fs from "fs";
import path from "path";

export default function handler(req, res) {
  try {
    const { file } = req.query;

    // Sanitize filename (prevent path traversal)
    const safeFile = path.basename(file);

    // Resolve absolute path inside Vercel /tmp
    const filePath = path.join("/tmp", safeFile);

    if (!fs.existsSync(filePath)) {
      console.error("❌ File not found:", filePath);
      return res.status(404).send("File not found");
    }

    // Stream audio back
    res.setHeader("Content-Type", "audio/mpeg");
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    console.error("❌ Error serving tmp file:", err);
    res.status(500).send("Internal Server Error");
  }
}
