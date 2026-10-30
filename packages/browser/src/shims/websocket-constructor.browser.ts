import { Layer } from "effect"
import { Socket } from "effect/socket"

export const WebSocketConstructor = {
  layer: Layer.succeed(Socket.WebSocketConstructor, (url, options) => {
    if (options && typeof options === "object" && !Array.isArray(options) && options.headers)
      throw new Error("Browser WebSockets cannot send authorization headers; select the HTTP transport")
    return new WebSocket(url, typeof options === "string" || Array.isArray(options) ? options : undefined)
  }),
  proxy: () => undefined,
}
