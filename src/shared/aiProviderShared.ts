/** AI 供应商配置的当前存储版本。 */
export const AI_PROVIDER_STORE_VERSION = 2 as const

/** AI 供应商采用的接口协议格式。 */
export type AiApiFormat = 'openai-chat' | 'anthropic-messages' | 'openai-responses'

/** 新增或历史数据缺失时使用的默认接口格式。 */
export const DEFAULT_AI_API_FORMAT: AiApiFormat = 'openai-chat'

/** 供应商接口格式选项，供设置界面复用。 */
export const AI_API_FORMAT_OPTIONS: ReadonlyArray<{ value: AiApiFormat; label: string }> = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-responses', label: 'OpenAI Responses API' }
]

/** 旧版按单个模型保存的配置。 */
export interface LegacyAiModel {
  id: string
  label: string
  apiUrl: string
  apiKey: string
  description?: string
  icon?: string
  cost?: number
}

/** 供应商中已选中的单个远端模型。 */
export interface AiProviderModel {
  /** 插件选择模型时使用的稳定、不透明标识。 */
  ref: string
  /** 供应商改名等场景产生的历史公开选择 ID。 */
  aliases?: string[]
  /** 发送给远端 OpenAI 兼容接口的真实模型 ID。 */
  modelId: string
  description?: string
  icon?: string
  cost?: number
}

/** 单个 AI 供应商及其已选模型。 */
export interface AiProvider {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  /** 供应商采用的接口格式。 */
  apiFormat: AiApiFormat
  /** 是否允许插件发现和调用该供应商的模型。 */
  enabled: boolean
  selectedModels: AiProviderModel[]
}

/** AI 供应商持久化文档。 */
export interface AiProviderStore {
  version: typeof AI_PROVIDER_STORE_VERSION
  providers: AiProvider[]
}

/** 新建或编辑供应商时提交的模型。 */
export interface AiProviderModelInput {
  modelId: string
  description?: string
  icon?: string
  cost?: number
}

/** 新建或编辑供应商时提交的数据。 */
export interface AiProviderInput {
  id?: string
  name: string
  apiUrl: string
  apiKey: string
  /** 供应商采用的接口格式；缺省时回退到默认格式。 */
  apiFormat?: AiApiFormat
  selectedModels: AiProviderModelInput[]
}

/** 从供应商接口拉取到的远端模型摘要。 */
export interface AiRemoteModel {
  id: string
}

/** 暴露给插件用于构建模型选择器的条目。 */
export interface AiModelChoice {
  /** 兼容旧插件的可读选择 ID，格式为“供应商 - 远端模型 ID”。 */
  id: string
  /** 新插件应优先使用的稳定、不透明选择 ID。 */
  value: string
  label: string
  providerId: string
  providerLabel: string
  modelId: string
  description: string
  icon: string
  cost: number
}

/** AI 供应商管理操作的统一结果。 */
export interface AiProviderMutationResult {
  success: boolean
  data?: AiProviderStore
  error?: string
}

/**
 * 判断未知数据是否为新版 AI 供应商文档。
 * @param value 待判断的持久化数据
 * @returns 是否为版本 2 的供应商文档
 */
export function isAiProviderStore(value: unknown): value is AiProviderStore {
  if (!value || typeof value !== 'object') return false

  const store = value as Partial<AiProviderStore>
  return store.version === AI_PROVIDER_STORE_VERSION && Array.isArray(store.providers)
}

/**
 * 规范化 OpenAI 兼容接口地址，避免尾部斜杠造成同一供应商被拆成多组。
 * @param apiUrl 用户填写的接口地址
 * @returns 去除首尾空白和尾部斜杠后的地址
 */
export function normalizeAiApiUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '')
}

/**
 * 将任意值归一化为合法的接口格式，非法或缺失时回退到默认格式。
 * @param value 待归一化的接口格式
 * @returns 合法的接口格式
 */
export function normalizeAiApiFormat(value: unknown): AiApiFormat {
  for (const option of AI_API_FORMAT_OPTIONS) {
    if (value === option.value) return option.value
  }
  return DEFAULT_AI_API_FORMAT
}
