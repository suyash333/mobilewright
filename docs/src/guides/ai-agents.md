---
sidebar_position: 1
title: AI Agents & MCP
---

# AI Agents & MCP

Mobilewright gives AI agents a phone, not a screenshot. The `@mobilewright/agent`
package turns the device's accessibility tree into a token-efficient text
snapshot with stable element refs, and exposes the whole input surface — taps,
fills, swipes, app lifecycle — as structured actions an LLM can emit. An MCP
server built on top of it plugs into Claude Code, Claude Desktop, Cursor, or any
other MCP client.

## The MCP server

Start the server on stdio:

```bash
npx mobilewright mcp
```

Register it with your MCP client, for example in Claude Desktop's
`claude_desktop_config.json` or Claude Code's `.mcp.json`:

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

### Tools

| Tool | Description |
|---|---|
| `mobile_list_devices` | List connected devices, simulators, and emulators |
| `mobile_use_device` | Connect to a device (optionally launch an app) |
| `mobile_disconnect` | Release the current device |
| `mobile_snapshot` | Text snapshot of the screen with element refs |
| `mobile_screenshot` | Scaled JPEG screenshot, for purely visual content |
| `mobile_tap` / `mobile_double_tap` / `mobile_long_press` | Tap an element by ref (or raw coordinates) |
| `mobile_fill` | Focus a field by ref, clear it, type text |
| `mobile_type_text` / `mobile_press_keys` | Keyboard input into the focused element |
| `mobile_swipe` | Swipe the screen or from an element |
| `mobile_press_button` | Hardware buttons — HOME, BACK, volume, … |
| `mobile_launch_app` / `mobile_terminate_app` / `mobile_list_apps` | App lifecycle |
| `mobile_open_url` | Deep links and web URLs |
| `mobile_set_orientation` | Portrait / landscape |
| `mobile_wait_for_text` | Wait until text appears on screen |

## Snapshots and refs

`mobile_snapshot` renders the accessibility tree as indented text. Structural
containers with no semantics are skipped so deep Android/React Native trees stay
readable, and every informative element gets a ref:

```
- textfield "Email" [ref=e2] [focused]: "user@example.com"
- textfield "Password" [ref=e3]
- button "Sign In" [ref=e4] [testId=signin-btn]
- text "Forgot password?" [ref=e5]
```

The agent acts by ref — `mobile_tap` with `ref: "e4"` — and every action returns
a fresh snapshot, closing the observe-act loop without a vision model. Refs are
re-resolved against the live hierarchy when the action runs (test id first, then
label/text with the same type, then position), so a re-render or scroll between
snapshot and tap doesn't break the run. When an element is truly gone, the agent
gets an actionable error telling it to take a new snapshot.

## Building your own loop

For custom agents, use the same layer programmatically:

```typescript
import { ios } from 'mobilewright';
import { AgentSession, executeAction } from '@mobilewright/agent';

const device = await ios.launch({ bundleId: 'com.example.app' });
const session = new AgentSession(device);

// Observe: feed the snapshot text to your model
const { text } = await session.snapshot();

// Act: pass the model's JSON tool output straight in
const result = await executeAction(session, { action: 'fill', ref: 'e2', text: 'user@example.com' });

// result: { ok: true, message: 'Filled e2 …', snapshot: '…fresh screen…' }
```

`executeAction` validates unknown input with zod and never throws on bad or
stale actions — failures come back as `{ ok: false, message }` with guidance the
model can react to. The supported actions are `snapshot`, `tap`, `tap_at`,
`double_tap`, `long_press`, `fill`, `type_text`, `press_keys`, `swipe`,
`press_button`, `open_url`, `launch_app`, `terminate_app`, `set_orientation`,
and `wait_for_text`.

`AgentSession` also exposes the primitives directly (`tap(ref)`, `fill(ref,
text)`, `waitForText(text)`, …) when you want typed calls instead of JSON.
