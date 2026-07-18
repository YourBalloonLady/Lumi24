import { GoogleGenAI } from "@google/genai";

const ALLOWED_ORIGINS = new Set([
  "https://www.lumi24.org",
  "https://lumi24.org"
]);

export async function onRequestOptions(context) {
  const origin = context.request.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse({ error: "Origin not allowed." }, 403);
  }

  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin)
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get("origin") || "";

  try {
    if (!ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ error: "Origin not allowed." }, 403);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 4096) {
      return jsonResponse({ error: "Request is too large." }, 413, origin);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return jsonResponse({ error: "Invalid content type." }, 400, origin);
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 4096) {
      return jsonResponse({ error: "Request is too large." }, 413, origin);
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Invalid JSON." }, 400, origin);
    }
    const message = String(body?.message || "").trim();

    if (!message) {
      return jsonResponse({ error: "Message is required." }, 400, origin);
    }

    if (message.length > 1000) {
      return jsonResponse({ error: "Message is too long." }, 400, origin);
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: "Server is missing GEMINI_API_KEY." }, 500, origin);
    }

    const productContext = `
Lumi24 Inventory:
- Metabolic: Semaglutide (£100), Tirzepatide (£110-150), Retatrutide (£120-180), Cagrilintide (£85-100).
- Recovery: BPC-157 & TB500 Blend (£35), GHK-Cu (£45-60), NAD+ (£145).
- Cognitive: Selank (£25-40), Semax (£25-40).
- Other: MOTS-c (£55), MT-2 (£25-40).
- Shipping: UK Dispatch, 24-48h Delivery.
- Payment: Secure Bank Transfer.
`;

    const systemInstruction = `
You are the Lumi24 Research Assistant.

Use only the provided product/store context.
All products are for LABORATORY RESEARCH ONLY.
Never provide dosage, cycle, injection, administration, human consumption, or medical advice.
If asked how to take or how much to use, respond exactly:
"I cannot provide dosage or usage instructions. Our products are supplied strictly for laboratory research purposes."

Keep replies short, helpful, and commercial-site appropriate.
Do not invent products, prices, stock, or policies that are not in context.
Context:
${productContext}
`.trim();

    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      config: {
        systemInstruction
      },
      contents: [
        {
          role: "user",
          parts: [{ text: message }]
        }
      ]
    });

    const reply =
  typeof response.text === "function"
    ? response.text().trim()
    : "Sorry, I could not generate a reply right now.";

    return jsonResponse({ reply }, 200, origin);
  } catch (error) {
    console.error("Chat API error:", error);
    return jsonResponse(
      { error: "The assistant is temporarily unavailable." },
      500,
      origin
    );
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function jsonResponse(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(ALLOWED_ORIGINS.has(origin) ? corsHeaders(origin) : {})
    }
  });
}
