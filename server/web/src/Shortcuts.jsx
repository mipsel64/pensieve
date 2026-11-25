import { Fragment, useEffect, useId, useRef } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Kbd } from '@astryxdesign/core/Kbd';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Heading, Text } from '@astryxdesign/core/Text';
import { resolveKey, SHORTCUT_GROUPS } from './shortcuts.js';

/** Global keyboard shortcuts. `on[type]` handlers run for the actions `resolveKey` names; `g` waits 1.5 seconds for its second key. */
export function useShortcuts(handlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    let pending = null;
    let timer = 0;
    const onKey = (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      const result = resolveKey(event, pending, document.activeElement);
      pending = result.pending;
      clearTimeout(timer);
      if (pending) timer = setTimeout(() => (pending = null), 1500);
      if (!result.action && !result.pending) return;
      const handler = latest.current[result.action?.type];
      if (result.action && !handler) return;
      event.preventDefault();
      handler?.(result.action);
    };
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, []);
}

const keyName = (key) => ({ '⌘': 'meta', Ctrl: 'ctrl', Esc: 'escape' })[key] ?? key;

function Keys({ keys }) {
  return (
    <HStack gap={1} align="center">
      {keys.map((key, i) => (
        <Fragment key={i}>
          {i > 0 && keys[0] === 'g' && <Text type="supporting">then</Text>}
          <Kbd keys={keyName(key)} />
        </Fragment>
      ))}
    </HStack>
  );
}

export function ShortcutsHelp({ modifier, onClose }) {
  const ids = useId();
  const onOpenChange = (open) => !open && onClose();
  return (
    <Dialog isOpen onOpenChange={onOpenChange} width={640} padding={4}>
      <DialogHeader title="Keyboard shortcuts" onOpenChange={onOpenChange} />
      <VStack gap={6} paddingBlockStart={4}>
        {SHORTCUT_GROUPS(modifier).map((group, index) => (
          <VStack key={group.title} as="section" gap={2} aria-labelledby={`${ids}-${index}`}>
            <Heading level={3} id={`${ids}-${index}`}>
              {group.title}
            </Heading>
            <VStack gap={2}>
              {group.items.map((item) => (
                <HStack key={item.label} gap={4} align="center" justify="between" wrap="wrap">
                  <Text type="body">{item.label}</Text>
                  <Keys keys={item.keys} />
                </HStack>
              ))}
            </VStack>
          </VStack>
        ))}
        <Text type="supporting" color="secondary">
          Shortcuts pause while you type in a field.
        </Text>
      </VStack>
    </Dialog>
  );
}
