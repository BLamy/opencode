import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { SpinnerRenderable } from "opentui-spinner"

test("spinner renders Unicode frames with the renderer's OpenTUI 0.8 resource owner", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 })
  try {
    const spinner = new SpinnerRenderable(app.renderer, {
      frames: ["A👋", "中"],
      autoplay: false,
    })
    app.renderer.root.add(spinner)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("A👋")
    expect(spinner.width).toBe(3)

    spinner.frames = ["👩‍💻B", "👩‍💻B"]
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("👩‍💻B")
    expect(spinner.width).toBe(3)
    spinner.destroy()
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("👩‍💻B")
  } finally {
    await app.dispose()
  }
})

test("spinner starts, advances, and stops", async () => {
  const app = await createTestRenderer({ width: 20, height: 3 })
  try {
    const spinner = new SpinnerRenderable(app.renderer, {
      frames: ["first", "second"],
      interval: 100,
      autoplay: false,
    })
    app.renderer.root.add(spinner)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("first")
    spinner.start()
    const started = performance.now()
    while (!app.captureCharFrame().includes("second")) {
      if (performance.now() - started > 2000) throw new Error("Spinner did not advance")
      await Bun.sleep(10)
      await app.renderOnce()
    }
    spinner.stop()
    await app.renderOnce()
    const stopped = app.captureCharFrame()
    await Bun.sleep(150)
    await app.renderOnce()
    expect(app.captureCharFrame()).toBe(stopped)
    spinner.destroy()
  } finally {
    await app.dispose()
  }
})
