import { describe, it, expect } from 'vitest'
import { createSimChannelPair } from './channel.js'

describe('SimChannel', () => {
  it('delivers ordered bytes both ways', async () => {
    const [a, b] = createSimChannelPair()
    a.send(new Uint8Array([1, 2, 3]))
    b.send(new Uint8Array([9]))
    expect(await b.recv()).toEqual(new Uint8Array([1, 2, 3]))
    expect(await a.recv()).toEqual(new Uint8Array([9]))
  })

  it('preserves message order under multiple sends', async () => {
    const [a, b] = createSimChannelPair()
    a.send(new Uint8Array([1])); a.send(new Uint8Array([2]))
    expect(await b.recv()).toEqual(new Uint8Array([1]))
    expect(await b.recv()).toEqual(new Uint8Array([2]))
  })

  it('close() causes pending recv() to reject', async () => {
    const [a, b] = createSimChannelPair()
    const pending = b.recv()
    a.close()
    // close() on a also closes b (the pair closes together)
    b.close()
    await expect(pending).rejects.toThrow('channel closed')
  })

  it('recv() on an already-closed channel rejects immediately', async () => {
    const [a] = createSimChannelPair()
    a.close()
    await expect(a.recv()).rejects.toThrow('channel closed')
  })
})
