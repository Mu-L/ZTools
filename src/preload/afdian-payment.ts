import { contextBridge, ipcRenderer } from 'electron'
import {
  AFDIAN_PAYMENT_ACTION_CHANNEL,
  AFDIAN_PAYMENT_STATE_CHANNEL,
  type AfdianPaymentMethod,
  type AfdianPaymentWindowAction,
  type AfdianPaymentWindowState
} from '@shared/afdianPaymentWindow'

/**
 * 向主进程发送受限的支付窗口动作。
 * @param action 用户在自定义收银台触发的动作。
 * @returns 无返回值。
 */
function sendAction(action: AfdianPaymentWindowAction): void {
  ipcRenderer.send(AFDIAN_PAYMENT_ACTION_CHANNEL, action)
}

contextBridge.exposeInMainWorld('afdianPayment', {
  /**
   * 订阅主进程发送的支付状态，并在订阅完成后请求初始状态。
   * @param callback 状态更新回调。
   * @returns 用于移除监听器的函数。
   */
  onState(callback: (state: AfdianPaymentWindowState) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, state: AfdianPaymentWindowState): void =>
      callback(state)
    ipcRenderer.on(AFDIAN_PAYMENT_STATE_CHANNEL, listener)
    sendAction({ type: 'ready' })
    return () => ipcRenderer.removeListener(AFDIAN_PAYMENT_STATE_CHANNEL, listener)
  },

  /**
   * 请求隐藏的爱发电页面向指定手机号发送登录验证码。
   * @param phone 中国大陆手机号。
   * @returns 无返回值。
   */
  sendLoginCode(phone: string): void {
    sendAction({ type: 'send-login-code', phone })
  },

  /**
   * 请求隐藏的爱发电页面提交手机号和短信验证码。
   * @param phone 接收验证码的中国大陆手机号。
   * @param code 用户收到的短信验证码。
   * @returns 无返回值。
   */
  submitLoginCode(phone: string, code: string): void {
    sendAction({ type: 'submit-login-code', phone, code })
  },

  /**
   * 选择支付渠道。
   * @param method 微信或支付宝。
   * @returns 无返回值。
   */
  selectMethod(method: AfdianPaymentMethod): void {
    sendAction({ type: 'select-method', method })
  },

  /**
   * 请求隐藏的爱发电页面提交支付。
   * @returns 无返回值。
   */
  submit(): void {
    sendAction({ type: 'submit' })
  },

  /**
   * 显示真实爱发电页面，用于登录或自动化失败时继续支付。
   * @returns 无返回值。
   */
  openOriginal(): void {
    sendAction({ type: 'open-original' })
  },

  /**
   * 关闭整个支付流程。
   * @returns 无返回值。
   */
  close(): void {
    sendAction({ type: 'close' })
  }
})
