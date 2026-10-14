import bcrypt from 'bcryptjs';

const COST = 10;

export async function hashPassword(plain: string): Promise<string> {
  if (!plain || plain.length < 6) throw new Error('密码长度至少 6 位');
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
