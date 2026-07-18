import { test, expect } from '@playwright/test';
import { buildSnapshot, findByDescriptor } from './snapshot.js';
import { node } from './fake-driver.js';

test.describe('buildSnapshot', () => {
  test('assigns refs in document order and renders roles with names', () => {
    const roots = [
      node({ type: 'Button', label: 'Sign In', bounds: { x: 0, y: 0, width: 100, height: 40 } }),
      node({ type: 'StaticText', text: 'Welcome' }),
    ];

    const snap = buildSnapshot(roots);

    expect(snap.text).toContain('- button "Sign In" [ref=e1]');
    expect(snap.text).toContain('- text "Welcome" [ref=e2]');
    expect(snap.refs.get('e1')?.label).toBe('Sign In');
    expect(snap.refs.get('e2')?.text).toBe('Welcome');
  });

  test('skips uninteresting containers but keeps their children', () => {
    const roots = [
      node({ type: 'Other' }, [
        node({ type: 'Other' }, [
          node({ type: 'Button', label: 'Go' }),
        ]),
      ]),
    ];

    const snap = buildSnapshot(roots);

    expect(snap.text).toBe('- button "Go" [ref=e1]');
  });

  test('indents children under their rendered parent', () => {
    const roots = [
      node({ type: 'Cell', label: 'Row 1' }, [
        node({ type: 'Button', label: 'Delete' }),
      ]),
    ];

    const snap = buildSnapshot(roots);

    expect(snap.text.split('\n')).toEqual([
      '- listitem "Row 1" [ref=e1]',
      '  - button "Delete" [ref=e2]',
    ]);
  });

  test('renders state flags and testId', () => {
    const roots = [
      node({ type: 'Button', label: 'Pay', isEnabled: false, identifier: 'pay-btn' }),
      node({ type: 'Switch', label: 'Wi-Fi', isChecked: true }),
      node({ type: 'TextField', label: 'Email', isFocused: true, value: 'a@b.co' }),
    ];

    const snap = buildSnapshot(roots);

    expect(snap.text).toContain('- button "Pay" [ref=e1] [testId=pay-btn] [disabled]');
    expect(snap.text).toContain('- switch "Wi-Fi" [ref=e2] [checked]');
    expect(snap.text).toContain('- textfield "Email" [ref=e3] [focused]: "a@b.co"');
  });

  test('omits invisible elements unless includeInvisible is set', () => {
    const roots = [
      node({ type: 'Button', label: 'Hidden', isVisible: false }),
      node({ type: 'Button', label: 'Shown' }),
    ];

    expect(buildSnapshot(roots).text).toBe('- button "Shown" [ref=e1]');

    const withHidden = buildSnapshot(roots, { includeInvisible: true });
    expect(withHidden.text).toContain('- button "Hidden" [ref=e1] [hidden]');
    expect(withHidden.text).toContain('- button "Shown" [ref=e2]');
  });

  test('renders placeholder when there is no label or text', () => {
    const roots = [node({ type: 'SearchField', placeholder: 'Search...' })];

    expect(buildSnapshot(roots).text).toBe('- textfield placeholder="Search..." [ref=e1]');
  });

  test('truncates at maxElements with a notice', () => {
    const roots = Array.from({ length: 5 }, (_, i) => node({ type: 'Button', label: `B${i}` }));

    const snap = buildSnapshot(roots, { maxElements: 3 });

    expect(snap.refs.size).toBe(3);
    expect(snap.text).toContain('(snapshot truncated at 3 elements)');
  });

  test('reports an empty screen', () => {
    expect(buildSnapshot([]).text).toBe('(no interactive or labeled elements on screen)');
  });
});

test.describe('findByDescriptor', () => {
  test('re-finds an element by testId even when it moved', () => {
    const before = buildSnapshot([node({ type: 'Button', label: 'Go', identifier: 'go', bounds: { x: 0, y: 0, width: 100, height: 40 } })]);
    const desc = before.refs.get('e1')!;

    const moved = node({ type: 'Button', label: 'Go later', identifier: 'go', bounds: { x: 0, y: 500, width: 100, height: 40 } });
    expect(findByDescriptor([moved], desc)).toBe(moved);
  });

  test('re-finds by label and type, preferring the closest match', () => {
    const before = buildSnapshot([node({ type: 'Button', label: 'Delete', bounds: { x: 0, y: 100, width: 100, height: 40 } })]);
    const desc = before.refs.get('e1')!;

    const far = node({ type: 'Button', label: 'Delete', bounds: { x: 0, y: 700, width: 100, height: 40 } });
    const near = node({ type: 'Button', label: 'Delete', bounds: { x: 0, y: 140, width: 100, height: 40 } });
    expect(findByDescriptor([far, near], desc)).toBe(near);
  });

  test('falls back to same type at the same bounds', () => {
    const bounds = { x: 10, y: 20, width: 50, height: 50 };
    const before = buildSnapshot([node({ type: 'Image', label: 'logo', bounds })]);
    const desc = before.refs.get('e1')!;

    const relabeled = node({ type: 'Image', label: 'new-logo', bounds });
    expect(findByDescriptor([relabeled], desc)).toBe(relabeled);
  });

  test('returns null when the element is gone', () => {
    const before = buildSnapshot([node({ type: 'Button', label: 'Go' })]);
    const desc = before.refs.get('e1')!;

    expect(findByDescriptor([node({ type: 'StaticText', text: 'Done', bounds: { x: 500, y: 500, width: 10, height: 10 } })], desc)).toBeNull();
  });
});
