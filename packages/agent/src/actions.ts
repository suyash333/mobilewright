import { z } from 'zod';
import { AgentError, AgentSession } from './session.js';

// Structured, JSON-serializable actions an LLM can emit from a tool-calling
// loop. executeAction() validates unknown input, so raw model output can be
// passed straight in.

const refField = z.string().regex(/^e\d+$/, 'ref must look like "e12" (from a snapshot)');

const swipeDirection = z.enum(['up', 'down', 'left', 'right']);

const hardwareButton = z.enum([
  'HOME', 'BACK', 'POWER', 'VOLUME_UP', 'VOLUME_DOWN', 'ENTER',
  'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'DPAD_CENTER',
  'APP_SWITCH', 'LOCK',
]);

export const agentActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot') }).strict(),
  z.object({ action: z.literal('tap'), ref: refField }).strict(),
  z.object({ action: z.literal('tap_at'), x: z.number(), y: z.number() }).strict(),
  z.object({ action: z.literal('double_tap'), ref: refField }).strict(),
  z.object({ action: z.literal('long_press'), ref: refField, duration: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('fill'), ref: refField, text: z.string() }).strict(),
  z.object({ action: z.literal('type_text'), text: z.string() }).strict(),
  z.object({ action: z.literal('press_keys'), keys: z.array(z.string()).min(1) }).strict(),
  z.object({
    action: z.literal('swipe'),
    direction: swipeDirection,
    ref: refField.optional(),
    distance: z.number().positive().optional(),
  }).strict(),
  z.object({ action: z.literal('press_button'), button: hardwareButton }).strict(),
  z.object({ action: z.literal('open_url'), url: z.string() }).strict(),
  z.object({ action: z.literal('launch_app'), bundleId: z.string() }).strict(),
  z.object({ action: z.literal('terminate_app'), bundleId: z.string() }).strict(),
  z.object({ action: z.literal('set_orientation'), orientation: z.enum(['portrait', 'landscape']) }).strict(),
  z.object({ action: z.literal('wait_for_text'), text: z.string(), timeout: z.number().int().positive().optional() }).strict(),
]);

export type AgentAction = z.infer<typeof agentActionSchema>;

export interface ActionResult {
  ok: boolean;
  /** What happened, phrased for the agent driving the loop. */
  message: string;
  /** Fresh snapshot text after the action (omitted for snapshot-free actions). */
  snapshot?: string;
}

/**
 * Validate and execute a single agent action against a session.
 *
 * Accepts unknown input so raw LLM tool output can be passed directly; invalid
 * shapes and runtime failures come back as `ok: false` with guidance rather
 * than throwing, so an agent loop can always continue.
 */
export async function executeAction(session: AgentSession, input: unknown): Promise<ActionResult> {
  const parsed = agentActionSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, message: `Invalid action: ${issues}` };
  }
  const action = parsed.data;

  try {
    const message = await perform(session, action);
    const snap = await session.snapshot();
    return { ok: true, message, snapshot: snap.text };
  } catch (err) {
    if (err instanceof AgentError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: `Action "${action.action}" failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function perform(session: AgentSession, action: AgentAction): Promise<string> {
  switch (action.action) {
    case 'snapshot':
      return 'Snapshot captured.';
    case 'tap':
      await session.tap(action.ref);
      return `Tapped ${action.ref}.`;
    case 'tap_at':
      await session.tapAt(action.x, action.y);
      return `Tapped at (${action.x}, ${action.y}).`;
    case 'double_tap':
      await session.doubleTap(action.ref);
      return `Double-tapped ${action.ref}.`;
    case 'long_press':
      await session.longPress(action.ref, action.duration);
      return `Long-pressed ${action.ref}.`;
    case 'fill':
      await session.fill(action.ref, action.text);
      return `Filled ${action.ref} with ${JSON.stringify(action.text)}.`;
    case 'type_text':
      await session.typeText(action.text);
      return `Typed ${JSON.stringify(action.text)} into the focused element.`;
    case 'press_keys':
      await session.pressKeys(action.keys);
      return `Pressed keys: ${action.keys.join(', ')}.`;
    case 'swipe':
      if (action.ref) {
        await session.swipeElement(action.ref, action.direction, action.distance);
        return `Swiped ${action.direction} from ${action.ref}.`;
      }
      await session.swipe(action.direction, action.distance);
      return `Swiped ${action.direction}.`;
    case 'press_button':
      await session.pressButton(action.button);
      return `Pressed ${action.button}.`;
    case 'open_url':
      await session.openUrl(action.url);
      return `Opened ${action.url}.`;
    case 'launch_app':
      await session.device.launchApp(action.bundleId);
      return `Launched ${action.bundleId}.`;
    case 'terminate_app':
      await session.device.terminateApp(action.bundleId);
      return `Terminated ${action.bundleId}.`;
    case 'set_orientation':
      await session.setOrientation(action.orientation);
      return `Orientation set to ${action.orientation}.`;
    case 'wait_for_text':
      await session.waitForText(action.text, { timeout: action.timeout });
      return `Text ${JSON.stringify(action.text)} is on screen.`;
  }
}
