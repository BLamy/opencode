// Measure timer scheduling delay in the browser, in the nanoseconds expected
// by the TUI's event-loop chart. CPU accounting has no browser equivalent.
export function monitorEventLoopDelay({ resolution = 20 } = {}) {
  let timer: ReturnType<typeof setInterval> | undefined
  let previous = performance.now()
  let samples: number[] = []
  return {
    enable() {
      if (timer !== undefined) return
      previous = performance.now()
      timer = setInterval(() => {
        const now = performance.now()
        samples.push(Math.max(0, now - previous - resolution) * 1_000_000)
        previous = now
      }, resolution)
    },
    disable() {
      clearInterval(timer)
      timer = undefined
    },
    percentile(percent: number) {
      const sorted = samples.toSorted((a, b) => a - b)
      return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)] ?? 0
    },
    reset() {
      samples = []
    },
  }
}
