import ExpoModulesCore

public class GoatReviewDiffModule: Module {
  public func definition() -> ModuleDefinition {
    Name("GoatReviewDiffSurface")

    View(GoatReviewDiffView.self) {
      Prop("contentInsetTop") { (view: GoatReviewDiffView, value: Double) in
        view.setContentInsetTop(CGFloat(value))
      }

      Prop("contentInsetBottom") { (view: GoatReviewDiffView, value: Double) in
        view.setContentInsetBottom(CGFloat(value))
      }

      Prop("tokensResetKey") { (view: GoatReviewDiffView, tokensResetKey: String) in
        view.setTokensResetKey(tokensResetKey)
      }

      Prop("contentResetKey") { (view: GoatReviewDiffView, contentResetKey: String) in
        view.setContentResetKey(contentResetKey)
      }

      Prop("collapsedFileIdsJson") { (view: GoatReviewDiffView, collapsedFileIdsJson: String) in
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }

      Prop("viewedFileIdsJson") { (view: GoatReviewDiffView, viewedFileIdsJson: String) in
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }

      Prop("selectedRowIdsJson") { (view: GoatReviewDiffView, selectedRowIdsJson: String) in
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }

      Prop("collapsedCommentIdsJson") { (view: GoatReviewDiffView, collapsedCommentIdsJson: String) in
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }

      Prop("appearanceScheme") { (view: GoatReviewDiffView, appearanceScheme: String) in
        view.setAppearanceScheme(appearanceScheme)
      }

      Prop("themeJson") { (view: GoatReviewDiffView, themeJson: String) in
        view.setThemeJson(themeJson)
      }

      Prop("styleJson") { (view: GoatReviewDiffView, styleJson: String) in
        view.setStyleJson(styleJson)
      }

      Prop("rowHeight") { (view: GoatReviewDiffView, rowHeight: Double) in
        view.setRowHeight(CGFloat(rowHeight))
      }

      Prop("contentWidth") { (view: GoatReviewDiffView, contentWidth: Double) in
        view.setContentWidth(CGFloat(contentWidth))
      }

      Prop("initialRowIndex") { (view: GoatReviewDiffView, initialRowIndex: Double) in
        view.setInitialRowIndex(initialRowIndex)
      }

      Prop("scrollEnabled") { (view: GoatReviewDiffView, enabled: Bool) in
        view.setScrollEnabled(enabled)
      }

      Prop("bounces") { (view: GoatReviewDiffView, bounces: Bool) in
        view.setBounces(bounces)
      }

      Prop("refreshEnabled") { (view: GoatReviewDiffView, enabled: Bool) in
        view.setRefreshEnabled(enabled)
      }

      Prop("refreshing") { (view: GoatReviewDiffView, refreshing: Bool) in
        view.setRefreshing(refreshing)
      }

      Events(
        "onDebug",
        "onVisibleFileChange",
        "onToggleFile",
        "onToggleViewedFile",
        "onPressLine",
        "onToggleComment",
        "onPullToRefresh"
      )

      AsyncFunction("scrollToFile") { (view: GoatReviewDiffView, fileId: String, animated: Bool) in
        view.scrollToFile(fileId, animated: animated)
      }

      AsyncFunction("scrollToTop") { (view: GoatReviewDiffView, animated: Bool) in
        view.scrollToTop(animated: animated)
      }

      // Large, frequently changing JSON values cannot be regular Fabric props. Expo's
      // prop adapter compares strings on the main thread before invoking a setter, which
      // makes a syntax-token patch capable of blocking a frame by itself.
      AsyncFunction("setRowsJson") { (view: GoatReviewDiffView, rowsJson: String) in
        view.setRowsJson(rowsJson)
      }

      AsyncFunction("setTokensJson") { (view: GoatReviewDiffView, tokensJson: String) in
        view.setTokensJson(tokensJson)
      }

      AsyncFunction("setTokensPatchJson") { (view: GoatReviewDiffView, tokensPatchJson: String) in
        view.setTokensPatchJson(tokensPatchJson)
      }
    }
  }
}
