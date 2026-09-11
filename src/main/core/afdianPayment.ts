const AFDIAN_CHECKOUT_HOST = 'ifdian.net'
const AFDIAN_CHECKOUT_PATH = '/order/create'

/**
 * 构造爱发电支付方式选择脚本。
 * @param method 要选中的微信或支付宝。
 * @returns 可传给 WebContents.executeJavaScript 的脚本。
 */
export function buildAfdianSelectPaymentMethodScript(method: 'wechat' | 'alipay'): string {
  return `
(() => {
  const target = ${JSON.stringify(method)}
  const targetTexts = target === 'wechat' ? ['微信支付', 'WechatPay', 'WeChatPay'] : ['支付宝', 'Alipay']
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }
  const normalizedText = (element) => (element.textContent || '').replace(/\\s+/g, '')
  const candidates = Array.from(document.querySelectorAll(
    '.vm-icon-pay:not(.disable), .vm-icon-pay-group .item, button, [role="button"], [class*="pay"]'
  )).filter(isVisible)
  const directSelector = target === 'wechat'
    ? '.vm-icon-pay.wpy:not(.disable)'
    : '.vm-icon-pay.apy:not(.disable)'
  let paymentMethod = document.querySelector(directSelector)
  if (!isVisible(paymentMethod)) paymentMethod = null
  if (!paymentMethod) {
    paymentMethod = candidates
      .filter((element) => targetTexts.some((text) => normalizedText(element).includes(text)))
      .sort((left, right) => normalizedText(left).length - normalizedText(right).length)[0]
  }

  // 登录状态下微信支付可能折叠在“更多支付”中，先展开后由主进程重试选择。
  if (!paymentMethod && target === 'wechat') {
    const morePaymentTexts = ['更多支付', '更多支付方式', 'Morepayments', 'Morepaymentmethods']
    const directMorePayments = document.querySelector('.vm-icon-pay-group .item')
    const morePaymentCandidates = Array.from(document.querySelectorAll(
      '[class*="more-pay"], [class*="more_pay"], .vm-icon-pay-group'
    )).filter(isVisible)
    const morePayments = isVisible(directMorePayments)
      ? directMorePayments
      : morePaymentCandidates.find((element) =>
          morePaymentTexts.some((text) => normalizedText(element).includes(text))
        ) ||
        candidates.find((element) =>
          morePaymentTexts.some((text) => normalizedText(element).includes(text))
        )
    if (morePayments instanceof HTMLElement) {
      morePayments.click()
      return { selected: false, expanded: true }
    }
  }

  if (!(paymentMethod instanceof HTMLElement)) return { selected: false, expanded: false }
  if (!paymentMethod.classList.contains('on')) paymentMethod.click()
  return {
    selected: paymentMethod.classList.contains('on'),
    clicked: true,
    expanded: false
  }
})()
`
}

/**
 * 支付方式异步渲染脚本：展开“更多支付”后默认选中微信。
 * 仅操作爱发电收银台自身的 DOM，不读取或写入 ZTools 数据。
 */
export const AFDIAN_PAYMENT_SELECT_WECHAT_SCRIPT = buildAfdianSelectPaymentMethodScript('wechat')

/**
 * 构造爱发电登录输入框赋值脚本片段。
 * @param value 需要写入输入框的值。
 * @returns 在爱发电页面中触发 Vue 输入事件的脚本片段。
 */
function buildInputValueScript(value: string): string {
  return `
  const setInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(input, value)
    else input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const inputValue = ${JSON.stringify(value)}
`
}

/**
 * 构造在隐藏爱发电收银台中发送登录验证码的脚本。
 * @param phone 接收验证码的中国大陆手机号。
 * @returns 可传给 WebContents.executeJavaScript 的异步脚本。
 */
export function buildAfdianSendLoginCodeScript(phone: string): string {
  return `
(async () => {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }
  const normalizedText = (element) => (element.textContent || '').replace(/\\s+/g, '')
  ${buildInputValueScript(phone)}
  const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible)
  const phoneInput = inputs.find((input) =>
    /验证手机或邮箱|手机号|手机号码|邮箱|phone or email verification|verify phone or email/i.test(
      input.getAttribute('placeholder') || ''
    )
  ) || inputs.find((input) => input.getAttribute('type') === 'tel') || inputs[0]
  if (!(phoneInput instanceof HTMLInputElement)) {
    return { success: false, message: '未找到爱发电手机号输入框' }
  }
  setInputValue(phoneInput, inputValue)

  // 等待爱发电 Vue 组件接收 v-model 事件，避免点击时仍读取到旧手机号。
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  // 记录爱发电验证码接口的业务响应，避免短暂通知消失后只能等待超时。
  let loginResponse = null
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this.__ztoolsAfdianLoginURL = String(url)
    return originalOpen.call(this, method, url, ...args)
  }
  XMLHttpRequest.prototype.send = function(body) {
    if ((this.__ztoolsAfdianLoginURL || '').includes('/api/passport/send-ql-code')) {
      this.addEventListener('loadend', () => {
        try {
          loginResponse = JSON.parse(String(this.responseText || ''))
        } catch {
          loginResponse = { ec: this.status, em: '' }
        }
      }, { once: true })
    }
    return originalSend.call(this, body)
  }
  const finish = (result) => {
    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
    return result
  }

  const candidates = Array.from(document.querySelectorAll(
    '.vm-login-mobile .code-btn, button, [role="button"], a, span.code-btn'
  ))
    .filter(isVisible)
    .filter((element) => {
      const text = normalizedText(element)
      return ['发送', '发送验证码', '重新发送', 'Send', 'Sendcode', 'Resend'].includes(text)
    })
    .sort((left, right) => normalizedText(left).length - normalizedText(right).length)
  const sendButton = candidates[0]
  if (!(sendButton instanceof HTMLElement)) {
    return finish({ success: false, message: '未找到爱发电发送验证码按钮' })
  }
  sendButton.click()

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const bodyText = (document.body?.innerText || '').replace(/\\s+/g, '')
    if (loginResponse) {
      const code = Number(loginResponse.ec)
      const responseMessage = String(loginResponse.em || '')
      if (code === 200) {
        return finish({ success: true, message: '验证码已发送', resendSeconds: 180 })
      }
      if (/刚刚已经发送了验证码|already.*verificationcode|verificationcode.*already/i.test(
        responseMessage.replace(/\\s+/g, '')
      )) {
        return finish({
          success: true,
          alreadySent: true,
          message: '验证码已经发送',
          resendSeconds: 180
        })
      }
      return finish({
        success: false,
        message: responseMessage || '爱发电验证码接口返回错误'
      })
    }
    const visibleInputs = Array.from(document.querySelectorAll('input')).filter(isVisible)
    const hasCodeInput = visibleInputs.some((input) =>
      /验证码|verification code/i.test(input.getAttribute('placeholder') || '')
    )
    if (
      hasCodeInput ||
      bodyText.includes('验证码已经发送') ||
      bodyText.includes('Verificationcodehasbeensent') ||
      bodyText.includes('已发送（') ||
      bodyText.includes('Sent(')
    ) {
      const countdown = bodyText.match(/(?:已发送|Sent)[（(]?\\s*(\\d+)\\s*s/i)
      return finish({
        success: true,
        message: '验证码已发送',
        resendSeconds: countdown ? Number(countdown[1]) : undefined
      })
    }
    if (
      bodyText.includes('刚刚已经发送了验证码了') ||
      bodyText.includes('Verificationcodehasalreadybeensent') ||
      bodyText.includes('Verificationcodewasjustsent')
    ) {
      return finish({
        success: true,
        alreadySent: true,
        message: '验证码已经发送',
        resendSeconds: 180
      })
    }
    if (/图形验证码|滑块|人机验证|安全验证|captcha|securityverification/i.test(bodyText)) {
      return finish({ success: false, needsManualVerification: true, message: '爱发电需要完成人机验证' })
    }
  }
  return finish({ success: false, message: '爱发电验证码接口响应超时，请稍后重试' })
})()
`
}

/**
 * 构造在隐藏爱发电收银台中提交短信验证码的脚本。
 * @param code 用户收到的短信验证码。
 * @returns 可传给 WebContents.executeJavaScript 的异步脚本。
 */
export function buildAfdianSubmitLoginCodeScript(code: string): string {
  return `
(async () => {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }
  const normalizedText = (element) => (element.textContent || '').replace(/\\s+/g, '')
  ${buildInputValueScript(code)}
  const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible)
  const codeInput = inputs.find((input) =>
    /验证码|verification code/i.test(input.getAttribute('placeholder') || '')
  ) || inputs[1]
  if (!(codeInput instanceof HTMLInputElement)) {
    return { success: false, message: '未找到爱发电验证码输入框' }
  }
  setInputValue(codeInput, inputValue)

  // 验证码同样需要先进入爱发电组件状态，再触发确认按钮。
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  const candidates = Array.from(document.querySelectorAll(
    '.vm-login-mobile .code-btn, button, [role="button"], a, span.code-btn'
  ))
    .filter(isVisible)
    .filter((element) => ['确认', 'Confirm'].includes(normalizedText(element)))
    .sort((left, right) => normalizedText(left).length - normalizedText(right).length)
  const confirmButton = candidates[0]
  if (!(confirmButton instanceof HTMLElement)) {
    return { success: false, message: '未找到爱发电验证码确认按钮' }
  }
  confirmButton.click()

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const bodyText = (document.body?.innerText || '').replace(/\\s+/g, '')
    const loginInput = Array.from(document.querySelectorAll('input')).filter(isVisible).find((input) =>
      /验证手机或邮箱|手机号|手机号码|邮箱|phone or email verification|verify phone or email/i.test(
        input.getAttribute('placeholder') || ''
      )
    )
    if (!loginInput || bodyText.includes('验证成功') || bodyText.includes('Verificationsuccessful')) {
      return { success: true, message: '登录成功' }
    }
    if (/验证码错误|验证码无效|验证码已过期|请重新获取|invalidcode|incorrectcode|codeexpired/i.test(bodyText)) {
      return { success: false, message: '验证码错误或已过期，请重新输入' }
    }
    if (/图形验证码|滑块|人机验证|安全验证|captcha|securityverification/i.test(bodyText)) {
      return { success: false, needsManualVerification: true, message: '爱发电需要完成人机验证' }
    }
  }
  return { success: false, message: '登录结果等待超时，请稍后重试' }
})()
`
}

/**
 * 检查爱发电页面是否可支付，并提取当前二维码候选。
 * @returns 可传给 WebContents.executeJavaScript 的异步脚本。
 */
export const AFDIAN_PAYMENT_INSPECT_SCRIPT = `
(async () => {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }
  const normalizedText = (element) => (element.textContent || '').replace(/\\s+/g, '')
  const paymentCandidates = Array.from(document.querySelectorAll(
    '.vm-icon-pay:not(.disable), .vm-icon-pay-group .item, button, [role="button"], [class*="pay"]'
  )).filter(isVisible)
  const wechat = paymentCandidates.find((element) =>
    ['微信支付', 'WechatPay', 'WeChatPay'].some((text) => normalizedText(element).includes(text))
  )
  const alipay = paymentCandidates.find((element) =>
    ['支付宝', 'Alipay'].some((text) => normalizedText(element).includes(text))
  )
  const selected = paymentCandidates.find((element) => element.classList.contains('on'))
  const selectedText = selected ? normalizedText(selected) : ''
  const bodyText = (document.body?.innerText || '').replace(/\\s+/g, '')
  const hostname = window.location.hostname.toLowerCase()
  const isAfdianPage = hostname === 'ifdian.net' || hostname.endsWith('.ifdian.net') ||
    hostname === 'afdian.com' || hostname.endsWith('.afdian.com')
  const visibleInputs = Array.from(document.querySelectorAll('input')).filter(isVisible)
  const phoneInput = visibleInputs.find((input) =>
    /验证手机或邮箱|手机号|手机号码|邮箱|phone or email verification|verify phone or email/i.test(
      input.getAttribute('placeholder') || ''
    )
  )
  const codeInput = visibleInputs.find((input) => input !== phoneInput && (
    /验证码|verification code/i.test(input.getAttribute('placeholder') || '') || visibleInputs.indexOf(input) === 1
  ))
  // 支付宝等第三方页面也可能带登录输入框，只允许爱发电页面触发爱发电登录流程。
  const loginRequired = isAfdianPage && (Boolean(phoneInput) || (
    Boolean(document.querySelector('input[type="password"]')) ||
    bodyText.includes('登录账号') ||
    bodyText.includes('验证手机或邮箱') ||
    bodyText.includes('Phoneoremailverification') ||
    bodyText.includes('Later,youcanfindyourordersbylogging') ||
    bodyText.includes('登录后') ||
    bodyText.includes('手机号登录') ||
    bodyText.includes('验证码登录')
  ))
  const countdown = bodyText.match(/(?:已发送|Sent)[（(]?\\s*(\\d+)\\s*s/i)

  const squareCandidates = Array.from(document.querySelectorAll([
    'img',
    'canvas',
    '#J_qrCode',
    '#J_qrCodeImg',
    '.qrcode-img-wrapper',
    '.qrcode-img-area',
    '[data-role*="qrPayImg"]',
    '[class*="qrcode-img"]'
  ].join(',')))
    .filter(isVisible)
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => {
      const ratio = rect.width / Math.max(rect.height, 1)
      return rect.width >= 130 && rect.height >= 130 && ratio > 0.78 && ratio < 1.28
    })
    .sort((a, b) => {
      const describe = (element) => [
        element.id,
        typeof element.className === 'string' ? element.className : '',
        normalizedText(element.parentElement || element)
      ].join(' ')
      const score = (value) => {
        if (/J_qrCode|qrcode-img|qrPayImg/i.test(value)) return 3
        return /二维码|扫码|微信|支付宝|支付/.test(value) ? 1 : 0
      }
      return score(describe(b.element)) - score(describe(a.element)) ||
        b.rect.width * b.rect.height - a.rect.width * a.rect.height
    })

  let qrDataUrl = ''
  let qrRect = null
  const candidate = squareCandidates[0]
  if (candidate) {
    qrRect = {
      x: Math.max(0, Math.round(candidate.rect.x)),
      y: Math.max(0, Math.round(candidate.rect.y)),
      width: Math.max(1, Math.round(candidate.rect.width)),
      height: Math.max(1, Math.round(candidate.rect.height))
    }
    try {
      if (candidate.element instanceof HTMLCanvasElement) {
        qrDataUrl = candidate.element.toDataURL('image/png')
      } else if (candidate.element instanceof HTMLImageElement) {
        const source = candidate.element.currentSrc || candidate.element.src
        if (source.startsWith('data:')) {
          qrDataUrl = source
        } else if (source) {
          const response = await fetch(source, { credentials: 'include' })
          const blob = await response.blob()
          qrDataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(blob)
          })
        }
      }
    } catch {
      // 跨域二维码无法转为 Data URL 时，由主进程按坐标截图。
    }
  }

  return {
    ready: Boolean(wechat || alipay),
    loginRequired,
    loginCodeSent: Boolean(codeInput) ||
      bodyText.includes('验证码已经发送') ||
      bodyText.includes('Verificationcodehasbeensent') ||
      bodyText.includes('已发送（') ||
      bodyText.includes('Sent('),
    resendSeconds: countdown ? Number(countdown[1]) : undefined,
    selectedMethod: selectedText.includes('支付宝') || selectedText.includes('Alipay')
      ? 'alipay'
      : selectedText.includes('微信') || selectedText.includes('Wechat') || selectedText.includes('WeChat')
        ? 'wechat'
        : null,
    qrDataUrl,
    qrRect
  }
})()
`

/**
 * 在爱发电页面中点击底部确认支付按钮。
 * @returns 可传给 WebContents.executeJavaScript 的脚本。
 */
export const AFDIAN_PAYMENT_SUBMIT_SCRIPT = `
(() => {
  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) return false
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }
  const normalizedText = (element) => (element.textContent || '').replace(/\\s+/g, '')
  const candidates = Array.from(document.querySelectorAll(
    'button, [role="button"], .btn, .vm-btn, [class*="submit"], [class*="pay"]'
  )).filter(isVisible)
  const button = candidates.find((element) => {
    const text = normalizedText(element)
    return text === '支付' || text === '立即支付' || text === '确认支付' || text === '去支付' || text === 'Pay'
  })
  if (!(button instanceof HTMLElement) || button.hasAttribute('disabled')) return false
  button.click()
  return true
})()
`

/**
 * 校验官方 AI 和插件赞赏使用的爱发电收银台链接。
 * @param value 服务端返回的待打开链接
 * @returns 链接是否满足固定域名、路径和订单参数约束
 */
export function isAllowedAfdianCheckoutURL(value: string): boolean {
  try {
    const parsed = new URL(value)
    const amount = parsed.searchParams.get('custom_price') || ''
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === AFDIAN_CHECKOUT_HOST &&
      parsed.port === '' &&
      parsed.pathname === AFDIAN_CHECKOUT_PATH &&
      parsed.username === '' &&
      parsed.password === '' &&
      /^[a-f0-9]{32}$/i.test(parsed.searchParams.get('user_id') || '') &&
      parsed.searchParams.get('fr') === 'afcom' &&
      parsed.searchParams.get('month') === '1' &&
      /^(AI|PL)[a-f0-9]{32}$/i.test(parsed.searchParams.get('custom_order_id') || '') &&
      /^(?:[1-9]\d{0,3}|10000)(?:\.\d{1,2})?$/.test(amount) &&
      Number(amount) >= 5 &&
      Number(amount) <= 10000
    )
  } catch {
    return false
  }
}
