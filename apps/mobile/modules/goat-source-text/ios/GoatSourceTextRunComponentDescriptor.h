#pragma once

#include "GoatSourceTextRunShadowNode.h"

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {
using GoatSourceTextRunComponentDescriptor =
    ConcreteComponentDescriptor<GoatSourceTextRunShadowNode>;

void GoatSourceTextRunSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
} // namespace facebook::react
