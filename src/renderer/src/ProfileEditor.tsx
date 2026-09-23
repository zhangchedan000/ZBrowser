import { ReloadOutlined } from '@ant-design/icons'
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Col,
  ColorPicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Tabs,
  Typography
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { defaultPlatform, defaultProfileDraft, randomSeed } from '../../shared/defaults'
import { fingerprintVersionWarning } from '../../shared/fingerprint-consistency'
import { applyAIIdentityConfigProvenance, applyAIIdentityConfigToFingerprint, generateAIIdentityConfig } from '../../shared/identity-ai-generator'
import { HARDWARE_IDENTITY_FIELDS, markFingerprintConfigSources, normalizeIdentityConfigProvenance } from '../../shared/identity-config-provenance'
import {
  applyFingerprintHardwarePersona,
  fingerprintHardwareRegionForCountry,
  recommendFingerprintHardwarePersona,
  resolveFingerprintPersona
} from '../../shared/fingerprint-persona-engine'
import {
  applyHardwareProfile,
  effectiveGpuIdentity,
  HARDWARE_PROFILES,
  hardwareProfile,
  hardwareProfileSummary,
  refreshSeededGpuIdentity
} from '../../shared/hardware-profiles'
import { applyRecommendedProxyNetworkIdentity, effectiveNetworkIdentity, networkIdentityPlan } from '../../shared/network-identity'
import { isKernelDowngrade, kernelFamilyForRelease, kernelMajorVersion, kernelReleaseMatchesPin, latestSameMajorCompatibleKernelVersion, newerCompatibleKernelVersion } from '../../shared/kernel-version'
import type { BrowserExtension, BrowserProfileView, EngineStatus, HardwareProfileId, IdentityConfigProvenance, KernelRelease, ProfileDraft, ProxyTestResult } from '../../shared/types'

interface EditorValues extends Omit<ProfileDraft, 'startUrls' | 'color'> {
  startUrlsText: string
  color: string | { toHexString: () => string }
}

interface ProfileEditorProps {
  open: boolean
  profile?: BrowserProfileView
  suggestedIndex: number
  saving: boolean
  extensions: BrowserExtension[]
  engine: EngineStatus | null
  kernels: KernelRelease[]
  groups: string[]
  onCancel: () => void
  onSave: (draft: ProfileDraft) => Promise<void>
}

function editorValues(profile: BrowserProfileView | undefined, index: number): EditorValues {
  const draft = profile ?? defaultProfileDraft(index)
  const fingerprint = { ...draft.fingerprint }
  return {
    name: draft.name,
    note: draft.note,
    group: draft.group,
    tags: [...draft.tags],
    extensionIds: [...draft.extensionIds],
    color: draft.color,
    startUrlsText: draft.startUrls.join('\n'),
    kernelVersion: draft.kernelVersion,
    kernelFamily: draft.kernelFamily,
    environmentType: draft.environmentType ?? 'account',
    window: { ...draft.window },
    proxy: { ...draft.proxy },
    fingerprint: {
      ...fingerprint,
      disabledSpoofing: [...draft.fingerprint.disabledSpoofing]
    }
  }
}

const riskLabels: Record<NonNullable<ProxyTestResult['networkRisk']>, string> = {
  tor: 'Tor 出口',
  vpn: 'VPN 网络',
  proxy: '代理网络',
  hosting: '机房网络'
}

export function ProfileEditor({ open, profile, suggestedIndex, saving, extensions, engine, kernels, groups, onCancel, onSave }: ProfileEditorProps) {
  const [form] = Form.useForm<EditorValues>()
  const proxyConfig = Form.useWatch('proxy', form)
  const proxyProtocol = Form.useWatch(['proxy', 'protocol'], form)
  const proxyPassword = Form.useWatch(['proxy', 'password'], form) ?? ''
  const proxyPasswordStored = Form.useWatch(['proxy', 'passwordStored'], form) === true
  const webrtcPolicy = Form.useWatch(['fingerprint', 'webrtcPolicy'], form) ?? 'proxy_only'
  const fingerprintConfig = Form.useWatch('fingerprint', form)
  const fingerprintTimezone = Form.useWatch(['fingerprint', 'timezone'], form)
  const fingerprintLanguage = Form.useWatch(['fingerprint', 'language'], form) ?? 'zh-CN'
  const fingerprintAcceptLanguages = Form.useWatch(['fingerprint', 'acceptLanguages'], form) ?? 'zh-CN,zh,en-US,en'
  const networkIdentityMode = Form.useWatch(['fingerprint', 'networkIdentityMode'], form) ?? 'manual'
  const brandVersion = Form.useWatch(['fingerprint', 'brandVersion'], form) ?? ''
  const hardwareProfileId = Form.useWatch(['fingerprint', 'hardwareProfileId'], form) ?? 'legacy-custom'
  const fingerprintSeed = Form.useWatch(['fingerprint', 'seed'], form) ?? 0
  const fingerprintGpuBucket = Form.useWatch(['fingerprint', 'gpuBucket'], form)
  const kernelVersion = Form.useWatch('kernelVersion', form) ?? ''
  const kernelFamily = Form.useWatch('kernelFamily', form)
  const windowMode = Form.useWatch(['window', 'mode'], form) ?? 'auto'
  const [testingProxy, setTestingProxy] = useState(false)
  const [applyingAIIdentity, setApplyingAIIdentity] = useState(false)
  const [aiIdentityFeedback, setAiIdentityFeedback] = useState<{ type: 'success' | 'warning'; message: string; description: string } | null>(null)
  const [identityConfigProvenance, setIdentityConfigProvenance] = useState<IdentityConfigProvenance>(() => normalizeIdentityConfigProvenance(profile?.identityConfigProvenance))
  const [proxyResult, setProxyResult] = useState<ProxyTestResult | null>(null)
  const pinnedKernel = kernels.find((kernel) => kernelReleaseMatchesPin(kernel, kernelVersion, kernelFamily))
  const effectiveKernelFamily = kernelFamily ?? (pinnedKernel ? kernelFamilyForRelease(pinnedKernel) : profile?.kernelFamily)
  const automaticPatchVersion = kernelVersion && effectiveKernelFamily
    ? latestSameMajorCompatibleKernelVersion(kernelVersion, effectiveKernelFamily, kernels)
    : undefined
  const automaticPatchKernel = automaticPatchVersion
    ? kernels.find((kernel) => kernelReleaseMatchesPin(kernel, automaticPatchVersion, effectiveKernelFamily))
    : undefined
  const resolvedPinnedKernel = automaticPatchKernel ?? pinnedKernel
  const upgradeVersion = useMemo(
    () => profile?.kernelVersion
      ? newerCompatibleKernelVersion(profile.kernelVersion, effectiveKernelFamily, kernels)
      : undefined,
    [effectiveKernelFamily, kernels, profile?.kernelVersion]
  )
  const upgradeKernel = upgradeVersion
    ? kernels.find((kernel) => kernelReleaseMatchesPin(kernel, upgradeVersion, effectiveKernelFamily))
    : undefined
  const selectedEngine: EngineStatus | null = kernelVersion
    ? {
        executable: resolvedPinnedKernel?.executable ?? null,
        source: resolvedPinnedKernel ? 'profile' : 'missing',
        fingerprintKernel: true,
        label: resolvedPinnedKernel ? 'Fingerprint Chromium（主版本固定）' : '固定主版本无可用内核',
        version: automaticPatchVersion ?? kernelVersion
      }
    : engine
  const versionWarning = fingerprintVersionWarning(brandVersion, selectedEngine)
  const selectedHardware = hardwareProfile(hardwareProfileId)
  const selectedGpuIdentity = effectiveGpuIdentity({
    hardwareProfileId,
    seed: fingerprintSeed,
    gpuBucket: fingerprintGpuBucket
  })
  const hostPlatform = defaultPlatform()
  const personaResolution = fingerprintConfig ? resolveFingerprintPersona(fingerprintConfig) : undefined
  const savedProxyCheckApplies = Boolean(
    profile
      && proxyConfig
      && profile.proxy.protocol === proxyConfig.protocol
      && profile.proxy.host === proxyConfig.host
      && profile.proxy.port === proxyConfig.port
      && profile.proxy.username === proxyConfig.username
      && (profile.proxy.passwordStored === true) === (proxyConfig.passwordStored === true)
      && !proxyConfig.password
  )
  const activeProxyCheck = proxyResult ?? (savedProxyCheckApplies ? profile?.proxyCheck : undefined)
  const networkFingerprint = {
    ...form.getFieldValue('fingerprint'),
    language: fingerprintLanguage,
    acceptLanguages: fingerprintAcceptLanguages,
    timezone: fingerprintTimezone,
    networkIdentityMode
  }
  const networkIdentity = effectiveNetworkIdentity(networkFingerprint, activeProxyCheck)
  const identityPlan = networkIdentityPlan(networkFingerprint, proxyProtocol ?? 'direct', activeProxyCheck)
  const proxyRecommendationPlan = networkIdentityPlan(
    { ...networkFingerprint, networkIdentityMode: 'proxy' },
    proxyProtocol ?? 'direct',
    activeProxyCheck
  )
  const personaRegion = fingerprintHardwareRegionForCountry(
    proxyRecommendationPlan.ready ? proxyRecommendationPlan.countryCode : undefined
  )
  const recommendedPersona = fingerprintConfig
    ? recommendFingerprintHardwarePersona({
        platform: profile ? fingerprintConfig.platform : hostPlatform,
        seed: fingerprintConfig.seed,
        region: personaRegion
      })
    : undefined
  const personaRecommendationApplied = Boolean(
    recommendedPersona?.id && personaResolution?.personaId === recommendedPersona.id
  )
  const timezoneMismatch = Boolean(proxyResult?.timezone && fingerprintTimezone && proxyResult.timezone !== fingerprintTimezone)

  useEffect(() => {
    if (open) {
      form.setFieldsValue(editorValues(profile, suggestedIndex))
      setProxyResult(null)
      setAiIdentityFeedback(null)
      setIdentityConfigProvenance(normalizeIdentityConfigProvenance((profile ?? defaultProfileDraft(suggestedIndex)).identityConfigProvenance))
    }
  }, [form, open, profile, suggestedIndex])

  function applyRecommendedNetworkIdentityFrom(result: ProxyTestResult): void {
    const current = form.getFieldValue('fingerprint')
    const applied = applyRecommendedProxyNetworkIdentity(current, result)
    if (applied) {
      form.setFieldValue('fingerprint', applied)
      setIdentityConfigProvenance((currentProvenance) => markFingerprintConfigSources(
        currentProvenance,
        ['networkIdentityMode', 'proxyExitPolicy', 'webrtcPolicy', 'language', 'acceptLanguages', 'timezone'],
        'ai'
      ))
    }
  }

  async function applyAIIdentityConfiguration(): Promise<void> {
    try {
      setApplyingAIIdentity(true)
      setAiIdentityFeedback(null)

      const effectiveProxyProtocol = proxyProtocol ?? 'direct'
      let check = activeProxyCheck

      if (effectiveProxyProtocol !== 'direct' && !check) {
        await form.validateFields([['proxy', 'host'], ['proxy', 'port']])
        check = await window.browserApi.proxy.test(form.getFieldValue('proxy'), profile?.id)
        setProxyResult(check)
      }

      if (effectiveProxyProtocol !== 'direct' && (!check || !check.ok)) {
        setAiIdentityFeedback({
          type: 'warning',
          message: 'AI 身份配置未应用',
          description: check?.error ? `代理检测失败：${check.error}` : '请先提供可用代理，或切换为直连后使用手动网络配置。'
        })
        return
      }

      const current = form.getFieldValue('fingerprint')
      const generated = generateAIIdentityConfig({
        baseFingerprint: current,
        platform: profile ? current.platform : hostPlatform,
        countryCode: check?.countryCode,
        proxyProtocol: effectiveProxyProtocol,
        proxyCheck: check,
        networkMode: effectiveProxyProtocol === 'direct' ? 'manual' : 'proxy'
      })
      const applied = applyAIIdentityConfigToFingerprint(current, generated, identityConfigProvenance)
      form.setFieldValue('fingerprint', applied)
      setIdentityConfigProvenance((currentProvenance) => applyAIIdentityConfigProvenance(currentProvenance, generated))

      const details = [
        generated.personaId ? `Persona ${generated.personaId}` : '保留当前硬件配置',
        effectiveProxyProtocol === 'direct'
          ? '网络保持手动模式，可继续修改'
          : generated.networkReadiness === 'ready'
            ? '网络身份已按代理出口匹配'
            : '网络配置保持现有手动值',
        ...generated.warnings
      ].filter(Boolean)

      setAiIdentityFeedback({
        type: generated.warnings.length ? 'warning' : 'success',
        message: generated.networkReadiness === 'ready' || effectiveProxyProtocol === 'direct'
          ? 'AI 身份配置已应用'
          : 'AI 指纹配置已应用，网络配置未自动覆盖',
        description: details.join('；')
      })
    } catch (error) {
      if (!(error && typeof error === 'object' && 'errorFields' in error)) {
        setAiIdentityFeedback({
          type: 'warning',
          message: 'AI 身份配置失败',
          description: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      setApplyingAIIdentity(false)
    }
  }

  async function testCurrentProxy(autoApply = false): Promise<void> {
    try {
      if (proxyProtocol !== 'direct') await form.validateFields([['proxy', 'host'], ['proxy', 'port']])
      setTestingProxy(true)
      setProxyResult(null)
      const result = await window.browserApi.proxy.test(form.getFieldValue('proxy'), profile?.id)
      setProxyResult(result)
      if (autoApply && result.ok) applyRecommendedNetworkIdentityFrom(result)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'errorFields' in error)) {
        setProxyResult({ ok: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) })
      }
    } finally {
      setTestingProxy(false)
    }
  }

  function applyRecommendedNetworkIdentity(): void {
    if (proxyResult) applyRecommendedNetworkIdentityFrom(proxyResult)
  }

  async function submit(): Promise<void> {
    await form.validateFields()
    const values = form.getFieldsValue(true) as EditorValues
    const color = typeof values.color === 'string' ? values.color : values.color.toHexString()
    const selectedKernel = values.kernelVersion
      ? kernels.find((kernel) => kernelReleaseMatchesPin(kernel, values.kernelVersion, values.kernelFamily))
        ?? kernels.find((kernel) => kernelReleaseMatchesPin(kernel, values.kernelVersion))
      : undefined
    const selectedKernelFamily = values.kernelVersion
      ? values.kernelFamily ?? (selectedKernel ? kernelFamilyForRelease(selectedKernel) : undefined)
      : undefined
    await onSave({
      name: values.name,
      note: values.note,
      group: values.group,
      tags: values.tags,
      color,
      startUrls: values.startUrlsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      kernelVersion: values.kernelVersion,
      kernelFamily: selectedKernelFamily,
      environmentType: values.environmentType ?? 'account',
      identityConfigProvenance,
      window: values.window,
      proxy: values.proxy,
      extensionIds: values.extensionIds,
      fingerprint: values.fingerprint
    })
  }

  const general = (
    <div className="editor-section">
      <Form.Item
        name="environmentType"
        label="环境类型"
        extra="账号环境默认锁定代理：代理失效或出口变化时阻止/隔离并报警，不自动换 IP。临时环境用于采集、测试，可手动使用代理池的最佳代理/轮换工具。"
      >
        <Select
          options={[
            { value: 'account', label: '账号环境（默认 · 一号一代理 · 禁止自动切换）' },
            { value: 'temporary', label: '临时环境（采集 / 测试 · 允许显式轮换）' }
          ]}
        />
      </Form.Item>
      <Form.Item name="name" label="环境名称" rules={[{ required: true, message: '请输入环境名称' }]}>
        <Input placeholder="例如：美国店铺 01" maxLength={60} />
      </Form.Item>
      <Form.Item name="color" label="标记颜色">
        <ColorPicker showText />
      </Form.Item>
      <Form.Item name="kernelFamily" hidden><Input /></Form.Item>
      <Form.Item name="kernelVersion" hidden><Input /></Form.Item>
      <Form.Item
        label="浏览器内核"
        extra="固定后锁定 Chromium 主版本和内核系列：同主版本补丁可自动升级且不会降级；跨主版本必须手动选择升级。"
      >
        <Select
          value={kernelVersion ? `${kernelFamily ?? 'legacy'}|${kernelVersion}` : ''}
          onChange={(value: string) => {
            if (!value) {
              form.setFieldValue('kernelVersion', '')
              form.setFieldValue('kernelFamily', undefined)
              return
            }
            const [family, version] = value.split('|')
            if ((family !== 'fingerprint-chromium' && family !== 'custom') || !version) return
            form.setFieldValue('kernelVersion', version)
            form.setFieldValue('kernelFamily', family)
          }}
          options={[
            { value: '', label: `自动跟随当前内核${engine?.version ? ` · ${engine.version}` : ''}` },
            ...kernels.map((kernel) => {
              const family = kernelFamilyForRelease(kernel)
              const downgrade = Boolean(profile?.kernelVersion && isKernelDowngrade(profile.kernelVersion, kernel.version))
              return {
                value: `${family}|${kernel.version}`,
                label: `${kernel.version} · ${family === 'custom' ? '本地构建' : 'Fingerprint Chromium'}${downgrade ? ' · 不可降级' : ''}`,
                disabled: downgrade
              }
            }),
            ...(kernelVersion && !kernelFamily
              ? [{ value: `legacy|${kernelVersion}`, label: `${kernelVersion} · 旧环境精确绑定`, disabled: true }]
              : []),
            ...(kernelVersion && kernelFamily && !pinnedKernel
              ? [{ value: `${kernelFamily}|${kernelVersion}`, label: `${kernelVersion} · ${kernelFamily} · 当前未安装` }]
              : [])
          ]}
        />
      </Form.Item>
      {kernelVersion && !resolvedPinnedKernel && (
        <Alert
          type="error"
          showIcon
          message={`固定的 ${kernelMajorVersion(kernelVersion) ?? '?'} 系列当前没有可用内核`}
          description={kernelFamily
            ? `需要 ${kernelFamily} 系列、版本不低于4