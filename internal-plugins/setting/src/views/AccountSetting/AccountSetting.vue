<script setup lang="ts">
import defaultAvatar from '@/assets/image/default.png'
import { BaseDialog, useToast } from '@/components'
import { useAccountProfile } from '@/composables'
import { notifyAccountChanged } from '@/composables/useZToolsAccount'
import type { OfficialAiRechargeOrder } from '@shared/aiProviderShared'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const { success, error, warning, confirm } = useToast()
const {
  state: accountProfile,
  refresh: refreshAccountProfile,
  update: updateAccountProfile,
  clear: clearAccountProfile
} = useAccountProfile()

const loadingStats = ref(false)
const loadingCredits = ref(false)
const editingNickname = ref(false)
const nicknameInput = ref('')
const updatingNickname = ref(false)
const deletingAccount = ref(false)
const changingPassword = ref(false)
const showPasswordDialog = ref(false)
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const showRechargeDialog = ref(false)
const rechargeAmount = ref('10')
const creatingRechargeOrder = ref(false)
const pollingRechargeOrder = ref(false)
const rechargeOrder = ref<OfficialAiRechargeOrder | null>(null)
const rechargePaymentWindowClosed = ref(false)
const rechargePresets = ['5', '10', '20', '50', '100']
let rechargePollTimer: ReturnType<typeof setInterval> | null = null
const stats = ref<{
  documentCount: number
  attachmentCount: number
  storageBytes: number
  monthlyTraffic: number
} | null>(null)
const credits = ref<{
  balance: string
  totalRecharged: string
  provisioned: boolean
  syncStatus: string
} | null>(null)

const username = computed(() => accountProfile.uid)
const nickname = computed(() => accountProfile.nickname)
const avatar = computed(() => accountProfile.avatarUrl || defaultAvatar)
const loadingProfile = computed(() => accountProfile.loading)
const displayName = computed(() => accountProfile.nickname || accountProfile.uid || 'ZTools 用户')
const rechargeStatusText = computed(() => {
  switch (rechargeOrder.value?.status) {
    case 'crediting':
      return '支付成功，积分入账中'
    case 'paid_pending_credit':
      return '支付成功，正在重试入账'
    case 'credited':
      return '积分已到账'
    case 'amount_mismatch':
      return '支付金额异常，请联系客服'
    case 'failed':
      return '赞助处理失败，请联系客服'
    case 'expired':
      return '订单已过期'
    default:
      return '等待支付'
  }
})

onMounted(() => {
  void loadAccount()
})

onBeforeUnmount(() => {
  stopRechargePolling()
})

/**
 * 校验登录状态并加载个人中心所需资料。
 * @returns 资料加载完成后结束的 Promise
 */
async function loadAccount(): Promise<void> {
  try {
    // 个人中心进入时强制读取服务端，确保跨设备修改立即覆盖本机缓存。
    await refreshAccountProfile({ force: true })
    if (!accountProfile.loggedIn) {
      await router.replace({ name: 'GeneralSetting' })
      return
    }
    await Promise.all([loadCloudStats(), loadCredits()])
  } catch (err: unknown) {
    console.error('加载个人中心失败:', err)
    error('加载个人中心失败')
  }
}

/**
 * 加载当前账号的官方 AI 积分余额。
 * @returns 积分加载完成后结束的 Promise
 */
async function loadCredits(): Promise<void> {
  loadingCredits.value = true
  try {
    const result = await window.ztools.internal.syncGetAccountCredits()
    credits.value = result.success && result.credits ? result.credits : null
  } finally {
    loadingCredits.value = false
  }
}

/**
 * 打开充值弹窗并恢复默认金额和初始状态。
 * @returns 无返回值
 */
function openRechargeDialog(): void {
  stopRechargePolling()
  rechargeAmount.value = '10'
  rechargeOrder.value = null
  rechargePaymentWindowClosed.value = false
  showRechargeDialog.value = true
}

/**
 * 使用一个预设金额更新充值输入。
 * @param amount 人民币金额文本
 * @returns 无返回值
 */
function selectRechargeAmount(amount: string): void {
  rechargeAmount.value = amount
}

/**
 * 校验金额、创建服务端订单并使用默认浏览器打开爱发电支付页面。
 * @returns 订单创建与支付页面打开完成后结束的 Promise
 */
async function createRechargeOrder(): Promise<void> {
  const amount = rechargeAmount.value.trim()
  if (
    !/^(?:[1-9]\d{0,3}|10000)(?:\.\d{1,2})?$/.test(amount) ||
    Number(amount) < 5 ||
    Number(amount) > 10000
  ) {
    warning('赞助金额须为 5 至 10000 元，最多两位小数')
    return
  }
  try {
    creatingRechargeOrder.value = true
    const created = await window.ztools.internal.syncCreateAIRechargeOrder(amount)
    if (!created.success || !created.order?.paymentUrl) {
      throw new Error(created.error || '创建赞助订单失败')
    }
    rechargeOrder.value = created.order
    rechargePaymentWindowClosed.value = false
    startRechargePolling(created.order.id)
    const opened = await window.ztools.internal.syncOpenAIRechargeURL(created.order.paymentUrl)
    if (!opened.success) throw new Error(opened.error || '打开支付页面失败')
  } catch (err: unknown) {
    error(err instanceof Error ? err.message : '创建赞助订单失败')
  } finally {
    creatingRechargeOrder.value = false
  }
}

/**
 * 在独立支付窗口中重新打开当前订单对应的爱发电支付页面。
 * @returns 支付页面打开完成后结束的 Promise
 */
async function reopenRechargePage(): Promise<void> {
  const paymentUrl = rechargeOrder.value?.paymentUrl
  if (!paymentUrl) return
  const result = await window.ztools.internal.syncOpenAIRechargeURL(paymentUrl)
  if (!result.success) error(result.error || '打开支付页面失败')
}

/**
 * 启动单订单轮询，并先立即读取一次状态。
 * @param orderId 服务端充值订单编号
 * @returns 无返回值
 */
function startRechargePolling(orderId: string): void {
  stopRechargePolling()
  void pollRechargeStatus(orderId)
  rechargePollTimer = setInterval(() => void pollRechargeStatus(orderId), 2500)
}

/**
 * 查询订单状态并在到账或终态时停止轮询。
 * @param orderId 服务端充值订单编号
 * @returns 本次状态查询完成后结束的 Promise
 */
async function pollRechargeStatus(orderId: string): Promise<void> {
  if (pollingRechargeOrder.value) return
  pollingRechargeOrder.value = true
  try {
    const result = await window.ztools.internal.syncGetAIRechargeOrder(orderId)
    if (!result.success || !result.order) throw new Error(result.error || '查询赞助状态失败')
    // 查询接口不重复下发支付链接，保留创建订单时得到的可信链接供用户重新打开。
    rechargeOrder.value = {
      ...result.order,
      paymentUrl: rechargeOrder.value?.paymentUrl
    }
    const paymentConfirmed = ['crediting', 'paid_pending_credit', 'credited'].includes(
      result.order.status
    )
    if (paymentConfirmed && !rechargePaymentWindowClosed.value) {
      const closed = await window.ztools.internal.syncCloseAIRechargeWindow()
      if (closed.success) {
        rechargePaymentWindowClosed.value = true
      } else {
        console.warn('关闭赞助窗口失败:', closed.error)
      }
    }
    if (result.order.status === 'credited') {
      stopRechargePolling()
      showRechargeDialog.value = false
      await loadCredits()
      success(`${result.order.creditAmount} 积分已到账`)
      return
    }
    if (['amount_mismatch', 'failed', 'expired'].includes(result.order.status)) {
      stopRechargePolling()
      error(rechargeStatusText.value)
    }
  } catch (err: unknown) {
    // 临时网络错误保留轮询，用户无需重新发起已经支付的订单。
    console.error('查询赞助状态失败:', err)
  } finally {
    pollingRechargeOrder.value = false
  }
}

/**
 * 停止当前充值订单的状态轮询。
 * @returns 无返回值
 */
function stopRechargePolling(): void {
  if (rechargePollTimer) clearInterval(rechargePollTimer)
  rechargePollTimer = null
}

/**
 * 关闭充值弹窗并清理当前轮询。
 * @returns 无返回值
 */
function closeRechargeDialog(): void {
  if (creatingRechargeOrder.value) return
  showRechargeDialog.value = false
  stopRechargePolling()
}

/**
 * 加载当前账号的云存储与流量统计。
 * @returns 统计加载完成后结束的 Promise
 */
async function loadCloudStats(): Promise<void> {
  loadingStats.value = true

  try {
    const result = await window.ztools.internal.syncGetAccountStats()
    if (!result.success || !result.stats) {
      stats.value = null
      return
    }

    stats.value = {
      documentCount: result.stats.documentCount || 0,
      attachmentCount: result.stats.attachmentCount || 0,
      storageBytes: result.stats.storageBytes || 0,
      monthlyTraffic: result.stats.monthlyTraffic || 0
    }
  } finally {
    loadingStats.value = false
  }
}

/**
 * 选择并上传新的账号头像。
 * @returns 头像选择与上传完成后结束的 Promise
 */
async function changeAvatar(): Promise<void> {
  // 先由主进程选择本地图片，再交给同步服务上传。
  const selected = await window.ztools.internal.selectImageFile()
  if (!selected.success || !selected.path) {
    if (selected.error) error(selected.error)
    return
  }

  const uploaded = await window.ztools.internal.syncUploadAccountAvatar(selected.path)
  if (!uploaded.success || !uploaded.profile) {
    error(uploaded.error || '头像上传失败')
    return
  }

  // 上传成功后写入共享状态，侧边栏与个人中心在同一轮渲染中更新。
  await updateAccountProfile(
    {
      uid: uploaded.profile.uid || username.value,
      nickname: uploaded.profile.nickname || nickname.value,
      avatarUrl: uploaded.profile.avatarUrl || '',
      updatedAt: Date.now()
    },
    username.value
  )
  success('账号头像已更新')
}

/**
 * 退出当前账号并返回通用设置页面。
 * @returns 退出流程完成后结束的 Promise
 */
async function logout(): Promise<void> {
  try {
    const result = await window.ztools.internal.accountLogout()
    if (!result.success) throw new Error(result.error || '退出登录失败')

    clearAccountProfile()
    notifyAccountChanged()
    success('已退出登录')
    await router.replace({ name: 'GeneralSetting' })
  } catch (err: unknown) {
    error(err instanceof Error ? err.message : '退出登录失败')
  }
}

/**
 * 确认后永久删除当前服务端账号，并在成功后退出 ZTools 登录。
 * @returns 删除账号流程完成后结束的 Promise
 */
async function deleteAccount(): Promise<void> {
  const confirmed = await confirm({
    title: '删除账号',
    message: `确定永久删除账号“${username.value}”吗？\n\n云同步数据、评论及其他账号相关数据将被删除，且无法恢复。`,
    type: 'danger',
    confirmText: '永久删除'
  })
  if (!confirmed) return

  try {
    deletingAccount.value = true
    const result = await window.ztools.internal.accountDelete()
    if (!result.success) throw new Error(result.error || '删除账号失败')

    // 主进程已完成服务端删除与本地会话清理，立即清空共享资料状态。
    clearAccountProfile()
    notifyAccountChanged()
    success('账号已删除')
    await router.replace({ name: 'GeneralSetting' })
  } catch (err: unknown) {
    error(err instanceof Error ? err.message : '删除账号失败')
  } finally {
    deletingAccount.value = false
  }
}

/**
 * 打开修改密码弹窗并清空上一次输入，避免密码残留在界面状态中。
 * @returns 无返回值
 */
function openPasswordDialog(): void {
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  showPasswordDialog.value = true
}

/**
 * 关闭修改密码弹窗并清理敏感输入。
 * @returns 无返回值
 */
function closePasswordDialog(): void {
  if (changingPassword.value) return
  showPasswordDialog.value = false
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
}

/**
 * 校验并提交新密码，成功后退出当前登录但保留本地账号数据。
 * @returns 修改密码流程完成后结束的 Promise
 */
async function changePassword(): Promise<void> {
  const current = currentPassword.value
  const next = newPassword.value
  if (!current || !next || !confirmPassword.value) {
    warning('请完整填写密码')
    return
  }
  const passwordBytes = new TextEncoder().encode(next).length
  if (passwordBytes < 6 || passwordBytes > 72) {
    warning('新密码长度应为 6-72 字节')
    return
  }
  if (next !== confirmPassword.value) {
    warning('两次输入的新密码不一致')
    return
  }
  if (current === next) {
    warning('新密码不能与当前密码相同')
    return
  }

  try {
    changingPassword.value = true
    // 主进程负责请求服务端、撤销 token，并切回默认登录数据空间。
    const result = await window.ztools.internal.accountChangePassword({
      currentPassword: current,
      newPassword: next
    })
    if (!result.success) throw new Error(result.error || '修改密码失败')
    showPasswordDialog.value = false
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    clearAccountProfile()
    notifyAccountChanged()
    success('密码已修改，请使用新密码重新登录')
    await router.replace({ name: 'GeneralSetting' })
  } catch (err: unknown) {
    error(err instanceof Error ? err.message : '修改密码失败')
  } finally {
    changingPassword.value = false
  }
}

/**
 * 进入昵称编辑状态并填充当前昵称。
 * @returns 无返回值
 */
function startEditNickname(): void {
  nicknameInput.value = nickname.value || username.value
  editingNickname.value = true
}

/**
 * 取消昵称编辑并清空临时输入。
 * @returns 无返回值
 */
function cancelEditNickname(): void {
  editingNickname.value = false
  nicknameInput.value = ''
}

/**
 * 保存当前输入的新昵称并同步账号资料缓存。
 * @returns 昵称保存完成后结束的 Promise
 */
async function saveNickname(): Promise<void> {
  const newNickname = nicknameInput.value.trim()
  if (!newNickname) {
    warning('昵称不能为空')
    return
  }

  if (newNickname === nickname.value) {
    editingNickname.value = false
    return
  }

  try {
    updatingNickname.value = true

    const account = await window.ztools.internal.accountGetSession()
    if (!account.success || !account.session?.token) {
      error('未登录，无法修改昵称')
      return
    }

    const result = await window.ztools.internal.syncUpdateNickname({
      nickname: newNickname
    })
    if (!result.success || !result.profile) {
      error(result.error || '更新昵称失败')
      return
    }

    // 保存服务端最终资料，共享状态会直接驱动侧边栏更新展示名称。
    await updateAccountProfile(
      {
        uid: result.profile.uid || username.value,
        nickname: result.profile.nickname || newNickname,
        avatarUrl: result.profile.avatarUrl || accountProfile.avatarUrl,
        updatedAt: Date.now()
      },
      username.value
    )
    editingNickname.value = false
    success('昵称已更新')
  } catch (err: unknown) {
    error(err instanceof Error ? err.message : '更新昵称失败')
  } finally {
    updatingNickname.value = false
  }
}

/**
 * 将字节数格式化为适合界面展示的容量文本。
 * @param value 要格式化的字节数
 * @returns 带容量单位的文本
 */
function formatBytes(value?: number): string {
  const size = Number(value || 0)
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}
</script>

<template>
  <div class="content-panel">
    <div v-if="loadingProfile" class="loading-state">加载中...</div>
    <div v-else class="account-page">
      <section class="profile-overview">
        <button class="avatar-button" type="button" @click="changeAvatar">
          <img class="profile-avatar" :src="avatar" alt="" />
          <span>修改头像</span>
        </button>
        <div class="profile-heading">
          <strong>{{ displayName }}</strong>
          <span>ZTools 云同步账号</span>
        </div>
      </section>

      <section class="profile-info" aria-label="账号资料">
        <div class="info-item">
          <span class="info-label">用户名</span>
          <span class="info-value">{{ username }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">昵称</span>
          <div v-if="!editingNickname" class="info-value-with-action">
            <span class="info-value">{{ nickname || username }}</span>
            <button type="button" class="btn-link" @click="startEditNickname">修改</button>
          </div>
          <div v-else class="nickname-edit">
            <input
              v-model="nicknameInput"
              type="text"
              placeholder="输入昵称"
              maxlength="50"
              @keyup.enter="saveNickname"
              @keyup.esc="cancelEditNickname"
            />
            <button
              type="button"
              class="btn-primary btn-sm"
              :disabled="updatingNickname"
              @click="saveNickname"
            >
              {{ updatingNickname ? '保存中...' : '保存' }}
            </button>
            <button
              type="button"
              class="btn-secondary btn-sm"
              :disabled="updatingNickname"
              @click="cancelEditNickname"
            >
              取消
            </button>
          </div>
        </div>
      </section>

      <section class="security-section" aria-label="账号安全">
        <div class="security-row">
          <div>
            <span class="info-label">密码</span>
            <span class="security-hint">定期修改密码可保护账号安全</span>
          </div>
          <button
            type="button"
            class="btn-link"
            data-testid="change-password"
            @click="openPasswordDialog"
          >
            修改密码
          </button>
        </div>
      </section>

      <section class="usage-section">
        <h2>AI 积分</h2>
        <div class="ai-credit-card">
          <div class="ai-credit-balance">
            <span>可用积分</span>
            <strong>{{ loadingCredits ? '加载中' : credits?.balance || '0' }}</strong>
          </div>
          <div class="ai-credit-meta">
            <span>1 元 = 1 积分</span>
            <button type="button" class="btn-primary recharge-button" @click="openRechargeDialog">
              赞助送积分
            </button>
          </div>
        </div>
      </section>

      <section class="usage-section">
        <h2>云同步用量</h2>
        <div class="stats-grid">
          <div class="stat-item">
            <span>云空间占用</span>
            <strong>{{ loadingStats ? '加载中' : formatBytes(stats?.storageBytes) }}</strong>
          </div>
          <div class="stat-item">
            <span>文档数量</span>
            <strong>{{ stats?.documentCount || 0 }}</strong>
          </div>
          <div class="stat-item">
            <span>附件数量</span>
            <strong>{{ stats?.attachmentCount || 0 }}</strong>
          </div>
          <div class="stat-item">
            <span>本月流量</span>
            <strong>{{ formatBytes(stats?.monthlyTraffic) }}</strong>
          </div>
        </div>
      </section>

      <footer class="profile-actions">
        <button
          type="button"
          class="btn-action btn-secondary"
          :disabled="deletingAccount"
          @click="logout"
        >
          退出登录
        </button>
        <button
          type="button"
          class="btn-danger"
          data-testid="delete-account"
          :disabled="deletingAccount"
          @click="deleteAccount"
        >
          {{ deletingAccount ? '删除中...' : '删除账号' }}
        </button>
      </footer>
    </div>
  </div>

  <BaseDialog
    v-model:visible="showRechargeDialog"
    title="赞助送积分"
    subtitle="每赞助 1 元赠送 1 积分"
    max-width="440px"
    :close-on-overlay="!creatingRechargeOrder"
    @close="closeRechargeDialog"
  >
    <div v-if="!rechargeOrder" class="recharge-form">
      <div class="recharge-presets" aria-label="赞助金额">
        <button
          v-for="amount in rechargePresets"
          :key="amount"
          type="button"
          :class="{ active: rechargeAmount === amount }"
          @click="selectRechargeAmount(amount)"
        >
          {{ amount }} 元
        </button>
      </div>
      <label class="recharge-custom-field">
        <span>自定义金额</span>
        <div>
          <input
            v-model="rechargeAmount"
            type="text"
            inputmode="decimal"
            maxlength="8"
            placeholder="5 - 10000"
            @keyup.enter="createRechargeOrder"
          />
          <span>元</span>
        </div>
      </label>
      <div class="recharge-actions">
        <button
          type="button"
          class="btn-secondary btn-action"
          :disabled="creatingRechargeOrder"
          @click="closeRechargeDialog"
        >
          取消
        </button>
        <button
          type="button"
          class="btn-primary btn-action"
          :disabled="creatingRechargeOrder"
          @click="createRechargeOrder"
        >
          {{ creatingRechargeOrder ? '创建中...' : '前往支付' }}
        </button>
      </div>
    </div>
    <div v-else class="recharge-waiting">
      <div>
        <span>赞助金额</span>
        <strong>{{ rechargeOrder.amount }} 元</strong>
      </div>
      <p>{{ rechargeStatusText }}</p>
      <div class="recharge-actions">
        <button type="button" class="btn-secondary btn-action" @click="closeRechargeDialog">
          稍后查看
        </button>
        <button type="button" class="btn-primary btn-action" @click="reopenRechargePage">
          重新打开支付页
        </button>
      </div>
    </div>
  </BaseDialog>

  <BaseDialog
    v-model:visible="showPasswordDialog"
    title="修改密码"
    subtitle="修改成功后，所有设备都会退出登录。"
    :close-on-overlay="!changingPassword"
    @close="closePasswordDialog"
  >
    <form class="password-form" @submit.prevent="changePassword">
      <label class="password-field">
        <span>当前密码</span>
        <input
          v-model="currentPassword"
          data-testid="current-password"
          type="password"
          autocomplete="current-password"
        />
      </label>
      <label class="password-field">
        <span>新密码</span>
        <input
          v-model="newPassword"
          data-testid="new-password"
          type="password"
          autocomplete="new-password"
        />
      </label>
      <label class="password-field">
        <span>确认新密码</span>
        <input
          v-model="confirmPassword"
          data-testid="confirm-password"
          type="password"
          autocomplete="new-password"
        />
      </label>
      <div class="password-actions">
        <button
          type="button"
          class="btn-secondary btn-action"
          :disabled="changingPassword"
          @click="closePasswordDialog"
        >
          取消
        </button>
        <button
          type="submit"
          class="btn-primary btn-action"
          data-testid="submit-password-change"
          :disabled="changingPassword"
        >
          {{ changingPassword ? '提交中...' : '确认修改' }}
        </button>
      </div>
    </form>
  </BaseDialog>
</template>

<style scoped>
.content-panel {
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 20px;
  background: var(--bg-color);
}

.account-page {
  width: min(100%, 820px);
  margin: 0 auto;
}

.ai-credit-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 20px;
  border: 1px solid color-mix(in srgb, var(--primary-color) 35%, var(--divider-color));
  border-radius: 12px;
  background: color-mix(in srgb, var(--primary-color) 6%, var(--card-bg));
}

.ai-credit-card > div:first-child {
  display: grid;
  gap: 6px;
}

.ai-credit-card span {
  color: var(--text-secondary);
  font-size: 12px;
}

.ai-credit-card strong {
  color: var(--primary-color);
  font-size: 28px;
  line-height: 1;
}

.ai-credit-meta {
  display: flex;
  align-items: center;
  gap: 12px;
}

.recharge-button {
  min-width: 72px;
  border: 0;
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
}

.recharge-form,
.recharge-waiting {
  display: grid;
  gap: 18px;
}

.recharge-presets {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.recharge-presets button {
  min-width: 0;
  border: 1px solid var(--divider-color);
  border-radius: 6px;
  padding: 9px 4px;
  background: var(--control-bg);
  color: var(--text-color);
  cursor: pointer;
  font-size: 13px;
}

.recharge-presets button.active {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.recharge-custom-field {
  display: grid;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
}

.recharge-custom-field > div {
  display: flex;
  align-items: center;
  gap: 10px;
}

.recharge-custom-field input {
  min-width: 0;
  flex: 1;
  box-sizing: border-box;
  border: 1px solid var(--divider-color);
  border-radius: 6px;
  outline: none;
  padding: 9px 10px;
  background: var(--control-bg);
  color: var(--text-color);
  font-size: 14px;
}

.recharge-custom-field input:focus {
  border-color: var(--primary-color);
}

.recharge-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.recharge-waiting > div:first-child {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  color: var(--text-secondary);
  font-size: 13px;
}

.recharge-waiting strong {
  color: var(--text-color);
  font-size: 20px;
}

.recharge-waiting p {
  margin: 0;
  border-top: 1px solid var(--divider-color);
  border-bottom: 1px solid var(--divider-color);
  padding: 14px 0;
  color: var(--primary-color);
  font-size: 13px;
  text-align: center;
}

.loading-state {
  display: grid;
  min-height: 160px;
  place-items: center;
  color: var(--text-secondary);
  font-size: 13px;
}

.profile-overview {
  display: flex;
  align-items: center;
  gap: 18px;
  padding-bottom: 28px;
}

.avatar-button {
  display: grid;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--primary-color);
  cursor: pointer;
  padding: 0;
  font-size: 12px;
}

.profile-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--hover-bg);
}

.profile-heading {
  display: grid;
  gap: 5px;
}

.profile-heading strong {
  color: var(--text-color);
  font-size: 20px;
}

.profile-heading span {
  color: var(--text-secondary);
  font-size: 13px;
}

.profile-info {
  border-top: 1px solid var(--divider-color);
}

.info-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 58px;
  border-bottom: 1px solid var(--divider-color);
}

.info-label {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.info-value {
  color: var(--text-color);
  font-size: 14px;
  overflow-wrap: anywhere;
}

.info-value-with-action,
.nickname-edit {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.btn-link {
  border: 0;
  background: none;
  color: var(--primary-color);
  cursor: pointer;
  padding: 0;
  font-size: 13px;
}

.nickname-edit {
  flex: 1;
}

.nickname-edit input {
  width: min(260px, 100%);
  border: 1px solid var(--divider-color);
  border-radius: 6px;
  outline: none;
  padding: 7px 10px;
  background: var(--control-bg);
  color: var(--text-color);
  font-size: 13px;
}

.nickname-edit input:focus {
  border-color: var(--primary-color);
}

.btn-sm,
.btn-action,
.btn-danger {
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.btn-sm {
  padding: 7px 12px;
  font-size: 13px;
}

.btn-action {
  padding: 9px 16px;
  font-size: 13px;
}

.btn-primary {
  background: var(--primary-color);
  color: var(--text-on-primary);
}

.btn-secondary {
  background: var(--control-bg);
  color: var(--text-color);
}

.btn-sm:disabled,
.btn-action:disabled,
.btn-danger:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.usage-section {
  padding: 28px 0;
}

.security-section {
  border-top: 1px solid var(--divider-color);
}

.security-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 66px;
  border-bottom: 1px solid var(--divider-color);
}

.security-row > div {
  display: grid;
  gap: 5px;
}

.security-hint {
  color: var(--text-secondary);
  font-size: 12px;
}

.password-form {
  display: grid;
  gap: 16px;
}

.password-field {
  display: grid;
  gap: 7px;
  color: var(--text-secondary);
  font-size: 13px;
}

.password-field input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--divider-color);
  border-radius: 6px;
  outline: none;
  padding: 9px 10px;
  background: var(--control-bg);
  color: var(--text-color);
  font-size: 14px;
}

.password-field input:focus {
  border-color: var(--primary-color);
}

.password-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 4px;
}

.usage-section h2 {
  margin: 0 0 14px;
  color: var(--primary-color);
  font-size: 14px;
  font-weight: 600;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.stat-item {
  display: grid;
  gap: 5px;
  min-height: 82px;
  border: 1px solid var(--divider-color);
  border-radius: 8px;
  padding: 16px;
}

.stat-item span {
  color: var(--text-secondary);
  font-size: 12px;
}

.stat-item strong {
  color: var(--text-color);
  font-size: 18px;
}

.profile-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 20px;
  border-top: 1px solid var(--divider-color);
}

.btn-danger {
  padding: 9px 16px;
  background: #fdecef;
  color: #d03050;
}

@media (prefers-color-scheme: dark) {
  .btn-danger {
    background: rgba(208, 48, 80, 0.18);
    color: #ff8098;
  }
}

@media (max-width: 760px) {
  .ai-credit-card {
    align-items: flex-start;
  }

  .ai-credit-meta {
    align-items: flex-end;
    flex-direction: column;
  }

  .recharge-presets {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .stats-grid {
    grid-template-columns: 1fr;
  }

  .nickname-edit {
    align-items: stretch;
    flex-direction: column;
  }

  .profile-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .security-row {
    align-items: flex-start;
    flex-direction: column;
    justify-content: center;
    gap: 8px;
    padding: 12px 0;
  }
}
</style>
