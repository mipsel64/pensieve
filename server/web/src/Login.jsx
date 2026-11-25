import { useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { Divider } from '@astryxdesign/core/Divider';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Eye, EyeOff } from 'lucide-react';
import { login, Unauthorized } from './api.js';

export function Login({ methods, onSuccess }) {
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    if (busy || !token.trim()) return;
    setBusy(true);
    setError('');
    try {
      await login(token.trim());
      onSuccess();
    } catch (err) {
      setError(err instanceof Unauthorized ? "That token doesn't match the server's." : `Couldn't reach the server: ${err.message}`);
      setBusy(false);
    }
  }

  return (
    <Center axis="both" padding={6} minHeight="100dvh">
      <VStack gap={4} hAlign="center" width="100%" maxWidth={400}>
        <VStack gap={2} hAlign="center">
          <Heading level={1}>Pensieve</Heading>
          <Text type="body" color="secondary">
            Shared memory for your agents
          </Text>
        </VStack>
        <Card padding={8} width="100%">
          <VStack gap={4} hAlign="stretch">
            {methods.includes('google') && <Button label="Sign in with Google" href="/auth/login" variant="secondary" size="lg" width="100%" />}
            {methods.includes('google') && methods.includes('token') && <Divider label="or" />}
            {methods.includes('token') && (
              <VStack as="form" gap={4} onSubmit={submit} noValidate>
                <HStack gap={2} align="end">
                  <TextInput
                    id="token"
                    label="Server token"
                    type={visible ? 'text' : 'password'}
                    autoComplete="current-password"
                    hasSpellCheck={false}
                    hasAutoFocus
                    value={token}
                    onChange={setToken}
                    size="lg"
                    width="100%"
                    status={error ? { type: 'error', message: error } : undefined}
                  />
                  <Button
                    label={visible ? 'Hide token' : 'Show token'}
                    variant="ghost"
                    size="lg"
                    isIconOnly
                    icon={<Icon icon={visible ? EyeOff : Eye} />}
                    onClick={() => setVisible((value) => !value)}
                  />
                </HStack>
                <Button
                  type="submit"
                  label={busy ? 'Signing in' : 'Sign in'}
                  variant="primary"
                  size="lg"
                  width="100%"
                  isLoading={busy}
                  isDisabled={busy || !token.trim()}
                />
              </VStack>
            )}
          </VStack>
        </Card>
      </VStack>
    </Center>
  );
}
