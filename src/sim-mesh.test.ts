import { describe, it, expect, vi } from 'vitest'
import { SimMesh } from './sim-mesh.js'

describe('SimMesh', () => {
  it('delivers a broadcast to every subscribed peer except the sender', () => {
    const mesh = new SimMesh()
    const venue = mesh.node('venue')
    const a = mesh.node('a')
    const onA = vi.fn()
    a.subscribe(onA)
    venue.broadcast({ kind: 'offer', payload: { offerId: 'o1' } })
    expect(onA).toHaveBeenCalledWith({ kind: 'offer', payload: { offerId: 'o1' }, from: 'venue' })
  })

  it('a directed send reaches only the addressed peer', () => {
    const mesh = new SimMesh()
    const venue = mesh.node('venue')
    const a = mesh.node('a'); const b = mesh.node('b')
    const onA = vi.fn(); const onB = vi.fn()
    a.subscribe(onA); b.subscribe(onB)
    venue.send('a', { kind: 'grant', payload: { offerId: 'o1' } })
    expect(onA).toHaveBeenCalledOnce()
    expect(onB).not.toHaveBeenCalled()
  })

  it('close() stops further delivery', () => {
    const mesh = new SimMesh()
    const a = mesh.node('a')
    const onA = vi.fn()
    const sub = a.subscribe(onA)
    sub.close()
    mesh.node('v').broadcast({ kind: 'offer', payload: {} })
    expect(onA).not.toHaveBeenCalled()
  })

  it('broadcast skips a subscribed sender, and a send to an unknown peer is a no-op', () => {
    const mesh = new SimMesh()
    const a = mesh.node('a'); const b = mesh.node('b')
    const onA = vi.fn(); const onB = vi.fn()
    a.subscribe(onA); b.subscribe(onB)
    // The sender is itself subscribed → the broadcast loop must skip its own id.
    // (`kind: 'ping'` is an arbitrary application kind — the transport never interprets it.)
    a.broadcast({ kind: 'ping', payload: 1 })
    expect(onA).not.toHaveBeenCalled()
    expect(onB).toHaveBeenCalledWith({ kind: 'ping', payload: 1, from: 'a' })
    // A directed send to a peer with no registered handlers is silently dropped, never throws.
    expect(() => a.send('ghost', { kind: 'ping', payload: 2 })).not.toThrow()
    expect(onB).toHaveBeenCalledOnce()
  })
})
