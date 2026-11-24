/**
 * BCP payment-file checksum rule from the supplied format guide.
 * Current accounts contribute their last 10 digits, savings accounts their
 * last 11 digits, and interbank CCI numbers their last 10 digits. The cargo
 * account is included in the sum, and the result is left-padded to 15 digits.
 */

export type BcpAccountKind = "current" | "savings" | "cci";

export type DetectedBcpAccount = {
  number: string;
  kind: BcpAccountKind;
  fileCode: "C" | "A" | null;
  digitsForChecksum: number;
};

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Cheque de gerencia: preserve document length and replace letters with 0. */
export function normalizeGuaranteeDocumentNumber(value: string): string {
  return value.replace(/[A-Za-z]/g, "0").replace(/\D/g, "");
}

/** Infer account type from the digit count shown by the supplied BCP template. */
export function detectBcpAccount(number: string): DetectedBcpAccount {
  const digits = digitsOnly(number);
  if (digits.length === 13) {
    return { number: digits, kind: "current", fileCode: "C", digitsForChecksum: 10 };
  }
  if (digits.length === 14) {
    return { number: digits, kind: "savings", fileCode: "A", digitsForChecksum: 11 };
  }
  if (digits.length === 20) {
    return { number: digits, kind: "cci", fileCode: null, digitsForChecksum: 10 };
  }
  throw new Error(`No se puede identificar el tipo de cuenta: ${digits.length} dígitos. Se esperan 13 (C), 14 (A) o 20 (CCI).`);
}

/** Extract the rightmost digits required for one account/document contribution. */
export function bcpChecksumContribution(number: string): bigint {
  const account = detectBcpAccount(number);
  return BigInt(account.number.slice(-account.digitsForChecksum));
}

/**
 * Calculates the 15-character numeric checksum. `cargoAccount` must be the
 * first account; all beneficiary accounts are added to it.
 */
export function calculateBcpPaymentChecksum(
  cargoAccount: string,
  beneficiaryAccounts: string[],
): string {
  if (!beneficiaryAccounts.length) {
    throw new Error("Agrega al menos una cuenta de abono para calcular el checksum.");
  }

  const sum = [cargoAccount, ...beneficiaryAccounts].reduce(
    (total, account) => total + bcpChecksumContribution(account),
    BigInt(0),
  );
  const result = sum.toString();

  if (result.length > 15) {
    throw new Error("La suma del checksum supera las 15 posiciones permitidas.");
  }

  return result.padStart(15, "0");
}

/** Header field used by the supplied TXT sample: marker N + 15 checksum digits. */
export function formatBcpPaymentChecksumField(
  cargoAccount: string,
  beneficiaryAccounts: string[],
): string {
  return `N${calculateBcpPaymentChecksum(cargoAccount, beneficiaryAccounts)}`;
}
