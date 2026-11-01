import { ActionIcon, Badge, Button, Checkbox, Drawer, Group, NumberInput, Stack, Switch, Table, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconStar, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, type Domain, type Sender } from "../api";

export default function DomainSendingDrawer({ domain, onClose }: { domain: Domain; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(domain.display_name ?? "");
  const [quota, setQuota] = useState<number | string>(domain.daily_quota);
  const [enabled, setEnabled] = useState(domain.status === "active");
  const [address, setAddress] = useState("");
  const [senderName, setSenderName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["domains"] });
  const onError = (e: Error) => notifications.show({ color: "red", title: "Action failed", message: e.message });
  const save = useMutation({
    mutationFn: () => api(`/domains/${domain.id}`, { method: "PATCH", body: { display_name: displayName.trim() || null, daily_quota: Number(quota), status: enabled ? "active" : "disabled" } }),
    onSuccess: () => { invalidate(); notifications.show({ color: "green", message: "Sending settings saved" }); }, onError,
  });
  const upsert = useMutation({
    mutationFn: (body: { address: string; display_name: string | null; is_default: boolean }) => api(`/domains/${domain.id}/senders`, { body }),
    onSuccess: () => { invalidate(); setAddress(""); setSenderName(""); setIsDefault(false); }, onError,
  });
  const remove = useMutation({
    mutationFn: (sender: Sender) => api(`/domains/${domain.id}/senders/${encodeURIComponent(sender.address)}`, { method: "DELETE" }),
    onSuccess: invalidate, onError,
  });
  return (
    <Drawer opened onClose={onClose} title={`${domain.name} — Sending settings`} position="right" size="lg">
      <Stack>
        <Title order={5}>Domain settings</Title>
        <TextInput label="Display name" description="Used in email templates; defaults to the domain name" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
        <NumberInput label="Daily send quota" description="Shared by all tokens sending from this domain (UTC)" min={1} max={1000000} value={quota} onChange={setQuota} />
        <Switch label="Allow API sending" description="Requires Cloudflare Email Sending setup and a token with Send permission" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
        <Button loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>
        <Text size="sm" c="dimmed">Today: {domain.sent_today} sent · {domain.failed_today} failed</Text>
        <Title order={5} mt="md">Allowed sender addresses</Title>
        <Text size="sm" c="dimmed">Add only the addresses you want to send from. Receiving mailboxes are managed separately.</Text>
        <Table>
          <Table.Thead><Table.Tr><Table.Th>Address</Table.Th><Table.Th>Default</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {domain.senders.map((s) => <Table.Tr key={s.address}>
              <Table.Td><Text size="sm">{s.address}</Text><Text size="xs" c="dimmed">{s.display_name}</Text></Table.Td>
              <Table.Td>{s.is_default ? <Badge size="sm">Default</Badge> : <Button size="compact-xs" variant="subtle" leftSection={<IconStar size={14} />} onClick={() => upsert.mutate({ address: s.address, display_name: s.display_name, is_default: true })}>Set default</Button>}</Table.Td>
              <Table.Td><ActionIcon aria-label={`Remove sender ${s.address}`} variant="subtle" color="red" onClick={() => modals.openConfirmModal({
                title: "Remove sender address", children: <Text size="sm">API sending from {s.address} will stop immediately.</Text>,
                labels: { confirm: "Remove", cancel: "Cancel" }, confirmProps: { color: "red" }, onConfirm: () => remove.mutate(s),
              })}><IconTrash size={16} /></ActionIcon></Table.Td>
            </Table.Tr>)}
            {!domain.senders.length && <Table.Tr><Table.Td colSpan={3}><Text size="sm" c="dimmed">No sender addresses configured</Text></Table.Td></Table.Tr>}
          </Table.Tbody>
        </Table>
        <TextInput label="Sender address" placeholder={`you@${domain.name}`} value={address} onChange={(e) => setAddress(e.currentTarget.value)} />
        <TextInput label="Sender display name (optional)" value={senderName} onChange={(e) => setSenderName(e.currentTarget.value)} />
        <Group justify="space-between">
          <Checkbox label="Set as default" checked={isDefault} onChange={(e) => setIsDefault(e.currentTarget.checked)} />
          <Button loading={upsert.isPending} disabled={!address.trim()} onClick={() => upsert.mutate({ address: address.trim(), display_name: senderName.trim() || null, is_default: isDefault })}>Add sender</Button>
        </Group>
        <Group justify="space-between" mt="md"><Title order={5}>Templates</Title><Button variant="light" onClick={() => navigate(`/templates?domain=${encodeURIComponent(domain.id)}`)}>Manage templates</Button></Group>
        <Text size="sm" c="dimmed">Domain templates override shared templates with the same name.</Text>
      </Stack>
    </Drawer>
  );
}
