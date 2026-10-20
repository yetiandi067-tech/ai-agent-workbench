/**
 * 并发闸门。
 *
 * 目标：默认**最多 1 个真实 DSH 任务**同时在跑；超过上限的任务不会被静默排队，
 * 而是保持 `pending` 并把原因写进任务记录 —— 因为「悄悄排队后自动开跑」会在
 * 用户不知情的情况下产生费用。
 */
export class ConcurrencyGate {
  private active = 0

  constructor(private readonly limitProvider: () => number) {}

  get limit(): number {
    return Math.max(1, this.limitProvider())
  }

  get activeCount(): number {
    return this.active
  }

  canStart(): boolean {
    return this.active < this.limit
  }

  /** 抢占一个槽位；失败返回 false（调用方必须据此拒绝启动）。 */
  acquire(): boolean {
    if (!this.canStart()) return false
    this.active += 1
    return true
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
  }
}
