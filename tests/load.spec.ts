import { describe, expect, it } from 'vitest'

describe('dsh-feishu-bot', () => {
  it('exports the host plugin contract', async () => {
    const mod = await import('../src/index.ts')
    expect(mod.name).toBe('feishu-bot')
    expect(typeof mod.apply).toBe('function')
    expect(Array.isArray(mod.inject)).toBe(true)
    expect(mod.inject).toContain('webServer')
  })
})
