import { ipcMain } from 'electron'
import type { PluginManager } from '../../managers/pluginManager'
import detachedWindowManager from '../../core/detachedWindowManager'
import aiProviderService, { type ResolvedAiModel } from '../../core/aiProviderService.js'
import { createAdapter } from './aiProtocol/adapters'
import type { AiModelChoice } from '../../../shared/aiProviderShared.js'

/**
 * AI 选项
 */
export interface AiOption {
  model?: string // allAiModels 返回的 id 或 value，为空使用首个已开启供应商的首个模型
  messages: Message[] // 消息列表
  tools?: Tool[] // 工具列表
}

/** 文本内容块 */
export interface TextContentPart {
  type: 'text'
  text: string
}

/** 图片内容块 */
export interface ImageContentPart {
  type: 'image_url'
  image_url: {
    url: string // URL 或 base64 data URI
    detail?: 'auto' | 'low' | 'high'
  }
}

/** 内容块联合类型 */
export type ContentPart = TextContentPart | ImageContentPart

/**
 * 消息
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool' // 消息角色
  content?: string | ContentPart[] // 消息内容（支持纯文本或多模态内容块）
  reasoning_content?: string // 消息推理内容
  tool_calls?: ToolCall[] // 工具调用
  tool_call_id?: string // 工具调用 ID（role 为 tool 时使用）
}

/**
 * 工具调用
 */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * 工具
 */
export interface Tool {
  type: 'function'
  function?: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
    }
    required?: string[]
  }
}
/** 工具调用循环最大轮次 */
const MAX_TOOL_ROUNDS = 25

/**
 * AI 调用 API（插件专用）- 基于 OpenAI SDK 直接调用
 * 直接控制消息格式，确保 reasoning_content 等非标准字段正确透传
 */
class PluginAiAPI {
  private pluginManager: PluginManager | null = null
  private mainWindow: Electron.BrowserWindow | null = null
  private abortControllers: Map<string, AbortController> = new Map()

  public init(mainWindow: Electron.BrowserWindow, pluginManager: PluginManager): void {
    this.mainWindow = mainWindow
    this.pluginManager = pluginManager
    this.setupIPC()
  }

  private setupIPC(): void {
    // 非流式调用 AI
    ipcMain.handle('plugin:ai-call', async (event, requestId: string, option: AiOption) => {
      try {
        const pluginInfo = this.pluginManager?.getPluginInfoByWebContents(event.sender)
        if (!pluginInfo) {
          return { success: false, error: '无法获取插件信息' }
        }
        return await this.callAI(option, requestId, event.sender)
      } catch (error: unknown) {
        console.error('[AI] AI 调用失败:', error)
        this.notifyAiStatus('idle', event.sender)
        return { success: false, error: error instanceof Error ? error.message : '未知错误' }
      }
    })

    // 流式调用 AI
    ipcMain.handle('plugin:ai-call-stream', async (event, requestId: string, option: AiOption) => {
      try {
        const pluginInfo = this.pluginManager?.getPluginInfoByWebContents(event.sender)
        if (!pluginInfo) {
          return { success: false, error: '无法获取插件信息' }
        }
        await this.callAIStream(option, requestId, event.sender, (chunk: Message) => {
          event.sender.send(`plugin:ai-stream-${requestId}`, chunk)
        })
        return { success: true }
      } catch (error: unknown) {
        console.error('[AI] AI 流式调用失败:', error)
        this.notifyAiStatus('idle', event.sender)
        return { success: false, error: error instanceof Error ? error.message : '未知错误' }
      }
    })
    // 中止 AI 调用
    ipcMain.handle('plugin:ai-abort', async (_event, requestId: string) => {
      try {
        this.abortAICall(requestId)
        return { success: true }
      } catch (error: unknown) {
        console.error('[AI] 中止 AI 调用失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '未知错误' }
      }
    })

    // 获取所有可用 AI 模型
    ipcMain.handle('plugin:ai-all-models', async () => {
      try {
        const models = await this.getAllAiModels()
        return { success: true, data: models }
      } catch (error: unknown) {
        console.error('[AI] 获取 AI 模型列表失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '未知错误' }
      }
    })

    // Function Calling - 调用插件函数
    ipcMain.handle('plugin:ai-call-function', async (event, functionName: string, args: string) => {
      try {
        const pluginInfo = this.pluginManager?.getPluginInfoByWebContents(event.sender)
        if (!pluginInfo) {
          return { success: false, error: '无法获取插件信息' }
        }
        const result = await event.sender.executeJavaScript(`
          (async () => {
            if (typeof window.${functionName} === 'function') {
              const args = ${args};
              return await window.${functionName}(args);
            } else {
              throw new Error('函数 ${functionName} 不存在');
            }
          })()
        `)
        return { success: true, data: result }
      } catch (error: unknown) {
        console.error('[AI] 调用插件函数失败:', error)
        return { success: false, error: error instanceof Error ? error.message : '未知错误' }
      }
    })
  }
  private notifyAiStatus(
    status: 'idle' | 'sending' | 'receiving',
    webContents: Electron.WebContents
  ): void {
    const pluginInfo = this.pluginManager?.getPluginInfoByWebContents(webContents)
    if (!pluginInfo) return

    const detachedWindows = detachedWindowManager.getAllWindows()
    for (const windowInfo of detachedWindows) {
      if (windowInfo.view.webContents === webContents) {
        if (windowInfo.window && !windowInfo.window.isDestroyed()) {
          windowInfo.window.webContents.send('ai-status-changed', status)
        }
        return
      }
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('ai-status-changed', status)
    }
  }

  /**
   * 获取供插件构建选择器的全部已启用 AI 模型。
   * @returns 带供应商展示信息的模型条目
   */
  private async getAllAiModels(): Promise<AiModelChoice[]> {
    return aiProviderService.getModelChoices()
  }

  /**
   * 将插件选择值解析为供应商连接和真实远端模型。
   * @param modelRef 插件传入的公开 ID、稳定 value 或历史兼容 ID
   * @returns 已解析的模型调用配置；没有配置时返回 null
   * @throws 旧式远端模型 ID 同时匹配多个供应商时抛出歧义错误
   */
  private async getModelConfig(modelRef?: string): Promise<ResolvedAiModel | null> {
    return aiProviderService.resolveModel(modelRef)
  }

  private async executeToolCall(
    toolCall: { id: string; function: { name: string; arguments: string } },
    webContents: Electron.WebContents
  ): Promise<string> {
    try {
      const fnName = toolCall.function.name
      const argsStr = toolCall.function.arguments
      const result = await webContents.executeJavaScript(`
        (async () => {
          if (typeof window.${fnName} === 'function') {
            const args = ${argsStr};
            return await window.${fnName}(args);
          } else {
            throw new Error('函数 ${fnName} 不存在');
          }
        })()
      `)
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return JSON.stringify({
        error: `工具执行失败: ${error instanceof Error ? error.message : '未知错误'}`
      })
    }
  }
  /**
   * 非流式调用 AI，自动处理工具调用循环
   * @param option 插件提交的模型、消息和工具选项
   * @param requestId 当前 AI 请求的唯一 ID
   * @param webContents 发起调用的插件页面
   * @returns AI 调用结果
   * @throws 模型选择值存在供应商歧义时抛出错误
   */
  private async callAI(
    option: AiOption,
    requestId: string,
    webContents: Electron.WebContents
  ): Promise<{ success: boolean; data?: Message; error?: string }> {
    const resolvedModel = await this.getModelConfig(option.model)
    if (!resolvedModel) {
      return { success: false, error: '未找到 AI 模型配置，请先在设置中添加模型' }
    }

    const abortController = new AbortController()
    this.abortControllers.set(requestId, abortController)

    try {
      this.notifyAiStatus('sending', webContents)
      // 按供应商配置的接口格式选择适配器，统一工具调用循环。
      const adapter = createAdapter(resolvedModel.provider)
      const tools = option.tools?.length ? option.tools : undefined
      const messages = [...option.messages]

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        this.notifyAiStatus(round === 0 ? 'sending' : 'receiving', webContents)

        const turn = await adapter.complete(
          { model: resolvedModel.model.modelId, messages, tools },
          abortController.signal
        )

        // 没有工具调用，直接返回结果。
        if (turn.toolCalls.length === 0) {
          this.notifyAiStatus('idle', webContents)
          return {
            success: true,
            data: {
              role: 'assistant',
              content: turn.content,
              reasoning_content: turn.reasoningContent
            }
          }
        }

        // 记录助手回复（含 reasoning_content 与工具调用）后执行工具。
        messages.push({
          role: 'assistant',
          content: turn.content,
          reasoning_content: turn.reasoningContent,
          tool_calls: turn.toolCalls
        })

        for (const toolCall of turn.toolCalls) {
          const result = await this.executeToolCall(toolCall, webContents)
          messages.push({ role: 'tool', content: result, tool_call_id: toolCall.id })
        }
      }

      // 超过最大轮次
      this.notifyAiStatus('idle', webContents)
      return { success: false, error: '工具调用轮次超过限制' }
    } catch (error: unknown) {
      this.notifyAiStatus('idle', webContents)
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'AI 调用已中止' }
      }
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    } finally {
      this.abortControllers.delete(requestId)
    }
  }
  /**
   * 流式调用 AI，自动处理工具调用循环
   * 流式过程中实时推送 content 和 reasoning_content 片段
   * @param option 插件提交的模型、消息和工具选项
   * @param requestId 当前 AI 请求的唯一 ID
   * @param webContents 发起调用的插件页面
   * @param onChunk 接收流式消息片段的回调
   * @returns 调用完成后结束的 Promise
   * @throws 模型无效、调用中止或远端请求失败时抛出错误
   */
  private async callAIStream(
    option: AiOption,
    requestId: string,
    webContents: Electron.WebContents,
    onChunk: (chunk: Message) => void
  ): Promise<void> {
    const resolvedModel = await this.getModelConfig(option.model)
    if (!resolvedModel) {
      throw new Error('未找到 AI 模型配置，请先在设置中添加模型')
    }

    const abortController = new AbortController()
    this.abortControllers.set(requestId, abortController)

    try {
      this.notifyAiStatus('sending', webContents)
      // 按供应商配置的接口格式选择适配器，统一工具调用循环。
      const adapter = createAdapter(resolvedModel.provider)
      const tools = option.tools?.length ? option.tools : undefined
      const messages = [...option.messages]

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        this.notifyAiStatus(round === 0 ? 'sending' : 'receiving', webContents)

        // 首个增量到达时切换为接收状态，与既有 UX 保持一致。
        let receivingNotified = false
        const turn = await adapter.stream(
          { model: resolvedModel.model.modelId, messages, tools },
          abortController.signal,
          (delta) => {
            if (!receivingNotified) {
              receivingNotified = true
              this.notifyAiStatus('receiving', webContents)
            }
            onChunk({
              role: 'assistant',
              content: delta.content ?? '',
              reasoning_content: delta.reasoningContent
            })
          }
        )

        // 流结束且无工具调用，本轮直接结束。
        if (turn.toolCalls.length === 0) {
          this.notifyAiStatus('idle', webContents)
          return
        }

        // 将助手回复（含 reasoning_content）加入历史后执行工具调用。
        messages.push({
          role: 'assistant',
          content: turn.content,
          reasoning_content: turn.reasoningContent,
          tool_calls: turn.toolCalls
        })

        for (const toolCall of turn.toolCalls) {
          const result = await this.executeToolCall(toolCall, webContents)
          messages.push({ role: 'tool', content: result, tool_call_id: toolCall.id })
        }
      }

      this.notifyAiStatus('idle', webContents)
      throw new Error('工具调用轮次超过限制')
    } catch (error: unknown) {
      this.notifyAiStatus('idle', webContents)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('AI 调用已中止')
      }
      throw error
    } finally {
      this.abortControllers.delete(requestId)
    }
  }

  private abortAICall(requestId: string): void {
    const abortController = this.abortControllers.get(requestId)
    if (abortController) {
      abortController.abort()
      this.abortControllers.delete(requestId)
    }
  }
}

// 导出单例
export default new PluginAiAPI()
