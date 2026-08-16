import OpenAI from 'openai'
import type { AiProvider } from '../../../../shared/aiProviderShared.js'
import type { Message, Tool, ToolCall } from '../ai'
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  fromAnthropicContent,
  fromResponsesOutput,
  toAnthropicMessages,
  toAnthropicTools,
  toResponsesInput,
  toResponsesTools,
  type AssistantTurn
} from './converters'

export type { AssistantTurn }

/** 单轮调用的输入：模型、消息历史与可选工具。 */
export interface AdapterInput {
  model: string
  messages: Message[]
  tools?: Tool[]
}

/** 流式增量回调携带的字段，缺省表示本轮该字段无增量。 */
interface AdapterDelta {
  content?: string
  reasoningContent?: string
}

/** 三种接口格式的统一调用契约。 */
export interface AiProtocolAdapter {
  /**
   * 非流式调用，返回单轮完整回复。
   * @param input 模型、消息与工具
   * @param signal 中止信号
   * @returns 归一化的助手回复
   */
  complete(input: AdapterInput, signal: AbortSignal): Promise<AssistantTurn>
  /**
   * 流式调用，实时回传增量并在结束时返回完整回复。
   * @param input 模型、消息与工具
   * @param signal 中止信号
   * @param onDelta 接收文本与推理增量的回调
   * @returns 归一化的助手回复
   */
  stream(
    input: AdapterInput,
    signal: AbortSignal,
    onDelta: (delta: AdapterDelta) => void
  ): Promise<AssistantTurn>
}

/**
 * 按供应商配置的接口格式选择对应适配器。
 * @param provider 已解析的供应商连接配置
 * @returns 该供应商的接口适配器
 */
export function createAdapter(provider: AiProvider): AiProtocolAdapter {
  switch (provider.apiFormat) {
    case 'openai-chat':
      return new OpenAiChatAdapter(createOpenAiClient(provider))
    case 'openai-responses':
      return new OpenAiResponsesAdapter(createOpenAiClient(provider))
    case 'anthropic-messages':
      return new AnthropicMessagesAdapter(provider)
    default:
      // 理论上不会到达，防御未知格式以避免静默失败。
      throw new Error(`不支持的接口格式: ${String(provider.apiFormat)}`)
  }
}

/**
 * 使用供应商凭据创建 OpenAI 兼容客户端，供 Chat 与 Responses 适配器复用。
 * @param provider 供应商连接配置
 * @returns OpenAI SDK 客户端
 */
function createOpenAiClient(provider: AiProvider): OpenAI {
  return new OpenAI({ apiKey: provider.apiKey, baseURL: provider.apiUrl })
}

/**
 * 将插件消息转为 OpenAI Chat Completions 的消息参数。
 * @param messages 标准消息历史
 * @returns OpenAI SDK 消息参数数组
 */
function convertMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    // 助手消息保留 reasoning_content 与 tool_calls，解决 DeepSeek thinking mode 透传。
    if (msg.role === 'assistant') {
      const assistantMsg: Record<string, unknown> = {
        role: 'assistant',
        content: msg.content || ''
      }
      if (msg.reasoning_content) {
        assistantMsg.reasoning_content = msg.reasoning_content
      }
      if (msg.tool_calls?.length) {
        assistantMsg.tool_calls = msg.tool_calls
      }
      return assistantMsg as unknown as OpenAI.ChatCompletionMessageParam
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool' as const,
        content: (typeof msg.content === 'string' ? msg.content : '') || '',
        tool_call_id: msg.tool_call_id || ''
      }
    }
    // user 消息支持字符串或内容块数组（多模态）。
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return {
        role: 'user' as const,
        content: msg.content as OpenAI.ChatCompletionContentPart[]
      }
    }
    return {
      role: msg.role as 'system' | 'user',
      content: (typeof msg.content === 'string' ? msg.content : '') || ''
    }
  })
}

/**
 * 将插件工具定义转为 OpenAI Chat Completions 的工具参数。
 * @param tools 可选的工具列表
 * @returns OpenAI SDK 工具参数数组
 */
function convertChatTools(tools?: Tool[]): OpenAI.ChatCompletionTool[] {
  return (tools ?? [])
    .filter((tool) => tool.function)
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.function!.name,
        description: tool.function!.description,
        parameters: tool.function!.parameters as OpenAI.FunctionParameters
      }
    }))
}

/**
 * 从 Chat Completions 返回中提取函数类型的工具调用。
 * @param toolCalls 模型返回的原始工具调用
 * @returns 归一化的 ToolCall 数组
 */
function extractChatToolCalls(toolCalls?: OpenAI.ChatCompletionMessageToolCall[]): ToolCall[] {
  if (!toolCalls?.length) return []
  return toolCalls
    .filter(
      (toolCall): toolCall is OpenAI.ChatCompletionMessageFunctionToolCall =>
        toolCall.type === 'function'
    )
    .map((toolCall) => ({
      id: toolCall.id,
      type: 'function' as const,
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments
      }
    }))
}

/**
 * OpenAI Chat Completions 适配器，沿用既有调用与透传逻辑。
 */
class OpenAiChatAdapter implements AiProtocolAdapter {
  constructor(private readonly client: OpenAI) {}

  public async complete(input: AdapterInput, signal: AbortSignal): Promise<AssistantTurn> {
    const tools = convertChatTools(input.tools)
    const response = await this.client.chat.completions.create(
      {
        model: input.model,
        messages: convertMessages(input.messages),
        ...(tools.length ? { tools } : {})
      },
      { signal }
    )

    const choice = response.choices[0]
    if (!choice) return { content: '', toolCalls: [] }
    const assistantMsg = choice.message
    // 提取 reasoning_content（DeepSeek 等模型的非标准字段）。
    const reasoningContent = (assistantMsg as unknown as Record<string, unknown>)
      .reasoning_content as string | undefined
    return {
      content: assistantMsg.content || '',
      reasoningContent,
      toolCalls: extractChatToolCalls(assistantMsg.tool_calls)
    }
  }

  public async stream(
    input: AdapterInput,
    signal: AbortSignal,
    onDelta: (delta: AdapterDelta) => void
  ): Promise<AssistantTurn> {
    const tools = convertChatTools(input.tools)
    const stream = await this.client.chat.completions.create(
      {
        model: input.model,
        messages: convertMessages(input.messages),
        stream: true,
        ...(tools.length ? { tools } : {})
      },
      { signal }
    )

    let fullContent = ''
    let fullReasoning = ''
    // 工具调用按 index 累积参数片段，流结束后统一归一化。
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue
      const deltaAny = delta as Record<string, unknown>
      const reasoningDelta = deltaAny.reasoning_content as string | undefined
      const contentDelta = delta.content || ''

      if (contentDelta || reasoningDelta) {
        fullContent += contentDelta
        fullReasoning += reasoningDelta || ''
        onDelta({
          content: contentDelta || undefined,
          reasoningContent: reasoningDelta || undefined
        })
      }

      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const existing = toolCalls.get(toolCall.index)
          if (existing) {
            existing.arguments += toolCall.function?.arguments || ''
          } else {
            toolCalls.set(toolCall.index, {
              id: toolCall.id || '',
              name: toolCall.function?.name || '',
              arguments: toolCall.function?.arguments || ''
            })
          }
        }
      }
    }

    return {
      content: fullContent,
      reasoningContent: fullReasoning || undefined,
      toolCalls: Array.from(toolCalls.values()).map((toolCall) => ({
        id: toolCall.id,
        type: 'function' as const,
        function: { name: toolCall.name, arguments: toolCall.arguments }
      }))
    }
  }
}

/**
 * OpenAI Responses API 适配器。
 */
class OpenAiResponsesAdapter implements AiProtocolAdapter {
  constructor(private readonly client: OpenAI) {}

  public async complete(input: AdapterInput, signal: AbortSignal): Promise<AssistantTurn> {
    const tools = toResponsesTools(input.tools)
    // store:false 使请求无状态化，工具调用历史由输入项完整回传。
    const params = {
      model: input.model,
      input: toResponsesInput(input.messages),
      store: false,
      ...(tools ? { tools } : {})
    } as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming
    const response = await this.client.responses.create(params, { signal })
    return fromResponsesOutput(response.output)
  }

  public async stream(
    input: AdapterInput,
    signal: AbortSignal,
    onDelta: (delta: AdapterDelta) => void
  ): Promise<AssistantTurn> {
    const tools = toResponsesTools(input.tools)
    const params = {
      model: input.model,
      input: toResponsesInput(input.messages),
      store: false,
      stream: true,
      ...(tools ? { tools } : {})
    } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming
    const stream = await this.client.responses.create(params, { signal })

    let completed: OpenAI.Responses.Response | null = null
    for await (const event of stream) {
      // 文本与推理增量实时回传，工具调用在 completed 事件中一次性归一化。
      if (event.type === 'response.output_text.delta') {
        onDelta({ content: event.delta })
      } else if (event.type === 'response.reasoning_text.delta') {
        onDelta({ reasoningContent: event.delta })
      } else if (event.type === 'response.completed') {
        completed = event.response
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        throw new Error('Responses API 返回失败或不完整事件')
      }
    }
    if (!completed) throw new Error('Responses API 未返回完整响应')
    return fromResponsesOutput(completed.output)
  }
}

/**
 * Anthropic Messages API 适配器，使用原生 fetch 以避免新增依赖并兼容自定义中转地址。
 */
class AnthropicMessagesAdapter implements AiProtocolAdapter {
  constructor(private readonly provider: AiProvider) {}

  public async complete(input: AdapterInput, signal: AbortSignal): Promise<AssistantTurn> {
    const response = await this.request(this.buildBody(input, false), signal)
    // 非流式响应体为单个 JSON 对象，content 字段即模型输出块。
    const json = (await response.json()) as { content?: unknown }
    return fromAnthropicContent(json.content)
  }

  public async stream(
    input: AdapterInput,
    signal: AbortSignal,
    onDelta: (delta: AdapterDelta) => void
  ): Promise<AssistantTurn> {
    const response = await this.request(this.buildBody(input, true), signal)
    return parseAnthropicSse(response.body, onDelta)
  }

  /**
   * 构造 Anthropic Messages 请求体。
   * @param input 模型、消息与工具
   * @param stream 是否流式
   * @returns 请求体对象
   */
  private buildBody(input: AdapterInput, stream: boolean): Record<string, unknown> {
    const { system, messages } = toAnthropicMessages(input.messages)
    // max_tokens 是 Anthropic 必填字段，使用较高默认值减少截断。
    const body: Record<string, unknown> = {
      model: input.model,
      messages,
      max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      stream
    }
    if (system) body.system = system
    const tools = toAnthropicTools(input.tools)
    if (tools) body.tools = tools
    return body
  }

  /**
   * 发起 Anthropic 请求并校验响应状态。
   * @param body 请求体
   * @param signal 中止信号
   * @returns fetch 响应
   * @throws 鉴权或参数错误时抛出携带状态码与响应文本的错误
   */
  private async request(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const endpoint = buildAnthropicEndpoint(this.provider.apiUrl)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.provider.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal
    })
    if (!response.ok) {
      // 读取错误响应体以便定位鉴权或参数问题。
      const errorText = await response.text().catch(() => '')
      throw new Error(
        `Anthropic 请求失败 (${response.status}): ${errorText || response.statusText}`
      )
    }
    return response
  }
}

/**
 * 根据供应商地址构造 Anthropic Messages 接口地址。
 * @param apiUrl 用户填写的接口地址
 * @returns 完整的 /messages 端点
 */
function buildAnthropicEndpoint(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, '')
  // 已包含 /v1 的中转地址直接拼接 /messages，否则补 /v1/messages。
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

/** Anthropic 流式中按索引累积的工具调用片段。 */
interface AnthropicToolCallAccumulator {
  id: string
  name: string
  args: string
}

/**
 * 解析 Anthropic 流式响应的 SSE，实时回传增量并累积工具调用。
 * @param body fetch 响应的可读流
 * @param onDelta 接收文本与推理增量的回调
 * @returns 归一化的助手回复
 * @throws 流中断或收到 error 事件时抛出错误
 */
async function parseAnthropicSse(
  body: ReadableStream<Uint8Array> | null,
  onDelta: (delta: AdapterDelta) => void
): Promise<AssistantTurn> {
  if (!body) throw new Error('Anthropic 流式响应缺少 body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''
  let fullReasoning = ''
  const toolCalls: ToolCall[] = []
  // 每个 content_block 的状态按 index 跟踪，content_block_stop 时完成工具调用解析。
  const blocks = new Map<number, AnthropicToolCallAccumulator>()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE 事件以空行分隔，逐块解析后保留未完成的尾部。
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    for (const rawEvent of events) {
      const data = extractSseData(rawEvent)
      if (!data) continue
      const event = JSON.parse(data) as Record<string, unknown>
      const type = typeof event.type === 'string' ? event.type : ''

      if (type === 'content_block_start') {
        const index = event.index as number
        const block = event.content_block as Record<string, unknown> | undefined
        if (block && block.type === 'tool_use') {
          blocks.set(index, {
            id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : '',
            args: ''
          })
        }
      } else if (type === 'content_block_delta') {
        const index = event.index as number
        const delta = event.delta as Record<string, unknown> | undefined
        if (!delta) continue
        // 文本增量：回传并累积为最终内容。
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          fullContent += delta.text
          onDelta({ content: delta.text })
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          // 扩展思考默认未启用，仅当中转站或模型返回时透传。
          fullReasoning += delta.thinking
          onDelta({ reasoningContent: delta.thinking })
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const accumulator = blocks.get(index)
          if (accumulator) accumulator.args += delta.partial_json
        }
      } else if (type === 'content_block_stop') {
        const index = event.index as number
        const accumulator = blocks.get(index)
        if (accumulator) {
          // 工具调用参数为累积的 JSON 片段，解析失败时回退为空对象。
          let input: unknown
          try {
            input = accumulator.args ? JSON.parse(accumulator.args) : {}
          } catch {
            input = {}
          }
          toolCalls.push({
            id: accumulator.id,
            type: 'function',
            function: {
              name: accumulator.name,
              arguments: typeof input === 'string' ? input : JSON.stringify(input)
            }
          })
          blocks.delete(index)
        }
      } else if (type === 'error') {
        const error = event.error as Record<string, unknown> | undefined
        throw new Error(
          `Anthropic 流式响应错误: ${typeof error?.message === 'string' ? error.message : data}`
        )
      }
    }
  }

  return {
    content: fullContent,
    reasoningContent: fullReasoning || undefined,
    toolCalls
  }
}

/**
 * 从单个 SSE 事件文本中提取 data 字段的 JSON 负载。
 * @param rawEvent 单个 SSE 事件的原始文本
 * @returns data 字段拼接后的字符串；无 data 行时返回 null
 */
function extractSseData(rawEvent: string): string | null {
  const dataLines: string[] = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  return dataLines.length ? dataLines.join('\n') : null
}
