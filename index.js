/**
 * dsh-notify-inline — host half (no-op).
 *
 * V1 为纯 client 侧插件：全部逻辑（双通道路由 / 横幅 / 系统通知 / 铃铛面板 /
 * 页内裁决）在 client.js，本文件仅满足 cordis 服务入口形态（inject 命名导出 +
 * apply），让 bundle patch（cordis.patch.yml insert）能激活一个无副作用的 host 服务。
 *
 * ⚠ 形态约束（同 dsh-instruction-tracker 教训）：cordis 用 `Inject.resolve(plugin.inject)`
 * 读模块的 `inject` 导出构造 Fiber；缺此导出激活即报 `cannot get property … without inject`。
 */
export const inject = [];

export async function apply(ctx) {
  const logger = ctx?.logger ?? console;
  logger.info?.('[dsh-notify-inline] host 半边激活（V1 无 host 逻辑，功能全在 client.js）');
}
