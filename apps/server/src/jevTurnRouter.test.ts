import { assert, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  JEV_APPLY_CONFIDENCE_THRESHOLD,
  JEV_MAX_ROUTING_TEXT_CHARS,
  JEV_TIMEOUT_MS,
  jevRoutingSummary,
  routeTurnWithJev,
  type JevTurnRouterConfig,
} from "./jevTurnRouter.ts";

type TurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

const makeCommand = (text = "Diagnose the failing test and implement the fix.") =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make("command:test"),
    threadId: ThreadId.make("thread:test"),
    message: {
      messageId: MessageId.make("message:test"),
      role: "user",
      text,
      attachments: [],
    },
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "composer-model",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-21T10:00:00.000Z",
  }) as TurnStartCommand;

const config = (mode: JevTurnRouterConfig["mode"]): JevTurnRouterConfig => ({
  mode,
  apiKey: Redacted.make("test-key"),
});

const jevResponse = (tier: "small" | "normal" | "expert", confidence: number) =>
  Response.json({
    answers: { model_tier: { type: "choice", choice: tier, confidence } },
    usage: { input_tokens: 120, output_tokens: 20, total_tokens: 140 },
  });

const decodeJsonRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const runRoute = (
  command: TurnStartCommand,
  routerConfig: JevTurnRouterConfig,
  response: (request: HttpClientRequest.HttpClientRequest) => Response,
) =>
  routeTurnWithJev(command, routerConfig).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, response(request))),
      ),
    ),
  );

it.effect("does nothing in off mode", () =>
  Effect.gen(function* () {
    const command = makeCommand();
    const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, jevResponse("normal", 1))),
    );
    const result = yield* routeTurnWithJev(command, {
      mode: "off",
      apiKey: undefined,
    }).pipe(Effect.provideService(HttpClient.HttpClient, HttpClient.make(execute)));

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({ command, activity: null });
  }),
);

it.effect("sends one bounded Jev choice and keeps shadow mode advisory", () => {
  const text = "x".repeat(JEV_MAX_ROUTING_TEXT_CHARS + 25);
  const command = makeCommand(text);
  let requestBody: Record<string, unknown> | undefined;
  let authorization: string | undefined;

  return Effect.gen(function* () {
    const result = yield* runRoute(command, config("shadow"), (request) => {
      authorization = request.headers.authorization;
      assert.strictEqual(request.body._tag, "Uint8Array");
      if (request.body._tag === "Uint8Array") {
        requestBody = decodeJsonRecord(new TextDecoder().decode(request.body.body));
      }
      return jevResponse("normal", 0.91);
    });

    expect(result.command).toBe(command);
    expect(result.command.modelSelection?.model).toBe("composer-model");
    expect(result.activity).toMatchObject({
      mode: "shadow",
      status: "recommended",
      tier: "normal",
      confidence: 0.91,
      originalModel: "composer-model",
      recommendedModel: "gpt-5.6-terra",
      inputTokens: 120,
      outputTokens: 20,
      totalTokens: 140,
    });
    expect(authorization).toBe("Bearer test-key");
    expect(requestBody).toBeDefined();
    const questions = requestBody?.questions as Record<string, unknown>;
    expect(Object.keys(questions)).toEqual(["model_tier"]);
    const state = requestBody?.state as Record<string, unknown>;
    expect(state.request).toBe("x".repeat(JEV_MAX_ROUTING_TEXT_CHARS));
    expect(state.request_truncated).toBe(true);
    expect(requestBody).not.toHaveProperty("apiKey");
    expect(state).not.toHaveProperty("apiKey");
    expect(questions).not.toHaveProperty("apiKey");
    expect(jevRoutingSummary(result.activity!)).toContain(
      "Jev shadow · normal · 91% · 0 ms · 120 in / 20 out tokens · composer-model → gpt-5.6-terra",
    );
  });
});

it.effect("applies the fixed tier mapping only above the initial confidence threshold", () =>
  Effect.gen(function* () {
    const command = makeCommand();
    const applied = yield* runRoute(command, config("apply"), () =>
      jevResponse("small", JEV_APPLY_CONFIDENCE_THRESHOLD),
    );
    const fallback = yield* runRoute(command, config("apply"), () =>
      jevResponse("expert", JEV_APPLY_CONFIDENCE_THRESHOLD - 0.01),
    );

    expect(applied.activity).toMatchObject({
      status: "applied",
      tier: "small",
      recommendedModel: "gpt-5.6-luna",
    });
    expect(applied.command.modelSelection?.model).toBe("gpt-5.6-luna");
    expect(command.modelSelection?.model).toBe("composer-model");
    expect(fallback.activity).toMatchObject({
      status: "fallback",
      tier: "expert",
      recommendedModel: "gpt-5.6-sol",
      reason: "confidence-below-threshold",
    });
    expect(fallback.command).toBe(command);
  }),
);

it.effect("fails open without exposing the prompt or key in the activity", () =>
  Effect.gen(function* () {
    const command = makeCommand("private synthetic prompt");
    const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "offline" }),
        }),
      ),
    );
    const result = yield* routeTurnWithJev(command, config("shadow")).pipe(
      Effect.provideService(HttpClient.HttpClient, HttpClient.make(execute)),
    );

    expect(result.command).toBe(command);
    expect(result.activity).toMatchObject({
      mode: "shadow",
      status: "fallback",
      originalModel: "composer-model",
      reason: "unavailable",
    });
    expect(result.activity).not.toHaveProperty("prompt");
    expect(result.activity).not.toHaveProperty("apiKey");
  }),
);

it.effect("fails open after 1500 ms", () =>
  Effect.gen(function* () {
    const command = makeCommand();
    const fiber = yield* routeTurnWithJev(command, config("apply")).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.never),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust(JEV_TIMEOUT_MS);
    const result = yield* Fiber.join(fiber);

    expect(result.command).toBe(command);
    expect(result.activity).toMatchObject({
      status: "fallback",
      reason: "timeout",
      latencyMs: JEV_TIMEOUT_MS,
    });
  }),
);

it.effect("keeps the composer model when the server key is absent", () =>
  Effect.gen(function* () {
    const command = makeCommand();
    const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, jevResponse("normal", 1))),
    );
    const result = yield* routeTurnWithJev(command, {
      mode: "apply",
      apiKey: undefined,
    }).pipe(Effect.provideService(HttpClient.HttpClient, HttpClient.make(execute)));

    expect(execute).not.toHaveBeenCalled();
    expect(result.command).toBe(command);
    expect(result.activity).toMatchObject({
      status: "fallback",
      reason: "missing-api-key",
      originalModel: "composer-model",
    });
  }),
);
