// 全局 toast：App.vue 挂载展示组件，任意视图 import useToast 调用。
import { reactive } from 'vue'

const state = reactive({ text: '', visible: false })
let timer = null

export function useToast() {
  function toast(msg) {
    state.text = msg
    state.visible = true
    clearTimeout(timer)
    timer = setTimeout(() => { state.visible = false }, 2200)
  }
  return { toast, toastState: state }
}
