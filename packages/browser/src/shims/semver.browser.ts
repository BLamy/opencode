import semverPackage from "../../../../node_modules/semver/index.js"

const semver = semverPackage as typeof import("semver")

export const valid = semver.valid
export const gt = semver.gt
export const gte = semver.gte
export const lt = semver.lt
export const lte = semver.lte
export const satisfies = semver.satisfies
export const coerce = semver.coerce
export const parse = semver.parse
export const compare = semver.compare
export const major = semver.major
export const minor = semver.minor
export const patch = semver.patch

export default semver
