const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const MODEL_CANDIDATES = (Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.5-pro")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const IMAGE_MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-image";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...cors, "Content-Type": "application/json; charset=utf-8" };
const baseSystem =
  [
    "You are Gemini in AuraRetail, a practical AI assistant for fashion retail owners and store teams.",
    "Answer naturally in the user's language. Keep answers concise, specific, and action-oriented.",
    "When retail reports, documents, images, or spreadsheet context are provided, ground your answer in them and mention the concrete evidence you used.",
    "Separate known facts from assumptions. If data is missing, say what is missing instead of inventing document values.",
    "For analysis requests, prioritize: revenue impact, margin/profit impact, inventory risk, returns/discounts, payroll/expense anomalies, and next actions.",
    "For non-retail questions, answer normally without forcing a retail frame.",
  ].join(" ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    if (!GEMINI_API_KEY) {
      throw new Error("Missing GEMINI_API_KEY. Set the Supabase secret GEMINI_API_KEY.");
    }

    const { prompt, system, files, mode } = await req.json();
    if (!prompt) throw new Error("Missing prompt");

    if (mode === "image") {
      const imageResponse = await generateImage(prompt, files);
      return new Response(JSON.stringify(imageResponse), { headers: jsonHeaders });
    }

    let lastError = "AI returned an empty response";
    for (const model of MODEL_CANDIDATES) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: buildSystemInstruction(system) }] },
            contents: [
              {
                parts: buildUserParts(prompt, files),
              },
            ],
            generationConfig: {
              temperature: 0.35,
              topP: 0.92,
              maxOutputTokens: 2048,
            },
          }),
        },
      );

      const data = await res.json();
      const text = readText(data);
      if (res.ok && text.trim()) {
        return new Response(JSON.stringify({ text: text.trim(), model }), { headers: jsonHeaders });
      }
      lastError = readGeminiError(data, model);
    }

    throw new Error(lastError);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});

async function generateImage(prompt: string, files: unknown) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }, ...normalizeFiles(files)],
          },
        ],
      }),
    },
  );

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((part: { inlineData?: { data?: string; mimeType?: string } }) => part?.inlineData?.data);
  const text = readText(data);

  if (!res.ok || !imagePart?.inlineData?.data) {
    throw new Error(data?.error?.message ?? "Gemini did not return an image");
  }

  return {
    text: text.trim(),
    image: `data:${imagePart.inlineData.mimeType ?? "image/png"};base64,${imagePart.inlineData.data}`,
    model: IMAGE_MODEL,
  };
}

function normalizeFiles(files: unknown) {
  return (Array.isArray(files) ? files : [])
    .filter((file): file is { data: string; mimeType: string } => {
      return Boolean(
        file &&
          typeof file === "object" &&
          "data" in file &&
          "mimeType" in file &&
          (file as { data?: unknown }).data &&
          (file as { mimeType?: unknown }).mimeType,
      );
    })
    .slice(0, 4)
    .map((file) => ({
      inlineData: {
        mimeType: String(file.mimeType),
        data: String(file.data),
      },
    }));
}

function buildSystemInstruction(system: unknown) {
  return [baseSystem, typeof system === "string" ? system.trim() : ""].filter(Boolean).join("\n\n");
}

function buildUserParts(prompt: string, files: unknown) {
  const evidenceReminder = [
    "Before answering, identify what evidence is available in the prompt/files.",
    "If the user asks for recommendations, return the highest-impact next steps first.",
    "Use bullets only when they make the answer easier to scan.",
  ].join(" ");

  return [{ text: `${prompt}\n\n${evidenceReminder}` }, ...normalizeFiles(files)];
}

function readText(data: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }) {
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim() ?? "";
}

function readGeminiError(
  data: {
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ finishReason?: string; safetyRatings?: Array<{ category?: string; probability?: string }> }>;
  },
  model: string,
) {
  const finishReason = data?.candidates?.[0]?.finishReason;
  const blockReason = data?.promptFeedback?.blockReason;
  if (data?.error?.message) return data.error.message;
  if (blockReason) return `Model ${model} blocked the prompt: ${blockReason}`;
  if (finishReason && finishReason !== "STOP") return `Model ${model} stopped without text: ${finishReason}`;
  return `Model ${model} returned an empty response`;
}
