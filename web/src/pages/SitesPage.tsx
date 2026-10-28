import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Button,
  Checkbox,
  Code,
  CopyButton,
  Drawer,
  Group,
  Modal,
  NumberInput,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy, IconPlus, IconStar, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Domain, type Site, type SitesResponse } from "../api";
import SecretField from "../components/SecretField";

function useSites() {
  return useQuery({ queryKey: ["sites"], queryFn: () => api<SitesResponse>("/sites") });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["sites"] });
}

const onError = (e: Error) => notifications.show({ color: "red", title: "Action failed", message: e.message });

function NewSiteModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const invalidate = useInvalidate();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [quota, setQuota] = useState<number | string>(2000);
  const create = useMutation({
    mutationFn: () => api("/sites", { body: { id: id.trim(), name: name.trim(), daily_quota: Number(quota) } }),
    onSuccess: () => {
      invalidate();
      setId("");
      setName("");
      onClose();
    },
    onError,
  });
  return (
    <Modal opened={opened} onClose={onClose} title="New site">
      <Stack>
        <TextInput label="Site ID" description="Lowercase letters, digits and hyphens; cannot be changed later" value={id} onChange={(e) => setId(e.currentTarget.value)} />
        <TextInput label="Name" description="Used as {{site_name}} in templates" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <NumberInput label="Daily quota" min={1} value={quota} onChange={setQuota} />
        <Button loading={create.isPending} onClick={() => create.mutate()}>
          Create
        </Button>
      </Stack>
    </Modal>
  );
}

function SiteDrawer({ site, data, onClose }: { site: Site | null; data: SitesResponse | undefined; onClose: () => void }) {
  const invalidate = useInvalidate();
  const domains = useQuery({ queryKey: ["domains"], queryFn: () => api<{ domains: Domain[] }>("/domains") });
  const [address, setAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const addSender = useMutation({
    mutationFn: (b: { address: string; display_name?: string | null; is_default: boolean }) =>
      api(`/sites/${site!.id}/senders`, { body: b }),
    onSuccess: () => {
      invalidate();
      setAddress("");
      setDisplayName("");
      setIsDefault(false);
    },
    onError,
  });
  const delSender = useMutation({
    mutationFn: (a: string) => api(`/sites/${site!.id}/senders/${encodeURIComponent(a)}`, { method: "DELETE" }),
    onSuccess: invalidate,
    onError,
  });
  const createKey = useMutation({
    mutationFn: () => api<{ id: string; key: string }>(`/sites/${site!.id}/keys`, { method: "POST" }),
    onSuccess: (r) => {
      invalidate();
      setNewKey(r.key);
    },
    onError,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/keys/${id}/revoke`, { method: "POST" }), onSuccess: invalidate, onError });

  if (!site) return null;
  const senders = data?.senders.filter((s) => s.site_id === site.id) ?? [];
  const keys = data?.keys.filter((k) => k.site_id === site.id) ?? [];
  const local = address.includes("@") ? address.split("@")[0] : address;
  const suggestions = (domains.data?.domains ?? []).map((d) => `${local || "no-reply"}@${d.name}`);

  return (
    <Drawer opened onClose={onClose} title={`${site.name}（${site.id}）`} position="right" size="lg">
      <Stack>
        <Title order={5}>Allowed sender addresses</Title>
        <Table>
          <Table.Tbody>
            {senders.map((s) => (
              <Table.Tr key={s.address}>
                <Table.Td>
                  <Text size="sm">{s.address}</Text>
                  {s.display_name && (
                    <Text size="xs" c="dimmed">
                      Display name: {s.display_name}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{s.is_default ? <Badge size="sm">Default</Badge> : null}</Table.Td>
                <Table.Td>
                  <Group gap={4} justify="flex-end">
                    {!s.is_default && (
                      <Tooltip label="Set as default">
                        <ActionIcon variant="subtle" onClick={() => addSender.mutate({ address: s.address, display_name: s.display_name, is_default: true })}>
                          <IconStar size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        modals.openConfirmModal({
                          title: "Remove sender address",
                          children: <Text size="sm">This site will no longer be able to send from {s.address}.</Text>,
                          confirmProps: { color: "red" },
                          onConfirm: () => delSender.mutate(s.address),
                        })
                      }
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group align="flex-end">
          <Autocomplete label="Address" placeholder="no-reply@example.com" data={suggestions} value={address} onChange={setAddress} flex={1} />
          <TextInput label="Display name" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} w={140} />
        </Group>
        <Group justify="space-between">
          <Checkbox label="Set as default" checked={isDefault} onChange={(e) => setIsDefault(e.currentTarget.checked)} />
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            loading={addSender.isPending}
            onClick={() => addSender.mutate({ address: address.trim(), display_name: displayName.trim() || null, is_default: isDefault })}
          >
            Add address
          </Button>
        </Group>

        <Group justify="space-between" mt="md">
          <Title order={5}>API keys</Title>
          <Button size="xs" leftSection={<IconPlus size={14} />} loading={createKey.isPending} onClick={() => createKey.mutate()}>
            New key
          </Button>
        </Group>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Key</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {keys.map((k) => (
              <Table.Tr key={k.id}>
                <Table.Td>
                  <SecretField value={k.key_plain} prefix={k.key_prefix} />
                </Table.Td>
                <Table.Td>{k.created_at}</Table.Td>
                <Table.Td>{k.revoked_at ? <Badge color="gray">Revoked</Badge> : <Badge color="green">Active</Badge>}</Table.Td>
                <Table.Td>
                  {!k.revoked_at && (
                    <Button
                      size="compact-xs"
                      color="red"
                      variant="light"
                      onClick={() =>
                        modals.openConfirmModal({
                          title: "Revoke key",
                          children: <Text size="sm">Sites using {k.key_prefix}… will stop sending immediately. This cannot be undone.</Text>,
                          labels: { confirm: "Revoke", cancel: "Cancel" },
                          confirmProps: { color: "red" },
                          onConfirm: () => revoke.mutate(k.id),
                        })
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>

      <Modal opened={!!newKey} onClose={() => setNewKey(null)} title="New API key" closeOnClickOutside={false}>
        <Stack>
          <Alert color="blue">Put this key in the website's environment variables (e.g. <Code>MAILER_API_KEY</Code>). You can view it again later in the keys table.</Alert>
          <Code block>{newKey}</Code>
          <CopyButton value={newKey ?? ""}>
            {({ copied, copy }) => (
              <Button leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} color={copied ? "green" : undefined} onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </CopyButton>
        </Stack>
      </Modal>
    </Drawer>
  );
}

export default function SitesPage() {
  const { data, error } = useSites();
  const invalidate = useInvalidate();
  const [newOpen, setNewOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const patch = useMutation({
    mutationFn: ({ id, ...b }: { id: string; status?: string; daily_quota?: number }) => api(`/sites/${id}`, { method: "PATCH", body: b }),
    onSuccess: invalidate,
    onError,
  });

  const usage = new Map(data?.usage_today.map((u) => [u.site_id, u]));
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Sites & API keys</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setNewOpen(true)}>
          New site
        </Button>
      </Group>
      <Text size="sm" c="dimmed">
        Websites send mail with <Code>POST {window.location.origin}/api/v1/send</Code> and the header <Code>Authorization: Bearer &lt;API key&gt;</Code>.
      </Text>
      {error && <Text c="red">{error.message}</Text>}
      <Table.ScrollContainer minWidth={640}>
        <Table highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Site</Table.Th>
              <Table.Th>Enabled</Table.Th>
              <Table.Th>Daily quota</Table.Th>
              <Table.Th>Today sent / failed</Table.Th>
              <Table.Th>Senders</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data?.sites.map((s) => (
              <Table.Tr key={s.id}>
                <Table.Td>
                  <Text fw={500}>{s.name}</Text>
                  <Text size="xs" c="dimmed">
                    {s.id}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Switch checked={s.status === "active"} onChange={(e) => patch.mutate({ id: s.id, status: e.currentTarget.checked ? "active" : "disabled" })} />
                </Table.Td>
                <Table.Td>
                  <NumberInput
                    size="xs"
                    w={110}
                    min={1}
                    defaultValue={s.daily_quota}
                    onBlur={(e) => {
                      const v = Number(e.currentTarget.value.replace(/,/g, ""));
                      if (v && v !== s.daily_quota) patch.mutate({ id: s.id, daily_quota: v });
                    }}
                  />
                </Table.Td>
                <Table.Td>
                  {usage.get(s.id)?.sent ?? 0} / {usage.get(s.id)?.failed ?? 0}
                </Table.Td>
                <Table.Td>
                  {data.senders
                    .filter((x) => x.site_id === s.id)
                    .map((x) => (
                      <Text key={x.address} size="xs">
                        {x.address}
                        {x.is_default ? " (default)" : ""}
                      </Text>
                    ))}
                </Table.Td>
                <Table.Td>
                  <Button size="compact-sm" variant="light" onClick={() => setSelected(s.id)}>
                    Manage
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <NewSiteModal opened={newOpen} onClose={() => setNewOpen(false)} />
      <SiteDrawer site={data?.sites.find((s) => s.id === selected) ?? null} data={data} onClose={() => setSelected(null)} />
    </Stack>
  );
}
