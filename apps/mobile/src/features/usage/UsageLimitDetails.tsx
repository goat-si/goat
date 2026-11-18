import type { ServerProviderUsageLimits } from "@goat/contracts";
import { limitsNotice } from "@goat/shared/usageLimits";
import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

export function UsageLimitDetails({
  limits,
  children,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly children: ReactNode;
}) {
  const notice = limitsNotice(limits);
  return (
    <>
      {notice ? (
        <Text className="text-sm text-foreground-muted">{notice}</Text>
      ) : (
        <View className="gap-3">{children}</View>
      )}
      {limits.zeroSpendCap ? <ZeroSpendCap /> : null}
    </>
  );
}

export function ZeroSpendCap() {
  return <Text className="text-sm text-foreground-muted">Monthly spend: $0 cap</Text>;
}
