import { calculateBcpPaymentChecksum, detectBcpAccount } from "./bcp-payment-checksum";
import { calculateCommissionCents } from "./bcp-commission";

export type PendingBcpPayment = {
  code: string;
  client: string;
  pancake_alias?: string;
  pancake_account?: string;
  cents: number | string;
  rate: number;
  company?: string;
  operation_type?: string;
  status: string;
};

export type BcpPaymentFileOptions = {
  payments: PendingBcpPayment[];
  selectedAccounts: Record<string, string>;
  cargoAccount: string;
  processDate: string;
  sequence: string;
};

export function isExportablePendingBcpPayment(payment: PendingBcpPayment): boolean {
  const hasPancakeMatch = Boolean(payment.pancake_alias?.trim());
  const hasBankAccount = (payment.pancake_account ?? "")
    .split(",")
    .some(account => [13, 14].includes(digits(account).length));
  return payment.status === "Pendiente" &&
    (payment.company ?? "").trim().toLowerCase() === "bcp" &&
    (payment.operation_type ?? "Efectivización") === "Efectivización" &&
    hasPancakeMatch && hasBankAccount;
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function paymentName(alias: string | undefined, dni: string): string {
  return (alias ?? "")
    .replace(new RegExp(dni.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*%/g, " ")
    .replace(/\b(?:C\s*\.?\s*E\s*\.?|D\s*\.?\s*N\s*\.?\s*I\s*\.?|R\s*\.?\s*U\s*\.?\s*C\s*\.?|PASAPORTE)\b/gi, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^\p{L}\p{M}\s'-]/gu, " ")
    .replace(/[·|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function place(target: string[], start: number, width: number, value: string, align: "left" | "right" = "left") {
  const text = align === "right" ? value.padStart(width, "0") : value.padEnd(width, " ");
  if (text.length > width) throw new Error(`El campo de ancho ${width} excede el formato del TXT.`);
  for (let i = 0; i < width; i += 1) target[start + i] = text[i];
}

function moneyField(cents: number, width: number): string {
  return (cents / 100).toFixed(2).padStart(width, "0");
}

function buildDetail(payment: PendingBcpPayment, accountNumber: string, netCents: number): string {
  const dni = digits(payment.client);
  if (!/^\d{8}$/.test(dni)) throw new Error(`${payment.code}: el documento debe tener 8 dígitos.`);
  const account = detectBcpAccount(accountNumber);
  if (!account.fileCode) throw new Error(`${payment.code}: el CCI no se puede exportar como abono a cuenta con este formato.`);
  const name = paymentName(payment.pancake_alias, dni);
  if (!name) throw new Error(`${payment.code}: falta el nombre del beneficiario en el alias de Pancake.`);
  if (name.length > 75) throw new Error(`${payment.code}: el nombre del beneficiario supera los 75 caracteres del formato.`);

  const line = Array<string>(196).fill(" ");
  place(line, 0, 1, "2");
  place(line, 1, 1, account.fileCode);
  // Keep the account's original digits; BCP rejects current accounts when
  // a zero is prefixed. The fixed-width field is padded with spaces on right.
  place(line, 2, 14, account.number);
  const documentType = dni.startsWith("00") ? "3" : "1";
  place(line, 22, 17, `1${documentType}${dni}`);
  place(line, 39, 75, name);
  place(line, 114, 24, "Referencia Beneficiario");
  place(line, 138, 16, dni);
  place(line, 154, 8, "Ref Emp");
  place(line, 162, 12, dni);
  place(line, 174, 4, "0001");
  place(line, 178, 17, moneyField(netCents, 17));
  place(line, 195, 1, "S");
  return line.join("");
}

/** Build the bank TXT using pending BCP efectivizaciones only. */
export function generatePendingBcpPaymentFile(options: BcpPaymentFileOptions): string {
  const { payments, selectedAccounts, cargoAccount, processDate, sequence } = options;
  const pending = payments.filter(isExportablePendingBcpPayment);
  if (!pending.length) throw new Error("No hay efectivizaciones BCP pendientes para exportar.");
  if (pending.length > 999_999) throw new Error("La cantidad supera el límite de registros del formato.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(processDate) || Number.isNaN(Date.parse(`${processDate}T00:00:00`))) {
    throw new Error("Selecciona una fecha de proceso válida.");
  }
  if (!/^\d{3}$/.test(sequence)) throw new Error("La referencia debe tener exactamente 3 dígitos (001, 002, …).");

  const charge = detectBcpAccount(cargoAccount);
  if (charge.kind !== "current" || charge.fileCode !== "C") {
    throw new Error("La cuenta de cargo del formato debe tener 13 dígitos y ser tipo C.");
  }

  const normalized = pending.map(payment => {
    const selected = selectedAccounts[payment.code];
    if (!selected) throw new Error(`${payment.code}: selecciona una cuenta de abono.`);
    const account = detectBcpAccount(selected);
    if (!account.fileCode) throw new Error(`${payment.code}: el formato de abono no admite CCI.`);
    const gross = Number(payment.cents);
    const fee = calculateCommissionCents({
      cents: gross,
      rate: Number(payment.rate),
      company: payment.company ?? "BCP",
      operationType: payment.operation_type ?? "Efectivización",
    });
    const net = gross - fee;
    if (!Number.isSafeInteger(gross) || net <= 0) throw new Error(`${payment.code}: el monto neto no es válido.`);
    return { payment, account: account.number, net };
  });

  const sumNet = normalized.reduce((sum, item) => sum + item.net, 0);
  if (!Number.isSafeInteger(sumNet)) throw new Error("El total neto supera el límite seguro de cálculo.");
  const checksum = calculateBcpPaymentChecksum(charge.number, normalized.map(item => item.account));
  const date = processDate.replace(/-/g, "");
  const header = Array<string>(113).fill(" ");
  place(header, 0, 1, "1");
  place(header, 1, 6, String(normalized.length).padStart(6, "0"));
  place(header, 7, 8, date);
  place(header, 15, 1, "C");
  place(header, 16, 4, "0001");
  place(header, 20, 13, charge.number);
  place(header, 40, 17, moneyField(sumNet, 17));
  place(header, 57, 40, `Referencia PaP${sequence}`);
  place(header, 97, 16, `N${checksum}`);

  return [header.join(""), ...normalized.map(item => buildDetail(item.payment, item.account, item.net))].join("\r\n") + "\r\n";
}

/** Encode the TXT in Windows-1252, which matches the supplied BCP sample. */
export function encodeWindows1252(text: string): Uint8Array {
  const extensions = new Map<number, number>([
    [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
    [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
    [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
    [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
    [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
    [0x017e, 0x9e], [0x0178, 0x9f],
  ]);
  const bytes = new Uint8Array([...text].map(character => {
    const code = character.codePointAt(0)!;
    if (code <= 0xff) return code;
    const encoded = extensions.get(code);
    if (encoded !== undefined) return encoded;
    throw new Error(`El texto contiene un carácter que no admite el archivo BCP: ${character}`);
  }));
  return bytes;
}
