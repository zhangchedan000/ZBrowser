import { describe, expect, it } from 'vitest'
import type { BrowserProfile } from '../shared/types'
import { createStoredZip, diagnosticProfileSummary, redactDiagnosticText } from './diagnostic-bundle'

function profileFixture(): BrowserProfile {
  return {
    id: 'profile-1',
    serialNumber: 1,
    name: 'Support profile',
    note: 'private note https://secret.example/account',
    group: 'test',
    tags: ['support'],
    extensionIds: [],
    color: '#5965e8',
    startUrls: ['https://private.example/path'],
    kernelVersion: '144.0.7559.132',
    kernelFamily: 'fingerprint-chromium',
    window: { mode: 'auto', x: 0, y: 0, width: 1200, height: 800 },
    favorite: false,
    proxy: {
      protocol: 'http',
      host: 'proxy.secret.example',
      port: 8080,
      username: 'alice',
      password: 'super-secret',
      passwordStored: true
    },
    fingerprint: {
      seed: 42,
      hardwareProfileId: 'windows-11-rtx4070',
      gpuBucket: 34,
      renderIdentityVersion: 4,
      platform: 'windows',
      platformVersion: '10.0.0',
      brand: 'Chrome',
      brandVersion: '',
      hardwareConcurrency: 16,
      language: 'en-US',
      acceptLanguages: 'en-US,en',
      timezone: 'America/New_York',
      webrtcPolicy: 'proxy_only',
      networkIdentityMode: 'manual',
      proxyExitPolicy: 'block',
      screenWidth: 2560,
      screenHeight: 1440,
      disabledSpoofing: []
    },
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    status: 'closed'
  }
}

describe('diagnostic bundle', () => {
  it('omits proxy credentials, proxy endpoint, notes and start URLs from profile summaries', () => {
    const serialized = JSON.stringify(diagnosticProfileSummary(profileFixture()))
    expect(serialized).not.toContain('proxy.secret.example')
    expect(serialized).not.toContain('alice')
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('private.example')
    expect(serialized).not.toContain('private note')
    expect(serialized).toContain('"credentialsConfigured":true')
  })

  it('redacts secret JSON fields and local paths', () => {
    const redacted = redactDiagnosticText(
      '{"token":"abc123","message":"C:\\\\Users\\\\Alice\\\\vault"}',
      ['C:\\Users\\Alice']
    )
    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('C:\\Users\\Alice')
    expect(redacted).toContain('[LOCAL_PATH]')
  })

  it('creates a stored ZIP containing named diagnostic entries', () => {
    const zip = createStoredZip([
      { name: 'diagnostics.json', data: '{"ok":true}' },
      { name: 'logs/current.log', data: 'safe log' }
    ], new Date('2026-09-22T12:00:00Z'))

    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304')
    expect(zip.includes(Buffer.from('diagnostics.json'))).toBe(true)
    expect(zip.includes(Buffer.from('logs/current.log'))).toBe(true)
    expect(zip.includes(Buffer.from('safe log'))).toBe(true)
  })
})
