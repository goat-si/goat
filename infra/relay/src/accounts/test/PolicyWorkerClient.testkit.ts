import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

// Local workerd drops a connection idle about 5 s, fetch reuses one for 4 s. Closing each
// connection after its response leaves no idle socket to carry between request bursts.
export const policyWorkerHttpClient = Effect.map(
  HttpClient.HttpClient,
  HttpClient.mapRequest(HttpClientRequest.setHeader("connection", "close")),
);
