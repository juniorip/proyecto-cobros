import https from "node:https";
import { randomUUID } from "node:crypto";

export type BcpValidationStatus = "valid" | "invalid" | "unverified";
export type BcpValidation = { status: BcpValidationStatus; detail?: string };

type JsonRecord = Record<string, unknown>;
type HttpsResult = { status: number; body: JsonRecord };

const TOKEN_SCOPE = "apsy-account.validateAccount+bs-account-v4+bs-person-v5+bs-data-protection-v1";
let tokenCache: { token: string; expiresAt: number } | null = null;
let tokenRequest: Promise<string> | null = null;
let httpsAgent: https.Agent | null = null;
const verificationCache = new Map<string, Promise<BcpValidation>>();

function jsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function clientAgent(): https.Agent | null {
  if (httpsAgent) return httpsAgent;
  const pfx = process.env.BCP_API_CLIENT_PFX_BASE64?.trim();
  const cert = process.env.BCP_API_CLIENT_CERT?.replace(/\\n/g, "\n").trim();
  const key = process.env.BCP_API_CLIENT_KEY?.replace(/\\n/g, "\n").trim();
  if (pfx) {
    httpsAgent = new https.Agent({
      pfx: Buffer.from(pfx, "base64"),
      passphrase: process.env.BCP_API_CLIENT_PFX_PASSPHRASE,
      keepAlive: true,
    });
    return httpsAgent;
  }
  if (cert && key) {
    httpsAgent = new https.Agent({ cert, key, passphrase: process.env.BCP_API_CLIENT_KEY_PASSPHRASE, keepAlive: true });
    return httpsAgent;
  }
  return null;
}

function requestJson(url: URL, options: https.RequestOptions, body?: string): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const agent = clientAgent();
    const req = https.request(url, { ...options, ...(agent ? { agent } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return reject(new Error("La API BCP devolvió una respuesta inválida.")); }
        const parsed = jsonRecord(value);
        if (!parsed) return reject(new Error("La API BCP devolvió una respuesta inválida."));
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function bcpConfigured() {
  return Boolean(
    process.env.BCP_API_CLIENT_ID?.trim() &&
    process.env.BCP_API_CLIENT_SECRET?.trim() &&
    process.env.BCP_API_SUBSCRIPTION_KEY?.trim() &&
    clientAgent(),
  );
}

function requestDateLima() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}.${String(new Date().getMilliseconds()).padStart(3, "0")}-0500`;
}

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  if (tokenRequest) return tokenRequest;
  tokenRequest = (async () => {
  const base = process.env.BCP_API_ENV === "certification"
    ? "https://authservercert.apisbcp.com/cas/oidc/"
    : "https://authserver.apisbcp.com/cas/oidc/";
  const url = new URL("accessToken", base.endsWith("/") ? base : `${base}/`);
  url.search = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.BCP_API_CLIENT_ID!.trim(),
    client_secret: process.env.BCP_API_CLIENT_SECRET!.trim(),
    scope: TOKEN_SCOPE,
  }).toString();
  const response = await requestJson(url, { method: "POST", headers: { Accept: "application/json" } });
  const token = typeof response.body.access_token === "string" ? response.body.access_token : "";
  if (response.status < 200 || response.status >= 300 || !token) throw new Error("No se pudo autenticar con la API BCP.");
  const expiresIn = Number(response.body.expires_in) || 300;
  tokenCache = { token, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 };
  return token;
  })();
  try { return await tokenRequest; }
  finally { tokenRequest = null; }
}

async function validateAccount(accountNumber: string, documentNumber: string, accountSubType: string, token: string): Promise<boolean> {
  const base = process.env.BCP_API_ENV === "certification"
    ? "https://partner-cert.apisbcp.com/apsy-account-v1/private/apsy/v1/"
    : "https://partner.apisbcp.com/apsy-account-v1/private/apsy/v1/";
  const response = await requestJson(new URL("accounts/validate", base), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "subscription-key": process.env.BCP_API_SUBSCRIPTION_KEY!.trim(),
      "request-id": randomUUID(),
      "request-date": requestDateLima(),
    },
  }, JSON.stringify({
    Data: {
      Account: { AccountNumber: accountNumber, AccountSubType: accountSubType, ValidationType: "DOC" },
      Beneficiary: { CreditorAccount: { DocumentNumber: documentNumber, DocumentType: "DNI" } },
    },
  }));
  if (response.status < 200 || response.status >= 300) throw new Error("La API BCP no pudo validar la cuenta.");
  const data = jsonRecord(response.body.Data);
  const accountRows = Array.isArray(data?.Account) ? data.Account : [];
  const result = jsonRecord(accountRows[0]);
  if (typeof result?.IsValid !== "boolean") throw new Error("La API BCP no devolvió el resultado de validación esperado.");
  return result.IsValid;
}

/**
 * Uses BCP's account-to-document check. Secrets and certificates are read only
 * on the server. Account subtype defaults to CurrentAccount and can be set in
 * BCP_API_ACCOUNT_SUBTYPE when BCP confirms the account product type.
 */
export async function validateBcpAccountDni(dni: string, accounts: string[]): Promise<BcpValidation> {
  const cleanDni = dni.replace(/\D/g, "");
  const cleanAccounts = [...new Set(accounts.map((account) => account.replace(/\D/g, "")))];
  if (!/^\d{8}$/.test(cleanDni) || !cleanAccounts.length || cleanAccounts.some((account) => !/^\d{13,14}$/.test(account))) {
    return { status: "unverified", detail: "DNI o número de cuenta incompleto." };
  }
  if (!bcpConfigured()) return { status: "unverified", detail: "Falta configurar el acceso mTLS de BCP." };

  const cacheKey = `${cleanDni}:${cleanAccounts.slice().sort().join(",")}:${process.env.BCP_API_ACCOUNT_SUBTYPE || "all"}`;
  const cached = verificationCache.get(cacheKey);
  if (cached) return cached;

  const pending = (async (): Promise<BcpValidation> => { try {
    const token = await accessToken();
    const configuredSubtype = process.env.BCP_API_ACCOUNT_SUBTYPE?.trim();
    const subtypes = configuredSubtype
      ? [configuredSubtype]
      : ["CurrentAccount", "CurrentAccount.Master", "Savings", "Savings.CTS"];
    for (const account of cleanAccounts) {
      for (const subtype of subtypes) {
        if (await validateAccount(account, cleanDni, subtype, token)) return { status: "valid" };
      }
    }
    return { status: "invalid", detail: "La cuenta no coincide con el DNI en los tipos de cuenta consultados." };
  } catch (error) {
    return { status: "unverified", detail: error instanceof Error ? error.message : "No se pudo consultar la API BCP." };
  } })();
  verificationCache.set(cacheKey, pending);
  const result = await pending;
  // Cache a conclusive result for this server process; don't cache transient
  // failures so a later import can retry once BCP access is restored.
  if (result.status === "unverified") verificationCache.delete(cacheKey);
  return result;
}
