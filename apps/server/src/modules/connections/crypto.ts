import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const MASKED = '******';

export function deriveKey(keyHex: string | Buffer): Buffer {
  if (typeof keyHex === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      throw new Error('ENCRYPTION_KEY 必须是 64 位十六进制字符串（32 字节）');
    }
    return Buffer.from(keyHex, 'hex');
  }
  if (keyHex.length !== 32) {
    throw new Error('ENCRYPTION_KEY 必须是 32 字节');
  }
  return keyHex;
}

export function encryptConfig(config: Record<string, unknown>, keyHex: string | Buffer): string {
  const key = deriveKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${data.toString('base64')}`;
}

export function decryptConfig(payload: string, keyHex: string | Buffer): Record<string, unknown> {
  const key = deriveKey(keyHex);
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('密文格式非法');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
}

export function maskConnection(config: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...config };
  if (masked.password !== undefined) masked.password = MASKED;
  return masked;
}
