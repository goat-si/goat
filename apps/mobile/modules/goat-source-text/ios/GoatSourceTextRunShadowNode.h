#pragma once

#include <react/renderer/components/GoatSourceTextSpec/EventEmitters.h>
#include <react/renderer/components/GoatSourceTextSpec/Props.h>
#include <react/renderer/components/GoatSourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char GoatSourceTextRunComponentName[];

using GoatSourceTextRunShadowNode =
    ConcreteViewShadowNode<GoatSourceTextRunComponentName, GoatSourceTextRunProps,
                           GoatSourceTextRunEventEmitter, GoatSourceTextRunState>;
} // namespace facebook::react
