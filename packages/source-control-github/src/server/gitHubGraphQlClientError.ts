import { GraphQLClientError } from "effect/graphql";

const isGraphQlClientError = (error: unknown): error is GraphQLClientError.GraphQLClientError =>
  GraphQLClientError.isGraphQLClientError(error);

export { isGraphQlClientError };
