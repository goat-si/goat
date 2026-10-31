import {
  AuthOrchestrationOperateScope,
  BrowserClaimsRpcError,
  EnvironmentAuthorizationError,
  WS_METHODS,
  WsBrowserClaimsRpcGroup,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import {
  canResolveHumanStep,
  sessionResolver,
  type HumanStepResolver,
} from "../handoffs/HumanStepAuthority.ts";
import { BrowserOriginGrants } from "./BrowserOriginGrantsLayer.ts";

export const ServerWsBrowserClaimsRpcGroup = WsBrowserClaimsRpcGroup.middleware(RpcInstrumentation);
export const requirePerson = (resolver: HumanStepResolver) =>
  canResolveHumanStep(resolver, "person_only")
    ? Effect.void
    : Effect.fail(
        new EnvironmentAuthorizationError({
          message: "Only a person's client can manage browser claims.",
          requiredScope: AuthOrchestrationOperateScope,
        }),
      );

export const makeBrowserClaimsRpcHandlers = (
  grants: Option.Option<BrowserOriginGrants["Service"]>,
  session: { readonly subject: string },
) => {
  const person = requirePerson(sessionResolver(session));
  const service = Effect.fromOption(
    grants,
    () => new BrowserClaimsRpcError({ message: "Browser claims are unavailable." }),
  );
  const failure = () => new BrowserClaimsRpcError({ message: "Browser claim operation failed." });
  return ServerWsBrowserClaimsRpcGroup.of({
    [WS_METHODS.browserClaimsClaim]: (input) =>
      person.pipe(
        Effect.andThen(service),
        Effect.flatMap((value) => value.claimWindow(input).pipe(Effect.mapError(failure))),
      ),
    [WS_METHODS.browserClaimsAnswer]: (input) =>
      person.pipe(
        Effect.andThen(service),
        Effect.flatMap((value) =>
          value.answer(input.claimId, input.approved).pipe(Effect.mapError(failure)),
        ),
      ),
    [WS_METHODS.browserClaimsRevoke]: (input) =>
      person.pipe(
        Effect.andThen(service),
        Effect.flatMap((value) =>
          value.revoke(input.threadId, input.origin).pipe(Effect.mapError(failure)),
        ),
      ),
    [WS_METHODS.browserClaimsEnd]: (input) =>
      person.pipe(
        Effect.andThen(service),
        Effect.flatMap((value) => value.endPerson(input.claimId).pipe(Effect.mapError(failure))),
      ),
    [WS_METHODS.browserClaimsList]: () =>
      person.pipe(
        Effect.andThen(service),
        Effect.flatMap((value) => value.listAll()),
      ),
  });
};
