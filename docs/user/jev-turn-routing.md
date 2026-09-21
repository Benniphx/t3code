# Jev turn routing

T3 can optionally ask TypeSafe Jev to choose a model tier before the server
starts a turn. Routing is off by default and always fails open to the model
selected in the composer.

Set these variables on the T3 server:

```bash
T3CODE_JEV_MODE=shadow
T3CODE_JEV_API_KEY=...
```

`T3CODE_JEV_MODE` accepts `off`, `shadow`, or `apply`. `shadow` leaves the
selected model unchanged and adds a visible routing activity to the thread.
The activity shows the tier, confidence, latency, token usage, original model,
and recommended model. `apply` changes the current turn when confidence is at
least 0.85.

The fixed tier mapping is:

| Tier     | Model           |
| -------- | --------------- |
| `small`  | `gpt-5.6-luna`  |
| `normal` | `gpt-5.6-terra` |
| `expert` | `gpt-5.6-sol`   |

The preflight times out after 1500 ms and keeps the composer model on timeout,
API failure, an invalid response, or missing configuration. T3 sends at most
12,000 characters of the turn text. The API key remains server-side and is
never included in the routing request body or thread activity.
