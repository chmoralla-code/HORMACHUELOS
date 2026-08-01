import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const FORMAT = "horma-secret-v1";
const KEY_ENV_NAMES = [
  "HORMACHUELOS_MODEL_CONFIG_KEY",
  "MODEL_CONFIG_ENCRYPTION_KEY",
  // Existing server-only secret is a safe fallback for already configured
  // deployments. A dedicated key is preferred so credentials can survive a
  // future service-role rotation.
  "SUPABASE_SERVICE_ROLE_KEY",
  "HORMACHUELOS_SERVICE_ROLE",
];

function configuredSecret() {
  for (const name of KEY_ENV_NAMES) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function encryptionKey() {
  const secret = configuredSecret();
  if (!secret) {
    throw Object.assign(
      new Error(
        "Hosted model credential storage is not configured. Set HORMACHUELOS_MODEL_CONFIG_KEY on the server.",
      ),
      { status: 503 },
    );
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function hostedModelCredentialStorageReady() {
  return Boolean(configuredSecret());
}

/** Encrypt a model credential before it is persisted in Supabase. */
export function encryptHostedModelCredential(value) {
  const plain = String(value || "").trim();
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Decrypt only inside the hosted API process; never return this value to clients. */
export function decryptHostedModelCredential(value) {
  const encoded = String(value || "").trim();
  if (!encoded) return "";
  const [format, ivText, tagText, cipherText, extra] = encoded.split(".");
  if (format !== FORMAT || !ivText || !tagText || !cipherText || extra) {
    throw new Error("A hosted model credential has an invalid encrypted format.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("A hosted model credential could not be decrypted by this server.");
  }
}
