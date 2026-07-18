import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { Device } from '@mobilewright/core';
import type { DeviceInfo } from '@mobilewright/protocol';
import { createMcpServer, type AgentLauncher } from './mcp-server.js';
import { createFakeDriver, node, type FakeDriver } from './fake-driver.js';

interface TextContent { type: 'text'; text: string }

function textOf(result: unknown): string {
  const content = (result as { content: TextContent[] }).content;
  return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

function fakeLauncher(driver: FakeDriver, devices: DeviceInfo[] = []): AgentLauncher {
  return {
    devices: async () => devices,
    launch: async () => new Device(driver),
  };
}

async function connectClient(driver: FakeDriver, devices: DeviceInfo[] = []) {
  const server = createMcpServer({
    ios: fakeLauncher(driver, devices),
    android: fakeLauncher(driver, []),
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const iphone: DeviceInfo = {
  id: 'SIM-1', name: 'iPhone 17', platform: 'ios', type: 'simulator', state: 'online',
};

test.describe('Mobilewright MCP server', () => {
  test('lists the expected tools', async () => {
    const client = await connectClient(createFakeDriver());

    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);

    for (const expected of [
      'mobile_list_devices', 'mobile_use_device', 'mobile_disconnect',
      'mobile_snapshot', 'mobile_screenshot', 'mobile_tap', 'mobile_fill',
      'mobile_swipe', 'mobile_press_button', 'mobile_launch_app', 'mobile_wait_for_text',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test('acting without a device returns guidance, not a crash', async () => {
    const client = await connectClient(createFakeDriver());

    const result = await client.callTool({ name: 'mobile_snapshot', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('mobile_use_device');
  });

  test('lists devices from both platforms', async () => {
    const client = await connectClient(createFakeDriver(), [iphone]);

    const result = await client.callTool({ name: 'mobile_list_devices', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('SIM-1 — iPhone 17 (ios simulator, online)');
  });

  test('use_device connects and returns an initial snapshot', async () => {
    const driver = createFakeDriver([node({ type: 'Button', label: 'Sign In' })]);
    const client = await connectClient(driver, [iphone]);

    const result = await client.callTool({
      name: 'mobile_use_device',
      arguments: { platform: 'ios', deviceId: 'SIM-1' },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('- button "Sign In" [ref=e1]');
  });

  test('tap by ref acts on the device and returns the new screen', async () => {
    const driver = createFakeDriver([
      node({ type: 'Button', label: 'Sign In', bounds: { x: 100, y: 100, width: 100, height: 50 } }),
    ]);
    const client = await connectClient(driver, [iphone]);
    await client.callTool({ name: 'mobile_use_device', arguments: { platform: 'ios' } });

    const result = await client.callTool({ name: 'mobile_tap', arguments: { ref: 'e1' } });

    expect(result.isError).toBeFalsy();
    expect(driver.calls.taps).toEqual([[150, 125]]);
    expect(textOf(result)).toContain('Current screen:');
  });

  test('tap without ref or coordinates is rejected with guidance', async () => {
    const driver = createFakeDriver([node({ type: 'Button', label: 'Go' })]);
    const client = await connectClient(driver, [iphone]);
    await client.callTool({ name: 'mobile_use_device', arguments: { platform: 'ios' } });

    const result = await client.callTool({ name: 'mobile_tap', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('ref');
  });

  test('fill drives tap + clear + type', async () => {
    const driver = createFakeDriver([node({ type: 'TextField', label: 'Email' })]);
    const client = await connectClient(driver, [iphone]);
    await client.callTool({ name: 'mobile_use_device', arguments: { platform: 'ios' } });

    const result = await client.callTool({ name: 'mobile_fill', arguments: { ref: 'e1', text: 'a@b.co' } });

    expect(result.isError).toBeFalsy();
    expect(driver.calls.clearTextCount).toBe(1);
    expect(driver.calls.typed).toEqual(['a@b.co']);
  });

  test('screenshot returns a scaled JPEG image', async () => {
    const driver = createFakeDriver([]);
    driver.screenshotBuffer = await sharp({
      create: { width: 1170, height: 2532, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer();
    const client = await connectClient(driver, [iphone]);
    await client.callTool({ name: 'mobile_use_device', arguments: { platform: 'ios' } });

    const result = await client.callTool({ name: 'mobile_screenshot', arguments: {} });

    const image = (result as { content: Array<{ type: string; mimeType?: string; data?: string }> })
      .content.find(c => c.type === 'image');
    expect(image?.mimeType).toBe('image/jpeg');
    const decoded = sharp(Buffer.from(image!.data!, 'base64'));
    expect((await decoded.metadata()).width).toBe(720);
  });

  test('disconnect closes the device', async () => {
    const driver = createFakeDriver([]);
    const client = await connectClient(driver, [iphone]);
    await client.callTool({ name: 'mobile_use_device', arguments: { platform: 'ios' } });

    const result = await client.callTool({ name: 'mobile_disconnect', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Disconnected');

    const after = await client.callTool({ name: 'mobile_snapshot', arguments: {} });
    expect(after.isError).toBe(true);
  });
});
