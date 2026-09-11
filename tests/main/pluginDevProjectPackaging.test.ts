import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dialog, shell } from 'electron'
import { promises as fs } from 'fs'

const mocks = vi.hoisted(() => ({
  dbGet: vi.fn(),
  dbPut: vi.fn(),
  packZpx: vi.fn(),
  fsAccess: vi.fn(),
  fsReadFile: vi.fn(),
  fsRm: vi.fn(),
  fsWriteFile: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

vi.mock('fs', () => ({
  promises: {
    access: mocks.fsAccess,
    cp: vi.fn(),
    readFile: mocks.fsReadFile,
    rm: mocks.fsRm,
    stat: vi.fn(),
    writeFile: mocks.fsWriteFile
  }
}))

vi.mock('../../src/main/api/shared/database', () => ({
  default: { dbGet: mocks.dbGet, dbPut: mocks.dbPut }
}))

vi.mock('../../src/main/core/internalPlugins', () => ({
  isBundledInternalPlugin: vi.fn(() => false)
}))

vi.mock('../../src/main/core/provider/providerManager', () => ({
  default: { cleanupForPlugin: vi.fn() }
}))

vi.mock('../../src/main/utils/zpxArchive.js', () => ({
  packZpx: mocks.packZpx
}))

import {
  DEV_PROJECT_REGISTRY_DB_KEY,
  type DevProjectRegistry
} from '../../src/main/api/renderer/pluginDevelopmentRegistry'
import { PluginDevProjectsAPI } from '../../src/main/api/renderer/pluginDevProjects'

describe('development plugin packaging', () => {
  const registry: DevProjectRegistry = {
    version: 3,
    projects: {
      demo: {
        name: 'demo',
        configSnapshot: { name: 'demo', title: 'Demo', version: '1.2.3' },
        addedAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
        sortOrder: 0,
        projectPath: '/workspace/demo',
        configPath: '/workspace/demo/plugin.json',
        status: 'ready',
        lastValidatedAt: '2026-09-07T00:00:00.000Z'
      }
    }
  }

  /**
   * 创建通过项目状态校验的开发项目 API。
   * @returns 已注入固定项目状态的 API 实例。
   */
  const createAPI = (): PluginDevProjectsAPI => {
    const api = new PluginDevProjectsAPI({
      mainWindow: null,
      pluginManager: null,
      readInstalledPlugins: () => [],
      writeInstalledPlugins: vi.fn(),
      notifyPluginsChanged: vi.fn(),
      validatePluginConfig: vi.fn(() => ({ valid: true })),
      resolvePluginLogo: vi.fn(),
      getRunningPlugins: vi.fn(() => [])
    })
    vi.spyOn(api as any, 'validateAndRefreshState').mockResolvedValue({
      success: true,
      registry,
      entry: registry.projects.demo,
      pluginConfig: { name: 'demo', title: 'Demo', version: '1.2.3' }
    })
    return api
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dbGet.mockImplementation((key: string) =>
      key === DEV_PROJECT_REGISTRY_DB_KEY ? registry : []
    )
    mocks.fsAccess.mockResolvedValue(undefined)
    mocks.fsRm.mockResolvedValue(undefined)
    mocks.packZpx.mockResolvedValue(undefined)
  })

  it('creates a temporary review package without showing a save dialog', async () => {
    const result = await createAPI().packageDevProject('demo', undefined, undefined, 'temporary')

    expect(result).toMatchObject({
      success: true,
      version: '1.2.3',
      temporaryPackage: true,
      packagePath: expect.stringMatching(/ztools-plugin-upload-demo-.+\.zpx$/)
    })
    expect(mocks.packZpx).toHaveBeenCalledWith('/workspace/demo', result.packagePath)
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('removes a partial temporary package when packaging fails', async () => {
    mocks.packZpx.mockRejectedValue(new Error('pack failed'))

    const result = await createAPI().packageDevProject('demo', undefined, undefined, 'temporary')

    expect(result).toEqual({ success: false, error: 'pack failed' })
    expect(mocks.fsRm).toHaveBeenCalledWith(
      expect.stringMatching(/ztools-plugin-upload-demo-.+\.zpx$/),
      { force: true }
    )
  })
})
