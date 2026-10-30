type Timer = {
  readonly id: ReturnType<typeof globalThis.setTimeout>
  ref(): Timer
  unref(): Timer
}

function handle(id: ReturnType<typeof globalThis.setTimeout>): Timer {
  const timer: Timer = { id, ref: () => timer, unref: () => timer }
  return timer
}

export function setTimeout<A extends unknown[]>(callback: (...args: A) => void, delay?: number, ...args: A) {
  return handle(globalThis.setTimeout(callback, delay, ...args))
}

export function setInterval<A extends unknown[]>(callback: (...args: A) => void, delay?: number, ...args: A) {
  return handle(globalThis.setInterval(callback, delay, ...args))
}

export function clearTimeout(timer?: Timer) {
  if (timer) globalThis.clearTimeout(timer.id)
}

export function clearInterval(timer?: Timer) {
  if (timer) globalThis.clearInterval(timer.id)
}
