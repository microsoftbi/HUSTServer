import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';

describe('password', () => {
  it('哈希后可校验通过', async () => {
    const hash = await hashPassword('secret123');
    expect(hash).not.toBe('secret123');
    expect(await verifyPassword('secret123', hash)).toBe(true);
  });

  it('错误密码校验失败', async () => {
    const hash = await hashPassword('secret123');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('过短密码拒绝', async () => {
    await expect(hashPassword('123')).rejects.toThrow('至少');
  });

  it('非法哈希不抛异常而返回 false', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});
