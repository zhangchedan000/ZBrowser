#!/usr/bin/env node

import proxyChain from 'proxy-chain'
import { ProxyAgent, request } from 'undici'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const HTTP_PROXY = process.env.ZBROWSER_TEST_HTTP_PROXY_URL?.trim()
const SOCKS5_PROXY = process.env.ZBROWSER_TEST_SOCKS5_PROXY?.trim()
const OUTPUT = resolve(process.env.ZBROWSER_PROXY_E2E_OUTPUT || 'test-results/proxy-e2e.json')

function proxyProtocol(defaultProtocol) {
  return defaultProtocol === 'socks5' ? 'socks' : defaultProtocol
}

function looksLikeHost(value) {
  const text = String(value ?? '').trim()
  if (!text) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return true
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text) || text === 'localhost'
}

function looksLikePort(value) {
  const port = Number(String(value ?? '').trim())
  return Number.isInteger(port) && port > 0 && port <= 65535
}

function proxyUrl(protocol, host, port, username = '', password = '') {
  const auth = username || password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : ''
  return `${protocol}://${auth}${host}:${port}`
}

function normalizeProxyCandidates(raw, defaultProtocol) {
  const value = String(raw ?? '').trim()
  if (!value) return []

  const protocol = proxyProtocol(defaultProtocol)
  const candidates = []
  const add = (candidate) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate)
  }

  for (const match of value.matchAll(/(?:https?|socks5h?|socks):\/\/[^\s"']+/gi)) {
    const parsed = new URL(match[0])
    if (parsed.protocol === 'socks5:') parsed.protocol = 'socks:'
    add(parsed.toString().replace(/\/$/, ''))
  }

  const atMatch = value.match(/([^\s:@]+):([^\s@]+)@([^\s:]+):(\d{1,5})/)
  if (atMatch) add(proxyUrl(protocol, atMatch[3], atMatch[4], atMatch[1], atMatch[2]))

  const compactTuple = value.match(/((?:\d{1,3}\.){3}\d{1,3})\s*[:|,;\s]\s*(\d{1,5})\s*[:|,;\s]\s*([^:|,;\s]+)\s*[:|,;\s]\s*([^:|,;\s]+)/)
  if (compactTuple) {
    add(proxyUrl(protocol, compactTuple[1], compactTuple[2], compactTuple[3], compactTuple[4]))
    add(proxyUrl(protocol, compactTuple[1], compactTuple[2], compactTuple[4], compactTuple[3]))
  }

  const reverseTuple = value.match(/([^:|,;\s]+)\s*[:|,;\s]\s*([^:|,;\s]+)\s*[:|,;\s]\s*((?:\d{1,3}\.){3}\d{1,3})\s*[:|,;\s]\s*(\d{1,5})/)
  if (reverseTuple) {
    add(proxyUrl(protocol, reverseTuple[3], reverseTuple[4], reverseTuple[1], reverseTuple[2]))
    add(proxyUrl(protocol, reverseTuple[3], reverseTuple[4], reverseTuple[2], reverseTuple[1]))
  }

  const tokens = value.split(/[|,;\s:]+/).map((item) => item.trim()).filter(Boolean)
  if (tokens.length === 2 && looksLikeHost(tokens[0]) && looksLikePort(tokens[1])) {
    add(proxyUrl(protocol, tokens[0], tokens[1]))
  }

  if (tokens.length === 4) {
    for (let hostIndex = 0; hostIndex < tokens.length; hostIndex += 1) {
      if (!looksLikeHost(tokens[hostIndex])) continue
      for (let portIndex = 0; portIndex < tokens.length; portIndex += 1) {
        if (portIndex === hostIndex || !looksLikePort(tokens[portIndex])) continue
        const credentials = tokens.filter((_, index) => index !== hostIndex && index !== portIndex)
        if (credentials.length !== 2) continue
        add(proxyUrl(protocol, tokens[hostIndex], tokens[portIndex], credentials[0], credentials[1]))
        add(proxyUrl(protocol, tokens[hostIndex], tokens[portIndex], credentials[1], credentials[0]))
      }
    }
  }

  if (!candidates.length) {
    const shape = {
      length: value.length,
      colonCount: (value.match(/:/g) || []).length,
      hasAt: value.includes('@'),
      hasScheme: /:\/\//.test(value),
      whitespaceCount: (value.match(/\s/g) || []).length,
      tokenCount: tokens.length
    }
    throw new Error(`Unsupported proxy format for ${defaultProtocol}; shape=${JSON.stringify(shape)}`)
  }
  return candidates
}

function redact(value) {
  return String(value ?? '')
    .replace(/\/\/([^/@:\s]+):([^/@\s]+)@/g, '//***:***@')
    .replace(/(https?|socks5):\/\/[^\s]+/gi, '$1://***')
}

async function fetchText(url, dispatcher) {
  const response = await request(url, {
    dispatcher,
    method: 'GET',
    headers: { 'user-agent': 'ZBrowser-Proxy-E2E/1.0' },
    headersTimeout: 15000,
    bodyTimeout: 15000
  })
  if (response.statusCode !== 200) {
    await response.body.dump()
    throw new Error(`HTTP ${response.statusCode} from ${url}`)
  }
  return (await response.body.text()).trim()
}

async function fetchJson(url, dispatcher) {
  const response = await request(url, {
    dispatcher,
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'ZBrowser-Proxy-E2E/1.0' },
    headersTimeout: 15000,
    bodyTimeout: 15000
  })
  if (response.statusCode !== 200) {
    await response.body.dump()
    throw new Error(`HTTP ${response.statusCode} from ${url}`)
  }
  return response.body.json()
}

async function withBridge(upstream, fn) {
  let bridgeFailure = ''
  const server = new proxyChain.Server({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: () => ({ upstreamProxyUrl: upstream })
  })
  server.on('requestFailed', ({ error }) => {
    bridgeFailure = redact(error instanceof Error ? error.message : error)
  })
  await server.listen()
  const local = `http://127.0.0.1:${server.port}`
  const dispatcher = new ProxyAgent(local)
  try {
    try {
      return await fn(dispatcher)
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error)
      throw new Error(bridgeFailure ? `${base}; upstream=${bridgeFailure}` : base)
    }
  } finally {
    await dispatcher.close().catch(() => undefined)
    await server.close(true).catch(() => undefined)
  }
}

async function probe(name, upstream, directIp) {
  const startedAt = Date.now()
  return withBridge(upstream, async (dispatcher) => {
    const [ip1, ip2, geo] = await Promise.all([
      fetchText('https://ipv4.icanhazip.com/', dispatcher),
      fetchText('https://api.ipify.org/', dispatcher),
      fetchJson('https://ipwho.is/', dispatcher)
    ])
    if (!ip1 || !ip2 || ip1 !== ip2) {
      throw new Error(`${name} returned inconsistent exit IPs`)
    }
    if (directIp && ip1 === directIp) {
      throw new Error(`${name} exit IP equals runner direct IP; proxy is not taking effect`)
    }
    if (geo?.success === false) {
      throw new Error(`${name} GeoIP lookup failed`)
    }
    return {
      name,
      protocol: new URL(upstream).protocol.replace(':', ''),
      ok: true,
      exitIp: ip1,
      directIpDifferent: !directIp || ip1 !== directIp,
      countryCode: geo?.country_code || null,
      region: geo?.region || null,
      city: geo?.city || null,
      timezone: geo?.timezone?.id || null,
      asn: geo?.connection?.asn || null,
      organization: geo?.connection?.org || null,
      latencyMs: Date.now() - startedAt
    }
  })
}

async function verifyNoDirectFallback() {
  const deadUpstream = 'http://127.0.0.1:9'
  try {
    await withBridge(deadUpstream, async (dispatcher) => {
      await fetchText('https://ipv4.icanhazip.com/', dispatcher)
    })
    return false
  } catch {
    return true
  }
}

async function main() {
  if (!HTTP_PROXY || !SOCKS5_PROXY) {
    throw new Error('Both ZBROWSER_TEST_HTTP_PROXY_URL and ZBROWSER_TEST_SOCKS5_PROXY are required')
  }

  const normalizedHttpCandidates = normalizeProxyCandidates(HTTP_PROXY, 'http')
  const normalizedSocks5Candidates = normalizeProxyCandidates(SOCKS5_PROXY, 'socks5')

  const directIp = await fetchText('https://ipv4.icanhazip.com/')
  const results = []
  for (const [name, candidates] of [['http', normalizedHttpCandidates], ['socks5', normalizedSocks5Candidates]]) {
    let passed
    let lastError
    for (const proxy of candidates) {
      try {
        passed = await probe(name, proxy, directIp)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (passed) {
      results.push(passed)
      console.log(`PASS ${name}: exit=${passed.exitIp} country=${passed.countryCode ?? '-'} timezone=${passed.timezone ?? '-'}`)
    } else {
      results.push({ name, ok: false, error: redact(lastError instanceof Error ? lastError.message : lastError) })
      console.error(`FAIL ${name}: ${redact(lastError instanceof Error ? lastError.message : lastError)}`)
    }
  }

  const noDirectFallback = await verifyNoDirectFallback()
  console.log(`${noDirectFallback ? 'PASS' : 'FAIL'} no-direct-fallback`)

  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    directIp,
    results,
    noDirectFallback,
    passed: results.every((item) => item.ok) && noDirectFallback
  }

  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Report: ${OUTPUT}`)
  if (!report.passed) process.exitCode = 1
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.stack : error))
  process.exitCode = 1
})
