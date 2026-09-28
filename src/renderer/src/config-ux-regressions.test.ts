import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const profileEditorSource = readFileSync(new URL('./ProfileEditor.tsx', import.meta.url), 'utf8')
const kernelManagerSource = readFileSync(new URL('./KernelManagerModal.tsx', import.meta.url), 'utf8')

describe('configuration UX regressions', () => {
  it('lets preset hardware fields be edited directly and converts edits to manual mode', () => {
    expect(profileEditorSource).toContain('convertHardwareProfileToManual(currentFingerprint)')
    expect(profileEditorSource).not.toContain("disabled={hardwareProfileId !== 'legacy-custom'}")
    expect(profileEditorSource).toContain('修改任意一项会自动切换为手动自定义并保留当前值')
  })

  it('keeps kernel install clickable so blocked installs show a reason', () => {
    expect(kernelManagerSource).toContain('if (hasRunningProfiles)')
    expect(kernelManagerSource).toContain('messageApi.warning(error)')
    expect(kernelManagerSource).not.toContain('disabled={Boolean(installing) || hasRunningProfiles}')
    expect(kernelManagerSource).toContain('安装在当前窗口完成，不会另外打开网页')
  })
})
