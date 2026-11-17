import { useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Grid } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Theme } from '@astryxdesign/core/theme';
import { Check, Copy, LogOut, RotateCcw } from 'lucide-react';
import { ThemeSegmented } from './ThemeSwitch.jsx';
import { ACCENT_THEMES } from './accents.js';
import { api } from './api.js';
import { Empty, ErrorNote, Loading, RelTime, useResource } from './ui.jsx';
import { useCopy } from './Toast.jsx';
import { ACCENTS, GraphControls, resetGraph, SEARCH_MODES, Toggle, useSettings } from './settings.jsx';

const MODE_LABELS = {
  ask: 'Answer: the passages recall would give an agent, with their sources',
  keywords: 'Pages: whole pages ranked by their words',
};

function SettingsSection({ titleId, children }) {
  return (
    <VStack as="section" gap={4} aria-labelledby={titleId}>
      {children}
    </VStack>
  );
}

export function Settings({ oauth, onSignOut }) {
  const { settings, update, status, retry } = useSettings();
  const [signOutError, setSignOutError] = useState(null);

  return (
    <VStack gap={6} maxWidth="73.75rem">
      <VStack gap={1}>
        <Heading level={1}>Settings</Heading>
        <Text as="p" color="secondary">
          Saved on the server, so every browser you sign in from uses them.
        </Text>
      </VStack>
      <SaveStatus status={status} onRetry={retry} />

      <SettingsSection titleId="appearance-title">
        <Heading level={2} id="appearance-title">
          Appearance
        </Heading>
        <HStack align="center" justify="between" wrap="wrap" gap={3}>
          <Text id="theme-label">Theme</Text>
          <ThemeSegmented labelledBy="theme-label" />
        </HStack>
        <Text as="p" type="supporting" color="secondary">
          Saved in this browser only. System follows your device setting.
        </Text>
        <RadioList label="Accent" value={settings.accent} onChange={(accent) => update(null, { accent })} htmlName="accent">
          {Object.entries(ACCENTS).map(([id, { label }]) => (
            <RadioListItem
              key={id}
              value={id}
              label={label}
              startContent={
                <Theme theme={ACCENT_THEMES[id]}>
                  <Text color="accent" size="xl" aria-hidden="true">
                    ●
                  </Text>
                </Theme>
              }
            />
          ))}
        </RadioList>
      </SettingsSection>

      <SettingsSection titleId="search-title">
        <Heading level={2} id="search-title">
          Search
        </Heading>
        <RadioList label="When you press Enter" value={settings.search.mode} onChange={(mode) => update('search', { mode })} htmlName="search-mode">
          {SEARCH_MODES.map((id) => (
            <RadioListItem key={id} value={id} label={MODE_LABELS[id]} />
          ))}
        </RadioList>
        <Toggle id="settings-rerank" label="Rerank page results with Jev, when the server has a key" checked={settings.search.rerank} onChange={(v) => update('search', { rerank: v })} />
      </SettingsSection>

      <SettingsSection titleId="graph-title">
        <HStack align="center" justify="between" wrap="wrap" gap={3}>
          <Heading level={2} id="graph-title">
            Graph
          </Heading>
          <Button label="Restore defaults" variant="ghost" size="sm" icon={<Icon icon={RotateCcw} />} onClick={() => resetGraph(update)} />
        </HStack>
        <Grid columns={{ minWidth: 240, max: 3 }} gap={6} align="start">
          <VStack gap={3}>
            <Heading level={3}>Filters and groups</Heading>
            <GraphControls section="filters" idPrefix="settings" />
            <GraphControls section="groups" idPrefix="settings" />
          </VStack>
          <VStack gap={3}>
            <Heading level={3}>Display</Heading>
            <GraphControls section="display" idPrefix="settings" />
          </VStack>
          <VStack gap={3}>
            <Heading level={3}>Forces</Heading>
            <GraphControls section="forces" idPrefix="settings" />
          </VStack>
        </Grid>
      </SettingsSection>

      {oauth && (
        <>
          <ConnectedApps />
          <ApiTokens />
        </>
      )}

      <SettingsSection titleId="session-title">
        <Heading level={2} id="session-title">
          Session
        </Heading>
        <Text as="p" color="secondary">
          This browser stays signed in for 30 days. Signing out here doesn't affect other browsers or agents.
        </Text>
        {signOutError && <InlineError title="Couldn't sign out" message={signOutError.message} />}
        <HStack>
          <Button
            label="Sign out"
            variant="secondary"
            icon={<Icon icon={LogOut} />}
            onClick={() => {
              setSignOutError(null);
              onSignOut().catch(setSignOutError);
            }}
          />
        </HStack>
      </SettingsSection>
    </VStack>
  );
}

function ConnectedApps() {
  const { data, error, loading, reload } = useResource('/grants');
  const [revoking, setRevoking] = useState(null);
  const [revokeError, setRevokeError] = useState(null);

  async function revoke(id) {
    setRevoking(id);
    setRevokeError(null);
    try {
      await api(`/grants/${encodeURIComponent(id)}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setRevokeError(err);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <SettingsSection titleId="connected-apps-title">
      <Heading level={2} id="connected-apps-title">
        Connected apps
      </Heading>
      <Text as="p" color="secondary">
        Apps you approved can read and change all of Pensieve's memory.
      </Text>
      {loading && !data && <Loading label="Loading connected apps" />}
      {error && <ErrorNote error={error} onRetry={reload} />}
      {data?.length === 0 && <Empty>No connected apps.</Empty>}
      {data?.length > 0 && (
        <List hasDividers edge="flush">
          {data.map((grant) => (
            <ListItem
              key={grant.id}
              align="start"
              label={<Text weight="semibold">{grant.client_name}</Text>}
              description={
                <VStack gap={0.5}>
                  <Text color="secondary">{grant.email}</Text>
                  <Text type="supporting" color="secondary">
                    Approved <RelTime iso={grant.created_at} /> · Last refreshed <RelTime iso={grant.refreshed_at} />
                  </Text>
                </VStack>
              }
              endContent={
                <Button
                  label={revoking === grant.id ? 'Revoking…' : 'Revoke'}
                  variant="ghost"
                  size="sm"
                  isLoading={revoking === grant.id}
                  isDisabled={revoking !== null}
                  onClick={() => revoke(grant.id)}
                />
              }
            />
          ))}
        </List>
      )}
      {revokeError && <InlineError title="Couldn't revoke the app" message={revokeError.message} />}
    </SettingsSection>
  );
}

function ApiTokens() {
  const { data, error, loading, reload } = useResource('/tokens');
  const [revoking, setRevoking] = useState(null);
  const [revokeError, setRevokeError] = useState(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [created, setCreated] = useState(null);
  const copy = useCopy();

  async function revoke(id) {
    setRevoking(id);
    setRevokeError(null);
    try {
      await api(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setCreated((current) => (current?.id === id ? null : current));
      reload();
    } catch (err) {
      setRevokeError(err);
    } finally {
      setRevoking(null);
    }
  }

  async function create(event) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const token = await api('/tokens', { method: 'POST', body: { name } });
      setCreated(token);
      setName('');
      reload();
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  return (
    <SettingsSection titleId="api-tokens-title">
      <Heading level={2} id="api-tokens-title">
        API tokens
      </Heading>
      <Text as="p" color="secondary">
        Tokens act like you on /api and /mcp until revoked. Use them for scripts and plugins such as pi-pensieve.
      </Text>
      {loading && !data && <Loading label="Loading API tokens" />}
      {error && <ErrorNote error={error} onRetry={reload} />}
      {data?.length === 0 && <Empty>No API tokens.</Empty>}
      {data?.length > 0 && (
        <List hasDividers edge="flush">
          {data.map((token) => (
            <ListItem
              key={token.id}
              align="start"
              label={<Text weight="semibold">{token.name}</Text>}
              description={
                <VStack gap={0.5}>
                  <Text color="secondary">{token.email}</Text>
                  <Text type="supporting" color="secondary">
                    Created <RelTime iso={token.created_at} />
                  </Text>
                </VStack>
              }
              endContent={
                <Button
                  label={revoking === token.id ? 'Revoking…' : 'Revoke'}
                  variant="ghost"
                  size="sm"
                  isLoading={revoking === token.id}
                  isDisabled={revoking !== null}
                  onClick={() => revoke(token.id)}
                />
              }
            />
          ))}
        </List>
      )}
      {revokeError && <InlineError title="Couldn't revoke the API token" message={revokeError.message} />}
      <HStack as="form" onSubmit={create} align="end" wrap="wrap" gap={2}>
        <TextInput
          id="api-token-name"
          label="Name"
          isRequired
          required
          maxLength={100}
          isDisabled={creating}
          value={name}
          onChange={setName}
          width="min(18rem, 100%)"
        />
        <Button type="submit" label={creating ? 'Creating…' : 'Create'} variant="primary" isLoading={creating} isDisabled={creating} />
      </HStack>
      {createError && <InlineError title="Couldn't create the API token" message={createError.message} />}
      {created && (
        <VStack gap={2} paddingBlockStart={3}>
          <HStack align="end" wrap="wrap" gap={2}>
            <TextInput
              id="created-api-token"
              label="New API token"
              isReadOnly
              value={created.token}
              onFocus={(event) => event.target.select()}
              width="min(32rem, 100%)"
            />
            <Button label="Copy" variant="secondary" icon={<Icon icon={Copy} />} onClick={() => copy(created.token, 'API token copied')} />
          </HStack>
          <Text as="p" type="supporting" color="secondary">
            Copy it now. Pensieve shows it only once.
          </Text>
        </VStack>
      )}
    </SettingsSection>
  );
}

function InlineError({ title, message }) {
  return (
    <VStack role="alert">
      <Banner status="error" title={title} description={message} />
    </VStack>
  );
}

function SaveStatus({ status, onRetry }) {
  if (status.state === 'saving')
    return (
      <HStack role="status" gap={2} align="center">
        <Spinner size="sm" aria-label="Saving settings" />
        <Text color="secondary">Saving…</Text>
      </HStack>
    );
  if (status.state === 'saved')
    return (
      <HStack role="status" gap={2} align="center">
        <Icon icon={Check} color="success" />
        <Text color="secondary">Saved</Text>
      </HStack>
    );
  if (status.state === 'error')
    return (
      <VStack role="alert">
        <Banner status="error" title="Couldn't save settings" description={status.error.message} endContent={<Button label="Retry" size="sm" onClick={onRetry} />} />
      </VStack>
    );
  return null;
}
