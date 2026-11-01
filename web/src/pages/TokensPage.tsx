import { Alert, Anchor, Badge, Button, Checkbox, Code, CopyButton, Group, Modal, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Domain } from "../api";
import SecretField from "../components/SecretField";

interface Permission { domain_id: string; read: boolean; send: boolean }
interface Token {
  id: string;
  name: string;
  key_prefix: string;
  key_plain: string | null;
  permissions: Permission[];
  site_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
const onError = (e: Error) => notifications.show({ color: "red", title: "Action failed", message: e.message });

export default function TokensPage() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api<{ tokens: Token[] }>("/tokens") });
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => api<{ domains: Domain[] }>("/domains") });
  const domainName = (id: string) => id === "*" ? "All domains (including future domains)" : domains.data?.domains.find((d) => d.id === id)?.name ?? id;
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState<Token | null>(null);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["tokens"] });
  const save = useMutation({
    mutationFn: () => api<{ key?: string }>(editing ? `/tokens/${editing.id}` : "/tokens", {
      method: editing ? "PATCH" : "POST", body: { name, permissions: permissions.filter((p) => p.read || p.send) },
    }),
    onSuccess: (r) => { setOpened(false); if (r.key) setNewKey(r.key); invalidate(); }, onError,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/tokens/${id}/revoke`, { method: "POST" }), onSuccess: invalidate, onError });
  const open = (token: Token | null) => {
    setEditing(token); setName(token?.name ?? ""); setPermissions(token?.permissions ?? []); setOpened(true);
  };
  const toggle = (id: string, action: "read" | "send", checked: boolean) => {
    setPermissions((prev) => {
      const grant = prev.find((p) => p.domain_id === id) ?? { domain_id: id, read: false, send: false };
      return [...prev.filter((p) => p.domain_id !== id), { ...grant, [action]: checked }];
    });
  };
  const rows = ["*", ...new Set([...(domains.data?.domains.map((d) => d.id) ?? []), ...permissions.map((p) => p.domain_id).filter((id) => id !== "*")])];
  const all = permissions.find((p) => p.domain_id === "*");
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>API tokens</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => open(null)}>New token</Button>
      </Group>
      <Text size="sm" c="dimmed">One token for reading and sending mail. Choose permissions for each domain. New tokens have no permissions until you select them.</Text>
      <Alert variant="light" title="AI integration guide">
        <Group gap="xs">
          <Anchor href="/api/v1/llms.txt" target="_blank" rel="noreferrer">Open AI integration guide ↗</Anchor>
          <CopyButton value={`${window.location.origin}/api/v1/llms.txt`}>{({ copied, copy }) => <Button size="compact-xs" variant="subtle" onClick={copy}>{copied ? "Copied" : "Copy link"}</Button>}</CopyButton>
        </Group>
        <Text size="xs" c="dimmed" mt="xs">Sending, reading and summarizing mail in one guide. Give your AI agent this link and a token with the required domain permissions.</Text>
      </Alert>
      {(tokens.error || domains.error) && <Alert color="red">{(tokens.error || domains.error)?.message}</Alert>}
      <Table.ScrollContainer minWidth={800}>
        <Table striped highlightOnHover>
          <Table.Thead><Table.Tr>
            <Table.Th>Name</Table.Th><Table.Th>Token</Table.Th><Table.Th>Permissions</Table.Th><Table.Th>Last used</Table.Th><Table.Th />
          </Table.Tr></Table.Thead>
          <Table.Tbody>
            {tokens.data?.tokens.map((t) => <Table.Tr key={t.id} style={t.revoked_at ? { opacity: 0.5 } : undefined}>
              <Table.Td><Text size="sm">{t.name}</Text>{t.site_id && <Text size="xs" c="dimmed">Legacy sender restrictions retained</Text>}</Table.Td>
              <Table.Td><SecretField value={t.key_plain} prefix={t.key_prefix} /></Table.Td>
              <Table.Td><Stack gap={4}>
                {t.permissions.filter((p) => p.read || p.send).map((p) => <Group gap={4} key={p.domain_id}>
                  <Text size="xs">{domainName(p.domain_id)}</Text>
                  {p.read && <Badge size="xs" variant="light">Read</Badge>}{p.send && <Badge size="xs" variant="light" color="orange">Send</Badge>}
                </Group>)}
                {!t.permissions.some((p) => p.read || p.send) && <Text size="xs" c="dimmed">No permissions</Text>}
              </Stack></Table.Td>
              <Table.Td>{t.last_used_at ? `${t.last_used_at} UTC` : "Never"}</Table.Td>
              <Table.Td>{t.revoked_at ? <Badge color="gray">Revoked</Badge> : <Group gap={6}>
                <Button size="compact-xs" variant="light" onClick={() => open(t)}>Edit</Button>
                <Button size="compact-xs" color="red" variant="subtle" loading={revoke.isPending} onClick={() => modals.openConfirmModal({
                  title: "Revoke token", children: <Text size="sm">Anything using “{t.name}” will stop working immediately.</Text>,
                  labels: { confirm: "Revoke", cancel: "Cancel" }, confirmProps: { color: "red" }, onConfirm: () => revoke.mutate(t.id),
                })}>Revoke</Button>
              </Group>}</Table.Td>
            </Table.Tr>)}
            {tokens.data?.tokens.length === 0 && <Table.Tr><Table.Td colSpan={5}><Text ta="center" c="dimmed">No tokens yet</Text></Table.Td></Table.Tr>}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Modal opened={opened} onClose={() => setOpened(false)} title={editing ? "Edit token" : "New token"} size="lg">
        <Stack>
          <TextInput label="Name" placeholder="Website / AI assistant" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
          {editing?.site_id && <Text size="sm" c="dimmed">This migrated credential retains its original sender address restrictions.</Text>}
          <Text size="sm">Grant access by domain. Sending also requires an allowed sender address in Domains.</Text>
          <Table><Table.Thead><Table.Tr><Table.Th>Domain</Table.Th><Table.Th>Read mail</Table.Th><Table.Th>Send mail</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{rows.map((id) => <Table.Tr key={id}>
              <Table.Td>{domainName(id)}</Table.Td>
              {(["read", "send"] as const).map((action) => <Table.Td key={action}><Checkbox
                aria-label={`${action} ${domainName(id)}`}
                checked={!!(permissions.find((p) => p.domain_id === id)?.[action] || (id !== "*" && all?.[action]))}
                disabled={id !== "*" && !!all?.[action]}
                onChange={(e) => toggle(id, action, e.currentTarget.checked)}
              /></Table.Td>)}
            </Table.Tr>)}</Table.Tbody>
          </Table>
          {(all?.read || all?.send) && <Alert color="orange">All domains also grants the selected permissions to domains added in the future.</Alert>}
          {!permissions.some((p) => p.read || p.send) && <Text size="sm" c="dimmed">No permissions selected. This token will have no access.</Text>}
          <Button loading={save.isPending} disabled={!name.trim() || !domains.data} onClick={() => save.mutate()}>{editing ? "Save" : "Create token"}</Button>
        </Stack>
      </Modal>
      <Modal opened={!!newKey} onClose={() => setNewKey(null)} title="New API token" closeOnClickOutside={false}>
        <Stack>
          <Alert color="blue">Store this token as a secret. Use the same token for both reading and sending, according to its permissions.</Alert>
          <Code block>{newKey}</Code>
          <CopyButton value={newKey ?? ""}>{({ copied, copy }) => <Button leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} onClick={copy}>{copied ? "Copied" : "Copy"}</Button>}</CopyButton>
        </Stack>
      </Modal>
    </Stack>
  );
}
