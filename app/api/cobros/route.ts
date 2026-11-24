import { neon } from "@neondatabase/serverless";
import { parseCrep, samePayment } from "../../../lib/crep.mjs";
import { isValidBcpEffectRate } from "../../../lib/bcp-commission";
import { findPancakeCustomersByDni, getPancakeBcpProfile } from "../../../lib/pancake-customer";
import { validateBcpAccountDni } from "../../../lib/bcp-account-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Payment = {
  code: string;
  client: string;
  account: string;
  pancake_alias?: string;
  pancake_account?: string;
  paid_account?: string;
  bcp_validation?: "valid" | "invalid" | "unverified";
  rate?: number;
  community?: string;
  date: string;
  time: string;
  cents: number | string;
  channel: string;
  raw: string;
  filename?: string;
};

type ImportRow = {
  id: string;
  filename: string;
  created: string;
  added: number;
  duplicates: number;
  conflicts: number;
};

type CashMovement = {
  id: string;
  direction: "Ingreso" | "Salida";
  company: string;
  account: string;
  cents: number | string;
  concept: string;
  date: string;
  created: string;
};

type NeonSql = ReturnType<typeof neon>;

let client: NeonSql | null = null;
let schemaReady: Promise<void> | null = null;

function database(): NeonSql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Falta configurar DATABASE_URL para la base de datos.");
  if (!client) client = neon(url);
  return client;
}

async function ensureSchema(sql: NeonSql) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS operations (
        code TEXT PRIMARY KEY,
        client TEXT NOT NULL,
        account TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        cents BIGINT NOT NULL,
        channel TEXT NOT NULL,
        raw TEXT NOT NULL,
        filename TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pendiente',
        document TEXT NOT NULL DEFAULT 'Sin asignar',
        reference TEXT NOT NULL DEFAULT '',
        rate INTEGER NOT NULL DEFAULT 100,
        company TEXT NOT NULL DEFAULT 'BCP',
        community TEXT NOT NULL DEFAULT '',
        operation_type TEXT NOT NULL DEFAULT 'Efectivización',
        pancake_alias TEXT NOT NULL DEFAULT '',
        pancake_account TEXT NOT NULL DEFAULT '',
        paid_account TEXT NOT NULL DEFAULT '',
        bcp_validation TEXT NOT NULL DEFAULT 'unverified'
      )`;
      await sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'BCP'`;
      await sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS community TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS operation_type TEXT NOT NULL DEFAULT 'Efectivización'`;
      await sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS pancake_alias TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS pancake_account TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS paid_account TEXT NOT NULL DEFAULT ''`;
      // Preserve legacy paid records only when Pancake had exactly one valid
      // BCP account for that DNI, so no ambiguous account is attributed.
      await sql`UPDATE operations AS operation SET paid_account = (
          SELECT regexp_replace(split.account_value, '[^0-9]', '', 'g')
          FROM regexp_split_to_table(operation.pancake_account, ',') AS split(account_value)
          WHERE length(regexp_replace(split.account_value, '[^0-9]', '', 'g')) IN (13, 14)
          LIMIT 1
        )
        WHERE operation.status='Completado' AND lower(operation.company)='bcp'
          AND operation.paid_account=''
          AND (SELECT count(*) FROM regexp_split_to_table(operation.pancake_account, ',') AS split(account_value)
            WHERE length(regexp_replace(split.account_value, '[^0-9]', '', 'g')) IN (13, 14))=1`;
      await sql`ALTER TABLE operations ADD COLUMN IF NOT EXISTS bcp_validation TEXT NOT NULL DEFAULT 'unverified'`;
      await sql`CREATE TABLE IF NOT EXISTS imports (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        created TEXT NOT NULL,
        added INTEGER NOT NULL,
        duplicates INTEGER NOT NULL,
        conflicts INTEGER NOT NULL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS cash_movements (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('Ingreso', 'Salida')),
        company TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT '',
        cents BIGINT NOT NULL CHECK (cents > 0),
        concept TEXT NOT NULL,
        date TEXT NOT NULL,
        created TEXT NOT NULL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS cash_settings (
        id TEXT PRIMARY KEY,
        cents BIGINT NOT NULL DEFAULT 0,
        updated TEXT NOT NULL
      )`;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

function allowed(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

async function queryPayments(sql: NeonSql, codes: string[]): Promise<Payment[]> {
  if (!codes.length) return [];
  const placeholders = codes.map((_, i) => `$${i + 1}`).join(",");
  return (await sql.query(
    `SELECT code, client, account, date, time, cents, channel, raw, filename, pancake_alias, pancake_account, community, bcp_validation, rate
       FROM operations WHERE code IN (${placeholders})`,
    codes,
  )) as Payment[];
}

export async function GET() {
  try {
    const sql = database();
    await ensureSchema(sql);
    const [rows, history, movements, settings] = await Promise.all([
      sql`SELECT * FROM operations ORDER BY date DESC, time DESC, code DESC`,
      sql`SELECT * FROM imports ORDER BY created DESC LIMIT 20`,
      sql`SELECT * FROM cash_movements ORDER BY date DESC, created DESC LIMIT 500`,
      sql`SELECT cents FROM cash_settings WHERE id='opening-balance' LIMIT 1`,
    ]);
    const settingRows = settings as unknown as { cents: number | string }[];
    return json({ rows, history, movements, openingBalance: settingRows[0]?.cents ?? 0 });
  } catch {
    return json({ error: "No se pudo leer la base de datos. Revisa la conexión e inténtalo otra vez." }, 500);
  }
}

export async function POST(req: Request) {
  if (!allowed(req)) return json({ error: "Origen no permitido" }, 403);

  try {
    const body = await req.json() as { kind?: unknown; direction?: unknown; company?: unknown; account?: unknown; amount?: unknown; concept?: unknown; date?: unknown; filename?: unknown; text?: unknown; code?: unknown; client?: unknown; channel?: unknown; rate?: unknown; community?: unknown; operationType?: unknown };
    if (body.kind === "opening-balance") {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) return json({ error: "Ingresa un saldo inicial válido." }, 400);
      const sql = database();
      await ensureSchema(sql);
      await sql`INSERT INTO cash_settings (id, cents, updated) VALUES ('opening-balance', ${Math.round(amount * 100)}, ${new Date().toISOString()})
        ON CONFLICT (id) DO UPDATE SET cents=EXCLUDED.cents, updated=EXCLUDED.updated`;
      return json({ ok: true });
    }
    if (body.kind === "cash-movement") {
      const amount = Number(body.amount);
      if (
        !["Ingreso", "Salida"].includes(String(body.direction)) ||
        typeof body.company !== "string" || !body.company.trim() || body.company.length > 120 ||
        typeof body.account !== "string" || body.account.length > 120 ||
        !Number.isFinite(amount) || amount <= 0 || amount > 100_000_000 ||
        typeof body.concept !== "string" || !body.concept.trim() || body.concept.length > 240 ||
        typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ) return json({ error: "Completa el tipo, empresa, monto, concepto y fecha correctamente." }, 400);
      const sql = database();
      await ensureSchema(sql);
      const id = crypto.randomUUID();
      await sql`INSERT INTO cash_movements (id, direction, company, account, cents, concept, date, created)
        VALUES (${id}, ${String(body.direction)}, ${body.company.trim()}, ${body.account.trim()}, ${Math.round(amount * 100)}, ${body.concept.trim()}, ${body.date}, ${new Date().toISOString()})`;
      return json({ ok: true, id });
    }
    if (body.kind === "manual-operation") {
      const amount = Number(body.amount), rate = Number(body.rate ?? 100);
      if (
        typeof body.code !== "string" || !/^\d{8}$/.test(body.code) ||
        typeof body.client !== "string" || !body.client.trim() || body.client.length > 100 ||
        !Number.isFinite(amount) || amount <= 0 || amount > 100_000_000 ||
        !Number.isInteger(rate) || rate < 0 || rate > 10000 ||
        typeof body.company !== "string" || !body.company.trim() || body.company.length > 120 ||
        typeof body.community !== "string" || body.community.length > 50 ||
        !["Efectivización", "Pago Deuda", "Otros"].includes(String(body.operationType))
      ) return json({ error: "Completa el código, cliente, empresa, trámite y monto correctamente." }, 400);
      if (body.company.trim().toLowerCase() === "bcp" && body.operationType === "Efectivización" && !isValidBcpEffectRate(rate)) {
        return json({ error: "Para efectivización BCP usa 0.35 %, 0.5 % o 1 %. Se aplica un mínimo de S/ 12." }, 400);
      }
      const sql = database();
      await ensureSchema(sql);
      const now = new Date();
      try {
        await sql`INSERT INTO operations (code, client, account, date, time, cents, channel, raw, filename, status, document, reference, rate, company, community, operation_type)
          VALUES (${body.code}, ${body.client.trim()}, '', ${now.toISOString().slice(0, 10)}, ${now.toTimeString().slice(0, 8)}, ${Math.round(amount * 100)}, 'Manual', '', 'Registro manual', 'Pendiente', 'Sin asignar', '', ${rate}, ${body.company.trim()}, ${String(body.community).trim()}, ${String(body.operationType)})`;
      } catch {
        return json({ error: "Ese código de operación ya existe. Usa otro código." }, 409);
      }
      return json({ ok: true });
    }
    if (
      typeof body.text !== "string" || body.text.length > 5_000_000 ||
      typeof body.filename !== "string"
    ) return json({ error: "Selecciona un TXT de hasta 5 MB." }, 400);

    let parsed;
    try {
      parsed = parseCrep(body.text);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "El archivo no es un reporte CREP válido." }, 400);
    }
    if (parsed.errors.length) {
      return json({ error: "No se importó el archivo. Corrige los siguientes errores.", details: parsed.errors }, 400);
    }

    const sql = database();
    await ensureSchema(sql);
    const incoming = parsed.rows as Payment[];
    const previous = new Map<string, Payment>();
    for (let i = 0; i < incoming.length; i += 500) {
      const existing = await queryPayments(sql, incoming.slice(i, i + 500).map((row) => row.code));
      for (const row of existing) previous.set(row.code, row);
    }

    // Classify already imported deposits before calling Pancake or the BCP
    // validation service. Re-uploaded/omitted rows must not trigger lookups.
    let duplicates = 0;
    const conflicts = new Set<string>();
    const fresh: Payment[] = [];
    const freshByCode = new Map<string, Payment>();
    for (const row of incoming) {
      const old = previous.get(row.code) ?? freshByCode.get(row.code);
      if (!old) {
        fresh.push(row);
        freshByCode.set(row.code, row);
      } else if (samePayment(old, row)) {
        duplicates++;
      } else {
        conflicts.add(row.code);
      }
    }

    let pancakeMatched = 0;
    let pancakeUnmatched = fresh.length;
    let pancakeWarning = "";
    let bcpValid = 0;
    let bcpInvalid = 0;
    let bcpUnverified = 0;
    if (fresh.length) {
      try {
        const customers = await findPancakeCustomersByDni(fresh.map(row => row.client));
        pancakeMatched = fresh.filter(row => customers.has(row.client)).length;
        pancakeUnmatched = fresh.length - pancakeMatched;
        for (const row of fresh) {
          const customer = customers.get(row.client);
          if (!customer) continue;
          row.pancake_alias = customer.alias;
          const profile = getPancakeBcpProfile(customer);
          row.pancake_account = profile.bcpAccounts.join(",");
          row.community = ["1%", "0.5%", "0.35%"].includes(profile.commission) ? profile.commission.slice(0, -1) : "";
          // Match the BCP efectivización rule used by Turnos ATK:
          // profiles at 0.35% or 0.5% use a 0.5% fee; profile 1% uses 1%.
          row.rate = ["0.35%", "0.5%"].includes(profile.commission) ? 50 : 100;
        }
        for (const row of fresh) {
          if (!row.pancake_account) continue;
          const result = await validateBcpAccountDni(row.client, row.pancake_account.split(","));
          row.bcp_validation = result.status;
        }
        bcpValid = fresh.filter(row => row.bcp_validation === "valid").length;
        bcpInvalid = fresh.filter(row => row.bcp_validation === "invalid").length;
        bcpUnverified = fresh.filter(row => row.pancake_account && (!row.bcp_validation || row.bcp_validation === "unverified")).length;
      } catch (error) {
        pancakeWarning = error instanceof Error ? error.message : "No se pudo consultar Pancake.";
      }
    }

    let added = 0;
    const filename = body.filename.slice(0, 250);
    for (let i = 0; i < fresh.length; i += 80) {
      const batch = fresh.slice(i, i + 80);
      const params: unknown[] = [];
      const tuples = batch.map((row) => {
        const values = [row.code, row.client, row.account, row.date, row.time, row.cents, row.channel, row.raw, filename, row.rate ?? 100, row.community || "", row.pancake_alias || "", row.pancake_account || "", row.bcp_validation || "unverified"];
        const start = params.length;
        params.push(...values);
        return `(${values.map((_, index) => `$${start + index + 1}`).join(",")})`;
      });
      const inserted = await sql.query(
        `INSERT INTO operations (code, client, account, date, time, cents, channel, raw, filename, rate, community, pancake_alias, pancake_account, bcp_validation)
         VALUES ${tuples.join(",")}
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        params,
      ) as { code: string }[];
      added += inserted.length;

      // If another import won a race, classify the skipped code accurately.
      const insertedCodes = new Set(inserted.map((row) => row.code));
      const skipped = batch.filter((row) => !insertedCodes.has(row.code));
      for (let j = 0; j < skipped.length; j += 500) {
        const raced = await queryPayments(sql, skipped.slice(j, j + 500).map((row) => row.code));
        const racedByCode = new Map(raced.map((row) => [row.code, row]));
        for (const row of skipped.slice(j, j + 500)) {
          const old = racedByCode.get(row.code);
          if (!old) continue;
          if (samePayment(old, row)) duplicates++;
          else conflicts.add(row.code);
        }
      }
    }

    const conflictCodes = [...conflicts];
    await sql`INSERT INTO imports (id, filename, created, added, duplicates, conflicts)
      VALUES (${crypto.randomUUID()}, ${filename}, ${new Date().toISOString()}, ${added}, ${duplicates}, ${conflictCodes.length})`;
    return json({ added, duplicates, conflicts: conflictCodes, total: incoming.length, pancake: { matched: pancakeMatched, unmatched: pancakeUnmatched, warning: pancakeWarning || null }, bcp: { valid: bcpValid, invalid: bcpInvalid, unverified: bcpUnverified } });
  } catch {
    return json({ error: "No se pudo completar la importación. Puedes reintentar; los códigos guardados no se duplicarán." }, 500);
  }
}

export async function PATCH(req: Request) {
  if (!allowed(req)) return json({ error: "Origen no permitido" }, 403);
  try {
    const body = await req.json() as Partial<Payment> & { status?: string; document?: string; reference?: string; rate?: number; company?: string; operation_type?: string };
    if (
      typeof body.code !== "string" || !/^\d{8}$/.test(body.code) ||
      !["Pendiente", "Completado", "Observado"].includes(body.status ?? "") ||
      !["Sin asignar", "Boleta", "Factura"].includes(body.document ?? "") ||
      typeof body.reference !== "string" || body.reference.length > 80 ||
      !Number.isInteger(body.rate) || (body.rate as number) < 0 || (body.rate as number) > 10000 ||
      (body.paid_account !== undefined && body.paid_account !== "" && !/^\d{13,14}$/.test(body.paid_account))
    ) return json({ error: "Datos inválidos" }, 400);
    if ((body.company || "").trim().toLowerCase() === "bcp" && (body.operation_type || "Efectivización") === "Efectivización" && !isValidBcpEffectRate(body.rate as number)) {
      return json({ error: "Para efectivización BCP usa 0.35 %, 0.5 % o 1 %." }, 400);
    }

    const sql = database();
    await ensureSchema(sql);
    const updated = await sql`UPDATE operations SET status=${body.status}, document=${body.document},
      reference=${body.reference}, rate=${body.rate},
      paid_account=COALESCE(NULLIF(${body.paid_account ?? ""}, ''), paid_account)
      WHERE code=${body.code} RETURNING code` as unknown as { code: string }[];
    if (!updated.length) return json({ error: "No se encontró la operación." }, 404);
    return json({ ok: true });
  } catch {
    return json({ error: "No se pudo guardar el cambio." }, 500);
  }
}
