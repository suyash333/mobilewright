import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import sharp from 'sharp';
import { z } from 'zod';
import type { Device } from '@mobilewright/core';
import type { DeviceInfo } from '@mobilewright/protocol';
import { AgentSession } from './session.js';
import { executeAction } from './actions.js';

const _require = createRequire(import.meta.url);
const _pkg = _require('../package.json') as { version: string };

/** Screenshot delivery caps — keeps images cheap for LLM context windows. */
const SCREENSHOT_MAX_WIDTH = 720;
const SCREENSHOT_JPEG_QUALITY = 70;

/**
 * Platform launcher injected from mobilewright, mirroring the inspector's
 * dependency injection to avoid a circular package dependency.
 */
export interface AgentLauncher {
  devices(): Promise<DeviceInfo[]>;
  launch(opts: {
    deviceId?: string;
    deviceName?: RegExp;
    bundleId?: string;
    autoStart?: boolean;
    autoAppLaunch?: boolean;
  }): Promise<Device>;
}

export interface McpServerOptions {
  ios: AgentLauncher;
  android: AgentLauncher;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
};

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const failure = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

/**
 * Build the Mobilewright MCP server. Exposes the connected device's
 * accessibility tree and input surface as tools any MCP client (Claude,
 * Cursor, custom agents) can drive. One device is active at a time;
 * mobile_use_device switches it.
 */
export function createMcpServer({ ios, android }: McpServerOptions): McpServer {
  const server = new McpServer({ name: 'mobilewright-mcp-server', version: _pkg.version });

  let session: AgentSession | null = null;

  function requireSession(): AgentSession {
    if (!session) {
      throw new Error('No device connected. Call mobile_list_devices, then mobile_use_device first.');
    }
    return session;
  }

  /** Run a handler, converting thrown errors into actionable isError results. */
  async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await fn();
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
  }

  /** Delegate to the shared action executor and format its result for MCP. */
  async function act(input: Record<string, unknown>): Promise<ToolResult> {
    return guarded(async () => {
      const result = await executeAction(requireSession(), input);
      if (!result.ok) {
        return failure(result.message);
      }
      const body = result.snapshot ? `${result.message}\n\nCurrent screen:\n${result.snapshot}` : result.message;
      return text(body);
    });
  }

  server.registerTool(
    'mobile_list_devices',
    {
      title: 'List devices',
      description: 'List connected iOS and Android devices, simulators, and emulators. Use the returned id with mobile_use_device.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => guarded(async () => {
      const [iosResult, androidResult] = await Promise.allSettled([ios.devices(), android.devices()]);
      const devices = [
        ...(iosResult.status === 'fulfilled' ? iosResult.value : []),
        ...(androidResult.status === 'fulfilled' ? androidResult.value : []),
      ];
      if (devices.length === 0) {
        return failure('No devices found. Boot a simulator/emulator or connect a device, then try again.');
      }
      const lines = devices.map(d => `- ${d.id} — ${d.name} (${d.platform} ${d.type}, ${d.state})`);
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'mobile_use_device',
    {
      title: 'Connect to a device',
      description: 'Connect to a device by platform and optional id/name, replacing any previous connection. Optionally launches an app. Returns a snapshot of the current screen.',
      inputSchema: {
        platform: z.enum(['ios', 'android']).describe('Device platform'),
        deviceId: z.string().optional().describe('Device id from mobile_list_devices; omit to use the first online device'),
        bundleId: z.string().optional().describe('App bundle id to launch after connecting'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ platform, deviceId, bundleId }) => guarded(async () => {
      if (session) {
        await session.device.close().catch(() => {});
        session = null;
      }
      const launcher = platform === 'ios' ? ios : android;
      const device = await launcher.launch({ deviceId, bundleId, autoStart: true, autoAppLaunch: bundleId !== undefined });
      session = new AgentSession(device);
      const snap = await session.snapshot();
      return text(`Connected to ${platform} device${deviceId ? ` ${deviceId}` : ''}${bundleId ? `, launched ${bundleId}` : ''}.\n\nCurrent screen:\n${snap.text}`);
    }),
  );

  server.registerTool(
    'mobile_disconnect',
    {
      title: 'Disconnect device',
      description: 'Disconnect from the current device and release it.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => guarded(async () => {
      if (!session) {
        return text('No device was connected.');
      }
      await session.device.close();
      session = null;
      return text('Disconnected.');
    }),
  );

  server.registerTool(
    'mobile_snapshot',
    {
      title: 'Screen snapshot',
      description: 'Get a token-efficient text snapshot of the current screen from the accessibility tree. Each element has a ref (e.g. e12) usable with mobile_tap, mobile_fill, etc. Prefer this over mobile_screenshot — no vision needed.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    () => guarded(async () => {
      const snap = await requireSession().snapshot();
      return text(snap.text);
    }),
  );

  server.registerTool(
    'mobile_screenshot',
    {
      title: 'Screenshot',
      description: 'Capture the device screen as a scaled JPEG image. Use only when the text snapshot is not enough (e.g. purely visual content).',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    () => guarded(async () => {
      const png = await requireSession().device.driver.screenshot();
      const jpeg = await sharp(png)
        .resize({ width: SCREENSHOT_MAX_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: SCREENSHOT_JPEG_QUALITY })
        .toBuffer();
      return { content: [{ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }] };
    }),
  );

  server.registerTool(
    'mobile_tap',
    {
      title: 'Tap element',
      description: 'Tap an element by its snapshot ref, or raw coordinates when no ref fits. Returns a fresh snapshot after the tap.',
      inputSchema: {
        ref: z.string().optional().describe('Element ref from the latest snapshot, e.g. "e12"'),
        x: z.number().optional().describe('X coordinate (with y, when no ref is given)'),
        y: z.number().optional().describe('Y coordinate (with x, when no ref is given)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ ref, x, y }) => {
      if (ref !== undefined) return act({ action: 'tap', ref });
      if (x !== undefined && y !== undefined) return act({ action: 'tap_at', x, y });
      return Promise.resolve(failure('Provide either "ref" or both "x" and "y".'));
    },
  );

  server.registerTool(
    'mobile_double_tap',
    {
      title: 'Double-tap element',
      description: 'Double-tap an element by its snapshot ref. Returns a fresh snapshot.',
      inputSchema: { ref: z.string().describe('Element ref from the latest snapshot') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ ref }) => act({ action: 'double_tap', ref }),
  );

  server.registerTool(
    'mobile_long_press',
    {
      title: 'Long-press element',
      description: 'Press and hold an element by its snapshot ref. Returns a fresh snapshot.',
      inputSchema: {
        ref: z.string().describe('Element ref from the latest snapshot'),
        duration: z.number().int().positive().optional().describe('Hold duration in ms'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ ref, duration }) => act({ action: 'long_press', ref, ...(duration !== undefined && { duration }) }),
  );

  server.registerTool(
    'mobile_fill',
    {
      title: 'Fill text field',
      description: 'Tap a text field by ref, clear it, and type the given text. Returns a fresh snapshot.',
      inputSchema: {
        ref: z.string().describe('Text field ref from the latest snapshot'),
        text: z.string().describe('Text to type'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ ref, text: value }) => act({ action: 'fill', ref, text: value }),
  );

  server.registerTool(
    'mobile_type_text',
    {
      title: 'Type text',
      description: 'Type text into the currently focused element (use mobile_fill to target a field). Returns a fresh snapshot.',
      inputSchema: { text: z.string().describe('Text to type') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ text: value }) => act({ action: 'type_text', text: value }),
  );

  server.registerTool(
    'mobile_press_keys',
    {
      title: 'Press keys',
      description: 'Press key combinations in order, e.g. ["ctrl+a", "backspace"]. Returns a fresh snapshot.',
      inputSchema: { keys: z.array(z.string()).min(1).describe('Key combos to press in order') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ keys }) => act({ action: 'press_keys', keys }),
  );

  server.registerTool(
    'mobile_swipe',
    {
      title: 'Swipe',
      description: 'Swipe the screen, or swipe starting from an element when ref is given. Returns a fresh snapshot.',
      inputSchema: {
        direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
        ref: z.string().optional().describe('Element ref to start the swipe from'),
        distance: z.number().positive().optional().describe('Swipe distance in points'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ direction, ref, distance }) => act({
      action: 'swipe',
      direction,
      ...(ref !== undefined && { ref }),
      ...(distance !== undefined && { distance }),
    }),
  );

  server.registerTool(
    'mobile_press_button',
    {
      title: 'Press hardware button',
      description: 'Press a hardware button (HOME, BACK, POWER, VOLUME_UP, VOLUME_DOWN, ENTER, APP_SWITCH, …). Returns a fresh snapshot.',
      inputSchema: {
        button: z.enum([
          'HOME', 'BACK', 'POWER', 'VOLUME_UP', 'VOLUME_DOWN', 'ENTER',
          'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_CENTER',
          'APP_SWITCH', 'LOCK',
        ]).describe('Hardware button to press'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ button }) => act({ action: 'press_button', button }),
  );

  server.registerTool(
    'mobile_open_url',
    {
      title: 'Open URL',
      description: 'Open a URL or deep link on the device. Returns a fresh snapshot.',
      inputSchema: { url: z.string().describe('Web URL or deep link, e.g. "myapp://settings"') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ url }) => act({ action: 'open_url', url }),
  );

  server.registerTool(
    'mobile_launch_app',
    {
      title: 'Launch app',
      description: 'Launch an app by bundle id and wait for it to reach the foreground. Returns a fresh snapshot.',
      inputSchema: { bundleId: z.string().describe('App bundle id, e.g. "com.example.app"') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ bundleId }) => act({ action: 'launch_app', bundleId }),
  );

  server.registerTool(
    'mobile_terminate_app',
    {
      title: 'Terminate app',
      description: 'Terminate a running app by bundle id. Returns a fresh snapshot.',
      inputSchema: { bundleId: z.string().describe('App bundle id to terminate') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ bundleId }) => act({ action: 'terminate_app', bundleId }),
  );

  server.registerTool(
    'mobile_list_apps',
    {
      title: 'List installed apps',
      description: 'List apps installed on the connected device.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => guarded(async () => {
      const apps = await requireSession().device.listApps();
      if (apps.length === 0) {
        return text('No apps found on the device.');
      }
      return text(apps.map(a => `- ${a.bundleId}${a.name ? ` — ${a.name}` : ''}${a.version ? ` (${a.version})` : ''}`).join('\n'));
    }),
  );

  server.registerTool(
    'mobile_set_orientation',
    {
      title: 'Set orientation',
      description: 'Rotate the device to portrait or landscape. Returns a fresh snapshot.',
      inputSchema: { orientation: z.enum(['portrait', 'landscape']).describe('Target orientation') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ orientation }) => act({ action: 'set_orientation', orientation }),
  );

  server.registerTool(
    'mobile_wait_for_text',
    {
      title: 'Wait for text',
      description: 'Wait until text appears anywhere on screen (case-insensitive substring). Returns a fresh snapshot once found.',
      inputSchema: {
        text: z.string().describe('Text to wait for'),
        timeout: z.number().int().positive().optional().describe('Timeout in ms (default 5000)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ text: value, timeout }) => act({ action: 'wait_for_text', text: value, ...(timeout !== undefined && { timeout }) }),
  );

  return server;
}

/** Start the MCP server on stdio. Resolves once the transport is connected. */
export async function runMcpServer(opts: McpServerOptions): Promise<McpServer> {
  const server = createMcpServer(opts);
  await server.connect(new StdioServerTransport());
  return server;
}
