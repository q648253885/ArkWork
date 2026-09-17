/* ============================================================
 * ArkWork — useOpenPath（v0.31.0 D21）
 * 交互区里出现的一切文件路径（工具卡 location / 搜索命中 / 变更清单）
 * 都必须可点击，且**只能**走 `fsSlice.openDoc` —— 它是「打开文件」的
 * 唯一门面（探针判定可编辑 → 编辑器 Tab；见 open-doc-wiring.test.ts
 * TC-WIRE-001/002）。组件内不得直连 uiSlice.openPreview，否则
 * 「只读打开过的文件再次打开无法升级为编辑器」的通路会分叉。
 * ============================================================ */
import { useCallback } from 'react'
import { useStore } from '../../store'

export function useOpenPath(): (path: string) => void {
  const openDoc = useStore((s) => s.openDoc)
  return useCallback(
    (path: string) => {
      if (!path) return
      void openDoc(path)
    },
    [openDoc],
  )
}
