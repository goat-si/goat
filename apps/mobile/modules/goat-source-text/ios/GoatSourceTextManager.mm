#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface GoatSourceTextManager : RCTViewManager
@end

@implementation GoatSourceTextManager

RCT_EXPORT_MODULE(GoatSourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface GoatSourceTextRunManager : RCTViewManager
@end

@implementation GoatSourceTextRunManager

RCT_EXPORT_MODULE(GoatSourceTextRun)

- (UIView *)view {
  return nil;
}

@end
