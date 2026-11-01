package expo.modules.goatterminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class GoatTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("GoatTerminalSurface")

    // Bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    Constants(
      "hardwareKeyRevision" to 2,
      "outputRevision" to 1,
    )

    View(GoatTerminalView::class) {
      AsyncFunction("writeOutput") { view: GoatTerminalView, data: String, reset: Boolean ->
        view.writeOutput(data, reset)
      }

      Prop("terminalKey") { view: GoatTerminalView, terminalKey: String ->
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { view: GoatTerminalView, initialBuffer: String ->
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { view: GoatTerminalView, fontSize: Double ->
        view.fontSize = fontSize.toFloat()
      }

      Prop("focusRequest") { view: GoatTerminalView, focusRequest: Double ->
        view.focusRequest = focusRequest
      }

      Prop("readOnly") { view: GoatTerminalView, readOnly: Boolean ->
        view.readOnly = readOnly
      }

      Prop("autoFocus") { view: GoatTerminalView, autoFocus: Boolean ->
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { view: GoatTerminalView, appearanceScheme: String ->
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { view: GoatTerminalView, themeConfig: String ->
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { view: GoatTerminalView, backgroundColor: String ->
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { view: GoatTerminalView, foregroundColor: String ->
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { view: GoatTerminalView, mutedForegroundColor: String ->
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Prop("captureRequest") { view: GoatTerminalView, request: Double ->
        view.captureRequest = request
      }
      Prop("sharedGrid") { view: GoatTerminalView, grid: List<Int> -> view.sharedGrid = grid }
      Events("onInput", "onResize", "onCapture")

      OnViewDidUpdateProps { view: GoatTerminalView -> view.applyPendingBuffer() }

      OnViewDestroys { view: GoatTerminalView ->
        view.cleanup()
      }
    }
  }
}
