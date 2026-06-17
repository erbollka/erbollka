// AI-функция на бесплатном ключе Google Gemini.
// Вызов с фронта: supabase.functions.invoke('ai', { body: { prompt, system } })
//
// Запуск (один раз):
//   1) Возьми бесплатный ключ: https://aistudio.google.com/apikey
//   2) Положи его в секрет:  npm run ai:secret -- GEMINI_API_KEY=твой_ключ
//   3) Задеплой функцию:     npm run ai:deploy
//
// Модель можно поменять (gemini-2.0-flash — быстрая и бесплатная).

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const MODEL_CANDIDATES = (Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.0-flash,gemini-3.1-flash-lite,gemini-3.5-flash,gemini-flash-latest')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const jsonHeaders = { ...cors, 'Content-Type': 'application/json; charset=utf-8' };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    if (!GEMINI_API_KEY) {
      throw new Error('Нет GEMINI_API_KEY. Поставь секрет: npm run ai:secret -- GEMINI_API_KEY=...');
    }
    const { prompt, system } = await req.json();
    if (!prompt) throw new Error('Нужно поле prompt');

    let lastError = 'AI returned an empty response';
    for (const model of MODEL_CANDIDATES) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.45,
              topP: 0.9,
              maxOutputTokens: 900,
            },
          }),
        },
      );

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (res.ok && text.trim()) {
        return new Response(JSON.stringify({ text, model }), {
          headers: jsonHeaders,
        });
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
