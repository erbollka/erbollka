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
  "You are Gemini in AuraRetail. Answer any user question helpfully and naturally. If uploaded document context or files are provided, read and use them when relevant. If the question is unrelated to retail or documents, answer normally. Separate facts from assumptions and do not invent document data.";

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
            systemInstruction: { parts: [{ text: [baseSystem, system].filter(Boolean).join("\n") }] },
            contents: [
              {
                parts: [{ text: prompt }, ...normalizeFiles(files)],
              },
            ],
            generationConfig: {
              temperature: 0.45,
              topP: 0.9,
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
      lastError = data?.error?.message ?? `Model ${model} returned an empty response`;
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

function readText(data: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }) {
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim() ?? "";
}
