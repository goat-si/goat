#import "GoatSourceTextRun.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "GoatSourceTextRunComponentDescriptor.h"
#import <react/renderer/components/GoatSourceTextSpec/Props.h>
#import <react/renderer/components/GoatSourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface GoatSourceTextRun () <RCTGoatSourceTextRunViewProtocol>

@end

@implementation GoatSourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      GoatSourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const GoatSourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<GoatSourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<GoatSourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> GoatSourceTextRunCls(void) {
  return GoatSourceTextRun.class;
}

@end
