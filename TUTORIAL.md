# Mobilewright Tutorial

A step-by-step walkthrough: from a fresh install to your first passing test, then on to driving a real phone with an AI agent — through the built-in MCP server or your own LLM loop.

**What you'll build:**

1. [Set up your environment](#1-set-up-your-environment)
2. [Write and run your first test](#2-write-and-run-your-first-test)
3. [Find reliable locators with the Inspector](#3-find-reliable-locators-with-the-inspector)
4. [Level up: assertions, chaining, and auto-waiting](#4-level-up-assertions-chaining-and-auto-waiting)
5. [Give an AI agent a phone (MCP)](#5-give-an-ai-agent-a-phone-mcp)
6. [Build your own agent loop with `@mobilewright/agent`](#6-build-your-own-agent-loop-with-mobilewrightagent)
7. [Troubleshooting](#7-troubleshooting)

## 1. Set up your environment

You need Node.js >= 18 and at least one device: a booted iOS simulator (macOS + Xcode), a running Android emulator (Android Studio), or a real device connected over USB.

```bash
mkdir my-mobile-tests && cd my-mobile-tests
npm init -y
npm install mobilewright @mobilewright/test
```

Check that everything is wired up:

```bash
npx mobilewright doctor
```

`doctor` verifies Xcode, the Android SDK, simulators, and ADB, and tells you exactly what's missing and how to fix it. Then confirm Mobilewright can see your device:

```bash
npx mobilewright devices
```

```
ID                                      Name                     Platform  Type        State
-------------------------------------------------------------------------------------------------
5A5FCFCA-27EC-4D1B-B412-BAE629154EE0    iPhone 17 Pro            ios       simulator   booted
```

No devices? Boot a simulator (`xcrun simctl boot "iPhone 17 Pro"` or open Simulator.app) or start an emulator from Android Studio, then run `devices` again.

## 2. Write and run your first test

Scaffold a config and example test:

```bash
npx mobilewright init
```

This creates `mobilewright.config.ts` and `example.test.ts`. Point the config at your app:

```typescript
// mobilewright.config.ts
import { defineConfig } from 'mobilewright';

export default defineConfig({
  platform: 'ios',                 // or 'android'
  bundleId: 'com.example.myapp',   // the app under test
  timeout: 10_000,
});
```

Write a test using the fixtures from `@mobilewright/test` — if you know Playwright Test, this will feel familiar:

```typescript
// login.test.ts
import { test, expect } from '@mobilewright/test';

test('user can sign in', async ({ screen }) => {
  await screen.getByLabel('Email').fill('user@example.com');
  await screen.getByLabel('Password').fill('secret123');
  await screen.getByRole('button', { name: 'Sign In' }).tap();

  await expect(screen.getByText('Welcome back')).toBeVisible();
});
```

Run it:

```bash
npx mobilewright test
```

Behind the scenes Mobilewright starts mobilecli if it isn't running, finds your booted device, launches the app, and hands each test a connected `screen`. On failure you automatically get a screenshot in the report; add `test.use({ video: 'retain-on-failure' })` for video too.

## 3. Find reliable locators with the Inspector

Guessing labels is tedious. The Inspector shows you the live accessibility tree next to a screenshot, with the best locator for every element:

```bash
npx mobilewright inspect
```

Pick your device at the top, hit **Refresh**, and click any row to highlight its bounding box on the screenshot. The locator column shows exactly what to paste into your test, ranked the same way Mobilewright ranks them:

1. `getByTestId('signin-btn')` — stable across copy changes; add accessibility identifiers to your app where you can
2. `getByRole('button', { name: 'Sign In' })` — semantic and readable
3. `getByLabel('Email')` — accessibility label
4. `getByText('Welcome back')` — visible text, best for assertions

## 4. Level up: assertions, chaining, and auto-waiting

Every action auto-waits for the element to be visible, enabled, and stable — no `sleep()` calls, no manual waits:

```typescript
// Scope queries to a parent element
const row = screen.getByType('Cell').filter({ hasText: 'Groceries' });
await row.getByRole('button', { name: 'Delete' }).tap();

// Work with multiple matches
await expect(screen.getByType('Cell')).toHaveCount(3);
await screen.getByType('Cell').first().tap();

// Scroll an off-screen element into view, then interact
await screen.getByText('Terms of Service').scrollIntoViewIfNeeded();
await screen.getByText('Terms of Service').tap();

// Assertions poll until satisfied or timeout
await expect(screen.getByText('Saved')).toBeVisible({ timeout: 10_000 });
await expect(screen.getByLabel('Email')).toHaveValue('user@example.com');
```

Device-level controls live on the `device` fixture:

```typescript
test('deep link opens settings', async ({ device, screen }) => {
  await device.goto('myapp://settings');
  await expect(screen.getByText('Settings')).toBeVisible();
});
```

## 5. Give an AI agent a phone (MCP)

Mobilewright ships an MCP server that exposes your devices to any MCP client — Claude Code, Claude Desktop, Cursor, or a custom agent. Register it:

```json
{
  "mcpServers": {
    "mobilewright": {
      "command": "npx",
      "args": ["mobilewright", "mcp"]
    }
  }
}
```

(For Claude Code, put this in `.mcp.json` at your project root; for Claude Desktop, in `claude_desktop_config.json`.)

Now ask your agent things like:

> "Connect to my iOS simulator, open com.example.myapp, and check whether a new user can complete onboarding. Tell me where you get stuck."

The agent's loop looks like this:

1. `mobile_list_devices` → picks a device
2. `mobile_use_device` → connects, gets a text snapshot of the screen
3. `mobile_tap` / `mobile_fill` / `mobile_swipe` by ref → every action returns a fresh snapshot
4. `mobile_wait_for_text` → synchronizes on app state

The snapshot is the key idea. Instead of screenshots and a vision model, the agent reads a compact text rendering of the accessibility tree where every element carries a ref:

```
- textfield "Email" [ref=e2] [focused]: "user@example.com"
- textfield "Password" [ref=e3]
- button "Sign In" [ref=e4] [testId=signin-btn]
- text "Forgot password?" [ref=e5]
```

Acting by ref (`mobile_tap` with `ref: "e4"`) is deterministic and token-cheap. Refs are re-resolved against the live hierarchy when the action runs, so a re-render between snapshot and tap doesn't break the run — and when an element is truly gone, the agent gets an error telling it to take a new snapshot.

## 6. Build your own agent loop with `@mobilewright/agent`

The MCP server is built on a small programmatic layer you can use directly in any LLM tool-calling loop. Two pieces:

- **`AgentSession`** — snapshots the screen and executes ref-based actions against a connected `Device`
- **`executeAction`** — validates raw JSON (straight from your model's tool output) and runs it, returning `{ ok, message, snapshot }` instead of throwing

Here's a complete agent loop using the Claude API — one tool, `mobile_act`, whose input is a Mobilewright action:

```bash
npm install @mobilewright/agent @anthropic-ai/sdk
```

```typescript
// agent-loop.ts
import Anthropic from '@anthropic-ai/sdk';
import { ios } from 'mobilewright';
import { AgentSession, executeAction } from '@mobilewright/agent';

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

const device = await ios.launch({ bundleId: 'com.example.myapp' });
const session = new AgentSession(device);

const tools: Anthropic.Tool[] = [{
  name: 'mobile_act',
  description: `Perform one action on the connected phone. Actions: snapshot, tap {ref},
tap_at {x,y}, double_tap {ref}, long_press {ref,duration?}, fill {ref,text},
type_text {text}, press_keys {keys[]}, swipe {direction,ref?,distance?},
press_button {button}, open_url {url}, launch_app {bundleId}, terminate_app {bundleId},
set_orientation {orientation}, wait_for_text {text,timeout?}.
Refs (e.g. "e4") come from the snapshot returned by every action.`,
  input_schema: {
    type: 'object',
    properties: { action: { type: 'string', description: 'The action name' } },
    required: ['action'],
    additionalProperties: true,
  },
}];

const task = 'Sign in as user@example.com with password secret123 and confirm the Welcome screen appears.';
const firstSnapshot = await session.snapshot();

const messages: Anthropic.MessageParam[] = [{
  role: 'user',
  content: `${task}\n\nCurrent screen:\n${firstSnapshot.text}`,
}];

while (true) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: 'You control a mobile device through the mobile_act tool. Act step by step. When the task is complete (or impossible), stop calling tools and report the outcome.',
    tools,
    messages,
  });

  messages.push({ role: 'assistant', content: response.content });
  if (response.stop_reason !== 'tool_use') break;

  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    // executeAction validates unknown input and never throws — bad or stale
    // actions come back as { ok: false, message } the model can react to.
    const result = await executeAction(session, block.input);
    toolResults.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: `${result.message}\n\nCurrent screen:\n${result.snapshot ?? '(no snapshot)'}`,
      is_error: !result.ok,
    });
  }
  messages.push({ role: 'user', content: toolResults });
}

const finalText = messages.at(-1);
console.log('Agent finished. Last assistant message:');
for (const block of (finalText?.content as Anthropic.ContentBlock[]) ?? []) {
  if (block.type === 'text') console.log(block.text);
}

await device.close();
```

Run it with `npx tsx agent-loop.ts`. The observe-act loop is entirely text: snapshot in, JSON action out, fresh snapshot back. If you prefer typed calls over JSON, `AgentSession` exposes the primitives directly — `session.tap('e4')`, `session.fill('e2', 'hello')`, `session.waitForText('Welcome')`.

You can also combine agents with regular tests: use the deterministic locator API for the critical path and let an agent do exploratory passes over the rest of the app.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `no online ios device found` | Boot a simulator/emulator; verify with `npx mobilewright devices` |
| `doctor` reports missing tools | Follow its per-check fix instructions (Xcode CLT, ANDROID_HOME, adb) |
| Element not found but visible on screen | Open the Inspector — the accessibility tree may name it differently than the UI renders it |
| Agent taps the wrong element | Prefer `testId`s in your app; snapshot refs pick them up automatically |
| Snapshot is huge on a complex screen | It caps at 500 elements; navigate closer to the target screen, or scope work per screen |
| MCP server prints nothing | It talks JSON-RPC on stdout by design; diagnostics go to stderr |

Next steps: the [README](README.md) documents the full API surface, the [AI Agents & MCP guide](docs/src/guides/ai-agents.md) covers the agent layer in depth, and the [ROADMAP](ROADMAP.md) shows what's coming.
