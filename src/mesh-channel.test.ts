/**
 * Unit tests for the MeshTransport → SecureChannel adapter.
 * Mirrors channel.test.ts — same FIFO and close() semantics, exercised over
 * two SimMesh nodes rather than a SimChannelPair.
 */

import { describe, it, expect } from 'vitest'
import { SimMesh } from './sim-mesh.js'
import { meshChannel } from './mesh-channel.js'

/** Set up two connected SimMesh nodes and return their SecureChannel views. */
function makePair(): [ReturnType<typeof meshChannel>, ReturnType<typeof meshChannel>] {
  const mesh = new SimMesh()
  const tA = mesh.node('alice')
  const tB = mesh.node('bob')
  const chA = meshChannel(tA, 'bob')   // alice's channel → bob
  const chB = meshChannel(tB, 'alice') // bob's channel → alice
  return [chA, chB]
}

describe('meshChannel', () => {
  it('delivers ordered bytes both ways', async () => {
    const [a, b] = makePair()
    a.send(new Uint8Array([1, 2, 3]))
    b.send(new Uint8Array([9]))
    expect(await b.recv()).toEqual(new Uint8Array([1, 2, 3]))
    expect(await a.recv()).toEqual(new Uint8Array([9]))
  })

  it('preserves message order under multiple sends from one side', async () => {
    const [a, b] = makePair()
    a.send(new Uint8Array([1]))
    a.send(new Uint8Array([2]))
    a.send(new Uint8Array([3]))
    expect(await b.recv()).toEqual(new Uint8Array([1]))
    expect(await b.recv()).toEqual(new Uint8Array([2]))
    expect(await b.recv()).toEqual(new Uint8Array([3]))
  })

  it('recv() blocks until a frame arrives then resolves in order', async () => {
    const [a, b] = makePair()
    const p1 = b.recv()
    const p2 = b.recv()
    a.send(new Uint8Array([10]))
    a.send(new Uint8Array([20]))
    expect(await p1).toEqual(new Uint8Array([10]))
    expect(await p2).toEqual(new Uint8Array([20]))
  })

  it('ignores frames from a third node (peer filter)', async () => {
    // a subscribes to 'bob' only; a third node sends to alice — should be ignored.
    const mesh = new SimMesh()
    const tA = mesh.node('alice')
    const tB = mesh.node('bob')
    const tC = mesh.node('carol')
    const chA = meshChannel(tA, 'bob')

    // carol sends directly to alice — must NOT arrive on chA (wrong peer)
    tC.send('alice', { kind: 'channel', payload: new Uint8Array([99]) })
    // bob sends to alice with kind 'channel' — MUST arrive
    meshChannel(tB, 'alice') // subscribe bob (needed for SimMesh to know 'bob')
    tB.send('alice', { kind: 'channel', payload: new Uint8Array([42]) })

    expect(await chA.recv()).toEqual(new Uint8Array([42]))
  })

  it('ignores frames from the peer with a non-channel kind (kind filter)', async () => {
    // Even if a frame comes FROM our target peer, it must be dropped when kind !== 'channel'.
    // This prevents toll 'grant' frames (or any other kind) from being mis-delivered
    // into the matcher channel when both share one MeshTransport.
    const mesh = new SimMesh()
    const tA = mesh.node('alice')
    const tB = mesh.node('bob')
    const chA = meshChannel(tA, 'bob')
    meshChannel(tB, 'alice') // register bob's transport node

    // bob sends a 'grant' frame (toll kind) — must NOT arrive on chA
    tB.send('alice', { kind: 'grant', payload: new Uint8Array([55]) })
    // bob then sends a proper 'channel' frame — MUST arrive
    tB.send('alice', { kind: 'channel', payload: new Uint8Array([77]) })

    expect(await chA.recv()).toEqual(new Uint8Array([77]))
  })

  it('close() causes a pending recv() to reject with "channel closed"', async () => {
    const [a, b] = makePair()
    const pending = b.recv()
    // close b's channel — pending recv must reject
    b.close()
    await expect(pending).rejects.toThrow('channel closed')
    // a is still open; any send from a is silently dropped (b is closed)
    expect(() => a.send(new Uint8Array([1]))).not.toThrow()
  })

  it('recv() on an already-closed channel rejects immediately', async () => {
    const [a] = makePair()
    a.close()
    await expect(a.recv()).rejects.toThrow('channel closed')
  })

  it('send() on a closed channel is a no-op (does not throw)', async () => {
    const [a] = makePair()
    a.close()
    expect(() => a.send(new Uint8Array([1]))).not.toThrow()
  })

  it('close() is idempotent — second call does not throw', () => {
    const [a] = makePair()
    a.close()
    expect(() => a.close()).not.toThrow()
  })
})
