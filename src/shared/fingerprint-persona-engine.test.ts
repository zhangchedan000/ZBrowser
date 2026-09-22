import { describe, expect, it } from 'vitest'
import { defaultFingerprint } from './defaults'
import { applyHardwareProfile } from './hardware-profiles'
import {
  applyFingerprintHardwarePersona,
  fingerprintHardwareRegionForCountry,
  recommendFingerprintHardwarePersona,
  resolveFingerprintPersona
} from './fingerprint-persona-engine'

describe('fingerprint persona engine', () => {
  it('resolves a fixed hardware template to its provenance-aware catalog persona', () => {
    const config = applyHardwareProfile(defaultFingerprint(42), 'windows-11-rtx4070')
    const resolution = resolveFingerprintPersona(config)

    expect(resolution).toMatchObject({
      source: 'catalog',
      consistency: 'coherent',
      personaId: 'win-performance-4070-1440p',
      hardwareConcurrency: 16,
      physicalMemoryGb: 32,
      deviceMemoryGb: 8,
      screenWidth: 2560,
      screenHeight: 1440,
      gpuModel: 'NVIDIA GeForce RTX 4070'
    })
    expect(resolution.sourceIds).toContain('steam-hardware-survey')
    expect(resolution.warnings).toEqual([])
  })

  it('detects visible hardware drift against the selected persona contract', () => {
    const config = {
      ...applyHardwareProfile(defaultFingerprint(42), 'windows-11-rtx4070'),
      hardwareConcurrency: 8,
      screenWidth: 1920
    }
    const resolution = resolveFingerprintPersona(config)

    expect(resolution.consistency).toBe('conflict')
    expect(resolution.warnings.join(' ')).toContain('CPU 核心数')
    expect(resolution.warnings.join(' ')).toContain('屏幕宽度')
  })

  it('describes seeded profiles without remapping their pinned GPU identity', () => {
    const config = applyHardwareProfile(defaultFingerprint(123), 'windows-seeded-nvidia', { refreshSeededGpu: true })
    const before = JSON.stringify(config)
    const resolution = resolveFingerprintPersona(config)

    expect(resolution.source).toBe('seeded-profile')
    expect(resolution.consistency).toBe('coherent')
    expect(resolution.gpuModel).toMatch(/NVIDIA/)
    expect(resolution.stableKey).toContain(String(config.gpuBucket))
    expect(JSON.stringify(config)).toBe(before)
  })

  it('keeps legacy seeded profiles unresolved instead of silently assigning a new GPU', () => {
    const config = {
      ...defaultFingerprint(42),
      hardwareProfileId: 'windows-seeded-nvidia' as const,
      gpuBucket: undefined,
      renderIdentityVersion: undefined
    }
    const resolution = resolveFingerprintPersona(config)

    expect(resolution.source).toBe('seeded-profile')
    expect(resolution.consistency).toBe('unresolved')
    expect(resolution.stableKey).toContain('legacy')
    expect(resolution.warnings.join(' ')).toContain('不会自动重新分配')
  })

  it('recommends catalog personas deterministically for new profiles', () => {
    expect(recommendFingerprintHardwarePersona({ platform: 'windows', seed: 0 })?.id)
      .toBe('win-mainstream-3060-1080p')
    expect(recommendFingerprintHardwarePersona({ platform: 'windows', seed: 100 })?.id)
      .toBe('win-mainstream-4060-1080p')
    expect(recommendFingerprintHardwarePersona({ platform: 'windows', seed: 100 })?.id)
      .toBe(recommendFingerprintHardwarePersona({ platform: 'windows', seed: 100 })?.id)
    expect(recommendFingerprintHardwarePersona({ platform: 'macos', seed: 0 })?.id)
      .toBe('mac-mainstream-m1')
  })

  it('maps proxy countries to broad hardware recommendation regions', () => {
    expect(fingerprintHardwareRegionForCountry('US')).toBe('us')
    expect(fingerprintHardwareRegionForCountry('DE')).toBe('eu')
    expect(fingerprintHardwareRegionForCountry('JP')).toBe('apac')
    expect(fingerprintHardwareRegionForCountry('BR')).toBe('global')
    expect(fingerprintHardwareRegionForCountry(undefined)).toBe('global')
  })

  it('applies a recommended persona only when explicitly requested', () => {
    const config = defaultFingerprint(987654)
    const applied = applyFingerprintHardwarePersona(config, 'win-mainstream-4060-1080p')

    expect(applied).toMatchObject({
      seed: 987654,
      hardwareProfileId: 'windows-11-rtx4060',
      hardwarePersonaId: 'win-mainstream-4060-1080p',
      hardwareConcurrency: 12,
      screenWidth: 1920,
      screenHeight: 1080
    })
    expect(applyFingerprintHardwarePersona(config, 'missing-persona')).toBeUndefined()
  })
})
