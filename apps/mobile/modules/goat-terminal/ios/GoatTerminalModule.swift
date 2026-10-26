import ExpoModulesCore

public class GoatTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("GoatTerminalSurface")

    // Bumped when native hardware-keyboard handling changes; surfaced in the JS debug
    // logs so a stale native binary is distinguishable from a broken key pipeline.
    Constants([
      "hardwareKeyRevision": 3,
    ])

    View(GoatTerminalView.self) {
      Prop("terminalKey") { (view: GoatTerminalView, terminalKey: String) in
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { (view: GoatTerminalView, initialBuffer: String) in
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { (view: GoatTerminalView, fontSize: Double) in
        view.fontSize = CGFloat(fontSize)
      }

      Prop("focusRequest") { (view: GoatTerminalView, focusRequest: Double) in
        view.focusRequest = focusRequest
      }

      Prop("readOnly") { (view: GoatTerminalView, readOnly: Bool) in
        view.readOnly = readOnly
      }

      Prop("autoFocus") { (view: GoatTerminalView, autoFocus: Bool) in
        view.autoFocus = autoFocus
      }

      Prop("appearanceScheme") { (view: GoatTerminalView, appearanceScheme: String) in
        view.appearanceScheme = appearanceScheme
      }

      Prop("themeConfig") { (view: GoatTerminalView, themeConfig: String) in
        view.themeConfig = themeConfig
      }

      Prop("backgroundColor") { (view: GoatTerminalView, backgroundColor: String) in
        view.backgroundColorHex = backgroundColor
      }

      Prop("foregroundColor") { (view: GoatTerminalView, foregroundColor: String) in
        view.foregroundColorHex = foregroundColor
      }

      Prop("mutedForegroundColor") { (view: GoatTerminalView, mutedForegroundColor: String) in
        view.mutedForegroundColorHex = mutedForegroundColor
      }

      Prop("captureRequest") { (view: GoatTerminalView, request: Double) in
        view.captureRequest = request
      }
      Events("onInput", "onResize", "onCapture")
    }
  }
}
