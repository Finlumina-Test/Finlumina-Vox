import { ElevenLabsClient } from "elevenlabs";
import cloudinary from "cloudinary";

const eleven = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Convert GPT text → ElevenLabs voice → upload to Cloudinary → return URL
export async function synthesizeAndUpload(text, voiceId = "FOtIACPya7JrUALJeYnn") {
  const audio = await eleven.textToSpeech.convert(voiceId, {
    text,
    model_id: "eleven_multilingual_v2",
  });

  const upload = await cloudinary.v2.uploader.upload_stream({
    resource_type: "video",
    format: "mp3",
  });

  return upload.secure_url;
}
