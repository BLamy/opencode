type FeatureMap = Record<string, boolean | null | undefined>

declare global {
  var __BUN_BUNDLE_FEATURES__: FeatureMap | undefined
}

function getFeatureMap(): FeatureMap {
  return globalThis.__BUN_BUNDLE_FEATURES__ ?? {}
}

export function feature(name: string): boolean {
  return getFeatureMap()[name] === true
}

export function setFeatureFlags(flags: FeatureMap): void {
  globalThis.__BUN_BUNDLE_FEATURES__ = { ...flags }
}

export function clearFeatureFlags(): void {
  delete globalThis.__BUN_BUNDLE_FEATURES__
}

export default { feature, setFeatureFlags, clearFeatureFlags }
