type Message = Record<string, unknown>
type Listener = (message: unknown, name: string | symbol) => void
type Store = { run<T>(value: unknown, fn: () => T): T }

/** In-page diagnostics channels, following the AlmostNode platform interface. */
export class Channel {
  private listeners = new Set<Listener>()
  private stores = new Map<Store, (message: unknown) => unknown>()
  constructor(readonly name: string | symbol) {}
  get hasSubscribers() {
    return this.listeners.size > 0
  }
  subscribe(fn: Listener) {
    this.listeners.add(fn)
  }
  unsubscribe(fn: Listener) {
    return this.listeners.delete(fn)
  }
  publish(message: unknown) {
    for (const fn of this.listeners) {
      try {
        fn(message, this.name)
      } catch (error) {
        queueMicrotask(() => {
          throw error
        })
      }
    }
  }
  bindStore(store: Store, transform = (message: unknown) => message) {
    this.stores.set(store, transform)
  }
  unbindStore(store: Store) {
    return this.stores.delete(store)
  }
  runStores<T>(message: unknown, fn: (...args: unknown[]) => T, receiver?: unknown, ...args: unknown[]): T {
    const run = Array.from(this.stores).reduceRight<() => T>(
      (next, [store, transform]) =>
        () =>
          store.run(transform(message), next),
      () => {
        this.publish(message)
        return fn.apply(receiver, args)
      },
    )
    return run()
  }
}

const channels = new Map<string | symbol, Channel>()
export function channel(name: string | symbol) {
  const existing = channels.get(name)
  if (existing) return existing
  const next = new Channel(name)
  channels.set(name, next)
  return next
}
export const subscribe = (name: string | symbol, fn: Listener) => channel(name).subscribe(fn)
export const unsubscribe = (name: string | symbol, fn: Listener) => channel(name).unsubscribe(fn)
export const hasSubscribers = (name: string | symbol) => channel(name).hasSubscribers

export class TracingChannel {
  readonly start: Channel
  readonly end: Channel
  readonly asyncStart: Channel
  readonly asyncEnd: Channel
  readonly error: Channel
  constructor(name: string) {
    this.start = channel("tracing:" + name + ":start")
    this.end = channel("tracing:" + name + ":end")
    this.asyncStart = channel("tracing:" + name + ":asyncStart")
    this.asyncEnd = channel("tracing:" + name + ":asyncEnd")
    this.error = channel("tracing:" + name + ":error")
  }
  get hasSubscribers() {
    return [this.start, this.end, this.asyncStart, this.asyncEnd, this.error].some((value) => value.hasSubscribers)
  }
  subscribe(handlers: Partial<Record<"start" | "end" | "asyncStart" | "asyncEnd" | "error", Listener>>) {
    for (const key of Object.keys(handlers) as (keyof typeof handlers)[]) this[key].subscribe(handlers[key]!)
  }
  unsubscribe(handlers: Partial<Record<"start" | "end" | "asyncStart" | "asyncEnd" | "error", Listener>>) {
    for (const key of Object.keys(handlers) as (keyof typeof handlers)[]) this[key].unsubscribe(handlers[key]!)
  }
  traceSync<T>(fn: (...args: unknown[]) => T, context: Message = {}, receiver?: unknown, ...args: unknown[]): T {
    return this.start.runStores(context, () => {
      try {
        context.result = fn.apply(receiver, args)
        return context.result as T
      } catch (error) {
        context.error = error
        this.error.publish(context)
        throw error
      } finally {
        this.end.publish(context)
      }
    })
  }
  tracePromise<T>(
    fn: (...args: unknown[]) => Promise<T>,
    context: Message = {},
    receiver?: unknown,
    ...args: unknown[]
  ) {
    return this.traceSync(fn, context, receiver, ...args).then(
      (result) => {
        context.result = result
        this.asyncStart.publish(context)
        this.asyncEnd.publish(context)
        return result
      },
      (error) => {
        context.error = error
        this.error.publish(context)
        throw error
      },
    )
  }
  traceCallback<T>(
    fn: (...args: unknown[]) => T,
    position: number,
    context: Message = {},
    receiver?: unknown,
    ...args: unknown[]
  ): T {
    const index = position < 0 ? args.length + position : position
    const callback = args[index]
    if (typeof callback !== "function") throw new TypeError("Tracing callback must be a function")
    args[index] = (...values: unknown[]) => {
      if (values[0]) {
        context.error = values[0]
        this.error.publish(context)
      }
      this.asyncStart.publish(context)
      try {
        return callback(...values)
      } finally {
        this.asyncEnd.publish(context)
      }
    }
    return this.traceSync(fn, context, receiver, ...args)
  }
}
export const tracingChannel = (name: string) => new TracingChannel(name)
export default { Channel, TracingChannel, channel, subscribe, unsubscribe, hasSubscribers, tracingChannel }
