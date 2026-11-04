import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("goat/no-negative-control-margin", {
  filename: "apps/web/src/components/chat/Example.tsx",
});

describe("goat/no-negative-control-margin", () => {
  rule.valid(
    "allows child nudges and layout margins off controls",
    `
      const a = <Button className="[&_svg]:-mx-0.5">Go</Button>;
      const b = <div className="-ms-2">x</div>;
      const c = <ComposerControl className="ms-1">x</ComposerControl>;
      const d = <Button className="[&>*]:-mx-2 *:-mx-1">x</Button>;
    `,
  );

  rule.invalid(
    "reports a negative inline margin on a control",
    `const a = <ComposerControl className="-ms-2 min-w-13">x</ComposerControl>;`,
  );

  rule.invalid(
    "reports one passed through a trigger class prop",
    `const a = <ProviderModelPicker triggerClassName={cn("-ms-2", wide && "min-w-13")} />;`,
  );

  rule.invalid(
    "reports a variant-scoped one on a native button",
    `const a = <button className="sm:-mx-1">x</button>;`,
  );

  rule.invalid(
    "reports arbitrary variants targeting the control itself",
    `const a = <Button className="[&:hover]:-mx-2">x</Button>;`,
  );
  rule.invalid(
    "reports a class selector targeting the control itself",
    `const a = <Button className="[&.active]:-mx-2">x</Button>;`,
  );
  rule.invalid(
    "reports an attribute selector targeting the control itself",
    `const a = <Button className="[&[data-x]]:-mx-2">x</Button>;`,
  );
});
