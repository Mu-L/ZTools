import { BrowserWindow, ipcMain, session, type Rectangle, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { getPreloadPath, getRendererPath } from '../utils/appBundlePath'
import {
  AFDIAN_PAYMENT_INSPECT_SCRIPT,
  AFDIAN_PAYMENT_SUBMIT_SCRIPT,
  buildAfdianSendLoginCodeScript,
  buildAfdianSelectPaymentMethodScript,
  buildAfdianSubmitLoginCodeScript,
  isAllowedAfdianCheckoutURL
} from './afdianPayment'
import {
  AFDIAN_PAYMENT_ACTION_CHANNEL,
  AFDIAN_PAYMENT_STATE_CHANNEL,
  type AfdianPaymentMethod,
  type AfdianPaymentWindowAction,
  type AfdianPaymentWindowState
} from '@shared/afdianPaymentWindow'

interface AfdianPageInspection {
  ready: boolean
  loginRequired: boolean
  loginCodeSent: boolean
  resendSeconds?: number
  selectedMethod: AfdianPaymentMethod | null
  qrDataUrl: string
  qrRect: Rectangle | null
}

interface AfdianCheckoutWindow {
  window: BrowserWindow
  originWindow: BrowserWindow
  popupWindow: BrowserWindow | null
  ownerWindow: BrowserWindow | null
  paymentUrl: string
  state: AfdianPaymentWindowState
  disposed: boolean
  inspectionRunning: boolean
  inspectTimer: NodeJS.Timeout | null
  returnAfterLogin: boolean
}

const windows = new Map<string, AfdianCheckoutWindow>()
let paymentIPCRegistered = false

/**
 * 恢复打开支付窗口前的宿主窗口，不在窗口已销毁时唤起其他窗口。
 * @param ownerWindow 支付流程的真实发起窗口。
 * @returns 无返回值。
 */
function restoreOwnerWindow(ownerWindow: BrowserWindow | null): void {
  if (!ownerWindow || ownerWindow.isDestroyed()) return
  ownerWindow.show()
  ownerWindow.focus()
}

/**
 * 从爱发电订单链接读取锁定金额。
 * @param paymentUrl 服务端签发的爱发电收银台地址。
 * @returns 用于界面展示的金额字符串。
 */
function paymentAmount(paymentUrl: string): string {
  return new URL(paymentUrl).searchParams.get('custom_price') || ''
}

/**
 * 将窗口标题转换为自定义收银台中的商品名称。
 * @param title 调用方传入的窗口标题。
 * @returns 去除业务前缀后的商品名称。
 */
function paymentProductName(title: string): string {
  return title.replace(/^插件赞赏\s*[·・]\s*/, '') || '赞助 ZTools'
}

/**
 * 向自定义支付窗口发送最新状态。
 * @param checkout 当前支付窗口上下文。
 * @returns 无返回值。
 */
function sendState(checkout: AfdianCheckoutWindow): void {
  if (checkout.disposed || checkout.window.isDestroyed()) return
  checkout.window.webContents.send(AFDIAN_PAYMENT_STATE_CHANNEL, checkout.state)
}

/**
 * 合并并推送自定义支付窗口状态。
 * @param checkout 当前支付窗口上下文。
 * @param patch 需要更新的状态字段。
 * @returns 无返回值。
 */
function updateState(
  checkout: AfdianCheckoutWindow,
  patch: Partial<AfdianPaymentWindowState>
): void {
  checkout.state = { ...checkout.state, ...patch }
  sendState(checkout)
}

/**
 * 判断新打开的页面是否属于爱发电或常见支付服务域名。
 * @param value 页面尝试打开的地址。
 * @returns 是否允许在隔离的隐藏窗口中加载。
 */
function isAllowedPaymentPopupURL(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:') return false
    return (
      parsed.hostname === 'ifdian.net' ||
      parsed.hostname.endsWith('.ifdian.net') ||
      parsed.hostname === 'afdian.com' ||
      parsed.hostname.endsWith('.afdian.com') ||
      parsed.hostname === 'alipay.com' ||
      parsed.hostname.endsWith('.alipay.com') ||
      parsed.hostname === 'weixin.qq.com' ||
      parsed.hostname.endsWith('.weixin.qq.com') ||
      parsed.hostname === 'tenpay.com' ||
      parsed.hostname.endsWith('.tenpay.com')
    )
  } catch {
    return false
  }
}

/**
 * 关闭支付流程并释放可见窗口、隐藏页面、轮询器和宿主焦点。
 * @param key 业务订单唯一标识。
 * @param checkout 当前支付窗口上下文。
 * @param closeVisibleWindow 是否需要主动销毁自定义可见窗口。
 * @returns 无返回值。
 */
function disposeCheckout(
  key: string,
  checkout: AfdianCheckoutWindow,
  closeVisibleWindow: boolean
): void {
  if (checkout.disposed) return
  checkout.disposed = true
  if (windows.get(key) === checkout) windows.delete(key)
  if (checkout.inspectTimer) clearInterval(checkout.inspectTimer)
  checkout.inspectTimer = null

  // 先销毁隐藏支付页面，避免其关闭事件重复恢复宿主窗口。
  for (const child of [checkout.popupWindow, checkout.originWindow]) {
    if (child && !child.isDestroyed()) child.destroy()
  }
  if (closeVisibleWindow && !checkout.window.isDestroyed()) checkout.window.destroy()
  restoreOwnerWindow(checkout.ownerWindow)
}

/**
 * 在指定爱发电页面中选择支付方式，并容忍“更多支付”的异步展开。
 * @param checkout 当前支付窗口上下文。
 * @param method 微信或支付宝。
 * @returns 是否成功找到并点击目标支付方式。
 */
async function selectPaymentMethod(
  checkout: AfdianCheckoutWindow,
  method: AfdianPaymentMethod
): Promise<boolean> {
  const contents = checkout.originWindow.webContents
  if (checkout.disposed || contents.isDestroyed()) return false

  // 爱发电通过 Vue 异步渲染“更多支付”，短时间重试比固定等待更稳定。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const result = (await contents.executeJavaScript(
        buildAfdianSelectPaymentMethodScript(method)
      )) as { selected?: boolean }
      if (result?.selected) return true
    } catch {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

/**
 * 从页面元素坐标截取二维码，作为跨域图片无法读取时的降级方式。
 * @param contents 包含二维码的页面 WebContents。
 * @param rect 二维码元素在页面内的可见坐标。
 * @returns PNG Data URL；截图失败时返回空字符串。
 */
async function captureQRCode(contents: WebContents, rect: Rectangle): Promise<string> {
  try {
    const image = await contents.capturePage(rect)
    return image.isEmpty() ? '' : image.toDataURL()
  } catch {
    return ''
  }
}

/**
 * 检查一个真实支付页面的可用状态和二维码。
 * @param contents 爱发电主页面或支付弹窗的 WebContents。
 * @returns 页面检查结果；页面不可用时返回 null。
 */
async function inspectWebContents(contents: WebContents): Promise<AfdianPageInspection | null> {
  if (contents.isDestroyed() || contents.isLoading()) return null
  try {
    const result = (await contents.executeJavaScript(
      AFDIAN_PAYMENT_INSPECT_SCRIPT
    )) as AfdianPageInspection
    if (!result || typeof result.ready !== 'boolean') return null
    if (!result.qrDataUrl && result.qrRect) {
      result.qrDataUrl = await captureQRCode(contents, result.qrRect)
    }
    return result
  } catch {
    return null
  }
}

/**
 * 检查隐藏收银台状态，并在登录完成或二维码出现时更新可见窗口。
 * @param checkout 当前支付窗口上下文。
 * @returns 检查完成后的 Promise。
 */
async function inspectCheckout(checkout: AfdianCheckoutWindow): Promise<void> {
  if (checkout.disposed || checkout.inspectionRunning) return
  checkout.inspectionRunning = true
  try {
    const candidates = [
      checkout.popupWindow?.webContents,
      checkout.originWindow.webContents
    ].filter((contents): contents is WebContents => Boolean(contents && !contents.isDestroyed()))
    for (const contents of candidates) {
      const result = await inspectWebContents(contents)
      if (!result) continue

      // 登录输入框和支付方式会同时存在，必须优先处理登录态，避免误判为可支付。
      if (result.loginRequired) {
        if (result.loginCodeSent) {
          if (checkout.state.stage !== 'logging-in') {
            const enteringCodeStage = checkout.state.stage !== 'code-sent'
            updateState(checkout, {
              stage: 'code-sent',
              message: enteringCodeStage
                ? '验证码已发送，请填写短信验证码'
                : checkout.state.message,
              resendSeconds: result.resendSeconds
            })
          }
        } else if (!['sending-code', 'logging-in'].includes(checkout.state.stage)) {
          const enteringLoginStage = checkout.state.stage !== 'login-required'
          updateState(checkout, {
            stage: 'login-required',
            message: enteringLoginStage
              ? '登录后发电记录会绑定到爱发电账号'
              : checkout.state.message,
            resendSeconds: undefined
          })
        }
        return
      }

      if (
        result.qrDataUrl &&
        (checkout.state.stage === 'submitting' || checkout.state.stage === 'qr-ready')
      ) {
        updateState(checkout, {
          stage: 'qr-ready',
          message: '请扫码完成支付',
          qrDataUrl: result.qrDataUrl
        })
        return
      }

      if (
        result.ready &&
        ['loading', 'login-required', 'sending-code', 'code-sent', 'logging-in'].includes(
          checkout.state.stage
        )
      ) {
        const desiredMethod = checkout.state.method
        const selected = await selectPaymentMethod(checkout, desiredMethod)
        updateState(checkout, {
          stage: selected ? 'ready' : 'error',
          message: selected
            ? '支付页面已准备好'
            : '未能自动选中支付方式，请打开爱发电原页面继续支付',
          method: desiredMethod,
          phone: undefined,
          resendSeconds: undefined
        })

        // 仅登录流程自动返回自定义页面，普通故障降级不会抢走用户当前操作。
        if (checkout.returnAfterLogin && !checkout.originWindow.isDestroyed()) {
          checkout.returnAfterLogin = false
          checkout.originWindow.hide()
          checkout.window.show()
          checkout.window.focus()
        }
        return
      }
    }
  } finally {
    checkout.inspectionRunning = false
  }
}

interface AfdianLoginActionResult {
  success: boolean
  message?: string
  resendSeconds?: number
  needsManualVerification?: boolean
  alreadySent?: boolean
}

/**
 * 恢复爱发电已发送验证码后的输入状态。
 * @param checkout 当前支付窗口上下文。
 * @param phone 已接收验证码的手机号。
 * @returns 页面重载完成前结束的 Promise。
 */
async function restoreAfdianCodeEntry(
  checkout: AfdianCheckoutWindow,
  phone: string
): Promise<void> {
  await checkout.originWindow.webContents.executeJavaScript(`
    localStorage.setItem('login_mobile:last_send:orderCreate:time', String(Date.now()))
    localStorage.setItem('login_mobile:last_send:orderCreate:account', ${JSON.stringify(phone)})
  `)
  updateState(checkout, {
    stage: 'loading',
    message: '验证码已发送，正在准备验证码输入…',
    phone,
    resendSeconds: 180
  })
  checkout.originWindow.webContents.reload()
}

/**
 * 在隐藏的爱发电收银台中发送短信验证码。
 * @param checkout 当前支付窗口上下文。
 * @param phone 接收验证码的中国大陆手机号。
 * @returns 发送动作完成后的 Promise。
 */
async function sendLoginCode(checkout: AfdianCheckoutWindow, phone: string): Promise<void> {
  if (checkout.disposed) return
  if (
    checkout.state.stage === 'sending-code' ||
    checkout.state.stage === 'logging-in' ||
    (checkout.state.stage === 'code-sent' && Boolean(checkout.state.resendSeconds))
  ) {
    return
  }
  if (!['login-required', 'code-sent'].includes(checkout.state.stage)) return
  if (!/^1\d{10}$/.test(phone)) {
    updateState(checkout, {
      stage: 'login-required',
      message: '请输入正确的 11 位手机号'
    })
    return
  }

  updateState(checkout, {
    stage: 'sending-code',
    message: '正在发送短信验证码…',
    phone
  })
  try {
    const result = (await checkout.originWindow.webContents.executeJavaScript(
      buildAfdianSendLoginCodeScript(phone)
    )) as AfdianLoginActionResult
    if (result?.success && result.alreadySent) {
      await restoreAfdianCodeEntry(checkout, phone)
      return
    }
    if (result?.success) {
      updateState(checkout, {
        stage: 'code-sent',
        message: '验证码已发送，请填写短信验证码',
        phone,
        resendSeconds: result.resendSeconds
      })
      return
    }
    updateState(checkout, {
      stage: 'login-required',
      message: result?.needsManualVerification
        ? '爱发电要求完成人机验证，请打开原页面继续登录'
        : result?.message || '验证码发送失败，请稍后重试',
      phone
    })
  } catch {
    updateState(checkout, {
      stage: 'login-required',
      message: '爱发电登录页面操作失败，请稍后重试',
      phone
    })
  }
}

/**
 * 在隐藏的爱发电收银台中提交短信验证码并恢复支付流程。
 * @param checkout 当前支付窗口上下文。
 * @param phone 接收验证码的中国大陆手机号。
 * @param code 用户收到的短信验证码。
 * @returns 登录动作完成后的 Promise。
 */
async function submitLoginCode(
  checkout: AfdianCheckoutWindow,
  phone: string,
  code: string
): Promise<void> {
  if (checkout.disposed || checkout.state.stage !== 'code-sent') return
  if (!/^1\d{10}$/.test(phone)) {
    updateState(checkout, { stage: 'login-required', message: '请输入正确的 11 位手机号' })
    return
  }
  if (!/^\d{4,8}$/.test(code)) {
    updateState(checkout, { stage: 'code-sent', message: '请输入正确的短信验证码', phone })
    return
  }

  updateState(checkout, { stage: 'logging-in', message: '正在验证登录…', phone })
  try {
    const result = (await checkout.originWindow.webContents.executeJavaScript(
      buildAfdianSubmitLoginCodeScript(code)
    )) as AfdianLoginActionResult
    if (!result?.success) {
      updateState(checkout, {
        stage: 'code-sent',
        message: result?.needsManualVerification
          ? '爱发电要求完成人机验证，请打开原页面继续登录'
          : result?.message || '验证码验证失败，请重新输入',
        phone
      })
      return
    }

    // 验证成功后重新检查页面，由统一流程选择支付方式并切换为 ready。
    updateState(checkout, { stage: 'loading', message: '登录成功，正在准备支付页面…' })
    await inspectCheckout(checkout)
  } catch {
    updateState(checkout, {
      stage: 'code-sent',
      message: '爱发电登录页面操作失败，请重新输入验证码',
      phone
    })
  }
}

/**
 * 将新创建的支付弹窗纳入隐藏页面检查和生命周期管理。
 * @param checkout 当前支付窗口上下文。
 * @param popupWindow 爱发电或支付服务创建的子窗口。
 * @returns 无返回值。
 */
function attachPaymentPopup(checkout: AfdianCheckoutWindow, popupWindow: BrowserWindow): void {
  if (checkout.popupWindow && !checkout.popupWindow.isDestroyed()) checkout.popupWindow.destroy()
  checkout.popupWindow = popupWindow
  popupWindow.hide()
  popupWindow.webContents.on('did-finish-load', () => void inspectCheckout(checkout))
  popupWindow.webContents.on('did-navigate-in-page', () => void inspectCheckout(checkout))
  popupWindow.on('closed', () => {
    if (checkout.popupWindow === popupWindow) checkout.popupWindow = null
  })
}

/**
 * 配置隐藏爱发电窗口的导航、弹窗和页面状态监听。
 * @param checkout 当前支付窗口上下文。
 * @returns 无返回值。
 */
function configureOriginWindow(checkout: AfdianCheckoutWindow): void {
  const { originWindow } = checkout
  originWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedPaymentPopupURL(url)) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
          session: session.fromPartition('persist:ztools-afdian-payment')
        }
      }
    }
  })
  originWindow.webContents.on('did-create-window', (popupWindow) =>
    attachPaymentPopup(checkout, popupWindow)
  )
  originWindow.webContents.on('did-finish-load', () => void inspectCheckout(checkout))
  originWindow.webContents.on('did-navigate-in-page', () => void inspectCheckout(checkout))
  originWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (errorCode === -3 || checkout.disposed) return
    updateState(checkout, {
      stage: 'error',
      message: `爱发电页面加载失败：${errorDescription}`
    })
  })
}

/**
 * 提交真实爱发电支付页面并开始等待二维码。
 * @param checkout 当前支付窗口上下文。
 * @returns 提交动作完成后的 Promise。
 */
async function submitPayment(checkout: AfdianCheckoutWindow): Promise<void> {
  if (checkout.disposed || checkout.state.stage === 'submitting') return
  updateState(checkout, {
    stage: 'submitting',
    message: '正在调用爱发电收银台…',
    qrDataUrl: undefined
  })

  const selected = await selectPaymentMethod(checkout, checkout.state.method)
  if (!selected) {
    updateState(checkout, {
      stage: 'error',
      message: '未能自动选中支付方式，请打开爱发电原页面继续支付'
    })
    return
  }

  try {
    const submitted = await checkout.originWindow.webContents.executeJavaScript(
      AFDIAN_PAYMENT_SUBMIT_SCRIPT
    )
    if (!submitted) {
      updateState(checkout, {
        stage: 'error',
        message: '未找到爱发电支付按钮，请打开原页面继续支付'
      })
      return
    }
  } catch {
    updateState(checkout, {
      stage: 'error',
      message: '爱发电支付页面操作失败，请打开原页面继续支付'
    })
    return
  }

  // 支付组件可能先请求接口再异步显示二维码，由统一检查器持续捕获。
  void inspectCheckout(checkout)
}

/**
 * 显示真实爱发电窗口，用于首次登录或自动化失效后的人工操作。
 * @param checkout 当前支付窗口上下文。
 * @returns 无返回值。
 */
function showOriginalCheckout(checkout: AfdianCheckoutWindow): void {
  if (checkout.disposed || checkout.originWindow.isDestroyed()) return
  checkout.returnAfterLogin = [
    'login-required',
    'sending-code',
    'code-sent',
    'logging-in'
  ].includes(checkout.state.stage)
  checkout.window.hide()
  checkout.originWindow.show()
  checkout.originWindow.focus()
}

/**
 * 处理自定义支付页面发来的受限动作。
 * @param key 业务订单唯一标识。
 * @param checkout 当前支付窗口上下文。
 * @param action 经过结构检查的窗口动作。
 * @returns 无返回值。
 */
function handleWindowAction(
  key: string,
  checkout: AfdianCheckoutWindow,
  action: AfdianPaymentWindowAction
): void {
  if (action.type === 'ready') {
    sendState(checkout)
    return
  }
  if (action.type === 'send-login-code') {
    if (typeof action.phone !== 'string') return
    void sendLoginCode(checkout, action.phone.trim())
    return
  }
  if (action.type === 'submit-login-code') {
    if (typeof action.phone !== 'string' || typeof action.code !== 'string') return
    void submitLoginCode(checkout, action.phone.trim(), action.code.trim())
    return
  }
  if (action.type === 'select-method') {
    if (action.method !== 'wechat' && action.method !== 'alipay') return
    updateState(checkout, { method: action.method, stage: 'ready', message: '支付方式已切换' })
    void selectPaymentMethod(checkout, action.method).then((selected) => {
      if (
        !selected &&
        !checkout.disposed &&
        checkout.state.stage === 'ready' &&
        checkout.state.method === action.method
      ) {
        updateState(checkout, {
          stage: 'error',
          message: '爱发电暂未显示该支付方式，请打开原页面检查'
        })
      }
    })
    return
  }
  if (action.type === 'submit') {
    void submitPayment(checkout)
    return
  }
  if (action.type === 'open-original') {
    showOriginalCheckout(checkout)
    return
  }
  if (action.type === 'close') disposeCheckout(key, checkout, true)
}

/**
 * 注册自定义支付窗口的单一 IPC 入口，并按发送方 WebContents 隔离订单。
 * @returns 无返回值。
 */
function ensurePaymentIPC(): void {
  if (paymentIPCRegistered) return
  paymentIPCRegistered = true
  ipcMain.on(AFDIAN_PAYMENT_ACTION_CHANNEL, (event, action: AfdianPaymentWindowAction) => {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return
    for (const [key, checkout] of windows) {
      if (checkout.window.webContents.id !== event.sender.id) continue
      handleWindowAction(key, checkout, action)
      return
    }
  })
}

/**
 * 加载 ZTools 自定义支付页面。
 * @param window 自定义支付 BrowserWindow。
 * @returns 页面加载完成后的 Promise。
 */
async function loadPaymentUI(window: BrowserWindow): Promise<void> {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/afdian-payment.html`)
    return
  }
  await window.loadFile(getRendererPath('afdian-payment.html'))
}

/**
 * 复用持久化爱发电会话，显示 ZTools 自定义收银台并在后台加载真实支付页。
 * @param key 业务订单唯一标识，AI 与插件不能互相关闭窗口。
 * @param url 服务端签发的收银台地址。
 * @param title 窗口名称和商品名称来源。
 * @param ownerWindow 支付发起窗口，支付时隐藏、关闭后恢复；可以是主窗口或分离插件窗口。
 * @returns 自定义收银台窗口；隔离 E2E 下不访问外部页面，返回 null。
 * @throws 收银台地址无效时抛错。
 */
export function openAfdianCheckout(
  key: string,
  url: string,
  title: string,
  ownerWindow: BrowserWindow | null
): BrowserWindow | null {
  if (!isAllowedAfdianCheckoutURL(url)) throw new Error('支付链接无效')
  if (process.env.ZTOOLS_E2E === '1') {
    ownerWindow?.hide()
    return null
  }
  ensurePaymentIPC()

  const existing = windows.get(key)
  if (existing && !existing.window.isDestroyed()) {
    existing.ownerWindow = ownerWindow
    existing.window.show()
    existing.window.focus()
    ownerWindow?.hide()
    return existing.window
  }

  const paymentSession = session.fromPartition('persist:ztools-afdian-payment')
  const window = new BrowserWindow({
    width: 460,
    height: 620,
    minWidth: 400,
    minHeight: 540,
    frame: false,
    show: true,
    title,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: getPreloadPath('afdian-payment.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const originWindow = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 400,
    minHeight: 600,
    show: false,
    title: `${title} · 爱发电`,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      session: paymentSession
    }
  })
  const checkout: AfdianCheckoutWindow = {
    window,
    originWindow,
    popupWindow: null,
    ownerWindow,
    paymentUrl: url,
    state: {
      title,
      productName: paymentProductName(title),
      amount: paymentAmount(url),
      method: 'wechat',
      stage: 'loading',
      message: '正在连接爱发电…'
    },
    disposed: false,
    inspectionRunning: false,
    inspectTimer: null,
    returnAfterLogin: false
  }
  windows.set(key, checkout)
  configureOriginWindow(checkout)

  window.on('closed', () => disposeCheckout(key, checkout, false))
  originWindow.on('closed', () => {
    if (!checkout.disposed) disposeCheckout(key, checkout, true)
  })

  // 自定义界面立即显示；真实收银台完全在隐藏窗口中加载和操作。
  void loadPaymentUI(window).catch(() => {
    updateState(checkout, {
      stage: 'error',
      message: 'ZTools 支付页面加载失败，请关闭后重试'
    })
  })
  void originWindow.loadURL(url)
  checkout.inspectTimer = setInterval(() => void inspectCheckout(checkout), 600)
  window.focus()
  ownerWindow?.hide()
  return window
}

/**
 * 仅关闭指定业务订单的支付窗口，不清理爱发电登录 Cookie。
 * @param key 业务订单唯一标识。
 * @param ownerWindow 需要恢复的支付发起窗口。
 * @returns 无返回值。
 */
export function closeAfdianCheckout(key: string, ownerWindow: BrowserWindow | null): void {
  const checkout = windows.get(key)
  if (checkout) {
    checkout.ownerWindow = ownerWindow
    disposeCheckout(key, checkout, true)
    return
  }
  restoreOwnerWindow(ownerWindow)
}
