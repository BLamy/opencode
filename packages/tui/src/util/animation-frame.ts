import { useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"

export function useAnimationFrame() {
  const renderer = useRenderer()
  const pending = new Set<number>()
  let disposed = false
  onCleanup(() => {
    disposed = true
    pending.forEach((frame) => renderer.cancelAnimationFrame(frame))
    pending.clear()
  })
  return (callback: FrameRequestCallback) => {
    if (disposed) return
    const frame = renderer.requestAnimationFrame((time) => {
      pending.delete(frame)
      callback(time)
    })
    pending.add(frame)
    return frame
  }
}
