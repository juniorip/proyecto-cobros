const PANCAKE_API = "https://pages.fm/api/public_api/v2";
const PAGE_SIZE = 60;

type RecordValue = Record<string, unknown>;
type Customer = { alias: string; profileName: string | null; notes: string[] };

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function notes(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(notes);
  const item = record(value);
  const text = item && (string(item.message) ?? string(item.content) ?? string(item.note));
  return text ? [text] : [];
}

export async function findPancakeCustomersByDni(dnis: string[]): Promise<Map<string, Customer>> {
  const pageId = process.env.PANCAKE_PAGE_ID?.trim();
  const token = process.env.PANCAKE_PAGE_ACCESS_TOKEN?.trim();
  if (!pageId || !token) throw new Error("Pancake no está configurado en este proyecto.");

  const wanted = new Set(dnis.map(dni => dni.replace(/\D/g, "")).filter(dni => dni.length === 8));
  const found = new Map<string, Customer>();
  if (!wanted.size) return found;
  let cursor = "";
  while (true) {
    const query = new URLSearchParams({ page_access_token: token, page_size: String(PAGE_SIZE) });
    if (cursor) query.set("last_conversation_id", cursor);
    const response = await fetch(`${PANCAKE_API}/pages/${encodeURIComponent(pageId)}/conversations?${query}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Pancake rechazó la consulta. Revisa el token de acceso." : `Pancake respondió con error (${response.status}).`);
    const payload = record(await response.json().catch(() => null));
    if (!payload) throw new Error("Pancake devolvió una respuesta que no se pudo leer.");
    if (payload.success === false) throw new Error("Pancake rechazó la consulta.");
    const conversations = Array.isArray(payload.conversations) ? payload.conversations : Array.isArray(payload.data) ? payload.data : null;
    if (!conversations) throw new Error("Pancake no devolvió la lista de conversaciones esperada.");

    for (const raw of conversations) {
      const conversation = record(raw);
      if (!conversation) continue;
      const sender = record(conversation.from);
      const customers = Array.isArray(conversation.customers) ? conversation.customers.map(record).filter((item): item is RecordValue => Boolean(item)) : [];
      const pageCustomer = record(conversation.page_customer) ?? customers.map(item => record(item.page_customer)).find(Boolean) ?? null;
      const aliases = [string(sender?.alias), ...customers.map(item => string(item.alias)), string(pageCustomer?.alias)].filter((item): item is string => Boolean(item));
      const matches = aliases.flatMap(alias => {
        const aliasDigits = alias.replace(/\D/g, "");
        return [...wanted].filter(dni => aliasDigits.includes(dni)).map(dni => ({ dni, alias }));
      });
      if (!matches.length) continue;
      const noteValues = [pageCustomer?.notes, ...customers.map(item => item.notes)].flatMap(notes);
      for (const { dni, alias } of matches) {
        if (found.has(dni)) continue;
        found.set(dni, {
          alias,
          profileName: string(pageCustomer?.name) ?? customers.map(item => string(item.name)).find(Boolean) ?? string(sender?.name),
          notes: [...new Set(noteValues)],
        });
        wanted.delete(dni);
      }
      if (!wanted.size) return found;
    }

    if (conversations.length < PAGE_SIZE) break;
    const last = record(conversations[conversations.length - 1]);
    const next = string(payload.last_conversation_id) ?? string(payload.next_cursor) ?? string(last?.id);
    if (!next || next === cursor) break;
    cursor = next;
  }
  return found;
}

export async function findPancakeCustomerByDni(dni: string): Promise<Customer | null> {
  const found = await findPancakeCustomersByDni([dni]);
  return found.get(dni.replace(/\D/g, "")) ?? null;
}

function plainNotes(customer: Customer): string[] {
  return customer.notes.map(note => note
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .trim());
}

export function getPancakeBcpProfile(customer: Customer) {
  const texts = plainNotes(customer);
  const normalized = `${texts.join("\n")}\n${customer.alias}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ");
  const rates = new Set<string>();
  for (const match of normalized.matchAll(/(\d+(?:[.,]\d+)?|[.,]\d+)\s*%/g)) {
    const value = Number(match[1].replace(",", "."));
    if ([0.35, 0.5, 1].includes(value)) rates.add(`${value}%`);
  }
  // Pancake aliases often store the commission as a bare decimal after the
  // DNI (for example "42912037 0.35 Jose..."), without a percent sign.
  const aliasWithoutDni = customer.alias.replace(/\b\d{8}\b/g, " ");
  for (const match of aliasWithoutDni.matchAll(/(?:^|\s)(0[.,](?:35|5))(?=\s|$)/g)) {
    const value = Number(match[1].replace(",", "."));
    rates.add(`${value}%`);
  }
  if (/\b(?:beto|luis|humberto|ccfvip|atk|jack|martin)[\s._-]*30\b/i.test(normalized) || /\b(?:vip[\s._-]*30|beto[\s._-]*35)\b/i.test(normalized)) rates.add("0.35%");
  if (/\batk[\s._-]*50\b/i.test(normalized)) rates.add("0.5%");
  if (/\bremy\b/i.test(normalized)) rates.add("1%");
  const commission = rates.size > 1 ? "Por confirmar" : [...rates][0] ?? "No encontrada";

  const accounts = new Set<string>();
  const bankPattern = /(?<![a-z])B[ .]*C[ .]*P(?![a-z])/i;
  for (const text of texts) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const bankMatch = bankPattern.exec(line);
      const explicitAccount = /\b(?:CUENTA|CTA|CCI)\b/i.test(line);
      const addNumbers = (source: string) => {
        const stripped = source.replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, " ").replace(/(?:\d+(?:[.,]\d+)?|[.,]\d+)\s*%/g, " ");
        for (const match of stripped.matchAll(/\d[\d -]*\d|\d/g)) {
          const account = match[0].replace(/\D/g, "");
          // The BCP account validation endpoint accepts 13–14 digit account
          // numbers. Short card endings and 20 digit CCI values are not accounts.
          if (account.length === 13 || account.length === 14) accounts.add(account);
        }
      };
      if (bankMatch) {
        // On notes such as "0050 - 5267 BCP 1919...", digits before BCP
        // are the card ending; only take the account written after the bank.
        const afterBank = line.slice(bankMatch.index + bankMatch[0].length);
        if (/\d/.test(afterBank)) addNumbers(afterBank);
        else if (index > 0) addNumbers(lines[index - 1]);
      } else if (explicitAccount) {
        addNumbers(line);
      }
    }
  }
  return { commission, bcpAccounts: [...accounts] };
}
