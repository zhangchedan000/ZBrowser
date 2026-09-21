#!/usr/bin/env node

import proxyChain from 'proxy-chain'
import { ProxyAgent, request } from 'undici'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const HTTP_PROXY = process.env.ZBROWSER_TEST_HTTP_PROXY_URL?.trim()
const SOCKS5_PROXY = process.env.ZBROWSER_TEST_SOCKS5_PROXY?.trim()
const OUTPUT = resolve(process.env.ZBROWSER_PROXY_E2E_OUTPUT || 'test-results/proxy-e2e.json')

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

  const directIp = await fetchText('https://ipv4.icanhazip.com/')
  const results = []
  for (const [name, proxy] of [['http', HTTP_PROXY], ['socks5', SOCKS5_PROXY]]) {
    try {
      const result = await probe(name, proxy, directIp)
      results.push(result)
      console.log(`PASS ${name}: exit=${result.exitIp} country=${result.countryCode ?? '-'} timezone=${result.timezone ?? '-'}`)
    } catch (error) {
      results.push({ name, ok: false, error: redact(error instanceof Error ? error.message : error) })
      console.error(`FAIL ${name}: ${redact(error instanceof Error ? error.message : error)}`)
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
