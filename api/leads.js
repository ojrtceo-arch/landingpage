import { randomUUID } from "node:crypto";

const MAX_BODY_BYTES = 12_000;
const MIN_FORM_AGE_MS = 1_500;
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1_000;

function sendJson(response, status, payload) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  return response.status(status).json(payload);
}

function getString(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function normalizePhone(value) {
  return getString(value, 30).replace(/[^0-9+\-\s()]/g, "");
}

function parseBody(request) {
  if (request.body && typeof request.body === "object") {
    return request.body;
  }

  if (typeof request.body === "string") {
    try {
      return JSON.parse(request.body);
    } catch {
      return null;
    }
  }

  return null;
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: "Method Not Allowed" });
  }

  const contentLength = Number(request.headers["content-length"] || 0);

  if (contentLength > MAX_BODY_BYTES) {
    return sendJson(response, 413, { error: "Payload Too Large" });
  }

  const body = parseBody(request);

  if (!body || Array.isArray(body)) {
    return sendJson(response, 400, { error: "בקשה לא תקינה." });
  }

  // Honeypot: real visitors never fill this field.
  if (getString(body.website, 200)) {
    return sendJson(response, 200, { success: true });
  }

  const startedAt = Number(body.formStartedAt);
  const formAge = Date.now() - startedAt;

  if (
    !Number.isFinite(startedAt) ||
    formAge < MIN_FORM_AGE_MS ||
    formAge > MAX_FORM_AGE_MS
  ) {
    return sendJson(response, 400, { error: "יש לרענן את הדף ולנסות שוב." });
  }

  const fullName = getString(body.fullName, 100);
  const phone = normalizePhone(body.phone);
  const businessName = getString(body.businessName, 120);
  const message = getString(body.message, 1_500);
  const phoneDigits = phone.replace(/\D/g, "");

  if (fullName.length < 2) {
    return sendJson(response, 400, { error: "יש למלא שם מלא." });
  }

  if (phoneDigits.length < 9 || phoneDigits.length > 15) {
    return sendJson(response, 400, { error: "מספר הטלפון אינו תקין." });
  }

  const webhookUrl = process.env.GOOGLE_LEADS_WEBHOOK_URL?.trim();
  const webhookSecret = process.env.GOOGLE_LEADS_WEBHOOK_SECRET?.trim();

  if (!webhookUrl || !webhookSecret) {
    console.error("[landing-lead] Google Sheets webhook is not configured");
    return sendJson(response, 503, {
      error: "השירות אינו זמין כרגע. אפשר לפנות בוואטסאפ.",
    });
  }

  const externalLeadId = `landing-${Date.now()}-${randomUUID()}`;

  try {
    const upstreamResponse = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: webhookSecret,
        externalLeadId,
        submittedAt: new Date().toISOString(),
        source: "דף נחיתה",
        fullName,
        phone,
        businessName,
        message,
      }),
    });

    const result = await upstreamResponse.json().catch(() => ({}));

    if (!upstreamResponse.ok || !result.success) {
      console.error("[landing-lead] Google Sheets webhook failed", {
        status: upstreamResponse.status,
        error: getString(result.error, 200),
      });

      return sendJson(response, 502, {
        error: "הייתה בעיה בשמירת הפרטים. אפשר לנסות שוב או לפנות בוואטסאפ.",
      });
    }

    return sendJson(response, 201, { success: true });
  } catch (error) {
    console.error("[landing-lead] Google Sheets request failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });

    return sendJson(response, 502, {
      error: "הייתה בעיה בשמירת הפרטים. אפשר לנסות שוב או לפנות בוואטסאפ.",
    });
  }
}
