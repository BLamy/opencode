import { Effect } from "effect"
import { DecodeError, SizeError } from "@opencode/core/image"
import type { FileSystem } from "@opencode/core/filesystem"

/** Image normalization uses the browser image codec and canvas implementation. */
export const make = Effect.succeed(
  (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: { autoResize: boolean; maxWidth: number; maxHeight: number; maxBase64Bytes: number },
  ) =>
    Effect.gen(function* () {
      const image = yield* Effect.tryPromise({
        try: async () =>
          createImageBitmap(
            new Blob([Uint8Array.from(atob(content.content), (value) => value.charCodeAt(0))], { type: content.mime }),
          ),
        catch: () => new DecodeError({ resource }),
      })
      try {
        const bytes = content.content.length
        if (image.width <= limits.maxWidth && image.height <= limits.maxHeight && bytes <= limits.maxBase64Bytes)
          return content
        const error = new SizeError({
          resource,
          width: image.width,
          height: image.height,
          bytes,
          maxWidth: limits.maxWidth,
          maxHeight: limits.maxHeight,
          maxBytes: limits.maxBase64Bytes,
        })
        if (!limits.autoResize) return yield* error
        const scale = Math.min(1, limits.maxWidth / image.width, limits.maxHeight / image.height)
        for (let step = 0; step < 32; step++) {
          const canvas = new OffscreenCanvas(
            Math.max(1, Math.floor(image.width * scale * 0.75 ** step)),
            Math.max(1, Math.floor(image.height * scale * 0.75 ** step)),
          )
          canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height)
          for (const type of ["image/png", "image/jpeg"]) {
            const blob = yield* Effect.promise(() => canvas.convertToBlob({ type, quality: 0.8 }))
            const data = new Uint8Array(yield* Effect.promise(() => blob.arrayBuffer()))
            const encoded = Buffer.from(data).toString("base64")
            if (encoded.length <= limits.maxBase64Bytes) return { ...content, content: encoded, mime: type }
          }
        }
        return yield* error
      } finally {
        image.close()
      }
    }),
)
