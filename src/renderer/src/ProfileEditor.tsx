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
import { analyzeIdentityEnvironment } from '../../shared/identity-environment-analysis'
import { normalizeIdentityIntent } from '../../shared/identity-intent'
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
import type { BrowserExtension, BrowserProfileView, EngineStatus, HardwareProfileId, IdentityConfigProvenance, IdentityIntent, KernelRelease, ProfileDraft, ProxyTestResult } from '../../shared/types'

interface EditorValues extends Omit<ProfileDraft, 'startUrls' | 'color'> {
  startUrlsText: string
  color: string | { toHexString: () => string }
  targetCountryCode?: string
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
    targetCountryCode: draft.identityIntent?.targetCountryCode ?? '',
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
  const targetCountryCode = (Form.useWatch('targetCountryCode', form) ?? '').trim().toUpperCase()
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
  const [identityIntent, setIdentityIntent] = useState<IdentityIntent>(() => normalizeIdentityIntent(profile?.identityIntent))
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
      setIdentityIntent(normalizeIdentityIntent((profile ?? defaultProfileDraft(suggestedIndex)).identityIntent))
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

      const environment = analyzeIdentityEnvironment({
        targetCountryCode,
        proxyProtocol: effectiveProxyProtocol,
        proxyCheck: check
      })
      if (!environment.canGenerate) {
        setAiIdentityFeedback({
          type: 'warning',
          message: '环境分析未通过，AI 身份配置未应用',
          description: environment.warnings.join('；')
        })
        return
      }

      const current = form.getFieldValue('fingerprint')
      const generated = generateAIIdentityConfig({
        baseFingerprint: current,
        platform: profile ? current.platform : hostPlatform,
        countryCode: environment.effectiveCountryCode,
        proxyProtocol: effectiveProxyProtocol,
        proxyCheck: check,
        networkMode: effectiveProxyProtocol === 'direct' ? 'manual' : 'proxy'
      })
      const applied = applyAIIdentityConfigToFingerprint(current, generated, identityConfigProvenance)
      form.setFieldValue('fingerprint', applied)
      setIdentityIntent({
        schemaVersion: 1,
        targetCountryCode: environment.targetCountryCode,
        strategy: 'ai_assisted',
        lastGeneratedAt: new Date().toISOString(),
        lastGenerator: 'identity-ai-v1',
        lastGeneratedPersonaId: generated.personaId,
        lastGeneratedCountryCode: environment.effectiveCountryCode
      })
      setIdentityConfigProvenance((currentProvenance) => applyAIIdentityConfigProvenance(currentProvenance, generated))

      const details = [
        environment.targetCountryCode
          ? `目标国家 ${environment.targetCountryCode}${environment.observedCountryCode ? ` / 代理出口 ${environment.observedCountryCode}` : ''}`
          : environment.observedCountryCode ? `代理出口国家 ${environment.observedCountryCode}` : undefined,
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
    const normalizedTarget = values.targetCountryCode?.trim().toUpperCase() || undefined
    const intent = normalizedTarget === identityIntent.targetCountryCode
      ? normalizeIdentityIntent({ ...identityIntent, targetCountryCode: normalizedTarget })
      : normalizeIdentityIntent({ schemaVersion: 1, targetCountryCode: normalizedTarget, strategy: 'manual' })
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
      identityIntent: intent,
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
            ? `需要 ${kernelFamily} 系列、版本不低于 ${kernelVersion} 的同主版本内核；不会自动降级或跨主版本。`
            : '旧环境尚未固定内核系列，只会继续寻找原来的精确版本；请先恢复该精确版本，再保存环境配置锁定系列。'}
        />
      )}
      {kernelVersion && resolvedPinnedKernel && automaticPatchVersion && automaticPatchVersion !== kernelVersion && (
        <Alert
          type="success"
          showIcon
          message={`${kernelMajorVersion(kernelVersion)} 系列可自动使用补丁 ${automaticPatchVersion}`}
          description={`当前版本下限为 ${kernelVersion}。下一次成功启动后会把下限推进到 ${automaticPatchVersion}，以后不会退回旧补丁。`}
        />
      )}
      {profile?.kernelVersion && upgradeVersion && upgradeKernel && (
        <Alert
          type="info"
          showIcon
          message={`该环境可升级到内核 ${upgradeVersion}`}
          description={kernelMajorVersion(upgradeVersion) === kernelMajorVersion(profile.kernelVersion)
            ? '这是同主版本补丁，也可在下次启动时自动采用；手动选择会立即推进版本下限。'
            : `这是跨主版本升级（${kernelMajorVersion(profile.kernelVersion)} → ${kernelMajorVersion(upgradeVersion)}），只会在你明确保存后生效，不会自动跨版本。`}
          action={
            <Button
              size="small"
              onClick={() => {
                form.setFieldValue('kernelVersion', upgradeVersion)
                form.setFieldValue('kernelFamily', kernelFamilyForRelease(upgradeKernel))
              }}
            >
              选择升级
            </Button>
          }
        />
      )}
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name="group" label="环境分组">
            <AutoComplete
              allowClear
              options={groups.map((value) => ({ value }))}
              placeholder="选择已有分组或输入新分组"
              maxLength={40}
              filterOption={(input, option) => String(option?.value ?? '').toLocaleLowerCase().includes(input.toLocaleLowerCase())}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" maxCount={20} tokenSeparators={[',']} placeholder="输入后回车" />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item name="startUrlsText" label="启动页面" extra="每行一个网址；不填写协议时自动使用 HTTPS">
        <Input.TextArea rows={4} placeholder={'https://example.com\nhttps://browserleaks.com/'} />
      </Form.Item>
      <Form.Item name="extensionIds" label="启动扩展" extra="从扩展管理中导入后，可为每个环境选择不同的扩展组合">
        <Select
          mode="multiple"
          allowClear
          placeholder={extensions.length ? '选择该环境启动时加载的扩展' : '尚未导入扩展'}
          options={extensions.map((extension) => ({
            value: extension.id,
            label: `${extension.name} · ${extension.version}`
          }))}
        />
      </Form.Item>
      <Divider />
      <Form.Item name={['window', 'mode']} label="浏览器窗口" extra="自动模式沿用指纹屏幕尺寸；自定义模式可固定窗口尺寸和桌面坐标。">
        <Select options={[{ value: 'auto', label: '自动尺寸与位置' }, { value: 'custom', label: '固定尺寸与位置' }]} />
      </Form.Item>
      {windowMode === 'custom' && (
        <>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="窗口尺寸">
                <Space.Compact block>
                  <Form.Item name={['window', 'width']} noStyle><InputNumber min={480} max={7680} precision={0} className="resolution-input" /></Form.Item>
                  <Input className="resolution-times" value="×" disabled />
                  <Form.Item name={['window', 'height']} noStyle><InputNumber min={360} max={4320} precision={0} className="resolution-input" /></Form.Item>
                </Space.Compact>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="桌面坐标">
                <Space.Compact block>
                  <Form.Item name={['window', 'x']} noStyle><InputNumber min={-20000} max={20000} precision={0} prefix="X" className="resolution-input" /></Form.Item>
                  <Input className="resolution-times" value="," disabled />
                  <Form.Item name={['window', 'y']} noStyle><InputNumber min={-20000} max={20000} precision={0} prefix="Y" className="resolution-input" /></Form.Item>
                </Space.Compact>
              </Form.Item>
            </Col>
          </Row>
          <Alert type="info" showIcon message="多显示器允许负坐标；显示器布局变化后，过期坐标可能让窗口出现在屏幕之外。" />
        </>
      )}
      <Form.Item name="note" label="备注">
        <Input.TextArea rows={3} maxLength={500} showCount placeholder="仅保存在本机" />
      </Form.Item>
    </div>
  )

  const proxy = (
    <div className="editor-section">
      <Form.Item name={['proxy', 'protocol']} label="代理方式">
        <Select
          options={[
            { value: 'direct', label: '不使用代理（本地网络）' },
            { value: 'http', label: 'HTTP' },
            { value: 'https', label: 'HTTPS' },
            { value: 'socks5', label: 'SOCKS5' }
          ]}
        />
      </Form.Item>
      {proxyProtocol !== 'direct' && (
        <>
          <Row gutter={12}>
            <Col span={16}>
              <Form.Item name={['proxy', 'host']} label="主机" rules={[{ required: true, message: '请输入代理主机' }]}>
                <Input placeholder="proxy.example.com" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name={['proxy', 'port']} label="端口" rules={[{ required: true, message: '请输入端口' }]}>
                <InputNumber min={1} max={65535} className="full-width" placeholder="8080" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name={['proxy', 'username']} label="用户名">
                <Input autoComplete="off" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="密码"
                extra={proxyPasswordStored
                  ? '已保存；代理地址和用户名未修改时，留空可保持原密码。'
                  : '密码将安全保存在当前设备。'}
              >
                <Space.Compact block>
                  <Form.Item name={['proxy', 'password']} noStyle>
                    <Input.Password
                      autoComplete="new-password"
                      placeholder={proxyPasswordStored ? '已保存，留空保持不变' : undefined}
                    />
                  </Form.Item>
                  {proxyPasswordStored && !proxyPassword && (
                    <Button onClick={() => form.setFieldValue(['proxy', 'passwordStored'], false)}>清除已保存</Button>
                  )}
                </Space.Compact>
              </Form.Item>
            </Col>
          </Row>
        </>
      )}
      <Form.Item
        name="targetCountryCode"
        label="目标国家"
        extra="输入 ISO 两位国家代码（如 US、GB、DE）。使用代理时会先核对实际出口国家，不匹配则阻止 AI 静默生成错误国家身份。"
        rules={[{ pattern: /^[A-Za-z]{2}$/, message: '请输入 ISO 两位国家代码，例如 US' }]}
        normalize={(value: string) => value?.trim().toUpperCase()}
      >
        <Input maxLength={2} placeholder="US" />
      </Form.Item>
      <Alert
        type="info"
        showIcon
        message="推荐流程：填代理 + 目标国家 → 环境分析 → AI 一键配置身份 → 手动确认/修改 → 保存 → 环境检测"
        description="AI 会先核对代理实际出口与目标国家，再根据可信出口和当前平台推荐成套硬件 Persona、语言、Accept-Language、时区、WebRTC 和出口策略；所有配置仍可手动修改。"
        action={(
          <Button type="primary" loading={applyingAIIdentity} onClick={() => void applyAIIdentityConfiguration()}>
            {profile ? 'AI 重新分析配置' : 'AI 一键配置身份'}
          </Button>
        )}
      />
      {aiIdentityFeedback && (
        <Alert
          type={aiIdentityFeedback.type}
          showIcon
          message={aiIdentityFeedback.message}
          description={aiIdentityFeedback.description}
        />
      )}
      <Space className="proxy-test-row" wrap>
        <Button loading={testingProxy} onClick={() => void testCurrentProxy(false)}>仅检测连接</Button>
        {proxyProtocol !== 'direct' && (
          <Button type="primary" loading={testingProxy} onClick={() => void testCurrentProxy(true)}>
            检测并一键匹配
          </Button>
        )}
        {proxyResult && !proxyResult.ok && <Typography.Text type="danger">连接失败：{proxyResult.error}</Typography.Text>}
      </Space>
      {proxyResult?.ok && targetCountryCode && (
        <Alert
          type={proxyResult.countryCode?.toUpperCase() === targetCountryCode ? 'success' : 'warning'}
          showIcon
          message={proxyResult.countryCode?.toUpperCase() === targetCountryCode
            ? `目标国家 ${targetCountryCode} 与代理出口一致`
            : `目标国家 ${targetCountryCode} 与代理出口 ${proxyResult.countryCode?.toUpperCase() ?? '未知'} 不一致`}
          description={proxyResult.countryCode?.toUpperCase() === targetCountryCode
            ? '可以继续生成身份配置。'
            : '请更换符合目标国家的代理，或修改目标国家后重新分析。'}
        />
      )}
      {proxyResult?.ok && (
        <div className="proxy-test-result">
          <div className="proxy-result-line">
            <Typography.Text strong>出口 IP：{proxyResult.ip}</Typography.Text>
            <Typography.Text type="secondary">{proxyResult.latencyMs} ms</Typography.Text>
            {proxyResult.networkRisk && <Tag color="warning">{riskLabels[proxyResult.networkRisk]}</Tag>}
          </div>
          {(proxyResult.country || proxyResult.city) && (
            <Typography.Text type="secondary">
              {[proxyResult.country, proxyResult.region, proxyResult.city].filter(Boolean).join(' · ')}
            </Typography.Text>
          )}
          {(proxyResult.asn || proxyResult.organization || proxyResult.isp) && (
            <Typography.Text type="secondary">
              {[proxyResult.asn ? `AS${proxyResult.asn}` : '', proxyResult.organization, proxyResult.isp]
                .filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' · ')}
            </Typography.Text>
          )}
          {proxyResult.timezone && (
            <div className="proxy-timezone-row">
              <Typography.Text type={proxyResult.geoConfidence === 'conflict' || timezoneMismatch ? 'warning' : 'success'}>
                代理时区：{proxyResult.timezone} · {proxyResult.geoConfidence === 'conflict'
                  ? 'GeoIP 数据源存在冲突'
                  : timezoneMismatch ? `与指纹时区 ${fingerprintTimezone} 不一致` : '与指纹时区一致'}
              </Typography.Text>
              {timezoneMismatch && proxyResult.geoConfidence !== 'conflict' && (
                <Button size="small" onClick={() => {
                  form.setFieldValue(['fingerprint', 'timezone'], proxyResult.timezone)
                  setIdentityConfigProvenance((currentProvenance) => markFingerprintConfigSources(currentProvenance, ['timezone'], 'ai'))
                }}>
                  应用代理时区
                </Button>
              )}
            </div>
          )}
          {proxyResult.latitude !== undefined && proxyResult.longitude !== undefined && (
            <Typography.Text type="secondary">
              城市级坐标：{proxyResult.latitude.toFixed(3)}, {proxyResult.longitude.toFixed(3)} · 精度约 {Math.round((proxyResult.accuracyMeters ?? 25000) / 1000)} km
            </Typography.Text>
          )}
          <Space wrap>
            <Button
              type="primary"
              size="small"
              disabled={!proxyRecommendationPlan.canApply}
              onClick={applyRecommendedNetworkIdentity}
            >
              应用推荐网络身份
            </Button>
            <Typography.Text type={proxyRecommendationPlan.canApply ? 'secondary' : 'warning'}>
              {proxyRecommendationPlan.canApply
                ? '自动设置跟随代理、语言、Accept-Language、时区、WebRTC 防泄漏和出口变化阻止策略。'
                : proxyRecommendationPlan.warnings.join('；')}
            </Typography.Text>
          </Space>
          {networkIdentityMode === 'proxy' && (
            <Alert
              type={identityPlan.ready ? 'success' : 'warning'}
              showIcon
              message={identityPlan.ready ? '代理网络身份已生成' : '代理网络身份尚未就绪'}
              description={identityPlan.ready
                ? `${networkIdentity.language} · ${networkIdentity.acceptLanguages} · ${networkIdentity.timezone}`
                : identityPlan.warnings.join('；')}
            />
          )}
          {proxyResult.degraded && <Typography.Text type="warning">{proxyResult.warning}</Typography.Text>}
        </div>
      )}
      <Divider />
      <Form.Item
        name={['fingerprint', 'webrtcPolicy']}
        label="WebRTC IP 策略"
        extra={networkIdentityMode === 'proxy' && proxyProtocol !== 'direct'
          ? '当前由网络身份自动管理；跟随代理时固定为防泄漏模式。'
          : '视频通话兼容性与网络隐私之间的取舍。'}
      >
        <Select
          disabled={networkIdentityMode === 'proxy' && proxyProtocol !== 'direct'}
          options={[
            { value: 'proxy_only', label: '防泄漏（推荐）— 禁止非代理 UDP' },
            { value: 'public_only', label: '仅公网接口 — 不暴露本地地址' },
            { value: 'default', label: '系统默认 — 使用所有网络接口' }
          ]}
        />
      </Form.Item>
      {webrtcPolicy === 'proxy_only' && (
        <Alert
          type="success"
          showIcon
          message="WebRTC 防泄漏已开启"
          description={proxyProtocol === 'direct'
            ? '不会枚举本地接口；未配置 UDP 代理时 WebRTC 将使用 TCP，部分实时音视频性能可能下降。'
            : 'WebRTC 仅使用代理支持的 UDP 或 TCP，不允许通过本地网络绕过代理。'}
        />
      )}
      {webrtcPolicy === 'public_only' && (
        <Alert
          type="warning"
          showIcon
          message="可能暴露真实公网 IP"
          description="该模式隐藏本地网卡地址，但 WebRTC 可以使用系统默认公网接口；使用代理环境时不建议选择。"
        />
      )}
      {webrtcPolicy === 'default' && (
        <Alert
          type="error"
          showIcon
          message="高风险：WebRTC 使用所有接口"
          description="网页可能获取本地网卡或绕过代理的公网地址，仅用于兼容性排障。"
        />
      )}
    </div>
  )

  const fingerprint = (
    <div className="editor-section">
      <Form.Item
        name={['fingerprint', 'hardwareProfileId']}
        label="硬件模板"
        extra="AI 可推荐完整硬件 Persona；也可切换“手动自定义”后修改系统、CPU 和屏幕参数。"
      >
        <Select
          options={[
            ...HARDWARE_PROFILES.map((item) => ({
              value: item.id,
              label: item.platform !== hostPlatform ? `${item.label} · 跨系统高风险` : item.label,
              disabled: item.platform !== hostPlatform
            })),
            { value: 'legacy-custom', label: hardwareProfileId === 'legacy-custom' ? '手动自定义（当前）' : '手动自定义（高级）' }
          ]}
          onChange={(id: HardwareProfileId) => {
            const current = form.getFieldValue('fingerprint')
            form.setFieldValue('fingerprint', applyHardwareProfile(current, id, { refreshSeededGpu: true }))
            setIdentityConfigProvenance((currentProvenance) => markFingerprintConfigSources(
              currentProvenance,
              HARDWARE_IDENTITY_FIELDS,
              'user'
            ))
          }}
        />
      </Form.Item>
      {selectedHardware && selectedHardware.platform !== hostPlatform && (
        <Alert
          type="error"
          showIcon
          message="跨系统 Persona 高风险"
          description={`当前宿主是 ${hostPlatform === 'windows' ? 'Windows' : 'macOS'}，这个环境模拟 ${selectedHardware.platform === 'windows' ? 'Windows' : 'macOS'}。旧环境不会被自动重写，但字体、Emoji、Canvas/WebGL 和系统 UI 细节仍可能暴露宿主系统；新环境请选择与宿主相同的 Persona。`}
        />
      )}
      {selectedHardware?.hostMatched && selectedHardware.platform === hostPlatform && (
        <Alert
          type="success"
          showIcon
          message="使用当前设备的硬件信息"
          description="不同环境可能显示相同的硬件信息。"
        />
      )}
      {selectedHardware && !selectedHardware.hostMatched && selectedHardware.platform === hostPlatform && (
        <Alert
          type="info"
          showIcon
          message={hardwareProfileSummary(selectedHardware.id)}
          description="同一环境的硬件信息保持稳定；重新生成后会获得新的身份。"
        />
      )}
      {selectedHardware?.renderIdentityMode === 'seeded-curated' && !selectedGpuIdentity && (
        <Alert
          type="warning"
          showIcon
          message="旧环境保持原有硬件信息"
          description="如需更换，请点击下方“重新生成”。"
        />
      )}
      {hardwareProfileId === 'legacy-custom' && (
        <Alert
          type="warning"
          showIcon
          message="这是升级前创建的自定义硬件组合"
          description="为避免已使用环境的指纹突变，当前值不会自动修改。新账号建议新建环境并选择成套硬件模板。"
        />
      )}
      {personaResolution && (
        <Alert
          type={personaResolution.consistency === 'conflict' || personaResolution.consistency === 'unresolved' ? 'warning' : 'success'}
          showIcon
          message={personaResolution.personaId
            ? `Persona Engine · ${personaResolution.label}`
            : `Persona Engine · ${personaResolution.label}`}
          description={personaResolution.warnings.length
            ? personaResolution.warnings.join('；')
            : personaResolution.source === 'catalog'
              ? `${personaResolution.personaId} · CPU / GPU / 内存 / 屏幕参数已按整套 Persona 锁定。`
              : '当前环境身份已解析；Persona Engine 不会在后台重映射已有环境。'}
        />
      )}
      {!profile && recommendedPersona && (
        <Alert
          type="info"
          showIcon
          message={personaRecommendationApplied
            ? `已使用推荐 Persona · ${recommendedPersona.label}`
            : `新环境推荐 Persona · ${recommendedPersona.label}`}
          description={`按当前 Seed 和 ${personaRegion.toUpperCase()} 区域做确定性推荐；只在你点击应用时修改新环境，不会自动改变已有 Profile。`}
          action={!personaRecommendationApplied ? (
            <Button
              size="small"
              onClick={() => {
                const current = form.getFieldValue('fingerprint')
                const applied = applyFingerprintHardwarePersona(current, recommendedPersona.id)
                if (applied) {
                  form.setFieldValue('fingerprint', applied)
                  setIdentityConfigProvenance((currentProvenance) => markFingerprintConfigSources(
                    currentProvenance,
                    HARDWARE_IDENTITY_FIELDS,
                    'ai'
                  ))
                }
              }}
            >
              应用推荐 Persona
            </Button>
          ) : undefined}
        />
      )}
      <Divider />
      <Row gutter={12}>
        <Col span={16}>
          <Form.Item name={['fingerprint', 'seed']} label="指纹种子" rules={[{ required: true }]}>
            <InputNumber min={0} max={0xffffffff} precision={0} className="full-width" />
          </Form.Item>
        </Col>
        <Col span={8} className="seed-action">
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              const current = form.getFieldValue('fingerprint')
              form.setFieldValue('fingerprint', refreshSeededGpuIdentity({
                ...current,
                seed: randomSeed()
              }))
              setIdentityConfigProvenance((currentProvenance) => markFingerprintConfigSources(currentProvenance, ['seed', 'gpuBucket'], 'user'))
            }}
          >
            重新生成
          </Button>
        </Col>
      </Row>
      <div className="form-hint prominent">
        {selectedHardware?.hostMatched
          ? '不同环境可能共享当前设备的硬件信息。'
          : '指纹种子决定环境身份。使用中的环境请勿随意修改；复制或重新生成会获得新身份。'}
      </div>
      <Divider />
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'platform']} label="模拟系统">
            <Select disabled={hardwareProfileId !== 'legacy-custom'} options={[{ value: 'windows', label: 'Windows' }, { value: 'macos', label: 'macOS' }]} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'platformVersion']} label="系统版本">
            <Input
              disabled={hardwareProfileId !== 'legacy-custom'}
              placeholder="10.0.0"
              addonAfter={selectedHardware?.hostMatched ? '启动时读取本机' : undefined}
            />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item
            name={['fingerprint', 'networkIdentityMode']}
            label="网络身份"
            extra="可跟随代理自动匹配，也可随时切换“手动固定”后修改语言、时区、WebRTC 等参数。"
          >
            <Select options={[
              { value: 'proxy', label: '跟随代理出口（推荐）' },
              { value: 'manual', label: '手动固定' }
            ]} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'proxyExitPolicy']} label="出口变化">
            <Select disabled={networkIdentityMode === 'proxy' && proxyProtocol !== 'direct'} options={[
              { value: 'block', label: '阻止启动并确认（推荐）' },
              { value: 'warn', label: '仅告警，继续启动' }
            ]} />
          </Form.Item>
        </Col>
      </Row>
      {networkIdentityMode === 'proxy' && (
        <Alert
          type={proxyProtocol === 'direct' ? 'warning' : 'info'}
          showIcon
          message={proxyProtocol === 'direct' ? '当前没有配置代理' : '语言、时区和地理位置将在启动时跟随代理'}
          description={proxyProtocol === 'direct'
            ? '直连环境继续使用下方手动值；配置代理后自动联动。'
            : `${networkIdentity.language} · ${networkIdentity.acceptLanguages} · ${networkIdentity.timezone}`}
        />
      )}
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'brand']} label="浏览器品牌">
            <Select options={[{ value: 'Chrome', label: 'Chrome' }, { value: 'Edge', label: 'Edge' }]} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item
            name={['fingerprint', 'brandVersion']}
            label="品牌版本"
            extra={selectedEngine?.version ? `留空时自动匹配内核 ${selectedEngine.version}` : '留空时与内核版本一致'}
            rules={[{ pattern: /^\d+(?:\.\d+){0,3}$/, message: '请输入 1–4 段数字版本，或留空自动匹配', validateTrigger: 'onBlur' }]}
          >
            <Input placeholder="自动" />
          </Form.Item>
        </Col>
      </Row>
      {versionWarning && <Alert type="warning" showIcon message={versionWarning} description="建议留空并自动匹配当前内核。" />}
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'hardwareConcurrency']} label="CPU 核心数">
            <Select disabled={hardwareProfileId !== 'legacy-custom'} options={[2, 4, 6, 8, 10, 12, 14, 16, 20, 24].map((value) => ({ value, label: `${value} 核` }))} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="屏幕分辨率">
            <Space.Compact block>
              <Form.Item name={['fingerprint', 'screenWidth']} noStyle>
                <InputNumber disabled={hardwareProfileId !== 'legacy-custom'} min={800} max={7680} precision={0} className="resolution-input" />
              </Form.Item>
              <Input className="resolution-times" value="×" disabled />
              <Form.Item name={['fingerprint', 'screenHeight']} noStyle>
                <InputNumber disabled={hardwareProfileId !== 'legacy-custom'} min={600} max={4320} precision={0} className="resolution-input" />
              </Form.Item>
            </Space.Compact>
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'language']} label="界面语言">
            <Input disabled={networkIdentityMode === 'proxy' && proxyProtocol !== 'direct'} placeholder="zh-CN" />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name={['fingerprint', 'timezone']} label="时区">
            <Input disabled={networkIdentityMode === 'proxy' && proxyProtocol !== 'direct'} placeholder="Asia/Shanghai" />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item name={['fingerprint', 'acceptLanguages']} label="Accept-Language">
        <Input disabled={networkIdentityMode === 'proxy' && proxyProtocol !== 'direct'} placeholder="zh-CN,zh,en-US,en" />
      </Form.Item>
      <Form.Item name={['fingerprint', 'disabledSpoofing']} label="关闭部分伪装" extra="仅用于排障，正常情况下保持全不选。">
        <Checkbox.Group
          options={[
            { value: 'font', label: '字体' },
            { value: 'audio', label: 'Audio' },
            { value: 'canvas', label: 'Canvas' },
            { value: 'clientrects', label: 'ClientRects' },
            { value: 'gpu', label: 'GPU' }
          ]}
        />
      </Form.Item>
    </div>
  )

  return (
    <Modal
      open={open}
      title={profile ? '编辑浏览器环境' : '新建浏览器环境'}
      width={720}
      destroyOnHidden
      confirmLoading={saving}
      okText={profile ? '保存并验证身份' : '创建并验证身份'}
      cancelText="取消"
      onCancel={onCancel}
      onOk={() => void submit()}
    >
      <Typography.Paragraph type="secondary" className="editor-intro">
        每个环境的数据、指纹和网络设置彼此独立。
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        onValuesChange={(changed) => {
          if ('proxy' in changed) setProxyResult(null)
          const changedFingerprint = changed.fingerprint
          if (changedFingerprint && typeof changedFingerprint === 'object') {
            setIdentityConfigProvenance((currentProvenance) => markFingerprintConfigSources(
              currentProvenance,
              Object.keys(changedFingerprint),
              'user'
            ))
          }
        }}
      >
        <Tabs
          defaultActiveKey="general"
          items={[
            { key: 'general', label: '基础设置', children: general, forceRender: true },
            { key: 'proxy', label: '代理设置', children: proxy, forceRender: true },
            { key: 'fingerprint', label: '指纹设置', children: fingerprint, forceRender: true }
          ]}
        />
      </Form>
    </Modal>
  )
}
