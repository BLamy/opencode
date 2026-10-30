// A native PTY requires an explicit host terminal capability.
export function spawn() {
  throw new Error("PTY not available in browser")
}
export default { spawn }
