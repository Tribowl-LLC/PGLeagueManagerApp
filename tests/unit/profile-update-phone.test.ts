import { describe, expect, it } from 'vitest';
import { profileUpdateSchema } from '../../server/routes/account';

describe('profile update — phone tri-state semantics', () => {
  it('preserves explicit null (clear intent) so the route can write phone = NULL', () => {
    const parsed = profileUpdateSchema.parse({ phone: null });
    expect(parsed.phone).toBeNull();
    expect('phone' in parsed).toBe(true);
  });

  it('preserves omitted (undefined) so the route knows to leave the column untouched', () => {
    const parsed = profileUpdateSchema.parse({});
    expect(parsed.phone).toBeUndefined();
  });

  it('passes through a valid phone string unchanged', () => {
    const parsed = profileUpdateSchema.parse({ phone: '202-555-0100' });
    expect(parsed.phone).toBe('202-555-0100');
  });

  it('coerces an empty string to null (clear intent from blank-input clients)', () => {
    const parsed = profileUpdateSchema.parse({ phone: '' });
    expect(parsed.phone).toBeNull();
  });

  it('coerces a whitespace-only string to null', () => {
    const parsed = profileUpdateSchema.parse({ phone: '   ' });
    expect(parsed.phone).toBeNull();
  });

  it('rejects a non-string non-null phone value', () => {
    const result = profileUpdateSchema.safeParse({ phone: 12345 });
    expect(result.success).toBe(false);
  });

  it('keeps name and email intact alongside an explicit phone clear', () => {
    const parsed = profileUpdateSchema.parse({
      name: 'Audit User',
      email: 'audit@example.com',
      phone: null,
    });
    expect(parsed.name).toBe('Audit User');
    expect(parsed.email).toBe('audit@example.com');
    expect(parsed.phone).toBeNull();
  });
});
